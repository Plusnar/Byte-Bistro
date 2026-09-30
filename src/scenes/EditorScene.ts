import { INGREDIENT_ASSETS } from "../data/ingredientAssets";
import { ASSET_LIBRARY } from "../data/assetLibrary";
import { createBuildingMesh } from "../editor/building";
import { mapRequirements } from "../editor/validation";
import {
  ArcRotateCamera,
  Color3,
  DirectionalLight,
  Engine,
  HemisphericLight,
  HighlightLayer,
  InstancedMesh,
  Matrix,
  Mesh,
  MeshBuilder,
  Plane,
  PositionGizmo,
  Quaternion,
  Scene,
  StandardMaterial,
  TransformNode,
  UtilityLayerRenderer,
  Vector3,
  type LinesMesh,
} from "@babylonjs/core";
import type { ModelInstance } from "../core/AssetManager";
import { AssetManager } from "../core/AssetManager";
import type { ManagedScene } from "../core/SceneManager";
import { CHARACTERS, SCENARIO_ASSETS } from "../data";
import { MANNEQUIN } from "../systems/WeddingGuests";
import { sanitizeRobotConfig, type RobotConfig } from "../data/robotConfig";
import { hasColorChange, hasTransformChange, isVisualPreservingChange } from "../editor/objectDiff";
import {
  createPlacedObject,
  generateObjectId,
  roundPlacement,
  type EditorAssetEntry,
} from "../editor/catalog";
import { createDefaultMap, emptyMap } from "../editor/defaults";
import { DEFAULT_SCENARIO_ID } from "../data/scenarios";
import type { MapMeta } from "../editor/MapData";
import type { MapData, MapPlacedObject, MapSlotSummary } from "../editor/MapData";
import { MIN_OBJECT_SCALE, wrapAngle } from "../editor/MapData";
import { MapStore } from "../editor/MapStore";
import {
  BUILD_LOT_HALF,
  GRID_STEP,
  isWallCutAway,
  layoutFloorRect,
  layoutWallRun,
  pieceStep,
  placementProblem,
  snapTo,
  type Footprint,
  type PiecePlacement,
  type Point2,
} from "../editor/buildTools";
import { isFloorAsset, isWallAsset } from "../physics/collisionPolicy";
import { OutdoorBackdrop } from "./OutdoorBackdrop";
import {
  applyColorOverrides,
  listMaterialSlots,
  MaterialOverrideCache,
  type MaterialSlot,
} from "./materialOverrides";

/**
 * - `select`: pick, move (drag or gizmo), rotate and scale.
 * - `place`: stamp the catalogue asset (or an eyedropped copy) with each click.
 * - `wall` / `floor`: drag to lay a run of wall pieces / a rectangle of floor tiles.
 * - `eyedropper`: click an object to keep placing copies of it, colours included.
 * - `design`: click an object to edit its colours.
 * - `erase` (sledgehammer): click to delete, drag a box to delete everything in it.
 */
export type EditorTool = "select" | "place" | "erase" | "eyedropper" | "design" | "wall" | "floor";
/** The Sims' walls views: all up, cut where they face the camera, all lowered. */
export type WallMode = "up" | "cutaway" | "down";
export type PlacementIssue = "outside" | "overlap" | null;

export interface EditorSceneCallbacks {
  readonly onExit: () => void;
  readonly onPlay: (map: MapData) => void;
  /** Short feedback for the status line (a refused placement, a paste...). */
  readonly onNotice?: (message: string, tone: "info" | "success" | "warning" | "error") => void;
}

export interface SelectionColors {
  /** Paintable parts shared by every selected object of the same model. */
  readonly slots: readonly MaterialSlot[];
  /** The first selected object's overrides. */
  readonly colors: Readonly<Record<string, string>>;
  /** How many selected objects the colours apply to. */
  readonly count: number;
}

interface EditorObjectVisual {
  data: MapPlacedObject;
  readonly root: TransformNode;
  /** Display-only node under the root: walls are lowered here, never in the saved transform. */
  readonly body: TransformNode;
  readonly instance: ModelInstance | null;
  readonly proxy: Mesh | null;
  readonly isWall: boolean;
  readonly isFloor: boolean;
  lowered: boolean;
  /** Cutaway for the room shell: its camera-side wall is clipped, as in the game. */
  clip: Plane | null;
  /** Ground footprint, cached until the transform changes. */
  footprint: Footprint | null;
}

interface BuildDrag {
  readonly kind: "wall" | "floor";
  readonly start: Point2;
  /** Measured once, before any ghost exists: the ghosts would otherwise count as the piece. */
  readonly step: { x: number; z: number };
  pieces: PiecePlacement[];
}

interface GhostSource {
  readonly mesh: Mesh;
  /** The mesh's transform relative to the preview's root. */
  readonly local: Matrix;
}

