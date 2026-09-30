import { CatalogThumbnails } from "./CatalogThumbnails";
import { mapRequirements } from "./validation";
import { confirmDialog, textDialog } from "../ui/confirmDialog";
import { packLabel } from "./packLabels";
import "../styles/editor.css";
import type { EditorTool, SelectionColors, WallMode } from "../scenes/EditorScene";
import type { MapData, MapMeta, MapPlacedObject, MapSlotSummary } from "./MapData";
import { EDITOR_ASSET_CATALOG, type EditorAssetEntry } from "./catalog";
import { sanitizeMapData } from "./MapStore";
import { DIFFICULTY_IDS, DIFFICULTY_PROFILES, isDifficultyId } from "../data/difficulty";
import { ROBOT_CLIPS, type RobotConfig } from "../data/robotConfig";
import { isFloorAsset, isWallAsset } from "../physics/collisionPolicy";

export interface EditorUIHandlers {
  onSave(name: string, meta: MapMeta, slotId?: string): string | null;
  onLoadSlot(slotId: string): Promise<boolean>;
  onDeleteSlot(slotId: string): boolean;
  onNewMap(name: string): void;
  onSetTool(tool: EditorTool): void;
  onSetAsset(asset: EditorAssetEntry | null): void;
  onSetGizmoMode(mode: "position" | "rotation" | "scale"): void;
  onDeleteSelected(): void;
  onDuplicateSelected(): void;
  /** Eyedropper on the selection: keep placing copies of it, one per click. */
  onCopySelected(): void;
  onSelectAll(): void;
  onClearSelection(): void;
  onPlay(): void;
  onPlacementOptions(snap: boolean, surface: boolean, height: number): void;
  onAllowOverlap(allow: boolean): void;
  onSetWallMode(mode: WallMode): void;
  onToggleGrid(): void;
  onToggleTopView(): void;
  onRotate(direction: number): void;
  onTransform(group: "position" | "rotation" | "scale", axis: "x" | "y" | "z", value: number): void;
  /** Patches the config of every selected robot. */
  onRobotConfig(patch: Partial<RobotConfig>): void;
  /** A colour being dragged in a picker: shown, not saved. */
  onColorPreview(material: string, hex: string | null): void;
  /** A colour chosen: saved as one undo step. Null restores the model's own. */
  onColorCommit(material: string, hex: string | null): void;
  onResetColors(): void;
  onUndo(redo: boolean): void;
  onClose(): void;
  listSlots(): MapSlotSummary[];
  /** Whether the working map differs from what was last saved or loaded. */
  hasUnsavedChanges(): boolean;
  /** The map as it stands, for exporting to a file. */
  getCurrentMap(): MapData | null;
  /** Replaces the working map with an imported one. */
  onImportMap(map: MapData): void;
}

/** Everything the chrome shows, read from the scene whenever its state version changes. */
export interface EditorViewState {
  readonly map: MapData;
  readonly selection: readonly MapPlacedObject[];
  readonly tool: EditorTool;
  readonly asset: EditorAssetEntry | null;
  readonly gizmo: "position" | "rotation" | "scale";
  readonly wallMode: WallMode;
  readonly gridVisible: boolean;
  readonly topView: boolean;
  readonly allowOverlap: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly hint: string;
  readonly loading: number;
  readonly colors: SelectionColors | null;
}

type Tone = "info" | "success" | "warning" | "error";

const createElement = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/** 24×24 line icons, drawn with `currentColor`. */
const ICONS: Readonly<Record<string, string>> = {
  menu: "M4 7h16M4 12h16M4 17h16",
  undo: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "m15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  select: "M5 3l13 8-6 1.5L9 19z",
  eyedropper: "m14 4 6 6M16 8l-9 9-3 1 1-3 9-9M13 5l6 6",
  design: "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5 1-1.5 2-1.5h2a4 4 0 0 0 4-4c0-4.5-4-8-9-8zM7.5 11.5h0M10 7.5h0M14.5 7.5h0",
  erase: "M14 4l6 6-3 3-6-6zM11 7 4 14l3 3h6l4-4M4 20h16",
  wall: "M3 6h18v12H3zM3 12h18M9 6v6M15 12v6",
  floor: "M3 9l9-5 9 5-9 5zM3 14l9 5 9-5",
  wallsUp: "M4 20V8h16v12M4 14h16",
  wallsCut: "M4 20v-6h7V8h9v12M4 17h16",
  wallsDown: "M4 20v-3h16v3",
  top: "M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  grid: "M4 4h16v16H4zM4 10h16M4 15h16M10 4v16M15 4v16",
  settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  help: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.8.4-1 1-1 1.7M12 17h0M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  play: "M7 4l13 8-13 8z",
  check: "m5 12 5 5 9-10",
  structure: "M4 20V9l8-5 8 5v11M9 20v-6h6v6",
  kitchen: "M5 11h14v9H5zM8 11V6a4 4 0 0 1 8 0v5M9 15h6",
  furniture: "M5 10h14v5H5zM7 15v4M17 15v4M7 10V6h10v4",
  equipment: "M4 7h16v12H4zM8 7V4h8v3M8 12h8M8 15h5",
  decor: "M12 21c-4-3-7-6-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4-3 7-7 10z",
  robot: "M8 8h8v8H8zM12 4v4M6 12H4M20 12h-2M10 11h0M14 11h0M10 14h4",
  spawn: "M12 21s-6-5.5-6-10a6 6 0 0 1 12 0c0 4.5-6 10-6 10zM12 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  all: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  rotate: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  duplicate: "M8 8h11v11H8zM5 16V5h11",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  close: "M6 6l12 12M18 6 6 18",
};

const icon = (name: string): string =>
  `<svg class="bm-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name] ?? ""}"/></svg>`;

interface CatalogTab {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly matches: (entry: EditorAssetEntry) => boolean;
}

const isStructure = (entry: EditorAssetEntry): boolean =>
  entry.category === "room" || isFloorAsset(entry.assetId) || isWallAsset(entry.assetId, entry.category);

