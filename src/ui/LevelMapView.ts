import {
  AbstractMesh,
  ArcRotateCamera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Matrix,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  PointerEventTypes,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
  type Node,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { assetStreaming } from "../core/assets/AssetStreamingManager";
import { qualityManager } from "../core/perf/QualityManager";
import {
  LEVEL_LANDMARKS,
  LEVEL_MAP_URL,
  neighbourInDirection,
  ringSpots,
  type GroundRect,
} from "../data/levelMap";

const MAP_ASSET = {
  id: "level-map",
  url: LEVEL_MAP_URL,
  required: true,
  priority: "critical" as const,
};
const NAME_PREFIX = "level-map-";
/** Star size, tip to centre, in map units (the diorama is about 11 × 13). */
const STAR_OUTER = 0.72;
const STAR_INNER = 0.32;
/** How far each face of the star bulges out, which gives it its cut-gem facets. */
const STAR_DEPTH = 0.22;
/** Gap between a landmark's highest point and the bottom of its star. */
const STAR_CLEARANCE = 0.55;
/** Height of a star over open ground, where there is no landmark to sit on. */
const STAR_GROUND_HEIGHT = 1.3;
const SELECTED_SCALE = 1.35;
const STAR_GOLD = new Color3(1, 0.77, 0.24);
const OUTLINE = Color3.FromHexString("#10204d");
/** Where the camera looks from at first: facing the church, with the town sign readable. */
const START_ALPHA = Math.PI / 2 - 0.45;
const START_BETA = 0.92;

export interface LevelMapOptions {
  /** A star was clicked or tapped; null when the click landed on the map itself. */
  readonly onPick: (key: string | null) => void;
}

interface Star {
  readonly key: string;
  readonly root: TransformNode;
  readonly gem: Mesh;
  readonly base: Vector3;
  readonly phase: number;
}

const prefersReducedMotion = (): boolean => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/** A five-pointed star with a raised centre on both faces; flat normals make each facet catch the light. */
const createStarGem = (name: string, scene: Scene): Mesh => {
  const rim: Vector3[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? STAR_OUTER : STAR_INNER;
    rim.push(new Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0));
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const addFacet = (a: Vector3, b: Vector3, c: Vector3): void => {
    const start = positions.length / 3;
    for (const corner of [a, b, c]) positions.push(corner.x, corner.y, corner.z);
    indices.push(start, start + 1, start + 2);
  };
  const front = new Vector3(0, 0, -STAR_DEPTH);
  const back = new Vector3(0, 0, STAR_DEPTH);
  for (let i = 0; i < 10; i++) {
    const current = rim[i]!;
    const next = rim[(i + 1) % 10]!;
    addFacet(front, current, next);
    addFacet(back, next, current);
  }
  const data = new VertexData();
  data.positions = positions;
  data.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  data.normals = normals;
  const mesh = new Mesh(name, scene);
  data.applyToMesh(mesh);
  return mesh;
};

/**
 * The level picker's 3D map: the São Bento do Sul diorama on its own canvas, with a star
 * over each official level. The player orbits and zooms it; picking is reported through
 * `onPick` and everything else (the level window, the rank) stays in the DOM.
 */
export class LevelMapView {
  static readonly assetUrl = LEVEL_MAP_URL;

  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly assets: AssetManager;
  private readonly mapRoot: TransformNode;
  private readonly resizeObserver: ResizeObserver;
  private readonly starMaterial: StandardMaterial;
  private readonly selectedMaterial: StandardMaterial;
  private readonly settled: Promise<boolean>;
  private readonly reducedMotion = prefersReducedMotion();
  private map: ModelInstance | null = null;
  private mapMaterials: StandardMaterial[] = [];
  private landmarks = new Map<string, Vector3>();
  private ground: GroundRect = { minX: -4, maxX: 4, minZ: -4, maxZ: 4 };
  private mapCenter = Vector3.Zero();
  private fitRadius = 18;
  private keys: readonly string[] = [];
  private stars: Star[] = [];
  private selectedKey: string | null = null;
  private hoveredKey: string | null = null;
  /** Where the camera is gliding to; follows the selected star part of the way. */
  private readonly targetGoal = Vector3.Zero();
  private elapsed = 0;
  private active = true;
  private disposed = false;
  private readonly unregisterQuality: () => void;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: LevelMapOptions) {
    this.engine = new Engine(canvas, true, {
      alpha: true,
      preserveDrawingBuffer: false,
      // The stars' cartoon outline is drawn through the stencil buffer.
      stencil: true,
      antialias: true,
    });
    this.scene = new Scene(this.engine);
    // Transparent, so the diorama floats over the menu's own backdrop.
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.skipPointerMovePicking = true;

    this.camera = new ArcRotateCamera(
      "level-map-camera",
      START_ALPHA,
      START_BETA,
      this.fitRadius,
      Vector3.Zero(),
      this.scene,
    );
    this.camera.fov = 0.8;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 200;
    // Orbit and zoom only: panning would let the island drift off screen.
    this.camera.panningSensibility = 0;
    this.camera.lowerBetaLimit = 0.3;
    // Never below the horizon, where the underside of the island would show.
    this.camera.upperBetaLimit = 1.32;
    this.camera.wheelDeltaPercentage = 0.012;
    this.camera.pinchDeltaPercentage = 0.004;
    // The arrow keys jump between stars; they must not also spin the camera.
    this.camera.inputs.removeByType("ArcRotateCameraKeyboardMoveInput");
    this.camera.attachControl();

    const ambient = new HemisphericLight("level-map-ambient", new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.78;
    ambient.diffuse = Color3.White();
    ambient.groundColor = Color3.FromHexString("#9fb3d6");
    ambient.specular = Color3.Black();
    // A soft key light so roofs, walls and treetops read as separate planes.
    const sun = new DirectionalLight("level-map-sun", new Vector3(0.45, -1, 0.6), this.scene);
    sun.intensity = 0.42;
    sun.specular = Color3.Black();

    this.starMaterial = this.createStarMaterial("level-map-star", 0);
    this.selectedMaterial = this.createStarMaterial("level-map-star-selected", 0.3);
    this.mapRoot = new TransformNode("level-map-root", this.scene);

    this.assets = assetStreaming.createSceneAssets(this.scene, [MAP_ASSET]);
    this.settled = this.load().then(() => this.map !== null).catch((error: unknown) => {
      console.error("O mapa de fases não pôde ser carregado.", error);
      return false;
    });

    this.scene.onPointerObservable.add((info) => {
      if (info.type === PointerEventTypes.POINTERTAP) {
        this.options.onPick(this.starAt(this.scene.pointerX, this.scene.pointerY));
      } else if (info.type === PointerEventTypes.POINTERMOVE) {
        const hovered = this.starAt(this.scene.pointerX, this.scene.pointerY);
        if (hovered !== this.hoveredKey) {
          this.hoveredKey = hovered;
          this.canvas.style.cursor = hovered ? "pointer" : "";
        }
      }
    });
    this.scene.onBeforeRenderObservable.add(() => this.animate(this.engine.getDeltaTime() / 1000));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.unregisterQuality = qualityManager.registerEngine(this.engine, { followsDevicePixelRatio: false });
    this.engine.runRenderLoop(this.frame);
  }

  /** Resolves true once the map is on screen, false if it could not load. Never rejects. */
  whenReady(): Promise<boolean> {
    return this.settled;
  }

  /** One star per key, in order: the first on the church, then the other landmarks. */
  setLevels(keys: readonly string[]): void {
    this.keys = [...keys];
    if (this.map) this.layoutStars();
  }

  /** Highlights a star and glides the camera toward it; null clears the highlight. */
  select(key: string | null): void {
    this.selectedKey = key;
    for (const star of this.stars) {
      const selected = star.key === key;
      star.gem.material = selected ? this.selectedMaterial : this.starMaterial;
      star.gem.outlineWidth = selected ? 0.05 : 0.035;
    }
    const star = this.stars.find((candidate) => candidate.key === key);
    // Halfway between the square and the star: the star comes into view without the
    // rest of the town leaving it.
    // Sideways only: following the star up would sink the island out of the frame.
    this.targetGoal.copyFrom(this.mapCenter);
    if (star) {
      this.targetGoal.x = (this.mapCenter.x + star.base.x) / 2;
      this.targetGoal.z = (this.mapCenter.z + star.base.z) / 2;
    }
  }

  /** The star the given arrow direction leads to from `key`, or null when none lies that way. */
  neighbour(key: string | null, dx: number, dy: number): string | null {
    if (this.stars.length === 0) return null;
    const from = this.stars.findIndex((star) => star.key === key);
    if (from < 0) return this.stars[0]!.key;
    const width = this.engine.getRenderWidth();
    const height = this.engine.getRenderHeight();
    const viewport = this.camera.viewport.toGlobal(width, height);
    const transform = this.scene.getTransformMatrix();
    const points = this.stars.map((star) => {
      const projected = Vector3.Project(star.root.position, Matrix.IdentityReadOnly, transform, viewport);
      return { x: projected.x, y: projected.y };
    });
    const index = neighbourInDirection(points, from, dx, dy);
    return index >= 0 ? this.stars[index]!.key : null;
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      this.resize();
      this.engine.runRenderLoop(this.frame);
    } else {
      this.engine.stopRenderLoop(this.frame);
    }
  }

  resize(): void {
    if (this.disposed) return;
    this.engine.resize();
    this.fitCamera(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterQuality();
    this.resizeObserver.disconnect();
    this.engine.stopRenderLoop(this.frame);
    for (const star of this.stars) star.root.dispose();
    this.stars = [];
    this.map?.dispose();
    for (const material of this.mapMaterials) material.dispose(false, false);
    this.assets.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    this.scene.render();
  };

  private createStarMaterial(name: string, glow: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    // Mostly self-lit so the star reads as gold from any side, with enough diffuse left
    // for the facets to catch the sun.
    material.diffuseColor = STAR_GOLD.scale(0.55);
    material.emissiveColor = STAR_GOLD.scale(0.5 + glow);
    material.specularColor = new Color3(0.35, 0.3, 0.2);
    material.specularPower = 24;
    // Culling on: the outline renderer draws the back faces, pushed outward, as the rim.
    // With culling off it draws every face and the dark shell covers the whole star.
    material.backFaceCulling = true;
    return material;
  }

  private async load(): Promise<void> {
    const instance = await this.assets.instantiateModel(MAP_ASSET.id, {
      namePrefix: NAME_PREFIX,
      parent: this.mapRoot,
    });
    if (!instance) return;
    if (this.disposed) {
      instance.dispose();
      return;
    }
    this.map = instance;
    this.mapMaterials = this.convertMaterials(instance);
    this.measure(instance);
    this.fitCamera(true);
    this.layoutStars();
  }

  /**
   * The Blender export uses PBR materials, which render dark without an environment map.
   * The diorama is flat-coloured, so a plain material with the same base colour shows it
   * the way it was painted.
   */
  private convertMaterials(instance: ModelInstance): StandardMaterial[] {
    const converted = new Map<number, StandardMaterial>();
    for (const mesh of this.meshesOf(instance.rootNodes)) {
      mesh.isPickable = false;
      const source = mesh.material;
      if (!(source instanceof PBRMaterial)) continue;
      let material = converted.get(source.uniqueId);
      if (!material) {
        material = new StandardMaterial(`${NAME_PREFIX}${source.name}`, this.scene);
        material.diffuseColor.copyFrom(source.albedoColor);
        material.diffuseTexture = source.albedoTexture;
        material.emissiveColor.copyFrom(source.emissiveColor);
        material.specularColor = Color3.Black();
        material.alpha = source.alpha;
        material.backFaceCulling = source.backFaceCulling;
        converted.set(source.uniqueId, material);
      }
      mesh.material = material;
    }
    return [...converted.values()];
  }

  /** Finds the landmarks, the ground and the overall size, then centres the island. */
  private measure(instance: ModelInstance): void {
    this.mapRoot.computeWorldMatrix(true);
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants(false)]) {
        if (node instanceof TransformNode) node.computeWorldMatrix(true);
      }
    }
    const whole = this.boundsOf(instance.rootNodes);
    if (!whole) return;
    // Centre the island on the origin so the camera orbits its middle.
    this.mapRoot.position.set(
      -(whole.min.x + whole.max.x) / 2,
      -whole.min.y,
      -(whole.min.z + whole.max.z) / 2,
    );
    this.mapRoot.computeWorldMatrix(true);
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants(false)]) {
        if (node instanceof TransformNode) node.computeWorldMatrix(true);
      }
    }
    const size = whole.max.subtract(whole.min);
    // Above the middle of the island, so the star over the church keeps clear of the top edge.
    this.mapCenter = new Vector3(0, size.y * 0.5, 0);
    this.targetGoal.copyFrom(this.mapCenter);
    this.camera.target.copyFrom(this.mapCenter);
    this.fitRadius = Math.hypot(size.x, size.y, size.z) / 2;

    const nodes = new Map<string, Node>();
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants(false)]) nodes.set(node.name, node);
    }
    for (const landmark of LEVEL_LANDMARKS) {
      const node = nodes.get(`${NAME_PREFIX}${landmark}`);
      const bounds = node ? this.boundsOf([node]) : null;
      if (!bounds) continue;
      this.landmarks.set(landmark, new Vector3(
        (bounds.min.x + bounds.max.x) / 2,
        bounds.max.y + STAR_CLEARANCE + STAR_OUTER,
        (bounds.min.z + bounds.max.z) / 2,
      ));
    }
    const grass = nodes.get(`${NAME_PREFIX}Mapa_Grama`);
    const groundBounds = (grass ? this.boundsOf([grass]) : null) ?? this.boundsOf(instance.rootNodes);
    if (groundBounds) {
      this.ground = {
        minX: groundBounds.min.x,
        maxX: groundBounds.max.x,
        minZ: groundBounds.min.z,
        maxZ: groundBounds.max.z,
      };
    }
  }

  private meshesOf(nodes: readonly Node[]): AbstractMesh[] {
    const meshes: AbstractMesh[] = [];
    for (const node of nodes) {
      if (node instanceof AbstractMesh) meshes.push(node);
      for (const child of node.getDescendants(false)) {
        if (child instanceof AbstractMesh) meshes.push(child);
      }
    }
    return meshes;
  }

  private boundsOf(nodes: readonly Node[]): { min: Vector3; max: Vector3 } | null {
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    let found = false;
    for (const mesh of this.meshesOf(nodes)) {
      if (mesh.getTotalVertices() === 0) continue;
      const box = mesh.getBoundingInfo().boundingBox;
      min.minimizeInPlace(box.minimumWorld);
      max.maximizeInPlace(box.maximumWorld);
      found = true;
    }
    return found ? { min, max } : null;
  }

  /** Frames the whole island, whatever the canvas shape; `reset` also restores the start view. */
  private fitCamera(reset: boolean): void {
    const aspect = this.engine.getAspectRatio(this.camera) || 1.6;
    const vertical = this.camera.fov;
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
    const radius = this.fitRadius / Math.sin(Math.min(vertical, horizontal) / 2);
    this.camera.lowerRadiusLimit = radius * 0.25;
    this.camera.upperRadiusLimit = radius * 1.05;
    if (reset) {
      this.camera.alpha = START_ALPHA;
      this.camera.beta = START_BETA;
      this.camera.radius = radius * 0.7;
    } else {
      this.camera.radius = Math.min(this.camera.upperRadiusLimit, Math.max(this.camera.lowerRadiusLimit, this.camera.radius));
    }
  }

  private layoutStars(): void {
    for (const star of this.stars) star.root.dispose();
    this.stars = [];
    const landmarkSpots = LEVEL_LANDMARKS
      .map((name) => this.landmarks.get(name))
      .filter((spot): spot is Vector3 => spot !== undefined);
    const extra = ringSpots(Math.max(0, this.keys.length - landmarkSpots.length), this.ground);
    this.keys.forEach((key, index) => {
      const ring = extra[index - landmarkSpots.length];
      const base = landmarkSpots[index]?.clone()
        ?? new Vector3(ring?.x ?? 0, this.groundHeightAt(ring?.x ?? 0, ring?.z ?? 0) + STAR_GROUND_HEIGHT, ring?.z ?? 0);
      const root = new TransformNode(`level-star-${index}`, this.scene);
      root.position.copyFrom(base);
      const gem = createStarGem(`level-star-gem-${index}`, this.scene);
      gem.parent = root;
      gem.material = this.starMaterial;
      gem.isPickable = false;
      gem.renderOutline = true;
      gem.outlineColor = OUTLINE;
      gem.outlineWidth = 0.035;
      // A generous invisible target, so a small star is still easy to click or tap.
      const target = MeshBuilder.CreateSphere(`level-star-target-${index}`, { diameter: STAR_OUTER * 2.6, segments: 6 }, this.scene);
      target.parent = root;
      target.visibility = 0;
      target.isPickable = true;
      target.metadata = { levelKey: key };
      this.stars.push({ key, root, gem, base, phase: index * 1.7 });
    });
    this.select(this.selectedKey);
  }

  /** Top of the solid ground at (x, z), for stars that have no landmark to sit on. */
  private groundHeightAt(x: number, z: number): number {
    const meshes = this.map ? this.meshesOf(this.map.rootNodes) : [];
    let highest = 0;
    for (const mesh of meshes) {
      if (!/Mapa_(Grama|Terra)/.test(mesh.name)) continue;
      const box = mesh.getBoundingInfo().boundingBox;
      if (x >= box.minimumWorld.x && x <= box.maximumWorld.x && z >= box.minimumWorld.z && z <= box.maximumWorld.z) {
        highest = Math.max(highest, box.maximumWorld.y);
      }
    }
    return highest;
  }

  private starAt(x: number, y: number): string | null {
    const pick = this.scene.pick(x, y, (mesh) => typeof mesh.metadata?.levelKey === "string");
    const key = pick?.hit ? (pick.pickedMesh?.metadata as { levelKey?: string } | null)?.levelKey : undefined;
    return key ?? null;
  }

  private animate(deltaSeconds: number): void {
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.elapsed += delta;
    const glide = 1 - Math.exp(-delta * 4);
    Vector3.LerpToRef(this.camera.target, this.targetGoal, glide, this.camera.target);
    for (const star of this.stars) {
      const selected = star.key === this.selectedKey;
      const hovered = star.key === this.hoveredKey;
      const emphasis = selected ? SELECTED_SCALE : hovered ? 1.15 : 1;
      if (this.reducedMotion) {
        star.root.position.copyFrom(star.base);
        star.root.scaling.setAll(emphasis);
        continue;
      }
      const t = this.elapsed;
      star.root.position.set(star.base.x, star.base.y + Math.sin(t * 2 + star.phase) * 0.09, star.base.z);
      star.root.rotation.y += delta * (selected ? 1.9 : 0.9);
      star.root.scaling.setAll(emphasis * (1 + Math.sin(t * 4.2 + star.phase) * 0.08));
    }
  }
}