const SNAP_ROTATION = Math.PI / 12;
const MIN_SCALE = MIN_OBJECT_SCALE;
/** How far walls are lowered in the cutaway / walls-down views: a stub, as in the Sims. */
const LOWERED_WALL_SCALE = 0.12;
/** Beyond this many selected objects the outline is too costly; they get a tint instead. */
const OUTLINE_LIMIT = 60;
const SELECTION_COLOR = Color3.FromHexString("#5DE4FF");
const HOVER_COLOR = Color3.FromHexString("#FFFFFF");
const VALID_COLOR = Color3.FromHexString("#5CFF9D");
const INVALID_COLOR = Color3.FromHexString("#FF5A5A");
const CAMERA_TARGET_LIMIT = BUILD_LOT_HALF + 20;
const MIN_RADIUS = 4;
const MAX_RADIUS = 90;
const TOP_VIEW_BETA = 0.02;
const MIN_BETA = 0.25;
const MAX_BETA = 1.45;
const DEFAULT_CAMERA = { alpha: -Math.PI / 2, beta: 0.95, radius: 28 } as const;

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export class EditorScene implements ManagedScene {
  readonly scene: Scene;

  private readonly assets: AssetManager;
  private readonly canvas: HTMLCanvasElement;
  private readonly store = new MapStore();
  private readonly visuals = new Map<string, EditorObjectVisual>();
  private readonly selectionIds = new Set<string>();
  private readonly utilityLayer: UtilityLayerRenderer;
  private readonly positionGizmo: PositionGizmo;
  /** The gizmo drives this node; every selected object follows it, not just the first. */
  private readonly selectionPivot: TransformNode;
  private readonly detachGizmoObservers: () => void;
  private readonly mouseObserver: (event: Event) => void;
  private readonly keyObserver: (event: Event) => void;
  private readonly contextMenuObserver: (event: Event) => void;
  private readonly backdrop: OutdoorBackdrop;
  private readonly colorCache = new MaterialOverrideCache();
  private readonly highlight: HighlightLayer;
  private currentTool: EditorTool = "select";
  private currentAsset: EditorAssetEntry | null = null;
  /** What the eyedropper copied; null while placing from the catalogue. */
  private copyTemplate: MapPlacedObject | null = null;
  private currentSlotId: string;
  private currentMap: MapData;
  private gizmoMode: "position" | "rotation" | "scale" = "position";
  private gridLines: LinesMesh | null = null;
  private gridVisible = true;
  private pickIndicator: Mesh | null = null;
  private disposed = false;
  private preview: EditorObjectVisual | null = null;
  private previewVersion = 0;
  private refreshVersion = 0;
  private snap = true;
  private surfacePlacement = false;
  private placementHeight = 0;
  private placementRotation = 0;
  private allowOverlap = false;
  private placementIssue: PlacementIssue = null;
  private dragPoint: Vector3 | null = null;
  /** "Girar": the selection turns about its centre as the pointer circles it. */
  private rotateDrag: { pivot: Vector3; startAngle: number; start: Map<string, { y: number; x: number; z: number }> } | null = null;
  /** "Escala": dragging up grows the selection, down shrinks it. */
  private scaleDrag: { startY: number; start: Map<string, Vector3> } | null = null;
  /** Box selection (select tool) or box delete (sledgehammer), started on empty space. */
  private marquee: {
    x: number; y: number; additive: boolean; erase: boolean; element: HTMLDivElement | null; clickId?: string;
  } | null = null;
  private buildDrag: BuildDrag | null = null;
  private ghostSources: GhostSource[] = [];
  /** One pool of instances per ghost source; index = piece. */
  private ghostPools: InstancedMesh[][] = [];
  private gizmoStart: { pivot: Vector3; roots: Map<string, Vector3> } | null = null;
  private orbiting = false;
  private isDragPanning = false;
  private altHeld = false;
  private hoverId: string | null = null;
  private history: MapData[] = [];
  private future: MapData[] = [];
  /** The redo stack as it was before the latest checkpoint cleared it. */
  private futureAtCheckpoint: MapData[] = [];
  /** The map's contents as last saved or loaded, to tell whether leaving it loses work. */
  private savedSnapshot = "";
  private clipboard: MapPlacedObject[] = [];
  private gizmoDragging = false;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private camera!: ArcRotateCamera;
  /** Where the camera eases to; input moves these, `updateCamera` follows. */
  private readonly desired: { alpha: number; beta: number; radius: number; target: Vector3 } = {
    alpha: DEFAULT_CAMERA.alpha, beta: DEFAULT_CAMERA.beta, radius: DEFAULT_CAMERA.radius, target: Vector3.Zero(),
  };
  private savedBeta: number = DEFAULT_CAMERA.beta;
  private readonly cameraKeys = new Set<string>();
  private wallMode: WallMode = "cutaway";
  private wallsDirty = true;
  private wallCameraKey = "";
  private loadingProgress = 1;
  private stateVersion = 0;
  private readonly releaseInput = (): void => {
    this.cameraKeys.clear();
    this.orbiting = false;
    this.isDragPanning = false;
    this.altHeld = false;
  };
  private readonly dropObserver = (event: DragEvent): void => {
    if (event.target instanceof HTMLElement && event.target.closest("[data-editor-chrome]")) return;
    event.preventDefault();
    const point = this.pointerCoordinates(event);
    this.updatePointerFeedback(point.x, point.y);
    if (event.type === "drop" && this.currentAsset) {
      const position = this.pickPlacement(point.x, point.y);
      if (position) this.tryPlaceAt(position);
    }
  };

  constructor(
    engine: Engine,
    _host: HTMLElement,
    private readonly callbacks: EditorSceneCallbacks,
    initialMap: MapData | null = null,
    initialSlotId: string | null = null,
  ) {
    this.canvas = engine.getRenderingCanvas()!;
    this.currentMap = initialMap ?? createDefaultMap();
    this.currentSlotId = initialSlotId ?? "";
    // A draft reopened on its slot counts as changed only if it differs from what is stored.
    const stored = this.currentSlotId ? this.store.load(this.currentSlotId) : null;
    this.savedSnapshot = EditorScene.snapshot(stored ?? this.currentMap);

    this.scene = new Scene(engine);
    this.scene.ambientColor = Color3.FromHexString("#27354A");
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    // Light haze: enough to sit the town back, not enough to hide the lot's far edge.
    this.scene.fogDensity = 0.0045;
    this.scene.collisionsEnabled = false;
    this.scene.skipPointerMovePicking = true;

    this.assets = new AssetManager(this.scene, [
      // Robots placed from the "Robôs" catalogue draw this model, so the editor needs it too
      // or they would all render as grey proxy boxes.
      { id: MANNEQUIN.modelAssetId, url: MANNEQUIN.modelUrl, required: true },
      ...CHARACTERS.map((character) => ({
        id: character.modelAssetId,
        url: character.modelUrl,
        required: true,
      })),
      ...SCENARIO_ASSETS,
      ...INGREDIENT_ASSETS,
      ...ASSET_LIBRARY,
    ]);

    // Sky, lawn and town; also sets the clear and fog colours to the horizon.
    this.backdrop = new OutdoorBackdrop(this.scene, this.assets);
    this.buildLights();
    this.buildGrid();
    this.highlight = new HighlightLayer("editor-highlight", this.scene, {
      mainTextureRatio: 0.5,
      blurHorizontalSize: 0.7,
      blurVerticalSize: 0.7,
    });
    this.highlight.innerGlow = false;

    this.utilityLayer = new UtilityLayerRenderer(this.scene);
    this.positionGizmo = new PositionGizmo(this.utilityLayer);
    this.positionGizmo.snapDistance = GRID_STEP;
    this.positionGizmo.scaleRatio = 1.1;
    this.positionGizmo.planarGizmoEnabled = true;
    this.selectionPivot = new TransformNode("editor-selection-pivot", this.scene);
    this.detachGizmoObservers = this.attachGizmoHandlers();

    this.initCamera();

    this.mouseObserver = (event) => this.handleMouse(event);
    this.keyObserver = (event) => this.handleKey(event);
    this.contextMenuObserver = (event) => event.preventDefault();
    this.canvas.addEventListener("pointerdown", this.mouseObserver);
    window.addEventListener("pointermove", this.mouseObserver);
    window.addEventListener("pointerup", this.mouseObserver);
    window.addEventListener("pointercancel", this.mouseObserver);
    this.canvas.addEventListener("dragover", this.dropObserver);
    this.canvas.addEventListener("drop", this.dropObserver);
    this.canvas.addEventListener("wheel", this.mouseObserver, { passive: false });
    this.canvas.addEventListener("contextmenu", this.contextMenuObserver);
    window.addEventListener("keydown", this.keyObserver);
    window.addEventListener("keyup", this.keyObserver);
    window.addEventListener("blur", this.releaseInput);

    void this.refresh();
    // Debug handle for ?dev sessions, like Game's __bbGame: lets the screenshot harness
    // inspect the editor without a UI path for everything.
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("dev")) {
      (window as unknown as { __bbEditor?: EditorScene }).__bbEditor = this;
    }
  }

  // ---------------------------------------------------------------------------------------
  // State the UI reads

  /** Bumped on every change the UI shows; the controller re-syncs the DOM only then. */
  getStateVersion(): number { return this.stateVersion; }
  getCurrentTool(): EditorTool { return this.currentTool; }
  getCurrentAsset(): EditorAssetEntry | null { return this.currentAsset; }
  getGizmoMode(): "position" | "rotation" | "scale" { return this.gizmoMode; }
  getLoadingProgress(): number { return this.loadingProgress; }
  getSelectionSize(): number { return this.selectionIds.size; }
  getWallMode(): WallMode { return this.wallMode; }
  isGridVisible(): boolean { return this.gridVisible; }
  isTopView(): boolean { return this.desired.beta <= TOP_VIEW_BETA + 1e-3; }
  isOverlapAllowed(): boolean { return this.allowOverlap; }
  getPlacementIssue(): PlacementIssue { return this.placementIssue; }
  canUndo(): boolean { return this.history.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }
  getCurrentMap(): MapData { return this.currentMap; }
  getCurrentSlotId(): string { return this.currentSlotId; }
  listSlots(): MapSlotSummary[] { return this.store.list(); }
  get isCopying(): boolean { return this.copyTemplate !== null; }

  getSelectedObject(): MapPlacedObject | null {
    return this.currentMap.objects.find(o => this.selectionIds.has(o.id)) ?? null;
  }

  getSelectedObjects(): MapPlacedObject[] {
    return this.currentMap.objects.filter(o => this.selectionIds.has(o.id));
  }

  /** True when loading another map or starting a new one would throw work away. */
  hasUnsavedChanges(): boolean {
    return EditorScene.snapshot(this.currentMap) !== this.savedSnapshot;
  }

  /** One line of help for what the pointer does right now. */
  getHint(): string {
    if (this.loadingProgress < 1) return `Carregando objetos… ${Math.round(this.loadingProgress * 100)}%`;
    switch (this.currentTool) {
      case "place":
        if (this.placementIssue === "overlap") return "Não cabe aqui: sobreposto a outro objeto (ative “Permitir sobreposição” para forçar)";
        if (this.placementIssue === "outside") return "Fora do lote de construção";
        return "Clique para colocar · , . girar (Shift: 15°) · Alt: sem grade · Esc: cancelar";
      case "wall":
        return this.currentAsset ? "Clique e arraste para desenhar a parede · Esc: cancelar" : "Escolha um estilo de parede no catálogo";
      case "floor":
        return this.currentAsset ? "Clique e arraste para cobrir uma área com piso · Esc: cancelar" : "Escolha um piso no catálogo";
      case "eyedropper":
        return "Clique num objeto para copiá-lo com as cores";
      case "design":
        return this.selectionIds.size ? "Mude as cores no painel à direita · clique em outro objeto para trocar" : "Clique num objeto para mudar as cores";
      case "erase":
        return "Clique para apagar · arraste para apagar uma área";
      default:
        return this.selectionIds.size
          ? "Arraste para mover · , . girar · Ctrl+D duplicar · Delete apagar · F focar"
          : "Clique para selecionar · arraste numa área vazia para selecionar vários";
    }
  }

  /** Colours of the selection, when every selected object is the same model. */
  getSelectionColors(): SelectionColors | null {
    const selected = this.getSelectedObjects();
    const first = selected[0];
    if (!first || selected.some(object => object.assetId !== first.assetId)) return null;
    const visual = this.visuals.get(first.id);
    if (!visual?.instance) return null;
    const slots = listMaterialSlots(visual.instance.rootNodes);
    if (slots.length === 0) return null;
    return { slots, colors: first.colors ?? {}, count: selected.length };
  }

  // ---------------------------------------------------------------------------------------
  // Tools and options

  setTool(tool: EditorTool): void {
    if (this.buildDrag) this.cancelBuildDrag();
    this.currentTool = tool;
    if (tool !== "place") this.copyTemplate = null;
    // Only the select and design tools keep a selection around.
    if (tool !== "select" && tool !== "design") this.clearSelection();
    if (this.preview) this.preview.root.setEnabled(false);
    this.setHover(null);
    this.placementIssue = null;
    this.canvas.style.cursor = tool === "erase" || tool === "eyedropper" ? "crosshair" : "";
    this.refreshGizmo();
    this.bump();
  }

  setAsset(asset: EditorAssetEntry | null): void {
    this.currentAsset = asset;
    // Picking from the catalogue (or Esc, which clears the asset) ends the eyedropper copy.
    this.copyTemplate = null;
    void this.createPreview();
    this.bump();
  }

  /**
   * Eyedropper: copies the selected object and keeps placing copies of it, one per click,
   * until Esc or another tool. A copy keeps everything but its position — rotation, scale,
   * colours and robot settings — and its height, so copies on an upper floor stay on it.
   * Returns the copied object's name, or null when nothing copyable is selected (spawn
   * points are one per player, so they are not).
   */
  startCopying(): string | null {
    const source = this.getSelectedObject();
    if (!source || source.role === "spawn") return null;
    const template = structuredClone(source);
    this.setTool("place");
    this.currentAsset = {
      assetId: template.assetId,
      label: template.label ?? template.assetId,
      category: template.category,
      role: template.role,
      stationId: template.stationId,
      ingredientId: template.ingredientId,
      color: template.color,
      scale: template.scale,
      robot: template.robot,
    };
    this.copyTemplate = template;
    this.placementRotation = template.rotation.y;
    void this.createPreview();
    this.bump();
    return template.label ?? "objeto";
  }

  setGizmoMode(mode: "position" | "rotation" | "scale"): void {
    this.gizmoMode = mode;
    this.refreshGizmo();
    this.bump();
  }

  setPlacementOptions(snap: boolean, surface: boolean, height: number): void {
    this.snap = snap;
    this.surfacePlacement = surface;
    this.placementHeight = Number.isFinite(height) ? height : 0;
    this.positionGizmo.snapDistance = snap ? GRID_STEP : 0;
    this.bump();
  }

  setAllowOverlap(allow: boolean): void {
    this.allowOverlap = allow;
    this.bump();
  }

  setWallMode(mode: WallMode): void {
    if (this.wallMode === mode) return;
    this.wallMode = mode;
    this.wallsDirty = true;
    this.bump();
  }

  cycleWallMode(): WallMode {
    const order: WallMode[] = ["up", "cutaway", "down"];
    this.setWallMode(order[(order.indexOf(this.wallMode) + 1) % order.length]!);
    return this.wallMode;
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible;
    this.gridLines?.setEnabled(visible);
    this.bump();
  }

  toggleTopView(): void {
    if (this.isTopView()) {
      this.desired.beta = this.savedBeta;
    } else {
      this.savedBeta = this.desired.beta;
      this.desired.beta = TOP_VIEW_BETA;
    }
    this.bump();
  }

  resetCamera(): void {
    this.desired.alpha = DEFAULT_CAMERA.alpha;
    this.desired.beta = DEFAULT_CAMERA.beta;
    this.desired.radius = DEFAULT_CAMERA.radius;
    this.desired.target.setAll(0);
    this.bump();
  }

  // ---------------------------------------------------------------------------------------
  // Editing the selection

  /** Turns the selection (or the next placement) by 45°, or 15° when `fine`. */
  rotateSelected(direction = 1, fine = false): void {
    const angle = direction * (fine ? SNAP_ROTATION : Math.PI / 4);
    this.placementRotation = wrapAngle(this.placementRotation + angle);
    if (this.preview) this.preview.root.rotation.y = this.placementRotation;
    if (this.currentTool !== "select" && this.currentTool !== "design") return;
    if (!this.selectionIds.size) return;
    this.checkpoint();
    const pivot = this.selectionCenter();
    const turn = Matrix.RotationY(angle);
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      this.useEuler(root);
      root.rotation.y += angle;
      // A group turns about its centre, so it keeps its shape.
      if (this.selectionIds.size > 1) {
        const offset = Vector3.TransformCoordinates(root.position.subtract(pivot), turn);
        root.position.x = pivot.x + offset.x;
        root.position.z = pivot.z + offset.z;
      }
    }
    this.commitGizmoChange();
  }

  editSelected(group: "position" | "rotation" | "scale", axis: "x" | "y" | "z", value: number): void {
    if (!Number.isFinite(value) || (group === "scale" && value <= 0)) return;
    this.checkpoint();
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      if (group === "rotation") this.useEuler(root);
      root[group === "scale" ? "scaling" : group][axis] = group === "rotation" ? value * Math.PI / 180 : value;
    }
    this.commitGizmoChange();
  }

  /** Applies a robot config patch to every selected robot. Non-robots are left alone. */
  editSelectedRobots(patch: Partial<RobotConfig>): void {
    const targets = this.currentMap.objects.filter(
      object => this.selectionIds.has(object.id) && object.role === "robot",
    );
    if (targets.length === 0) return;
    this.checkpoint();
    const patched = new Map(targets.map(object => [
      object.id,
      { ...object, robot: sanitizeRobotConfig({ ...(object.robot ?? {}), ...patch }) },
    ]));
    this.replaceObjects(patched);
  }

  /**
   * Live colour while a picker is dragged: painted on the models, not written to the map
   * (and so not an undo step per pixel). `commitSelectedColor` writes it.
   */
  previewSelectedColor(material: string, hex: string | null): void {
    for (const id of this.selectionIds) {
      const visual = this.visuals.get(id);
      if (!visual?.instance) continue;
      const colors = { ...(visual.data.colors ?? {}) };
      if (hex) colors[material] = hex; else delete colors[material];
      applyColorOverrides(visual.instance.rootNodes, colors, this.colorCache);
    }
  }

  /** Sets (or with null, restores) one part's colour on every selected object. */
  commitSelectedColor(material: string, hex: string | null): void {
    const targets = this.getSelectedObjects();
    if (targets.length === 0) return;
    this.checkpoint();
    const patched = new Map(targets.map((object) => {
      const colors: Record<string, string> = { ...(object.colors ?? {}) };
      if (hex) colors[material] = hex.toLowerCase(); else delete colors[material];
      return [object.id, { ...object, colors: Object.keys(colors).length ? colors : undefined }];
    }));
    this.replaceObjects(patched);
  }

  /** Every part back to the model's own colours. */
  resetSelectedColors(): void {
    const targets = this.getSelectedObjects().filter(object => object.colors);
    if (targets.length === 0) return;
    this.checkpoint();
    this.replaceObjects(new Map(targets.map(object => [object.id, { ...object, colors: undefined }])));
  }

  undo(redo = false): void {
    const source = redo ? this.future : this.history;
    const previous = source.pop();
    if (!previous) return;
    (redo ? this.history : this.future).push(this.currentMap);
    this.currentMap = previous;
    void this.refresh();
  }

  /** Replaces the working map with an imported file, as a single undoable step. */
  loadImportedMap(map: MapData): void {
    this.checkpoint();
    this.currentMap = { ...map, updatedAt: Date.now() };
    this.currentSlotId = "";
    this.selectionIds.clear();
    void this.refresh();
  }

  async loadSlot(slotId: string): Promise<MapData | null> {
    const data = this.store.load(slotId);
    if (!data) return null;
    this.history = [];
    this.future = [];
    this.clearSelection();
    this.currentMap = data;
    this.currentSlotId = slotId;
    this.savedSnapshot = EditorScene.snapshot(data);
    await this.refresh();
    return data;
  }

  async newMap(name: string): Promise<MapData> {
    const data = emptyMap(name);
    this.history = [];
    this.future = [];
    this.clearSelection();
    this.currentMap = data;
    this.currentSlotId = "";
    this.savedSnapshot = EditorScene.snapshot(data);
    await this.refresh();
    return data;
  }

  saveCurrentMap(name: string, meta: MapMeta, slotId?: string): string | null {
    const trimmed = name.trim() || "Fase sem nome";
    const targetSlotId = slotId || this.store.generateSlotId();
    // The level settings live on the map, so an exported file plays the same anywhere.
    const data: MapData = {
      ...this.currentMap,
      name: trimmed,
      updatedAt: Date.now(),
      scenarioId: this.currentMap.scenarioId ?? DEFAULT_SCENARIO_ID,
      meta,
    };
    this.currentMap = data;
    const success = this.store.save(targetSlotId, data);
    if (!success) return null;
    this.currentSlotId = targetSlotId;
    this.savedSnapshot = EditorScene.snapshot(this.currentMap);
    this.bump();
    return targetSlotId;
  }

  deleteSlot(slotId: string): boolean {
    const removed = this.store.delete(slotId);
    if (removed && slotId === this.currentSlotId) this.currentSlotId = "";
    return removed;
  }

  duplicateSelected(): void {
    this.pasteObjects(this.getSelectedObjects(), 1.25);
  }

  /** Ctrl+C: keeps a copy of the selection for Ctrl+V. */
  copySelection(): number {
    this.clipboard = this.getSelectedObjects().filter(object => object.role !== "spawn").map(object => structuredClone(object));
    return this.clipboard.length;
  }

  /** Ctrl+V: pastes the copied objects one grid cell over, selected. */
  pasteClipboard(): number {
    return this.pasteObjects(this.clipboard, 1.25);
  }

  deleteSelected(): void {
    if (this.selectionIds.size === 0) return;
    this.checkpoint();
    const removed = new Set(this.selectionIds);
    this.currentMap = {
      ...this.currentMap,
      objects: this.currentMap.objects.filter((object) => !removed.has(object.id)),
      updatedAt: Date.now(),
    };
    this.selectionIds.clear();
    void this.refresh();
  }

  selectAll(): void {
    this.selectionIds.clear();
    for (const object of this.currentMap.objects) this.selectionIds.add(object.id);
    this.refreshSelectionHighlights();
  }

  clearSelection(): void {
    if (this.selectionIds.size === 0) return;
    this.selectionIds.clear();
    this.refreshSelectionHighlights();
  }

  selectObject(objectId: string, additive: boolean): void {
    if (!additive) this.selectionIds.clear();
    if (this.selectionIds.has(objectId) && additive) this.selectionIds.delete(objectId);
    else this.selectionIds.add(objectId);
    this.refreshSelectionHighlights();
  }

  playCurrentMap(): void {
    if (mapRequirements(this.currentMap).every(r => r.satisfied)) this.callbacks.onPlay(this.currentMap);
  }

  exit(): void {
    this.callbacks.onExit();
  }

  // ---------------------------------------------------------------------------------------
  // Frame loop

  update(deltaSeconds: number): void {
    if (this.disposed) return;
    this.updateCamera(Math.min(deltaSeconds, 0.1));
    this.updateWalls();
  }

  render(): void {
    if (this.disposed) return;
    this.scene.render();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.marquee?.element?.remove();
    this.marquee = null;
    this.canvas.style.cursor = "";
    this.canvas.removeEventListener("pointerdown", this.mouseObserver);
    window.removeEventListener("pointermove", this.mouseObserver);
    window.removeEventListener("pointerup", this.mouseObserver);
    window.removeEventListener("pointercancel", this.mouseObserver);
    this.canvas.removeEventListener("dragover", this.dropObserver);
    this.canvas.removeEventListener("drop", this.dropObserver);
    this.canvas.removeEventListener("wheel", this.mouseObserver);
    this.canvas.removeEventListener("contextmenu", this.contextMenuObserver);
    window.removeEventListener("keydown", this.keyObserver);
    window.removeEventListener("keyup", this.keyObserver);
    window.removeEventListener("blur", this.releaseInput);
    this.previewVersion++;
    this.refreshVersion++;
    this.disposeGhosts();
    if (this.preview) this.disposeVisual(this.preview);
    this.detachGizmoObservers();
    this.positionGizmo.dispose();
    this.utilityLayer.dispose();
    this.highlight.dispose();
    for (const visual of this.visuals.values()) this.disposeVisual(visual);
    this.visuals.clear();
    this.colorCache.dispose();
    this.backdrop.dispose();
    this.assets.dispose();
    this.scene.dispose();
  }

  // ---------------------------------------------------------------------------------------
  // Scene setup

  private initCamera(): void {
    const camera = new ArcRotateCamera(
      "editor-camera",
      DEFAULT_CAMERA.alpha,
      DEFAULT_CAMERA.beta,
      DEFAULT_CAMERA.radius,
      Vector3.Zero(),
      this.scene,
    );
    camera.minZ = 0.3;
    camera.maxZ = 400;
    camera.fov = 0.8;
    camera.lowerRadiusLimit = MIN_RADIUS;
    camera.upperRadiusLimit = MAX_RADIUS;
    camera.lowerBetaLimit = TOP_VIEW_BETA;
    camera.upperBetaLimit = MAX_BETA;
    // No attachControl: input is the Sims-style scheme below.
    this.camera = camera;
    this.scene.activeCamera = camera;
  }

  private buildLights(): void {
    const sky = new HemisphericLight("editor-sky-light", new Vector3(0.2, 1, -0.3), this.scene);
    sky.diffuse = Color3.FromHexString("#F4F8FF");
    sky.groundColor = Color3.FromHexString("#5E6A52");
    sky.intensity = 0.8;
    const sun = new DirectionalLight("editor-sun", new Vector3(-0.45, -1, 0.35), this.scene);
    sun.diffuse = Color3.FromHexString("#FFF1DC");
    sun.intensity = 0.55;
  }

  /** 1 m grid over the lot, plus its border, drawn just above the floor tiles. */
  private buildGrid(): void {
    const half = BUILD_LOT_HALF;
    const lines: Vector3[][] = [];
    for (let v = -half; v <= half; v += 1) {
      lines.push([new Vector3(v, 0.012, -half), new Vector3(v, 0.012, half)]);
      lines.push([new Vector3(-half, 0.012, v), new Vector3(half, 0.012, v)]);
    }
    const grid = MeshBuilder.CreateLineSystem("editor-grid", { lines }, this.scene);
    grid.color = new Color3(1, 1, 1);
    grid.alpha = 0.22;
    grid.isPickable = false;
    this.gridLines = grid;

    const corners = [[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]
      .map(([x, z]) => new Vector3(x!, 0.02, z!));
    const border = MeshBuilder.CreateLines("editor-lot-border", { points: corners }, this.scene);
    border.color = Color3.FromHexString("#FFD84D");
    border.alpha = 0.9;
    border.isPickable = false;

    const indicator = MeshBuilder.CreateDisc("editor-pick-indicator", { radius: 0.35, tessellation: 24 }, this.scene);
    indicator.rotation.x = Math.PI / 2;
    indicator.position.y = 0.03;
    const material = new StandardMaterial("editor-pick-indicator-material", this.scene);
    material.diffuseColor = Color3.Black();
    material.emissiveColor = VALID_COLOR.clone();
    material.specularColor = Color3.Black();
    material.alpha = 0.7;
    material.disableLighting = true;
    indicator.material = material;
    indicator.isVisible = false;
    indicator.isPickable = false;
    this.pickIndicator = indicator;
  }

  private attachGizmoHandlers(): () => void {
    const onDragStart = (): void => {
      this.checkpoint();
      this.gizmoDragging = true;
      this.dragPoint = null;
      const roots = new Map<string, Vector3>();
      for (const id of this.selectionIds) {
        const root = this.visuals.get(id)?.root;
        if (root) roots.set(id, root.position.clone());
      }
      this.gizmoStart = { pivot: this.selectionPivot.position.clone(), roots };
    };
    const onDrag = (): void => {
      const start = this.gizmoStart;
      if (!start) return;
      const delta = this.selectionPivot.position.subtract(start.pivot);
      for (const [id, origin] of start.roots) {
        const root = this.visuals.get(id)?.root;
        if (root) root.position.copyFrom(origin.add(delta));
      }
      this.commitGizmoChange();
    };
    const onDragEnd = (): void => {
      this.gizmoDragging = false;
      onDrag();
      this.gizmoStart = null;
      this.dropCheckpointIfUnchanged();
      this.refreshGizmo();
    };
    const gizmo = this.positionGizmo;
    const startObserver = gizmo.onDragStartObservable.add(onDragStart);
    const dragObserver = gizmo.onDragObservable.add(onDrag);
    const endObserver = gizmo.onDragEndObservable.add(onDragEnd);
    return () => {
      gizmo.onDragStartObservable.remove(startObserver);
      gizmo.onDragObservable.remove(dragObserver);
      gizmo.onDragEndObservable.remove(endObserver);
    };
  }

  // ---------------------------------------------------------------------------------------
  // Map edits

  private bump(): void {
    this.stateVersion += 1;
  }

  private checkpoint(): void {
    this.history.push(this.currentMap);
    if (this.history.length > 80) this.history.shift();
    this.futureAtCheckpoint = this.future;
    this.future = [];
  }

  /**
   * Drags checkpoint on press, before anyone knows whether the object will move. A plain
   * click that moved nothing must not leave a no-op undo step behind or wipe the redo stack.
   */
  private dropCheckpointIfUnchanged(): void {
    const last = this.history[this.history.length - 1];
    if (!last) return;
    if (last !== this.currentMap && JSON.stringify(last.objects) !== JSON.stringify(this.currentMap.objects)) return;
    this.history.pop();
    this.future = this.futureAtCheckpoint;
    this.bump();
  }

  private static snapshot(map: MapData): string {
    return JSON.stringify([map.objects, map.environment]);
  }

  private replaceObjects(patched: ReadonlyMap<string, MapPlacedObject>): void {
    this.currentMap = {
      ...this.currentMap,
      objects: this.currentMap.objects.map(object => patched.get(object.id) ?? object),
      updatedAt: Date.now(),
    };
    void this.refresh();
  }

  private pasteObjects(sources: readonly MapPlacedObject[], offset: number): number {
    const copies = sources
      .filter(object => object.role !== "spawn")
      .map(object => ({
        ...structuredClone(object),
        id: generateObjectId(),
        position: { x: object.position.x + offset, y: object.position.y, z: object.position.z + offset },
      }));
    if (copies.length === 0) return 0;
    this.checkpoint();
    this.currentMap = { ...this.currentMap, objects: [...this.currentMap.objects, ...copies], updatedAt: Date.now() };
    this.selectionIds.clear();
    for (const copy of copies) this.selectionIds.add(copy.id);
    // The clipboard follows the paste, so pasting again keeps stepping along.
    if (sources === this.clipboard) this.clipboard = copies.map(copy => structuredClone(copy));
    void this.refresh();
    return copies.length;
  }

  private commitGizmoChange(): void {
    if (this.selectionIds.size === 0) return;
    const updates: MapPlacedObject[] = [];
    for (const id of this.selectionIds) {
      const visual = this.visuals.get(id);
      if (!visual) continue;
      const node = visual.root;
      const position = { x: node.position.x, y: node.position.y, z: node.position.z };
      const euler = node.rotationQuaternion?.toEulerAngles() ?? node.rotation;
      // Stored within (-π, π]: turning a room a full circle must not read as rotated in the
      // game, which only clips the room shell's front wall when it faces the camera.
      const rotation = { x: euler.x, y: wrapAngle(euler.y), z: euler.z };
      // A zero or negative scale makes a model vanish (unclickable) or turn inside out, and
      // repeated scale drags compound towards zero.
      node.scaling.set(
        Math.max(MIN_SCALE, Math.abs(node.scaling.x)),
        Math.max(MIN_SCALE, Math.abs(node.scaling.y)),
        Math.max(MIN_SCALE, Math.abs(node.scaling.z)),
      );
      const scale = { x: node.scaling.x, y: node.scaling.y, z: node.scaling.z };
      const data = roundPlacement({ ...visual.data, position, rotation, scale });
      visual.data = data;
      visual.footprint = null;
      updates.push(data);
    }
    if (updates.length === 0) return;
    const updated = new Map(updates.map((entry) => [entry.id, entry]));
    this.currentMap = {
      ...this.currentMap,
      objects: this.currentMap.objects.map((entry: MapPlacedObject) => updated.get(entry.id) ?? entry),
      updatedAt: Date.now(),
    };
    this.wallsDirty = true;
    this.bump();
  }

  /**
   * Brings the visuals in line with `currentMap`: drops removed objects, re-applies moved or
   * recoloured ones in place, and spawns new ones in parallel batches with progress.
   */
  private async refresh(): Promise<void> {
    const version = ++this.refreshVersion;
    const byId = new Map(this.currentMap.objects.map(object => [object.id, object]));
    for (const [id, visual] of this.visuals) {
      const data = byId.get(id);
      if (!data) {
        this.disposeVisual(visual);
        this.visuals.delete(id);
        continue;
      }
      if (data === visual.data) continue;
      // Every edit makes a new object, so identity alone would reload the GLB on each gizmo
      // nudge and each robot checkbox. Rebuild only when the model itself changed.
      if (!isVisualPreservingChange(visual.data, data)) {
        this.disposeVisual(visual);
        this.visuals.delete(id);
        continue;
      }
      // Never fight a live gizmo: mid-drag the node is authoritative, not the map.
      if (!this.gizmoDragging && hasTransformChange(visual.data, data)) {
        this.applyTransform(visual.root, data);
        visual.footprint = null;
      }
      if (hasColorChange(visual.data, data) && visual.instance) {
        applyColorOverrides(visual.instance.rootNodes, data.colors, this.colorCache);
      }
      visual.data = data;
    }
    for (const id of [...this.selectionIds]) if (!byId.has(id)) this.selectionIds.delete(id);
    this.wallsDirty = true;
    this.refreshSelectionHighlights();

    const missing = this.currentMap.objects.filter(object => !this.visuals.has(object.id));
    const BATCH = 12;
    for (let index = 0; index < missing.length; index += BATCH) {
      if (this.disposed || version !== this.refreshVersion) return;
      this.loadingProgress = index / missing.length;
      this.bump();
      const batch = missing.slice(index, index + BATCH);
      const spawned = await Promise.all(batch.map(object => this.spawnObject(object)));
      if (this.disposed || version !== this.refreshVersion) {
        for (const visual of spawned) this.disposeVisual(visual);
        return;
      }
      for (const visual of spawned) {
        // An undo mid-load may already have spawned it, or removed it again.
        if (this.visuals.has(visual.data.id) || !byId.has(visual.data.id)) this.disposeVisual(visual);
        else this.visuals.set(visual.data.id, visual);
      }
      this.wallsDirty = true;
    }
    this.loadingProgress = 1;
    this.refreshSelectionHighlights();
  }

  /** Writes a placement's transform onto its node, without touching the model. */
  private applyTransform(root: TransformNode, object: MapPlacedObject): void {
    root.position.copyFromFloats(object.position.x, object.position.y, object.position.z);
    // A gizmo rotation leaves a quaternion behind, which would win over the euler below.
    root.rotationQuaternion = null;
    root.rotation.copyFromFloats(object.rotation.x, object.rotation.y, object.rotation.z);
    root.scaling.copyFromFloats(object.scale.x, object.scale.y, object.scale.z);
  }

  private async spawnObject(object: MapPlacedObject): Promise<EditorObjectVisual> {
    const root = new TransformNode(`editor-obj-${object.id}`, this.scene);
    if (object.id.startsWith("preview-")) root.setEnabled(false);
    this.applyTransform(root, object);
    const body = new TransformNode(`editor-body-${object.id}`, this.scene);
    body.parent = root;
    let instance: ModelInstance | null = null;
    let proxy: Mesh | null = createBuildingMesh(object.assetId, this.scene, body, object.color);
    try {
      if (!proxy) instance = await this.assets.instantiateModel(object.assetId, {
        namePrefix: `editor-${object.id}-`,
        parent: body,
        cloneMaterials: false,
      });
    } catch (error) {
      console.warn(`Editor could not instantiate ${object.assetId}`, error);
    }
    if (!instance && !proxy) {
      proxy = MeshBuilder.CreateBox(`editor-proxy-${object.id}`, { size: 0.9 }, this.scene);
      proxy.parent = body;
      const proxyMaterial = new StandardMaterial(`editor-proxy-material-${object.id}`, this.scene);
      proxyMaterial.diffuseColor = Color3.FromHexString(object.color ?? "#8da7c8");
      proxyMaterial.emissiveColor = Color3.FromHexString(object.color ?? "#1b2c44");
      proxyMaterial.specularColor = new Color3(0.05, 0.05, 0.1);
      proxy.material = proxyMaterial;
      proxy.onDisposeObservable.addOnce(() => proxyMaterial.dispose());
    }
    if (instance && object.colors) applyColorOverrides(instance.rootNodes, object.colors, this.colorCache);
    for (const mesh of root.getChildMeshes()) {
      mesh.isPickable = true;
      mesh.metadata = { objectId: object.id };
    }
    const visual: EditorObjectVisual = {
      data: object,
      root,
      body,
      instance,
      proxy,
      isWall: isWallAsset(object.assetId, object.category),
      isFloor: isFloorAsset(object.assetId),
      lowered: false,
      clip: null,
      footprint: null,
    };
    if (object.assetId === "scenario-room-wide") {
      // Scene clip planes are global, so one is set only while the shell itself draws.
      for (const mesh of root.getChildMeshes()) {
        if (!(mesh instanceof Mesh)) continue;
        let previous: Plane | null = null;
        mesh.onBeforeRenderObservable.add(() => {
          if (!visual.clip) return;
          previous = this.scene.clipPlane;
          this.scene.clipPlane = visual.clip;
        });
        mesh.onAfterRenderObservable.add(() => {
          if (visual.clip) this.scene.clipPlane = previous;
        });
      }
    }
    return visual;
  }

  private disposeVisual(visual: EditorObjectVisual): void {
    for (const mesh of visual.root.getChildMeshes()) {
      if (mesh instanceof Mesh) this.highlight.removeMesh(mesh);
    }
    visual.instance?.dispose();
    visual.proxy?.dispose();
    visual.root.dispose(false, false);
  }

  // ---------------------------------------------------------------------------------------
  // Selection, hover and highlight

  private refreshSelectionHighlights(): void {
    this.highlight.removeAllMeshes();
    const outlined = this.selectionIds.size <= OUTLINE_LIMIT;
    for (const visual of this.visuals.values()) {
      const selected = this.selectionIds.has(visual.data.id);
      for (const mesh of visual.root.getChildMeshes()) {
        mesh.renderOverlay = selected && !outlined;
        mesh.overlayColor = SELECTION_COLOR;
        mesh.overlayAlpha = 0.35;
        if (selected && outlined && mesh instanceof Mesh && mesh.getTotalVertices() > 0) {
          this.highlight.addMesh(mesh, SELECTION_COLOR);
        }
      }
    }
    if (this.hoverId && !this.selectionIds.has(this.hoverId)) this.outlineHover(this.hoverId, true);
    this.refreshGizmo();
    this.bump();
  }

  private outlineHover(id: string, on: boolean): void {
    const visual = this.visuals.get(id);
    if (!visual) return;
    for (const mesh of visual.root.getChildMeshes()) {
      if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
      if (on) this.highlight.addMesh(mesh, HOVER_COLOR);
      else this.highlight.removeMesh(mesh);
    }
  }

  private setHover(id: string | null): void {
    if (id === this.hoverId) return;
    if (this.hoverId && !this.selectionIds.has(this.hoverId)) this.outlineHover(this.hoverId, false);
    this.hoverId = id;
    if (id && !this.selectionIds.has(id)) this.outlineHover(id, true);
    const pointerTools: EditorTool[] = ["select", "design"];
    if (pointerTools.includes(this.currentTool)) this.canvas.style.cursor = id ? "pointer" : "";
  }

  private refreshGizmo(): void {
    this.positionGizmo.attachedNode = null;
    if (this.selectionIds.size === 0 || this.currentTool !== "select" || this.gizmoMode !== "position") return;
    const center = this.selectionCenter();
    this.selectionPivot.position.copyFrom(center);
    this.positionGizmo.attachedNode = this.selectionPivot;
  }

  /** Euler angles are what the map stores; a gizmo may have left a quaternion behind. */
  private useEuler(node: TransformNode): void {
    if (!node.rotationQuaternion) return;
    node.rotation.copyFrom(node.rotationQuaternion.toEulerAngles());
    node.rotationQuaternion = null;
  }

  private selectionCenter(): Vector3 {
    const center = Vector3.Zero();
    let count = 0;
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      center.addInPlace(root.position);
      count += 1;
    }
    return count > 0 ? center.scaleInPlace(1 / count) : center;
  }

  private pickObjectId(x: number, y: number): string | null {
    const pick = this.scene.pick(x, y, mesh => Boolean(mesh.metadata?.objectId) && mesh.isPickable && mesh.isEnabled());
    return (pick?.pickedMesh?.metadata?.objectId as string | undefined) ?? null;
  }

  // ---------------------------------------------------------------------------------------
  // Walls views

  private updateWalls(): void {
    const target = this.camera.target;
    const position = this.camera.position;
    const cameraKey = this.wallMode === "cutaway"
      ? `${target.x.toFixed(1)},${target.z.toFixed(1)},${this.camera.alpha.toFixed(2)},${this.camera.beta.toFixed(2)}`
      : this.wallMode;
    if (!this.wallsDirty && cameraKey === this.wallCameraKey) return;
    this.wallsDirty = false;
    this.wallCameraKey = cameraKey;
    const targetPoint = { x: target.x, z: target.z };
    const cameraPoint = { x: position.x, z: position.z };
    for (const visual of this.visuals.values()) {
      if (!visual.isWall) continue;
      const shell = visual.data.assetId === "scenario-room-wide";
      if (shell) {
        // The game cuts the shell's front wall (see placementsFromMap in KitchenEnvironment);
        // the cutaway view shows the room the way it will be played.
        const { position, rotation, scale } = visual.data;
        visual.clip = this.wallMode === "cutaway" && Math.abs(wrapAngle(rotation.y)) < 0.01
          ? new Plane(0, 0, -1, position.z - 6 * scale.z + 2.2)
          : null;
      }
      const lowered = this.wallMode === "down" ||
        (this.wallMode === "cutaway" && !shell && !this.selectionIds.has(visual.data.id) &&
          isWallCutAway({ x: visual.root.position.x, z: visual.root.position.z }, targetPoint, cameraPoint));
      if (lowered === visual.lowered) continue;
      visual.lowered = lowered;
      visual.body.scaling.y = lowered ? LOWERED_WALL_SCALE : 1;
    }
  }

  // ---------------------------------------------------------------------------------------
  // Camera

  private updateCamera(deltaSeconds: number): void {
    if (isTypingTarget(document.activeElement)) this.cameraKeys.clear();
    const keys = this.cameraKeys;
    const axis = (...pairs: [string, string][]): number => {
      let value = 0;
      for (const [positive, negative] of pairs) value += Number(keys.has(positive)) - Number(keys.has(negative));
      return Math.max(-1, Math.min(1, value));
    };
    const fast = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 2.5 : 1;
    const forward = axis(["KeyW", "KeyS"], ["ArrowUp", "ArrowDown"]);
    const strafe = axis(["KeyD", "KeyA"], ["ArrowRight", "ArrowLeft"]);
    if (forward || strafe) {
      const speed = this.desired.radius * 0.9 * fast * deltaSeconds;
      const f = { x: -Math.cos(this.desired.alpha), z: -Math.sin(this.desired.alpha) };
      // Screen right, left-handed: (f.z, -f.x).
      this.desired.target.x += (f.x * forward + f.z * strafe) * speed;
      this.desired.target.z += (f.z * forward - f.x * strafe) * speed;
    }
    const turn = axis(["KeyE", "KeyQ"]);
    if (turn) this.desired.alpha += turn * 1.8 * deltaSeconds;
    const zoom = axis(["KeyX", "KeyZ"]);
    if (zoom) this.desired.radius *= 1 + zoom * 1.4 * deltaSeconds;

    this.clampDesired();
    const ease = 1 - Math.exp(-12 * deltaSeconds);
    const camera = this.camera;
    camera.alpha += (this.desired.alpha - camera.alpha) * ease;
    camera.beta += (this.desired.beta - camera.beta) * ease;
    camera.radius += (this.desired.radius - camera.radius) * ease;
    const target = camera.target.clone();
    target.addInPlace(this.desired.target.subtract(target).scaleInPlace(ease));
    camera.setTarget(target);
  }

  private clampDesired(): void {
    const target = this.desired.target;
    target.x = Math.max(-CAMERA_TARGET_LIMIT, Math.min(CAMERA_TARGET_LIMIT, target.x));
    target.z = Math.max(-CAMERA_TARGET_LIMIT, Math.min(CAMERA_TARGET_LIMIT, target.z));
    target.y = 0;
    this.desired.radius = Math.max(MIN_RADIUS, Math.min(MAX_RADIUS, this.desired.radius));
    const top = this.desired.beta <= TOP_VIEW_BETA + 1e-3;
    this.desired.beta = top ? TOP_VIEW_BETA : Math.max(MIN_BETA, Math.min(MAX_BETA, this.desired.beta));
  }

  private frameSelection(): void {
    if (this.selectionIds.size === 0) return;
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      const bounds = root.getHierarchyBoundingVectors(true);
      min.minimizeInPlace(bounds.min);
      max.maximizeInPlace(bounds.max);
    }
    if (!Number.isFinite(min.x)) return;
    const center = min.add(max).scaleInPlace(0.5);
    this.desired.target.set(center.x, 0, center.z);
    this.desired.radius = Math.max(6, Math.min(45, max.subtract(min).length() * 1.4 + 4));
    this.bump();
  }

  // ---------------------------------------------------------------------------------------
  // Pointer

  private pointerCoordinates(event: MouseEvent): { x: number; y: number } {
    const engine = this.scene.getEngine();
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * engine.getRenderWidth() * engine.getHardwareScalingLevel() / rect.width,
      y: (event.clientY - rect.top) * engine.getRenderHeight() * engine.getHardwareScalingLevel() / rect.height,
    };
  }

  private handleMouse(event: Event): void {
    if (this.disposed || !(event instanceof PointerEvent || event instanceof WheelEvent)) return;
    if (event.type === "pointerup" || event.type === "pointercancel") {
      this.handlePointerUp(event as PointerEvent);
      return;
    }
    if (event.target instanceof HTMLElement && event.target.closest("[data-editor-chrome]")) {
      if (this.preview && !this.buildDrag) this.preview.root.setEnabled(false);
      if (this.pickIndicator) this.pickIndicator.isVisible = false;
      this.setHover(null);
      return;
    }
    event.preventDefault();
    if (event instanceof WheelEvent) {
      const factor = Math.pow(1.0015, Math.max(-300, Math.min(300, event.deltaY)));
      this.desired.radius *= factor;
      return;
    }
    const { x, y } = this.pointerCoordinates(event);
    if (event.type === "pointerdown") {
      this.handlePointerDown(event, x, y);
    } else if (event.type === "pointermove") {
      this.handlePointerMove(event, x, y);
    }
  }

  private handlePointerDown(event: PointerEvent, x: number, y: number): void {
    this.lastPointerX = x;
    this.lastPointerY = y;
    this.altHeld = event.altKey;
    if (event.button === 2 || event.button === 1 || (event.button === 0 && event.shiftKey && this.currentTool === "select")) {
      this.canvas.setPointerCapture(event.pointerId);
      this.orbiting = event.button === 2;
      this.isDragPanning = !this.orbiting;
      return;
    }
    if (event.button !== 0 || this.gizmoDragging || this.utilityLayer.utilityLayerScene.pick(x, y)?.hit) return;

    switch (this.currentTool) {
      case "place": {
        if (!this.currentAsset) return;
        const point = this.pickPlacement(x, y);
        if (point) this.tryPlaceAt(point);
        return;
      }
      case "wall":
      case "floor": {
        if (!this.currentAsset || !this.preview) return;
        const point = this.pickGround(x, y, false);
        if (!point) return;
        this.canvas.setPointerCapture(event.pointerId);
        this.buildDrag = { kind: this.currentTool, start: { x: point.x, z: point.z }, step: this.pieceSize(), pieces: [] };
        this.updateBuildDrag(point);
        return;
      }
      case "eyedropper": {
        const id = this.pickObjectId(x, y);
        if (!id) return;
        this.selectObject(id, false);
        const label = this.startCopying();
        if (label) this.callbacks.onNotice?.(`Conta-gotas: colocando cópias de "${label}"`, "info");
        return;
      }
      case "design": {
        const id = this.pickObjectId(x, y);
        if (id) this.selectObject(id, event.ctrlKey || event.metaKey);
        return;
      }
      case "erase": {
        const id = this.pickObjectId(x, y);
        if (id) {
          this.selectObject(id, false);
          this.deleteSelected();
          return;
        }
        this.marquee = { x: event.clientX, y: event.clientY, additive: false, erase: true, element: null };
        return;
      }
      default:
        this.selectPointerDown(event, x, y);
    }
  }

  private selectPointerDown(event: PointerEvent, x: number, y: number): void {
    const id = this.pickObjectId(x, y);
    const additive = event.ctrlKey || event.metaKey;
    if (!id) {
      // A click on empty space clears the selection; a drag draws a selection box.
      this.marquee = { x: event.clientX, y: event.clientY, additive, erase: false, element: null };
      return;
    }
    // Floors and room shells cover the whole stage: dragging on one draws a selection box
    // instead of dragging the room, and a plain click still selects it.
    const picked = this.visuals.get(id);
    if ((picked?.isFloor || picked?.data.category === "room") && !this.selectionIds.has(id)) {
      this.marquee = { x: event.clientX, y: event.clientY, additive, erase: false, element: null, clickId: id };
      return;
    }
    if (!this.selectionIds.has(id) || additive) this.selectObject(id, additive);
    if (!this.selectionIds.has(id)) return;
    if (this.gizmoMode === "position") {
      this.checkpoint();
      this.dragPoint = this.pickGround(x, y, false);
    } else if (this.gizmoMode === "rotation") {
      this.beginRotate(x, y);
    } else {
      this.beginScale(y);
    }
  }

  private handlePointerMove(event: PointerEvent, x: number, y: number): void {
    const dx = x - this.lastPointerX;
    const dy = y - this.lastPointerY;
    this.lastPointerX = x;
    this.lastPointerY = y;
    this.altHeld = event.altKey;
    if (this.orbiting) {
      this.desired.alpha -= dx * 0.006;
      if (!this.isTopView()) this.desired.beta -= dy * 0.005;
      return;
    }
    if (this.isDragPanning) {
      const scale = this.camera.radius * 0.0016;
      const f = { x: -Math.cos(this.camera.alpha), z: -Math.sin(this.camera.alpha) };
      this.desired.target.x += (-dx * f.z + dy * f.x) * scale;
      this.desired.target.z += (dx * f.x + dy * f.z) * scale;
      return;
    }
    if (this.buildDrag) {
      const point = this.pickGround(x, y, false);
      if (point) this.updateBuildDrag(point);
      return;
    }
    if (this.dragPoint && !this.gizmoDragging) {
      this.dragSelection(x, y);
      return;
    }
    if (this.rotateDrag) { this.updateRotate(x, y); return; }
    if (this.scaleDrag) { this.updateScale(y); return; }
    if (this.marquee) { this.updateMarquee(event); return; }
    this.updatePointerFeedback(x, y);
  }

  private handlePointerUp(event: PointerEvent): void {
    if (this.buildDrag) {
      this.commitBuildDrag();
    }
    if (this.dragPoint || this.rotateDrag || this.scaleDrag) {
      this.commitGizmoChange();
      this.dropCheckpointIfUnchanged();
      this.refreshGizmo();
    }
    this.dragPoint = null;
    this.rotateDrag = null;
    this.scaleDrag = null;
    if (this.marquee) this.finishMarquee(event);
    this.isDragPanning = false;
    this.orbiting = false;
  }

  /** Hover outline, the placement ghost and its green/red verdict. */
  private updatePointerFeedback(x: number, y: number): void {
    const hoverTools: EditorTool[] = ["select", "design", "eyedropper", "erase"];
    this.setHover(hoverTools.includes(this.currentTool) ? this.pickObjectId(x, y) : null);

    const placing = this.currentTool === "place" || this.currentTool === "wall" || this.currentTool === "floor";
    const point = placing && this.currentAsset ? this.pickPlacement(x, y) : null;
    if (this.preview) {
      this.preview.root.setEnabled(Boolean(point));
      if (point) this.preview.root.position.copyFrom(point);
    }
    const issue = point && this.currentTool === "place" ? this.placementIssueAt(point) : null;
    if (issue !== this.placementIssue) {
      this.placementIssue = issue;
      this.bump();
    }
    const tint = issue ? INVALID_COLOR : VALID_COLOR;
    if (this.preview) {
      for (const mesh of this.preview.root.getChildMeshes()) {
        mesh.renderOverlay = true;
        mesh.overlayColor = tint;
        mesh.overlayAlpha = 0.28;
      }
    }
    if (this.pickIndicator) {
      this.pickIndicator.isVisible = Boolean(point);
      if (point) this.pickIndicator.position.set(point.x, point.y + 0.03, point.z);
      (this.pickIndicator.material as StandardMaterial).emissiveColor = tint;
    }
  }

  private dragSelection(x: number, y: number): void {
    const point = this.pickGround(x, y, false);
    if (!point || !this.dragPoint) return;
    const delta = point.subtract(this.dragPoint);
    const snap = this.snap && !this.altHeld;
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      root.position.addInPlace(delta);
    }
    this.dragPoint = point;
    // Snap the result, not just the step, by moving the lead object onto the grid and the
    // rest by the same amount: a group keeps its shape, and lands aligned.
    if (snap) {
      const lead = this.visuals.get([...this.selectionIds][0] ?? "")?.root;
      if (lead) {
        const offsetX = snapTo(lead.position.x, GRID_STEP) - lead.position.x;
        const offsetZ = snapTo(lead.position.z, GRID_STEP) - lead.position.z;
        if (offsetX || offsetZ) {
          for (const id of this.selectionIds) {
            const root = this.visuals.get(id)?.root;
            if (root) { root.position.x += offsetX; root.position.z += offsetZ; }
          }
          this.dragPoint.x += offsetX;
          this.dragPoint.z += offsetZ;
        }
      }
    }
    this.commitGizmoChange();
  }

  private beginRotate(x: number, y: number): void {
    const point = this.pickGround(x, y, false);
    if (!point) return;
    const pivot = this.selectionCenter();
    this.checkpoint();
    const start = new Map<string, { y: number; x: number; z: number }>();
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      this.useEuler(root);
      start.set(id, { y: root.rotation.y, x: root.position.x, z: root.position.z });
    }
    this.rotateDrag = { pivot, startAngle: Math.atan2(point.x - pivot.x, point.z - pivot.z), start };
  }

  private updateRotate(x: number, y: number): void {
    const drag = this.rotateDrag;
    const point = drag ? this.pickGround(x, y, false) : null;
    if (!drag || !point) return;
    let delta = Math.atan2(point.x - drag.pivot.x, point.z - drag.pivot.z) - drag.startAngle;
    if (this.snap && !this.altHeld) delta = Math.round(delta / SNAP_ROTATION) * SNAP_ROTATION;
    const turn = Matrix.RotationY(delta);
    for (const [id, start] of drag.start) {
      const root = this.visuals.get(id)?.root;
      if (!root) continue;
      root.rotation.y = start.y + delta;
      // The group turns about its centre, as the comment on `rotateDrag` promises.
      if (drag.start.size > 1) {
        const offset = Vector3.TransformCoordinates(new Vector3(start.x - drag.pivot.x, 0, start.z - drag.pivot.z), turn);
        root.position.x = drag.pivot.x + offset.x;
        root.position.z = drag.pivot.z + offset.z;
      }
    }
    this.commitGizmoChange();
  }

  private beginScale(y: number): void {
    this.checkpoint();
    const start = new Map<string, Vector3>();
    for (const id of this.selectionIds) {
      const root = this.visuals.get(id)?.root;
      if (root) start.set(id, root.scaling.clone());
    }
    this.scaleDrag = { startY: y, start };
  }

  private updateScale(y: number): void {
    const drag = this.scaleDrag;
    if (!drag) return;
    let factor = Math.exp((drag.startY - y) * 0.006);
    if (this.snap && !this.altHeld) factor = Math.round(factor * 10) / 10;
    factor = Math.max(0.1, Math.min(10, factor));
    for (const [id, scaling] of drag.start) {
      const root = this.visuals.get(id)?.root;
      if (root) root.scaling.copyFrom(scaling.scale(factor));
    }
    this.commitGizmoChange();
  }

  private updateMarquee(event: PointerEvent): void {
    const box = this.marquee;
    if (!box) return;
    const width = Math.abs(event.clientX - box.x);
    const height = Math.abs(event.clientY - box.y);
    if (!box.element && width + height < 6) return;
    if (!box.element) {
      box.element = document.createElement("div");
      box.element.className = "bm-marquee";
      box.element.dataset.erase = String(box.erase);
      document.body.append(box.element);
    }
    box.element.style.left = `${Math.min(event.clientX, box.x)}px`;
    box.element.style.top = `${Math.min(event.clientY, box.y)}px`;
    box.element.style.width = `${width}px`;
    box.element.style.height = `${height}px`;
  }

  /** Selects (or, with the sledgehammer, deletes) every object whose centre is in the box. */
  private finishMarquee(event: PointerEvent): void {
    const box = this.marquee;
    this.marquee = null;
    if (!box) return;
    if (!box.element) {
      if (box.clickId) this.selectObject(box.clickId, box.additive);
      else if (!box.additive && !box.erase) this.clearSelection();
      return;
    }
    box.element.remove();
    const left = Math.min(event.clientX, box.x);
    const right = Math.max(event.clientX, box.x);
    const top = Math.min(event.clientY, box.y);
    const bottom = Math.max(event.clientY, box.y);
    const engine = this.scene.getEngine();
    const camera = this.scene.activeCamera;
    if (!camera) return;
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    const viewport = camera.viewport.toGlobal(width, height);
    const transform = this.scene.getTransformMatrix();
    const rect = this.canvas.getBoundingClientRect();
    const inside: string[] = [];
    for (const [id, visual] of this.visuals) {
      // The room shell's centre is inside almost any box; it is selected by clicking it.
      if (visual.data.assetId === "scenario-room-wide") continue;
      const projected = Vector3.Project(visual.root.getAbsolutePosition(), Matrix.IdentityReadOnly, transform, viewport);
      if (projected.z < 0 || projected.z > 1) continue;
      const screenX = rect.left + (projected.x * rect.width) / width;
      const screenY = rect.top + (projected.y * rect.height) / height;
      if (screenX >= left && screenX <= right && screenY >= top && screenY <= bottom) inside.push(id);
    }
    if (box.erase) {
      if (inside.length === 0) return;
      this.selectionIds.clear();
      for (const id of inside) this.selectionIds.add(id);
      this.deleteSelected();
      this.callbacks.onNotice?.(`${inside.length} objeto(s) apagado(s) · Ctrl+Z desfaz`, "warning");
      return;
    }
    if (!box.additive) this.selectionIds.clear();
    for (const id of inside) this.selectionIds.add(id);
    this.refreshSelectionHighlights();
  }

  // ---------------------------------------------------------------------------------------
  // Placement

  private tryPlaceAt(point: Vector3): void {
    const issue = this.placementIssueAt(point);
    if (issue) {
      this.callbacks.onNotice?.(issue === "outside" ? "Fora do lote de construção" : "Não cabe aqui: sobreposto a outro objeto", "warning");
      return;
    }
    this.placeAt(point);
  }

  private placeAt(point: Vector3): void {
    if (!this.currentAsset) return;
    this.checkpoint();
    const created = this.copyTemplate
      ? roundPlacement({
        ...structuredClone(this.copyTemplate),
        id: generateObjectId(),
        position: { x: point.x, y: point.y, z: point.z },
        rotation: { ...this.copyTemplate.rotation, y: this.placementRotation },
      })
      : { ...createPlacedObject(this.currentAsset, point), rotation: { x: 0, y: this.placementRotation, z: 0 } };
    const objects = created.role === "spawn"
      ? [...this.currentMap.objects.filter(object => object.playerIndex !== created.playerIndex), created]
      : [...this.currentMap.objects, created];
    this.currentMap = { ...this.currentMap, objects, updatedAt: Date.now() };
    // Keep placing: the new object is not selected, so the next click places again.
    void this.refresh();
  }

  /** Why the ghost may not go down at `point`, or null. */
  private placementIssueAt(point: Vector3): PlacementIssue {
    const preview = this.preview;
    if (!preview) return null;
    preview.root.position.copyFrom(point);
    const candidate = this.footprintOf(preview, true);
    if (!candidate) return null;
    // Set on top of something, or deliberately raised: overlap is the point.
    const stacked = point.y > 0.05;
    const kind = this.currentAsset;
    const ignoresOverlap = this.allowOverlap || stacked || !kind ||
      isFloorAsset(kind.assetId) || kind.role === "spawn" || kind.category === "room";
    const others: Footprint[] = [];
    if (!ignoresOverlap) {
      for (const visual of this.visuals.values()) {
        if (visual.isFloor || visual.data.assetId === "scenario-room-wide" || visual.data.role === "spawn") continue;
        // Anything raised off the floor (a lamp on a table) is not in the way at ground level.
        if (visual.data.position.y > 0.05) continue;
        const footprint = this.footprintOf(visual, false);
        if (footprint) others.push(footprint);
      }
    }
    return placementProblem(candidate, others);
  }

  private footprintOf(visual: EditorObjectVisual, fresh: boolean): Footprint | null {
    if (visual.footprint && !fresh) return visual.footprint;
    visual.root.computeWorldMatrix(true);
    const wasEnabled = visual.root.isEnabled(false);
    // A disabled ghost still has geometry; bounds need it enabled for a moment.
    if (!wasEnabled) visual.root.setEnabled(true);
    const { min, max } = visual.root.getHierarchyBoundingVectors(true);
    if (!wasEnabled) visual.root.setEnabled(false);
    if (!Number.isFinite(min.x)) return null;
    const footprint = { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z };
    if (!fresh) visual.footprint = footprint;
    return footprint;
  }

  private pickGround(x: number, y: number, snap = this.snap && !this.altHeld): Vector3 | null {
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), this.scene.activeCamera);
    const distance = ray.intersectsPlane(new Plane(0, 1, 0, 0));
    if (distance === null || distance < 0) return null;
    const point = ray.origin.add(ray.direction.scale(distance));
    if (snap) { point.x = snapTo(point.x, GRID_STEP); point.z = snapTo(point.z, GRID_STEP); }
    return point;
  }

  private pickPlacement(x: number, y: number): Vector3 | null {
    const surface = this.surfacePlacement
      ? this.scene.pick(x, y, mesh => Boolean(mesh.metadata?.objectId) && mesh.isPickable && mesh.isEnabled())?.pickedPoint
      : null;
    const point = surface?.clone() ?? this.pickGround(x, y);
    if (!point) return null;
    if (this.snap && !this.altHeld) { point.x = snapTo(point.x, GRID_STEP); point.z = snapTo(point.z, GRID_STEP); }
    // A copy stays at its original's height unless it is set down on whatever is under it.
    if (this.copyTemplate && !surface) point.y = this.copyTemplate.position.y;
    point.y += this.placementHeight;
    return point;
  }

  private async createPreview(): Promise<void> {
    const version = ++this.previewVersion;
    this.disposeGhosts();
    if (this.preview) this.disposeVisual(this.preview);
    this.preview = null;
    if (!this.currentAsset) return;
    const data = this.copyTemplate
      ? { ...structuredClone(this.copyTemplate), position: { x: 0, y: 0, z: 0 } }
      : createPlacedObject(this.currentAsset, Vector3.Zero());
    const visual = await this.spawnObject({ ...data, id: `preview-${version}` });
    if (this.disposed || version !== this.previewVersion) { this.disposeVisual(visual); return; }
    for (const mesh of visual.root.getChildMeshes()) {
      mesh.isPickable = false;
      mesh.visibility = 0.55;
      mesh.metadata = null;
    }
    visual.root.rotation.y = this.placementRotation;
    visual.root.setEnabled(false);
    this.preview = visual;
  }

  // ---------------------------------------------------------------------------------------
  // Wall and floor tools

  /** The preview's footprint at rotation 0, rounded to the grid: the step between pieces. */
  private pieceSize(): { x: number; z: number } {
    const preview = this.preview;
    if (!preview) return { x: 1, z: 1 };
    const rotation = preview.root.rotation.y;
    const position = preview.root.position.clone();
    preview.root.rotation.y = 0;
    preview.root.position.setAll(0);
    const footprint = this.footprintOf(preview, true);
    preview.root.rotation.y = rotation;
    preview.root.position.copyFrom(position);
    if (!footprint) return { x: 1, z: 1 };
    return { x: pieceStep(footprint.maxX - footprint.minX), z: pieceStep(footprint.maxZ - footprint.minZ) };
  }

  private updateBuildDrag(point: Vector3): void {
    const drag = this.buildDrag;
    if (!drag) return;
    const size = drag.step;
    const inLot = (piece: PiecePlacement): boolean =>
      Math.abs(piece.x) <= BUILD_LOT_HALF && Math.abs(piece.z) <= BUILD_LOT_HALF;
    // Like the Sims, nothing is built past the lot line.
    drag.pieces = (drag.kind === "wall"
      ? layoutWallRun(drag.start, { x: point.x, z: point.z }, size.x)
      : layoutFloorRect(drag.start, { x: point.x, z: point.z }, size.x, size.z)).filter(inLot);
    this.showGhosts(drag.pieces);
    this.callbacks.onNotice?.(
      drag.kind === "wall"
        ? `${drag.pieces.length} peça(s) · ${(drag.pieces.length * size.x).toFixed(2).replace(".", ",")} m`
        : `${drag.pieces.length} piso(s)`,
      "info",
    );
  }

  /** Instances of the ghost's meshes, one set per piece: cheap enough to redo every move. */
  private showGhosts(pieces: readonly PiecePlacement[]): void {
    const preview = this.preview;
    if (!preview) return;
    if (this.ghostSources.length === 0) {
      preview.root.setEnabled(true);
      preview.root.computeWorldMatrix(true);
      const inverseRoot = Matrix.Invert(preview.root.getWorldMatrix());
      for (const mesh of preview.root.getChildMeshes()) {
        if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0) continue;
        this.ghostSources.push({ mesh, local: mesh.computeWorldMatrix(true).multiply(inverseRoot) });
      }
      this.ghostPools = this.ghostSources.map(() => []);
    }
    // The source meshes hide; their instances still draw.
    for (const source of this.ghostSources) source.mesh.isVisible = false;
    if (this.pickIndicator) this.pickIndicator.isVisible = false;
    const scale = this.copyTemplate?.scale ?? this.currentAsset?.scale ?? { x: 1, y: 1, z: 1 };
    const scaling = new Vector3(scale.x, scale.y, scale.z);
    this.ghostSources.forEach((source, sourceIndex) => {
      const pool = this.ghostPools[sourceIndex]!;
      pieces.forEach((piece, pieceIndex) => {
        let ghost = pool[pieceIndex];
        if (!ghost) {
          ghost = source.mesh.createInstance(`${source.mesh.name}-ghost-${pieceIndex}`);
          // World matrices are frozen absolute; out of the preview so its bounds stay its own.
          ghost.parent = null;
          ghost.isPickable = false;
          pool.push(ghost);
        }
        ghost.setEnabled(true);
        const world = Matrix.Compose(
          scaling,
          Quaternion.RotationAxis(Vector3.Up(), piece.rotationY),
          new Vector3(piece.x, this.placementHeight, piece.z),
        );
        ghost.freezeWorldMatrix(source.local.multiply(world));
      });
      for (let index = pieces.length; index < pool.length; index += 1) pool[index]!.setEnabled(false);
    });
  }

  private disposeGhosts(): void {
    for (const pool of this.ghostPools) for (const ghost of pool) ghost.dispose();
    for (const source of this.ghostSources) if (!source.mesh.isDisposed()) source.mesh.isVisible = true;
    this.ghostPools = [];
    this.ghostSources = [];
  }

  private cancelBuildDrag(): void {
    this.buildDrag = null;
    this.disposeGhosts();
  }

  private commitBuildDrag(): void {
    const drag = this.buildDrag;
    this.buildDrag = null;
    this.disposeGhosts();
    const asset = this.currentAsset;
    if (!drag || !asset || drag.pieces.length === 0) return;
    // Redrawing over an existing run must not stack duplicate pieces on top of each other.
    const existing = new Set(this.currentMap.objects
      .filter(object => object.assetId === asset.assetId)
      .map(object => `${object.position.x.toFixed(2)}|${object.position.z.toFixed(2)}|${wrapAngle(object.rotation.y).toFixed(2)}`));
    const created: MapPlacedObject[] = [];
    for (const piece of drag.pieces) {
      const key = `${piece.x.toFixed(2)}|${piece.z.toFixed(2)}|${wrapAngle(piece.rotationY).toFixed(2)}`;
      if (existing.has(key)) continue;
      existing.add(key);
      const base = createPlacedObject(asset, new Vector3(piece.x, this.placementHeight, piece.z));
      created.push(roundPlacement({
        ...base,
        rotation: { x: 0, y: piece.rotationY, z: 0 },
        colors: this.copyTemplate?.assetId === asset.assetId ? this.copyTemplate.colors : undefined,
      }));
    }
    if (created.length === 0) return;
    this.checkpoint();
    this.currentMap = { ...this.currentMap, objects: [...this.currentMap.objects, ...created], updatedAt: Date.now() };
    this.callbacks.onNotice?.(`${created.length} peça(s) colocada(s) · Ctrl+Z desfaz`, "success");
    void this.refresh();
  }

  // ---------------------------------------------------------------------------------------
  // Keyboard

  private handleKey(event: Event): void {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.type === "keyup") {
      this.cameraKeys.delete(event.code);
      if (event.key === "Alt") this.altHeld = false;
      return;
    }
    if (isTypingTarget(event.target)) return;
    if (event.key === "Alt") {
      // Alt alone would focus the browser menu and swallow the next key.
      event.preventDefault();
      this.altHeld = true;
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    const cameraCodes = ["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyZ", "KeyX",
      "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"];
    if (!ctrl && !event.altKey && cameraCodes.includes(event.code)) {
      event.preventDefault();
      this.cameraKeys.add(event.code);
      return;
    }
    const handled = ctrl ? this.handleCtrlKey(event) : this.handlePlainKey(event);
    if (handled) event.preventDefault();
  }

  private handleCtrlKey(event: KeyboardEvent): boolean {
    switch (event.code) {
      case "KeyZ": this.undo(event.shiftKey); return true;
      case "KeyY": this.undo(true); return true;
      case "KeyD": this.duplicateSelected(); return true;
      case "KeyA": this.selectAll(); return true;
      case "KeyC": {
        const count = this.copySelection();
        if (count) this.callbacks.onNotice?.(`${count} objeto(s) copiado(s) · Ctrl+V cola`, "info");
        return true;
      }
      case "KeyV": this.pasteClipboard(); return true;
      default: return false;
    }
  }

  private handlePlainKey(event: KeyboardEvent): boolean {
    switch (event.key) {
      case "Delete":
      case "Backspace":
        this.deleteSelected();
        return true;
      case "Escape":
        if (this.buildDrag) this.cancelBuildDrag();
        else if (this.currentTool !== "select") { this.setTool("select"); this.setAsset(null); }
        else this.clearSelection();
        return true;
      case ",": case "<": case "[":
        this.rotateSelected(-1, event.shiftKey);
        return true;
      case ".": case ">": case "]":
        this.rotateSelected(1, event.shiftKey);
        return true;
      case "Home":
        this.resetCamera();
        return true;
      default:
        break;
    }
    switch (event.code) {
      case "Digit1": this.setGizmoMode("position"); return true;
      case "Digit2": this.setGizmoMode("rotation"); return true;
      case "Digit3": this.setGizmoMode("scale"); return true;
      case "KeyH": this.setTool("select"); this.setAsset(null); return true;
      case "KeyI": this.setTool("eyedropper"); this.setAsset(null); return true;
      case "KeyR": this.setTool("design"); this.setAsset(null); return true;
      case "KeyK": this.setTool("erase"); this.setAsset(null); return true;
      case "KeyV": this.cycleWallMode(); return true;
      case "KeyG": this.setGridVisible(!this.gridVisible); return true;
      case "KeyT": this.toggleTopView(); return true;
      case "KeyF": this.frameSelection(); return true;
      default: return false;
    }
  }
}