const CATALOG_TABS: readonly CatalogTab[] = [
  { id: "all", label: "Tudo", icon: "all", matches: () => true },
  { id: "structure", label: "Estrutura", icon: "structure", matches: isStructure },
  { id: "kitchen", label: "Cozinha", icon: "kitchen", matches: (e) => e.role === "station" || e.role === "dispenser" },
  { id: "furniture", label: "Móveis", icon: "furniture", matches: (e) => e.role === "decor" && e.category === "storage" },
  { id: "equipment", label: "Equipamentos", icon: "equipment", matches: (e) => e.role === "decor" && ["machine", "screen", "pipe", "cable", "supply"].includes(e.category) },
  { id: "decor", label: "Decoração", icon: "decor", matches: (e) => e.role === "decor" && e.category === "decor" && !isStructure(e) },
  { id: "robot", label: "Robôs", icon: "robot", matches: (e) => e.role === "robot" },
  { id: "spawn", label: "Pontos de início", icon: "spawn", matches: (e) => e.role === "spawn" },
];

const STRUCTURE_FILTERS = [
  { id: "", label: "Tudo" },
  { id: "walls", label: "Paredes" },
  { id: "floors", label: "Pisos" },
  { id: "other", label: "Outros" },
] as const;

const TOOLS: readonly { tool: EditorTool; label: string; key: string; icon: string; title: string }[] = [
  { tool: "select", label: "Selecionar", key: "H", icon: "select", title: "Selecionar, mover e girar objetos" },
  { tool: "eyedropper", label: "Conta-gotas", key: "I", icon: "eyedropper", title: "Copiar um objeto da cena, com as cores" },
  { tool: "design", label: "Cores", key: "R", icon: "design", title: "Mudar as cores de um objeto" },
  { tool: "erase", label: "Marreta", key: "K", icon: "erase", title: "Apagar objetos (arraste para apagar uma área)" },
  { tool: "wall", label: "Parede", key: "", icon: "wall", title: "Arraste para desenhar paredes" },
  { tool: "floor", label: "Piso", key: "", icon: "floor", title: "Arraste para cobrir uma área com piso" },
];

const WALL_MODES: readonly { mode: WallMode; label: string; icon: string }[] = [
  { mode: "up", label: "Paredes em pé", icon: "wallsUp" },
  { mode: "cutaway", label: "Paredes em corte", icon: "wallsCut" },
  { mode: "down", label: "Paredes abaixadas", icon: "wallsDown" },
];

const PALETTE = [
  "#f4efe6", "#d9c7a7", "#a8744a", "#5b3a29", "#e84f4f", "#f2a93b",
  "#f6d84a", "#6fb35a", "#3f8f9f", "#3d6fd6", "#8e5bd6", "#2b2f36",
];

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["W A S D / setas", "Mover a câmera"],
  ["Q / E", "Girar a câmera"],
  ["Roda / Z X", "Aproximar e afastar"],
  ["Botão direito", "Orbitar · botão do meio: arrastar a vista"],
  ["T", "Vista de cima"],
  ["F", "Enquadrar a seleção · Home: câmera inicial"],
  ["V", "Paredes em pé / em corte / abaixadas"],
  ["G", "Mostrar a grade"],
  ["H I R K", "Selecionar · Conta-gotas · Cores · Marreta"],
  [", .", "Girar 45° (com Shift: 15°)"],
  ["Alt", "Colocar e mover fora da grade"],
  ["Ctrl+C / Ctrl+V", "Copiar e colar"],
  ["Ctrl+D", "Duplicar"],
  ["Ctrl+Z / Ctrl+Y", "Desfazer e refazer"],
  ["Delete", "Apagar a seleção"],
  ["Ctrl+S", "Salvar"],
  ["Esc", "Cancelar / soltar a ferramenta"],
  ["?", "Esta ajuda"],
];

/** First-render and step size of the catalogue strip; more cards append as it scrolls. */
const CATALOG_CHUNK = 120;

export class EditorUI {
  private readonly thumbnails = new CatalogThumbnails();
  private readonly thumbnailEntries = new WeakMap<HTMLImageElement, EditorAssetEntry>();
  private readonly thumbnailObserver: IntersectionObserver;
  private readonly shell: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly inspector: HTMLElement;
  private readonly inspectorBody: HTMLElement;
  private readonly slotList: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly toast: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly requirementsButton: HTMLButtonElement;
  private readonly requirementsList: HTMLElement;
  private readonly handlers: EditorUIHandlers;
  private readonly events = new AbortController();
  private currentSlotId = "";
  private slots: MapSlotSummary[] = [];
  private destroyed = false;
  private state: EditorViewState | null = null;
  private lastRequirementsMap: MapData | null = null;
  private inspectorKey = "";
  private catalogTab = "all";
  private structureFilter = "";
  private catalogPack = "";
  private search = "";
  private catalogMatches: EditorAssetEntry[] = [];
  private catalogRendered = 0;
  private activeColorSlot = "";
  private toastTimer = 0;

  constructor(
    host: HTMLElement,
    initialName: string,
    initialSlotId: string,
    initialSlots: MapSlotSummary[],
    handlers: EditorUIHandlers,
  ) {
    this.handlers = handlers;
    this.currentSlotId = initialSlotId;
    this.slots = initialSlots;
    this.shell = createElement("section", "bm");
    this.shell.dataset.editorOpen = "true";
    this.shell.setAttribute("aria-label", "Modo construção");
    this.shell.innerHTML = this.createMarkup();
    host.append(this.shell);

    this.strip = this.require("[data-catalog-strip]");
    this.inspector = this.require("[data-inspector]");
    this.inspectorBody = this.require("[data-inspector-body]");
    this.slotList = this.require("[data-slots]");
    this.nameInput = this.require<HTMLInputElement>("[data-map-name]");
    this.toast = this.require("[data-toast]");
    this.hint = this.require("[data-hint]");
    this.progress = this.require("[data-progress]");
    this.playButton = this.require<HTMLButtonElement>("[data-action='play']");
    this.requirementsButton = this.require<HTMLButtonElement>("[data-action='requirements']");
    this.requirementsList = this.require("[data-requirements]");
    this.nameInput.value = initialName;

    this.thumbnailObserver = new IntersectionObserver((entries) => {
      for (const visible of entries) {
        if (!visible.isIntersecting) continue;
        const image = visible.target as HTMLImageElement;
        const entry = this.thumbnailEntries.get(image);
        this.thumbnailObserver.unobserve(image);
        if (entry) this.loadThumbnail(image, entry);
      }
    }, { root: this.strip, rootMargin: "0px 240px" });

    this.populatePacks();
    this.bindTopbar();
    this.bindDock();
    this.bindKeys();
    this.renderTabs();
    this.renderCatalog();
    this.renderSlots();
  }

  // ---------------------------------------------------------------------------------------
  // Called by the controller

  /** Re-renders what changed since the last state; cheap to call on every state version. */
  sync(state: EditorViewState): void {
    if (this.destroyed) return;
    const previous = this.state;
    this.state = state;
    for (const button of this.shell.querySelectorAll<HTMLElement>("[data-tool]")) {
      button.dataset.active = String(button.dataset.tool === state.tool);
    }
    for (const button of this.shell.querySelectorAll<HTMLElement>("[data-wall-mode]")) {
      button.dataset.active = String(button.dataset.wallMode === state.wallMode);
    }
    for (const button of this.shell.querySelectorAll<HTMLElement>("[data-gizmo]")) {
      button.dataset.active = String(button.dataset.gizmo === state.gizmo);
    }
    this.require("[data-action='grid']").dataset.active = String(state.gridVisible);
    this.require("[data-action='top']").dataset.active = String(state.topView);
    this.require<HTMLInputElement>("[data-option='overlap']").checked = state.allowOverlap;
    this.require<HTMLButtonElement>("[data-action='undo']").disabled = !state.canUndo;
    this.require<HTMLButtonElement>("[data-action='redo']").disabled = !state.canRedo;
    this.hint.textContent = state.hint;
    this.progress.hidden = state.loading >= 1;
    this.progress.style.setProperty("--progress", `${Math.round(state.loading * 100)}%`);
    if (previous?.asset !== state.asset || previous?.tool !== state.tool) this.updateCatalogSelection();
    if (this.lastRequirementsMap !== state.map) this.syncRequirements(state.map);
    this.syncInspector(state);
  }

  setMap(map: MapData, slotId: string): void {
    this.currentSlotId = slotId;
    this.nameInput.value = map.name;
    // The level-settings form belongs to the map: without this it kept its defaults (or the
    // previous map's values) and the next save silently overwrote the map's own settings.
    this.setMeta(map);
    this.renderSlots();
  }

  setSlots(slots: MapSlotSummary[]): void {
    this.slots = slots;
    this.renderSlots();
  }

  setMapName(name: string): void {
    this.nameInput.value = name;
  }

  setCurrentSlot(slotId: string): void {
    this.currentSlotId = slotId;
    this.renderSlots();
  }

  getCurrentSlotId(): string {
    return this.currentSlotId;
  }

  notify(message: string, tone: Tone = "info"): void {
    if (this.destroyed) return;
    this.toast.textContent = message;
    this.toast.dataset.tone = tone;
    this.toast.dataset.visible = "true";
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toast.dataset.visible = "false"; }, tone === "error" ? 5000 : 2600);
  }

  /** Fills the level-settings form from a loaded or imported map. */
  setMeta(map: MapData): void {
    const description = this.require<HTMLTextAreaElement>("[data-meta='description']");
    const duration = this.require<HTMLInputElement>("[data-meta='duration']");
    const difficulty = this.require<HTMLSelectElement>("[data-meta='difficulty']");
    // Never clobber a field the designer is typing in.
    if (document.activeElement !== description) description.value = map.meta?.description ?? "";
    if (document.activeElement !== duration) duration.value = String(map.meta?.shiftDurationSeconds ?? 240);
    if (document.activeElement !== difficulty) difficulty.value = map.meta?.difficultyId ?? "standard";
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.toastTimer);
    this.events.abort();
    this.thumbnailObserver.disconnect();
    this.thumbnails.dispose();
    this.shell.remove();
  }

  // ---------------------------------------------------------------------------------------
  // Top bar: file, history, view, requirements, play

  private bindTopbar(): void {
    const signal = this.events.signal;
    const on = (selector: string, handler: () => void): void => {
      this.require(selector).addEventListener("click", handler, { signal });
    };
    on("[data-action='file']", () => this.togglePanel("file"));
    on("[data-action='save']", () => { this.saveCurrent(); this.togglePanel(null); });
    on("[data-action='save-as']", () => { this.saveAs(); this.togglePanel(null); });
    on("[data-action='new']", () => { this.togglePanel(null); void this.newMap(); });
    on("[data-action='import']", () => { this.togglePanel(null); this.importMap(); });
    on("[data-action='export']", () => { this.togglePanel(null); this.exportCurrent(); });
    on("[data-action='exit']", () => this.handlers.onClose());
    on("[data-action='undo']", () => this.handlers.onUndo(false));
    on("[data-action='redo']", () => this.handlers.onUndo(true));
    on("[data-action='grid']", () => this.handlers.onToggleGrid());
    on("[data-action='top']", () => this.handlers.onToggleTopView());
    on("[data-action='requirements']", () => this.togglePanel("requirements"));
    on("[data-action='settings']", () => this.togglePanel("settings"));
    on("[data-action='help']", () => this.togglePanel("help"));
    on("[data-action='close-help']", () => this.togglePanel(null));
    on("[data-action='close-settings']", () => this.togglePanel(null));
    on("[data-action='play']", () => {
      if (this.playButton.getAttribute("aria-disabled") === "true") {
        this.togglePanel("requirements");
        return;
      }
      if (this.saveCurrent()) this.handlers.onPlay();
    });
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>("[data-wall-mode]")) {
      button.addEventListener("click", () => this.handlers.onSetWallMode(button.dataset.wallMode as WallMode), { signal });
    }
    // A click anywhere outside an open panel closes it.
    document.addEventListener("pointerdown", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("[data-panel], [data-panel-toggle], .confirm-dialog-backdrop")) return;
      this.togglePanel(null);
    }, { signal, capture: true });
  }

  /** Opens one popover or drawer (file, requirements, settings, help) and closes the rest. */
  private togglePanel(name: string | null): void {
    for (const panel of this.shell.querySelectorAll<HTMLElement>("[data-panel]")) {
      const open = panel.dataset.panel === name && panel.hidden;
      panel.hidden = !open;
      const toggle = this.shell.querySelector<HTMLElement>(`[data-panel-toggle='${panel.dataset.panel}']`);
      toggle?.setAttribute("aria-expanded", String(open));
    }
  }

  private syncRequirements(map: MapData): void {
    this.lastRequirementsMap = map;
    const requirements = mapRequirements(map);
    const met = requirements.filter(r => r.satisfied).length;
    const ready = met === requirements.length;
    this.requirementsButton.dataset.ready = String(ready);
    this.require("[data-requirements-count]").textContent = `${met}/${requirements.length}`;
    this.requirementsList.replaceChildren(...requirements.map((requirement) => {
      const item = createElement("li", undefined, requirement.label);
      item.dataset.ok = String(requirement.satisfied);
      return item;
    }));
    this.playButton.setAttribute("aria-disabled", String(!ready));
    this.playButton.title = ready
      ? "Salvar e jogar esta fase"
      : `Falta: ${requirements.filter(r => !r.satisfied).map(r => r.label).join(", ")}`;
  }

  // ---------------------------------------------------------------------------------------
  // Dock: tools, catalogue tabs, filters and the thumbnail strip

  private bindDock(): void {
    const signal = this.events.signal;
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>("[data-tool]")) {
      button.addEventListener("click", () => this.chooseTool(button.dataset.tool as EditorTool), { signal });
    }
    this.require<HTMLInputElement>("[data-catalog-search]").addEventListener("input", (event) => {
      this.search = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
      this.renderCatalog();
    }, { signal });
    this.require<HTMLSelectElement>("[data-catalog-pack]").addEventListener("change", (event) => {
      this.catalogPack = (event.target as HTMLSelectElement).value;
      this.renderCatalog();
    }, { signal });
    this.strip.addEventListener("scroll", () => {
      if (this.strip.scrollLeft + this.strip.clientWidth > this.strip.scrollWidth - 600) this.appendCatalogChunk();
    }, { signal, passive: true });
    // A vertical wheel scrolls the horizontal strip.
    this.strip.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      this.strip.scrollLeft += event.deltaY;
    }, { signal, passive: false });
    const options = (): void => this.handlers.onPlacementOptions(
      this.require<HTMLInputElement>("[data-option='snap']").checked,
      this.require<HTMLInputElement>("[data-option='surface']").checked,
      Number(this.require<HTMLInputElement>("[data-option='height']").value) || 0,
    );
    for (const name of ["snap", "surface", "height"]) {
      this.require(`[data-option='${name}']`).addEventListener("input", options, { signal });
    }
    this.require<HTMLInputElement>("[data-option='overlap']").addEventListener("change", (event) => {
      this.handlers.onAllowOverlap((event.target as HTMLInputElement).checked);
    }, { signal });
  }

  private chooseTool(tool: EditorTool): void {
    if (tool === "wall" || tool === "floor") {
      // The wall and floor tools draw with a style from the catalogue: keep the current one
      // if it fits, otherwise take the first of its kind and show where the others are.
      const fits = (entry: EditorAssetEntry | null): boolean => Boolean(entry) &&
        (tool === "wall" ? isWallAsset(entry!.assetId, entry!.category) : isFloorAsset(entry!.assetId));
      const current = this.state?.asset ?? null;
      const style = fits(current) ? current : this.defaultStyle(tool);
      this.catalogTab = "structure";
      this.structureFilter = tool === "wall" ? "walls" : "floors";
      this.renderTabs();
      this.renderCatalog();
      this.handlers.onSetTool(tool);
      if (style) this.handlers.onSetAsset(style);
      return;
    }
    this.handlers.onSetTool(tool);
    this.handlers.onSetAsset(null);
  }

  private defaultStyle(tool: "wall" | "floor"): EditorAssetEntry | null {
    const preferred = tool === "wall" ? "/Praca/parede_colonial.glb" : "/Praca/piso_paver.glb";
    return EDITOR_ASSET_CATALOG.find((entry) => entry.assetId.endsWith(preferred))
      ?? EDITOR_ASSET_CATALOG.find((entry) => tool === "wall"
        ? isWallAsset(entry.assetId, entry.category)
        : isFloorAsset(entry.assetId))
      ?? null;
  }

  /** Picking a card: walls draw, floors paint, anything else is placed click by click. */
  private chooseAsset(entry: EditorAssetEntry): void {
    const tool: EditorTool = isWallAsset(entry.assetId, entry.category) && entry.assetId !== "scenario-room-wide"
      ? "wall"
      : isFloorAsset(entry.assetId) && entry.assetId !== "build-floor" ? "floor" : "place";
    this.handlers.onSetTool(tool);
    this.handlers.onSetAsset(entry);
  }

  private populatePacks(): void {
    const select = this.require<HTMLSelectElement>("[data-catalog-pack]");
    const packs = [...new Set(EDITOR_ASSET_CATALOG.map((entry) => entry.pack ?? "Byte Bistro"))];
    packs.sort((a, b) => packLabel(a).localeCompare(packLabel(b), "pt-BR"));
    for (const pack of packs) {
      const option = createElement("option", undefined, packLabel(pack));
      option.value = pack;
      select.append(option);
    }
  }

  private renderTabs(): void {
    const tabs = this.require("[data-catalog-tabs]");
    tabs.replaceChildren(...CATALOG_TABS.map((tab) => {
      const button = createElement("button", "bm-tab");
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(tab.id === this.catalogTab));
      button.title = tab.label;
      button.innerHTML = `${icon(tab.icon)}<span>${tab.label}</span>`;
      button.addEventListener("click", () => {
        this.catalogTab = tab.id;
        this.structureFilter = "";
        this.renderTabs();
        this.renderCatalog();
      });
      return button;
    }));
    const chips = this.require("[data-structure-filters]");
    chips.hidden = this.catalogTab !== "structure";
    chips.replaceChildren(...STRUCTURE_FILTERS.map((filter) => {
      const chip = createElement("button", "bm-chip", filter.label);
      chip.type = "button";
      chip.dataset.active = String(filter.id === this.structureFilter);
      chip.addEventListener("click", () => {
        this.structureFilter = filter.id;
        this.renderTabs();
        this.renderCatalog();
      });
      return chip;
    }));
  }

  private renderCatalog(): void {
    // A search looks through the whole catalogue: finding nothing because the wrong tab was
    // open is the most common "it isn't there" in a catalogue this size.
    const tab = this.search
      ? CATALOG_TABS[0]!
      : CATALOG_TABS.find((candidate) => candidate.id === this.catalogTab) ?? CATALOG_TABS[0]!;
    this.catalogMatches = EDITOR_ASSET_CATALOG.filter((entry) => {
      if (!tab.matches(entry)) return false;
      if (this.catalogPack && (entry.pack ?? "Byte Bistro") !== this.catalogPack) return false;
      if (tab.id === "structure" && this.structureFilter) {
        const wall = isWallAsset(entry.assetId, entry.category);
        const floor = isFloorAsset(entry.assetId);
        if (this.structureFilter === "walls" && !wall) return false;
        if (this.structureFilter === "floors" && !floor) return false;
        if (this.structureFilter === "other" && (wall || floor)) return false;
      }
      if (!this.search) return true;
      return `${entry.label} ${entry.assetId} ${packLabel(entry.pack ?? "")}`.toLocaleLowerCase().includes(this.search);
    });
    this.require("[data-catalog-count]").textContent = `${this.catalogMatches.length} ${this.catalogMatches.length === 1 ? "objeto" : "objetos"}`;
    this.thumbnailObserver.disconnect();
    this.strip.replaceChildren();
    this.strip.scrollLeft = 0;
    this.catalogRendered = 0;
    if (this.catalogMatches.length === 0) {
      this.strip.append(createElement("p", "bm-empty", "Nada encontrado. Tente outra busca ou categoria."));
      return;
    }
    this.appendCatalogChunk();
  }

  private appendCatalogChunk(): void {
    const next = this.catalogMatches.slice(this.catalogRendered, this.catalogRendered + CATALOG_CHUNK);
    if (next.length === 0) return;
    this.catalogRendered += next.length;
    const fragment = document.createDocumentFragment();
    for (const entry of next) fragment.append(this.createCard(entry));
    this.strip.append(fragment);
    this.updateCatalogSelection();
  }

  private createCard(entry: EditorAssetEntry): HTMLButtonElement {
    const card = createElement("button", "bm-card");
    card.type = "button";
    card.dataset.key = this.assetKey(entry);
    card.title = entry.pack ? `${entry.label} · ${packLabel(entry.pack)}` : entry.label;
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
      this.chooseAsset(entry);
      event.dataTransfer?.setData("text/plain", card.dataset.key ?? "");
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
    });
    const frame = createElement("span", "bm-thumb");
    frame.dataset.state = "loading";
    const image = createElement("img");
    image.alt = "";
    image.width = 192;
    image.height = 144;
    image.draggable = false;
    frame.append(image);
    if (entry.color && !entry.pack) frame.style.setProperty("--swatch", entry.color);
    this.thumbnailEntries.set(image, entry);
    this.thumbnailObserver.observe(image);
    card.append(frame, createElement("span", "bm-card-name", entry.label));
    card.addEventListener("click", () => this.chooseAsset(entry));
    return card;
  }

  private loadThumbnail(image: HTMLImageElement, entry: EditorAssetEntry): void {
    void this.thumbnails.get(entry, () => image.isConnected).then((url) => {
      if (this.destroyed || !image.isConnected) return;
      const frame = image.parentElement;
      if (url) {
        image.src = url;
        image.alt = entry.label;
        if (frame) frame.dataset.state = "ready";
      } else if (frame) {
        frame.dataset.state = "unavailable";
      }
    });
  }

  private assetKey(entry: EditorAssetEntry): string {
    return `${entry.assetId}:${entry.ingredientId ?? entry.stationId ?? entry.playerIndex ?? entry.robot?.displayName ?? ""}`;
  }

  private updateCatalogSelection(): void {
    const asset = this.state?.asset;
    const tool = this.state?.tool;
    const active = asset && (tool === "place" || tool === "wall" || tool === "floor") ? this.assetKey(asset) : null;
    for (const card of this.strip.querySelectorAll<HTMLElement>(".bm-card")) {
      card.dataset.active = String(card.dataset.key === active);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Inspector: shown for a selection (or the colours tool)

  private syncInspector(state: EditorViewState): void {
    const selection = state.selection;
    const show = selection.length > 0 && (state.tool === "select" || state.tool === "design");
    this.inspector.hidden = !show;
    if (!show) {
      this.inspectorKey = "";
      return;
    }
    // Rebuild only when the selection or its colour set changes; otherwise refresh values.
    const key = `${selection.map(o => o.id).join(",")}|${state.colors?.slots.map(s => s.name).join(",") ?? ""}|${state.tool}`;
    if (key !== this.inspectorKey) {
      this.inspectorKey = key;
      this.renderInspector(state);
    }
    this.fillInspector(state);
  }

  private renderInspector(state: EditorViewState): void {
    const selection = state.selection;
    const first = selection[0]!;
    const single = selection.length === 1;
    const body = this.inspectorBody;
    body.replaceChildren();

    const heading = createElement("header", "bm-inspector-head");
    heading.append(
      createElement("strong", undefined, single ? first.label ?? "Objeto" : `${selection.length} objetos`),
      createElement("small", undefined, single ? this.packOf(first) : "Seleção múltipla"),
    );
    body.append(heading);

    if (state.colors) body.append(this.renderColors(state.colors));
    else if (state.tool === "design") {
      body.append(createElement("p", "bm-muted", selection.length > 1
        ? "Selecione objetos do mesmo modelo para mudar as cores juntos."
        : "Este objeto não tem cores editáveis."));
    }

    if (single) {
      const transform = createElement("section", "bm-section");
      transform.append(createElement("h3", undefined, "Posição e tamanho"));
      const rows: [string, "position" | "rotation" | "scale", ("x" | "y" | "z")[], number][] = [
        ["Posição (m)", "position", ["x", "y", "z"], 0.25],
        ["Rotação (°)", "rotation", ["y"], 15],
        ["Escala", "scale", ["x", "y", "z"], 0.1],
      ];
      for (const [label, group, axes, step] of rows) {
        const row = createElement("div", "bm-field-row");
        row.append(createElement("span", "bm-field-label", label));
        for (const axis of axes) {
          const input = createElement("input", "bm-number");
          input.type = "number";
          input.step = String(step);
          input.dataset.transform = group;
          input.dataset.axis = axis;
          input.setAttribute("aria-label", `${label} ${axis.toUpperCase()}`);
          input.addEventListener("change", () => {
            const value = Number(input.value);
            if (Number.isFinite(value)) this.handlers.onTransform(group, axis, value);
          });
          row.append(input);
        }
        transform.append(row);
      }
      body.append(transform);
    }

    if (selection.some(object => object.role === "robot")) body.append(this.renderRobotFields());

    const actions = createElement("div", "bm-actions");
    const action = (label: string, iconName: string, handler: () => void, danger = false): HTMLButtonElement => {
      const button = createElement("button", `bm-button${danger ? " bm-danger" : ""}`);
      button.type = "button";
      button.innerHTML = `${icon(iconName)}<span>${label}</span>`;
      button.addEventListener("click", handler);
      return button;
    };
    actions.append(
      action("Girar", "rotate", () => this.handlers.onRotate(1)),
      action("Duplicar", "duplicate", () => this.handlers.onDuplicateSelected()),
      action("Conta-gotas", "eyedropper", () => this.handlers.onCopySelected()),
      action("Excluir", "trash", () => this.handlers.onDeleteSelected(), true),
    );
    body.append(actions);
  }

  private renderColors(colors: SelectionColors): HTMLElement {
    const section = createElement("section", "bm-section bm-colors");
    const title = createElement("h3", undefined, colors.count > 1 ? `Cores (${colors.count} objetos)` : "Cores");
    section.append(title);
    if (!colors.slots.some(slot => slot.name === this.activeColorSlot)) this.activeColorSlot = colors.slots[0]?.name ?? "";
    for (const slot of colors.slots) {
      const row = createElement("div", "bm-swatch-row");
      row.dataset.slot = slot.name;
      row.dataset.active = String(slot.name === this.activeColorSlot);
      const input = createElement("input", "bm-swatch");
      input.type = "color";
      input.dataset.colorSlot = slot.name;
      input.dataset.default = slot.defaultColor;
      input.setAttribute("aria-label", `Cor: ${slot.label}`);
      input.addEventListener("focus", () => this.setActiveSlot(slot.name));
      input.addEventListener("input", () => this.handlers.onColorPreview(slot.name, input.value));
      input.addEventListener("change", () => this.handlers.onColorCommit(slot.name, input.value));
      const label = createElement("button", "bm-swatch-label", slot.label);
      label.type = "button";
      label.addEventListener("click", () => this.setActiveSlot(slot.name));
      const reset = createElement("button", "bm-icon-button bm-swatch-reset");
      reset.type = "button";
      reset.title = "Voltar à cor original";
      reset.innerHTML = icon("undo");
      reset.addEventListener("click", () => this.handlers.onColorCommit(slot.name, null));
      row.append(input, label, reset);
      section.append(row);
    }
    const palette = createElement("div", "bm-palette");
    palette.setAttribute("aria-label", "Paleta rápida");
    for (const hex of PALETTE) {
      const chip = createElement("button", "bm-palette-chip");
      chip.type = "button";
      chip.style.setProperty("--chip", hex);
      chip.title = hex;
      chip.addEventListener("click", () => {
        if (this.activeColorSlot) this.handlers.onColorCommit(this.activeColorSlot, hex);
      });
      palette.append(chip);
    }
    section.append(palette);
    const reset = createElement("button", "bm-button bm-ghost", "Restaurar todas as cores");
    reset.type = "button";
    reset.addEventListener("click", () => this.handlers.onResetColors());
    section.append(reset);
    return section;
  }

  private setActiveSlot(name: string): void {
    this.activeColorSlot = name;
    for (const row of this.inspectorBody.querySelectorAll<HTMLElement>("[data-slot]")) {
      row.dataset.active = String(row.dataset.slot === name);
    }
  }

  private renderRobotFields(): HTMLElement {
    const section = createElement("section", "bm-section");
    section.innerHTML = `
      <h3>Robô</h3>
      <label class="bm-check"><input type="checkbox" data-robot="customer"> Recebe pedidos</label>
      <label class="bm-check"><input type="checkbox" data-robot="canMove"> Anda pela sala</label>
      <label class="bm-field">Animação parado<select data-robot="idleClip">${ROBOT_CLIPS
        .map((clip) => `<option value="${clip.id}">${clip.label}</option>`).join("")}</select></label>
      <label class="bm-field">Raio de perambulação (m)<input type="number" data-robot="wanderRadius" min="0" max="12" step="0.5"></label>
      <label class="bm-field">Velocidade (m/s)<input type="number" data-robot="moveSpeed" min="0.2" max="4" step="0.05"></label>
      <label class="bm-field">Nome<input type="text" data-robot="displayName" maxlength="40" placeholder="Automático"></label>`;
    for (const field of section.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-robot]")) {
      const key = field.dataset.robot as keyof RobotConfig;
      field.addEventListener("change", () => {
        if (field instanceof HTMLInputElement && field.type === "checkbox") {
          this.handlers.onRobotConfig({ [key]: field.checked } as Partial<RobotConfig>);
        } else if (field instanceof HTMLInputElement && field.type === "number") {
          if (field.value !== "") this.handlers.onRobotConfig({ [key]: Number(field.value) } as Partial<RobotConfig>);
        } else {
          this.handlers.onRobotConfig({ [key]: field.value } as Partial<RobotConfig>);
        }
      });
    }
    return section;
  }

  /** Writes current values into the inspector without fighting the field being edited. */
  private fillInspector(state: EditorViewState): void {
    const first = state.selection[0];
    if (!first) return;
    for (const input of this.inspectorBody.querySelectorAll<HTMLInputElement>("[data-transform]")) {
      if (document.activeElement === input) continue;
      const group = input.dataset.transform as "position" | "rotation" | "scale";
      const axis = input.dataset.axis as "x" | "y" | "z";
      const value = first[group][axis] * (group === "rotation" ? 180 / Math.PI : 1);
      input.value = String(Number(value.toFixed(group === "rotation" ? 1 : 3)));
    }
    for (const input of this.inspectorBody.querySelectorAll<HTMLInputElement>("[data-color-slot]")) {
      if (document.activeElement === input) continue;
      input.value = state.colors?.colors[input.dataset.colorSlot ?? ""] ?? input.dataset.default ?? "#ffffff";
    }
    const robot = state.selection.find(object => object.role === "robot")?.robot;
    if (!robot) return;
    for (const field of this.inspectorBody.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-robot]")) {
      if (document.activeElement === field) continue;
      const value = robot[field.dataset.robot as keyof RobotConfig];
      if (field instanceof HTMLInputElement && field.type === "checkbox") field.checked = value === true;
      else field.value = String(value);
    }
  }

  private packOf(object: MapPlacedObject): string {
    const entry = EDITOR_ASSET_CATALOG.find((candidate) => candidate.assetId === object.assetId);
    return entry?.pack ? packLabel(entry.pack) : object.role === "decor" ? "Byte Bistro" : "Objeto de jogo";
  }

  // ---------------------------------------------------------------------------------------
  // Keys the chrome owns (the scene owns the rest)

  private bindKeys(): void {
    window.addEventListener("keydown", (event) => {
      // Ctrl+S saves from anywhere, the name box included; left to the browser it would open
      // "Save page as".
      if ((event.ctrlKey || event.metaKey) && event.code === "KeyS") {
        event.preventDefault();
        this.saveCurrent();
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "?") {
        event.preventDefault();
        this.togglePanel("help");
      } else if (event.key === "Escape") {
        this.togglePanel(null);
      }
    }, { signal: this.events.signal });
  }

  // ---------------------------------------------------------------------------------------
  // Files and slots

  private readMeta(): MapMeta {
    const description = this.require<HTMLTextAreaElement>("[data-meta='description']").value;
    const duration = Number(this.require<HTMLInputElement>("[data-meta='duration']").value);
    const difficulty = this.require<HTMLSelectElement>("[data-meta='difficulty']").value;
    return {
      description: description.trim(),
      shiftDurationSeconds: Number.isFinite(duration) ? duration : 240,
      difficultyId: isDifficultyId(difficulty) ? difficulty : "standard",
    };
  }

  private saveCurrent(): boolean {
    const slotId = this.handlers.onSave(this.nameInput.value, this.readMeta(), this.currentSlotId || undefined);
    if (slotId) {
      this.currentSlotId = slotId;
      this.slots = this.handlers.listSlots();
      this.renderSlots();
    }
    return Boolean(slotId);
  }

  private saveAs(): void {
    const slotId = this.handlers.onSave(this.nameInput.value, this.readMeta());
    if (slotId) {
      this.currentSlotId = slotId;
      this.slots = this.handlers.listSlots();
      this.renderSlots();
    }
  }

  private async newMap(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const name = await textDialog({
      title: "Novo mapa",
      message: "Nome do mapa",
      value: "Novo mapa",
      maxLength: 40,
      confirmLabel: "Criar",
    });
    if (name === null) return;
    this.handlers.onNewMap(name || "Novo mapa");
  }

  /**
   * Downloads the current map as JSON: the handoff for turning a map built in-game into a
   * shipped level (the file drops into `src/data/levels/`).
   */
  private exportCurrent(): void {
    const map = this.handlers.getCurrentMap();
    if (!map) { this.notify("Nada para exportar", "warning"); return; }
    const name = (this.nameInput.value.trim() || map.name || "mapa")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mapa";
    // The form, not the last saved meta: what the designer sees is what ships in the file.
    const payload = JSON.stringify({ ...map, name: this.nameInput.value.trim() || map.name, meta: this.readMeta() }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}.bytebistro.json`;
    link.click();
    // Revoking immediately can cancel the download in some browsers.
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    this.notify(`Exportado como ${name}.bytebistro.json`, "success");
  }

  /** Loads a previously exported map file back into the editor. */
  private importMap(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          this.notify("Arquivo inválido", "error");
          return;
        }
        // The same sanitiser the slot store uses, so a hand-edited file cannot smuggle
        // anything unexpected into the editor.
        const map = sanitizeMapData(parsed);
        if (!map) { this.notify("Mapa inválido", "error"); return; }
        this.handlers.onImportMap(map);
        this.nameInput.value = map.name;
        this.setMeta(map);
        this.currentSlotId = "";
        this.renderSlots();
        this.notify(`Importado: ${map.name} · Ctrl+Z desfaz`, "success");
      });
    }, { once: true });
    input.click();
  }

  /**
   * Asks before replacing a map with unsaved work. Loading or starting a map clears the
   * undo history, so there is no way back afterwards.
   */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.handlers.hasUnsavedChanges()) return true;
    return confirmDialog({
      title: "Descartar alterações?",
      message: "O mapa atual tem alterações que não foram salvas. Elas serão perdidas.",
      confirmLabel: "Descartar",
      danger: true,
    });
  }

  private renderSlots(): void {
    this.slotList.replaceChildren();
    if (this.slots.length === 0) {
      this.slotList.append(createElement("p", "bm-muted", "Nenhum mapa salvo ainda."));
      return;
    }
    for (const slot of this.slots) {
      const item = createElement("div", "bm-slot");
      if (slot.slotId === this.currentSlotId) item.dataset.active = "true";
      const text = createElement("div", "bm-slot-text");
      text.append(
        createElement("strong", undefined, slot.name),
        createElement("small", undefined, `${slot.objectCount} objetos · ${new Date(slot.updatedAt).toLocaleDateString("pt-BR")}`),
      );
      const load = createElement("button", "bm-button bm-small", "Abrir");
      load.type = "button";
      load.addEventListener("click", () => { this.togglePanel(null); void this.loadSlot(slot.slotId); });
      const remove = createElement("button", "bm-icon-button bm-danger");
      remove.type = "button";
      remove.title = "Excluir mapa";
      remove.innerHTML = icon("trash");
      remove.addEventListener("click", () => void this.deleteSlot(slot.slotId));
      item.append(text, load, remove);
      this.slotList.append(item);
    }
  }

  private async loadSlot(slotId: string): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const ok = await this.handlers.onLoadSlot(slotId);
    if (ok) {
      this.currentSlotId = slotId;
      this.renderSlots();
    } else {
      this.notify("Não foi possível abrir esse mapa", "error");
    }
  }

  private async deleteSlot(slotId: string): Promise<void> {
    const name = this.slots.find((slot) => slot.slotId === slotId)?.name ?? "sem nome";
    const confirmed = await confirmDialog({
      title: "Excluir mapa?",
      message: `O mapa "${name}" será apagado permanentemente. Essa ação não pode ser desfeita.`,
      confirmLabel: "Excluir",
      danger: true,
    });
    if (!confirmed) return;
    if (this.handlers.onDeleteSlot(slotId)) {
      if (slotId === this.currentSlotId) this.currentSlotId = "";
      this.slots = this.slots.filter((slot) => slot.slotId !== slotId);
      this.renderSlots();
    }
  }

  private require<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = this.shell.querySelector<T>(selector);
    if (!element) throw new Error(`Editor UI missing required element: ${selector}`);
    return element;
  }

  private createMarkup(): string {
    const tools = TOOLS.map((tool) => `
      <button type="button" class="bm-tool" data-tool="${tool.tool}" title="${tool.title}${tool.key ? ` (${tool.key})` : ""}">
        ${icon(tool.icon)}<span>${tool.label}</span>${tool.key ? `<kbd>${tool.key}</kbd>` : ""}
      </button>`).join("");
    const wallModes = WALL_MODES.map((mode) => `
      <button type="button" class="bm-icon-button" data-wall-mode="${mode.mode}" title="${mode.label} (V)" aria-label="${mode.label}">${icon(mode.icon)}</button>`).join("");
    const shortcuts = SHORTCUTS.map(([keys, text]) => `<dt><kbd>${keys}</kbd></dt><dd>${text}</dd>`).join("");
    return `
      <header class="bm-topbar" data-editor-chrome>
        <div class="bm-cluster">
          <div class="bm-popover-anchor">
            <button type="button" class="bm-button" data-action="file" data-panel-toggle="file" aria-haspopup="true" aria-expanded="false">${icon("menu")}<span>Arquivo</span></button>
            <div class="bm-popover bm-file" data-panel="file" hidden>
              <button type="button" class="bm-menu-item" data-action="save">Salvar <kbd>Ctrl+S</kbd></button>
              <button type="button" class="bm-menu-item" data-action="save-as">Salvar uma cópia</button>
              <button type="button" class="bm-menu-item" data-action="new">Novo mapa…</button>
              <div class="bm-menu-heading">Mapas salvos</div>
              <div class="bm-slots" data-slots></div>
              <div class="bm-menu-heading">Arquivo</div>
              <button type="button" class="bm-menu-item" data-action="import">Importar JSON…</button>
              <button type="button" class="bm-menu-item" data-action="export">Exportar JSON</button>
              <button type="button" class="bm-menu-item bm-danger" data-action="exit">Sair do modo construção</button>
            </div>
          </div>
          <div class="bm-segment">
            <button type="button" class="bm-icon-button" data-action="undo" title="Desfazer (Ctrl+Z)" aria-label="Desfazer">${icon("undo")}</button>
            <button type="button" class="bm-icon-button" data-action="redo" title="Refazer (Ctrl+Y)" aria-label="Refazer">${icon("redo")}</button>
          </div>
          <input class="bm-name" data-map-name type="text" maxlength="40" aria-label="Nome do mapa" placeholder="Nome do mapa">
        </div>
        <div class="bm-cluster">
          <div class="bm-segment" role="group" aria-label="Paredes">${wallModes}</div>
          <div class="bm-segment">
            <button type="button" class="bm-icon-button" data-action="top" title="Vista de cima (T)" aria-label="Vista de cima">${icon("top")}</button>
            <button type="button" class="bm-icon-button" data-action="grid" title="Grade (G)" aria-label="Grade">${icon("grid")}</button>
            <button type="button" class="bm-icon-button" data-action="help" data-panel-toggle="help" title="Atalhos (?)" aria-label="Atalhos">${icon("help")}</button>
          </div>
          <div class="bm-popover-anchor">
            <button type="button" class="bm-button bm-requirements" data-action="requirements" data-panel-toggle="requirements" aria-expanded="false" title="O que falta para jogar">${icon("check")}<span data-requirements-count>0/0</span></button>
            <div class="bm-popover bm-popover-right" data-panel="requirements" hidden>
              <div class="bm-menu-heading">Obrigatórios para jogar</div>
              <ul class="bm-requirements-list" data-requirements></ul>
            </div>
          </div>
          <button type="button" class="bm-icon-button" data-action="settings" data-panel-toggle="settings" title="Configurações do mapa" aria-label="Configurações do mapa">${icon("settings")}</button>
          <button type="button" class="bm-button bm-primary" data-action="play">${icon("play")}<span>Jogar</span></button>
        </div>
      </header>

      <div class="bm-toast" data-toast data-visible="false" role="status" aria-live="polite"></div>

      <aside class="bm-panel bm-inspector" data-inspector data-editor-chrome hidden>
        <div data-inspector-body></div>
      </aside>

      <aside class="bm-panel bm-drawer" data-panel="settings" data-editor-chrome hidden>
        <header class="bm-drawer-head"><strong>Configurações do mapa</strong>
          <button type="button" class="bm-icon-button" data-action="close-settings" aria-label="Fechar">${icon("close")}</button></header>
        <label class="bm-field">Descrição<textarea data-meta="description" rows="3" maxlength="240" placeholder="Do que se trata esta fase?"></textarea></label>
        <label class="bm-field">Tempo do turno (s)<input type="number" data-meta="duration" min="60" max="900" step="10" value="240"></label>
        <label class="bm-field">Dificuldade<select data-meta="difficulty">${DIFFICULTY_IDS
          .map((id) => `<option value="${id}">${DIFFICULTY_PROFILES[id].label}</option>`).join("")}</select></label>
        <p class="bm-muted">Esses dados são salvos com o mapa e usados quando a fase é jogada.</p>
      </aside>

      <section class="bm-panel bm-help" data-panel="help" data-editor-chrome hidden>
        <header class="bm-drawer-head"><strong>Atalhos do modo construção</strong>
          <button type="button" class="bm-icon-button" data-action="close-help" aria-label="Fechar">${icon("close")}</button></header>
        <dl class="bm-shortcuts">${shortcuts}</dl>
      </section>

      <div class="bm-hint-bar">
        <span data-hint></span>
        <span class="bm-progress" data-progress hidden><i></i></span>
      </div>

      <footer class="bm-dock" data-editor-chrome>
        <nav class="bm-tools" aria-label="Ferramentas">${tools}</nav>
        <div class="bm-catalog">
          <div class="bm-catalog-bar">
            <div class="bm-tabs" role="tablist" data-catalog-tabs></div>
            <div class="bm-filters">
              <input type="search" class="bm-search" data-catalog-search placeholder="Buscar…" aria-label="Buscar no catálogo">
              <select class="bm-select" data-catalog-pack aria-label="Pacote"><option value="">Todos os pacotes</option></select>
              <span class="bm-count" data-catalog-count></span>
            </div>
          </div>
          <div class="bm-catalog-sub">
            <div class="bm-chips" data-structure-filters hidden></div>
            <div class="bm-options">
              <label class="bm-check"><input type="checkbox" data-option="snap" checked> Grade</label>
              <label class="bm-check"><input type="checkbox" data-option="surface"> Apoiar sobre objetos</label>
              <label class="bm-check"><input type="checkbox" data-option="overlap"> Permitir sobreposição</label>
              <label class="bm-check">Altura <input type="number" class="bm-number" data-option="height" step="0.25" value="0" aria-label="Altura ao inserir (m)"></label>
            </div>
          </div>
          <div class="bm-strip" data-catalog-strip></div>
        </div>
      </footer>
    `;
  }
}
