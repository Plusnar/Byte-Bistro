import { createBuildingMesh } from "../editor/building";
import { WEDDING_HALL_PLACEMENTS } from "./weddingHall";
import {
  AbstractMesh,
  Color3,
  DirectionalLight,
  HemisphericLight,
  Mesh,
  Plane,
  PointLight,
  Scene,
  TransformNode,
  Vector3,
  type Light,
  type Node as BabylonNode,
  type Nullable,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import type { MovementBounds } from "../entities/Player";
import type { StationId } from "../types/game";
import type { MapData, MapPlacedObject } from "../editor/MapData";
import { wrapAngle } from "../editor/MapData";
import {
  DEFAULT_KITCHEN_LAYOUT,
  stationsFromMap,
  type KitchenStationPlacement,
} from "../data/kitchenLayout";
import { WEDDING_SCENARIO, type ScenarioDefinition } from "../data/scenarios";
import { areaFitsWithin } from "../data/receptionFit";
import { sanitizeRobotConfig, type RobotSpawn } from "../data/robotConfig";
import {
  GROUND_FLOOR_COLLISION_GROUP,
  STEP_OVER_HEIGHT,
  isFloorAsset,
  isWallAsset,
  isSolidByDefault,
  measuredHeight,
  shouldCollide,
} from "../physics/collisionPolicy";
import { createPartitionedCollider, needsPartitioning } from "../physics/partitionedCollider";
import { OutdoorBackdrop } from "./OutdoorBackdrop";
import { BUILD_LOT_HALF, isWallCutAway } from "../editor/buildTools";
import { GAME_CONFIG } from "../config";
import { applyColorOverrides, MaterialOverrideCache } from "./materialOverrides";

export interface StationAnchor {
  readonly id: StationId;
  readonly position: Vector3;
  readonly rotationY: number;
  readonly label: string;
  readonly color: string;
}

export interface DispenserAnchor {
  readonly ingredientId: string;
  readonly position: Vector3;
  readonly rotationY: number;
  readonly label: string;
  readonly color: string;
}

export interface ScenarioPlacement {
  readonly name: string;
  readonly assetId: string;
  readonly position: Vector3;
  readonly rotation?: Vector3;
  readonly scale?: Vector3;
  readonly collides?: boolean;
  readonly color?: string;
  /** Design-tool colours from the map: material name → hex. */
  readonly colors?: Readonly<Record<string, string>>;
  /**
   * Cutaway: geometry south of this world z is not drawn, so the wall between
   * the camera and the kitchen never hides the front counters.
   */
  readonly clipBelowZ?: number;
}

export const KITCHEN_STATION_ANCHORS: readonly StationAnchor[] = [
  {
    id: "ingredient_dispenser",
    position: new Vector3(-8.15, 0, -5.72),
    rotationY: Math.PI,
    label: "Ingredients",
    color: "#44DFFF",
  },
  {
    id: "bit_crusher",
    position: new Vector3(-8.2, 0, -2.55),
    rotationY: -Math.PI * 0.5,
    label: "Bit Crusher",
    color: "#FF65C3",
  },
  {
    id: "data_mixer",
    position: new Vector3(-8.05, 0, 0.35),
    rotationY: -Math.PI * 0.5,
    label: "Data Mixer",
    color: "#A986FF",
  },
  {
    id: "cache_freezer",
    position: new Vector3(-8.2, 0, 3.45),
    rotationY: -Math.PI * 0.5,
    label: "Cache Freezer",
    color: "#55E7FF",
  },
  {
    id: "compiler_oven",
    position: new Vector3(8.15, 0, 3.4),
    rotationY: Math.PI * 0.5,
    label: "Compiler Oven",
    color: "#FF8B4D",
  },
  {
    id: "plating_station",
    position: new Vector3(8.15, 0, 0.2),
    rotationY: Math.PI * 0.5,
    label: "Plating Scanner",
    color: "#7DFFAD",
  },
  {
    id: "serving_terminal",
    position: new Vector3(0, 0, 5.05),
    rotationY: 0,
    label: "Feed CORE",
    color: "#40F2FF",
  },
];

export const KITCHEN_DISPENSER_ANCHORS: readonly DispenserAnchor[] = [
  {
    ingredientId: "ram_module",
    position: new Vector3(-8.15, 0, -5.72),
    rotationY: Math.PI,
    label: "RAM Module",
    color: "#48D9FF",
  },
  {
    ingredientId: "binary_sugar",
    position: new Vector3(-4.9, 0, -5.72),
    rotationY: Math.PI,
    label: "Binary Sugar",
    color: "#FFD166",
  },
  {
    ingredientId: "cache_cream",
    position: new Vector3(-1.65, 0, -5.72),
    rotationY: Math.PI,
    label: "Cache Cream",
    color: "#F38BFF",
  },
  {
    ingredientId: "cache_fragment",
    position: new Vector3(1.65, 0, -5.72),
    rotationY: Math.PI,
    label: "Cache Fragment",
    color: "#FF9F43",
  },
  {
    ingredientId: "cooling_fluid",
    position: new Vector3(4.9, 0, -5.72),
    rotationY: Math.PI,
    label: "Cooling Fluid",
    color: "#5DE4FF",
  },
  {
    ingredientId: "data_cream",
    position: new Vector3(8.15, 0, -5.72),
    rotationY: Math.PI,
    label: "Data Cream",
    color: "#B8A1FF",
  },
];

const STATION_ASSET_PLACEMENTS: readonly ScenarioPlacement[] = [
  ...KITCHEN_DISPENSER_ANCHORS.map((anchor, index): ScenarioPlacement => ({
    name: `supply-hopper-${index + 1}`,
    assetId: "scenario-hopper",
    position: anchor.position,
    rotation: new Vector3(0, anchor.rotationY, 0),
    scale: new Vector3(1.18, 1.08, 1.18),
  })),
  {
    name: "bit-crusher",
    assetId: "scenario-machine-fortified",
    position: KITCHEN_STATION_ANCHORS[1]!.position,
    rotation: new Vector3(0, KITCHEN_STATION_ANCHORS[1]!.rotationY, 0),
    scale: new Vector3(1.28, 1.2, 1.18),
  },
  {
    name: "data-mixer",
    assetId: "scenario-machine-bed",
    position: KITCHEN_STATION_ANCHORS[2]!.position,
    rotation: new Vector3(0, KITCHEN_STATION_ANCHORS[2]!.rotationY, 0),
    scale: new Vector3(0.86, 1.08, 0.86),
  },
  {
    name: "cache-freezer",
    assetId: "scenario-freezer-standing",
    position: KITCHEN_STATION_ANCHORS[3]!.position,
    rotation: new Vector3(0, KITCHEN_STATION_ANCHORS[3]!.rotationY, 0),
    scale: new Vector3(1.75, 1.75, 1.75),
  },
  {
    name: "compiler-oven",
    assetId: "scenario-machine",
    position: KITCHEN_STATION_ANCHORS[4]!.position,
    rotation: new Vector3(0, KITCHEN_STATION_ANCHORS[4]!.rotationY, 0),
    scale: new Vector3(1.38, 1.22, 1.25),
  },
  {
    name: "plating-scanner",
    assetId: "scenario-scanner-low",
    position: KITCHEN_STATION_ANCHORS[5]!.position,
    rotation: new Vector3(0, KITCHEN_STATION_ANCHORS[5]!.rotationY, 0),
    scale: new Vector3(1.65, 1.24, 1.18),
  },
  {
    name: "serving-conveyor",
    assetId: "scenario-conveyor-long",
    position: KITCHEN_STATION_ANCHORS[6]!.position,
    scale: new Vector3(1.28, 1.05, 1.25),
  },
  {
    name: "serving-register",
    assetId: "scenario-cash-register",
    position: new Vector3(0.52, 0.43, 5.02),
    rotation: new Vector3(0, Math.PI, 0),
    scale: new Vector3(1.05, 1.05, 1.05),
  },
];

const DECOR_PLACEMENTS: readonly ScenarioPlacement[] = [
  {
    name: "server-room-shell",
    assetId: "scenario-room-wide",
    position: Vector3.Zero(),
    scale: new Vector3(1.08, 1.08, 1.22),
    collides: true,
    clipBelowZ: -5.1,
  },
  {
    name: "maintenance-robot-arm",
    assetId: "scenario-robot-arm",
    position: new Vector3(6.65, 0.25, 5.55),
    rotation: new Vector3(0, -Math.PI * 0.35, 0),
    scale: new Vector3(1.45, 1.45, 1.45),
  },
  {
    name: "supply-shelf-west",
    assetId: "scenario-shelf-boxes",
    position: new Vector3(-9.0, 0, 5.55),
    rotation: new Vector3(0, -Math.PI * 0.5, 0),
    scale: new Vector3(1.45, 1.45, 1.45),
    collides: true,
  },
  {
    name: "cable-trench-a",
    collides: false,
    assetId: "scenario-cables",
    position: new Vector3(-2.6, 0.015, 3.25),
    rotation: new Vector3(0, Math.PI * 0.5, 0),
    scale: new Vector3(1.15, 1, 1.15),
  },
  {
    name: "cable-trench-b",
    collides: false,
    assetId: "scenario-cables",
    position: new Vector3(3.0, 0.015, -0.75),
    scale: new Vector3(0.9, 1, 0.9),
  },
  ...[-6.2, -3.1, 0, 3.1, 6.2].map((x, index): ScenarioPlacement => ({
    name: `coolant-pipe-${index + 1}`,
    assetId: index === 2 ? "scenario-pipe-valve" : "scenario-pipe-long",
    position: new Vector3(x, 3.05, 6.05),
    scale: index === 2
      ? new Vector3(0.86, 0.86, 0.86)
      : new Vector3(1.65, 0.82, 0.82),
  })),
  {
    name: "pipe-corner-west",
    assetId: "scenario-pipe-bend",
    position: new Vector3(-8.65, 3.05, 5.85),
    rotation: new Vector3(0, Math.PI, 0),
    scale: new Vector3(0.82, 0.82, 0.82),
  },
  // Storage now sits in the reception corners; the kitchen walls hold counters.
  {
    name: "storage-box-reception",
    assetId: "scenario-box-large",
    position: new Vector3(8.4, 0, 4.4),
    rotation: new Vector3(0, -Math.PI * 0.08, 0),
    scale: new Vector3(1.12, 1.12, 1.12),
    collides: true,
  },
  {
    name: "storage-box-reception-top",
    assetId: "scenario-box-small",
    position: new Vector3(8.2, 0.64, 4.4),
    rotation: new Vector3(0, Math.PI * 0.14, 0),
    scale: new Vector3(1.12, 1.12, 1.12),
  },
];

let environmentSequence = 0;

/**
 * Collision for the meshes of one placed object: building primitives and loaded models
 * alike. `height` is how high the object reaches (see `measuredHeight`).
 *
 * Floors are solid at any height so cooks can stand on upper storeys and platforms; the
 * ones at ground level also join a collision group robots leave out of their sweep.
 */
export const applyPlacementCollision = (
  meshes: readonly AbstractMesh[],
  assetId: string,
  authoredSolid: boolean,
  height: number,
): void => {
  const floor = isFloorAsset(assetId);
  const solid = shouldCollide(authoredSolid || floor, height, floor);
  const groundFloor = floor && height <= STEP_OVER_HEIGHT;
  for (const mesh of meshes) {
    mesh.checkCollisions = solid && mesh.getTotalVertices() > 0;
    if (groundFloor) mesh.collisionGroup = GROUND_FLOOR_COLLISION_GROUP;
  }
};

export const STATION_ASSET_PLACEMENTS_REF: readonly ScenarioPlacement[] = STATION_ASSET_PLACEMENTS;
export const DECOR_PLACEMENTS_REF: readonly ScenarioPlacement[] = DECOR_PLACEMENTS;

const toVector3 = (value: { x: number; y: number; z: number }): Vector3 =>
  new Vector3(value.x, value.y, value.z);

/**
 * The game camera's cutaway, as in the editor: walls standing between the fixed camera and
 * the middle of the play area are built as low stubs, so they never hide the cooks.
 */
export interface MapCutaway {
  readonly target: { readonly x: number; readonly z: number };
  readonly camera: { readonly x: number; readonly z: number };
}

/** Walls lowered by the cutaway keep this much of their height (see the editor's views). */
export const CUTAWAY_WALL_SCALE = 0.12;

const cutScale = (object: MapPlacedObject, cutaway?: MapCutaway): Vector3 => {
  const scale = toVector3(object.scale);
  const cut = cutaway && object.assetId !== "scenario-room-wide" &&
    isWallAsset(object.assetId, object.category) &&
    isWallCutAway({ x: object.position.x, z: object.position.z }, cutaway.target, cutaway.camera);
  if (cut) scale.y *= CUTAWAY_WALL_SCALE;
  return scale;
};

/** Stations and dispensers are drawn by WorkstationView, so only decor is placed here. */
export const placementsFromMap = (map: MapData, cutaway?: MapCutaway): readonly ScenarioPlacement[] =>
  map.objects.filter(object => object.role === "decor").map((object, index) => ({
    name: `custom-${object.role}-${index}`,
    assetId: object.assetId,
    position: toVector3(object.position),
    rotation: toVector3(object.rotation),
    scale: cutScale(object, cutaway),
    // Maps saved before scenery was solid stored `false` everywhere, so the
    // category decides unless the object is one the policy never makes solid.
    collides: object.collides || isSolidByDefault(object),
    color: object.color,
    colors: object.colors,
    // The room shell's front wall (6 units from its centre) would hide the kitchen.
    // Wrapped first: a shell turned a full circle faces the camera just the same.
    clipBelowZ: object.assetId === "scenario-room-wide" && Math.abs(wrapAngle(object.rotation.y)) < 0.01
      ? object.position.z - 6 * object.scale.z + 2.2
      : undefined,
  }));


export interface CustomMapAnchors {
  readonly stations: readonly KitchenStationPlacement[];
  readonly bounds: MovementBounds;
  readonly playerSpawn: Vector3;
  readonly playerSpawns: readonly [Vector3, Vector3];
}

/**
 * Where the cooks play: floors, stations, crates and spawns. Scenery is left out — the size
 * of a model is only guessed from its scale, so a church, a tree or a prop placed far away
 * used to stretch the walkable area off the floor.
 */
const isPlayAreaObject = (object: MapPlacedObject): boolean =>
  object.role === "station" || object.role === "dispenser" || object.role === "spawn" ||
  isFloorAsset(object.assetId);

/** Half the footprint of an object, per unit of scale. */
const footprintHalf = (assetId: string): number => {
  if (assetId === "build-floor") return 1;
  // Library floor tiles are 1 m modules (the packs' pack.json scale makes them 1.25 m).
  if (isFloorAsset(assetId)) return 0.5;
  return 1.5;
};

export const computeBounds = (allObjects: readonly MapPlacedObject[]): MovementBounds => {
  const playArea = allObjects.filter(isPlayAreaObject);
  // A map of pure scenery keeps the old behaviour rather than collapsing to nothing.
  const objects = playArea.length > 0 ? playArea : allObjects;
  if (objects.length === 0) {
    return { minX: -9.75, maxX: 9.75, minZ: -6.55, maxZ: 6.45 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const object of objects) {
    const half = footprintHalf(object.assetId);
    const halfX = Math.abs(object.scale.x) * half;
    const halfZ = Math.abs(object.scale.z) * half;
    const extentX = Math.abs(Math.cos(object.rotation.y)) * halfX + Math.abs(Math.sin(object.rotation.y)) * halfZ;
    const extentZ = Math.abs(Math.sin(object.rotation.y)) * halfX + Math.abs(Math.cos(object.rotation.y)) * halfZ;
    minX = Math.min(minX, object.position.x - extentX);
    maxX = Math.max(maxX, object.position.x + extentX);
    minZ = Math.min(minZ, object.position.z - extentZ);
    maxZ = Math.max(maxZ, object.position.z + extentZ);
  }
  const padX = 1.5;
  const padZ = 1.5;
  return {
    minX: minX - padX,
    maxX: maxX + padX,
    minZ: minZ - padZ,
    maxZ: maxZ + padZ,
  };
};

/**
 * How far inside the lot line a character's centre may go: its collision capsule (0.33 m)
 * plus a margin, so no part of a cook or robot ever crosses the marked border.
 */
export const LOT_EDGE_INSET = 0.45;

/**
 * Cuts movement bounds to the buildable lot — the area marked in the editor. Whatever the map
 * holds (a floor laid past the line, scenery far out, the padding around the play area),
 * nobody walks off the lot.
 */
export const clampToLot = (bounds: MovementBounds): MovementBounds => {
  const edge = BUILD_LOT_HALF - LOT_EDGE_INSET;
  const clamp = (value: number): number => Math.max(-edge, Math.min(edge, value));
  const minX = clamp(bounds.minX);
  const maxX = clamp(bounds.maxX);
  const minZ = clamp(bounds.minZ);
  const maxZ = clamp(bounds.maxZ);
  // A map built entirely off the lot would collapse to a line; keep the whole lot instead.
  if (maxX - minX < 1 || maxZ - minZ < 1) return { minX: -edge, maxX: edge, minZ: -edge, maxZ: edge };
  return { minX, maxX, minZ, maxZ };
};

export const deriveAnchorsFromMap = (map: MapData): CustomMapAnchors => {
  const stations = stationsFromMap(map);
  const bounds = clampToLot(computeBounds(map.objects));
  const inside = (point: Vector3): Vector3 => new Vector3(
    Math.max(bounds.minX, Math.min(bounds.maxX, point.x)),
    point.y,
    Math.max(bounds.minZ, Math.min(bounds.maxZ, point.z)),
  );
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const floor = map.objects.find(object => object.assetId === "build-floor");
  const fallbackSpawn = floor
    ? new Vector3(floor.position.x, 0, floor.position.z)
    : new Vector3(centerX, 0, Math.min(bounds.minZ + 1.5, centerZ));
  const playerOne = map.objects.find(object => object.role === "spawn" && object.playerIndex === 1);
  const playerTwo = map.objects.find(object => object.role === "spawn" && object.playerIndex === 2);
  // A spawn placed off the lot starts the cook on its edge instead of outside it.
  const playerSpawns: [Vector3, Vector3] = [
    inside(playerOne ? toVector3(playerOne.position) : fallbackSpawn.add(new Vector3(-1.15, 0, 0))),
    inside(playerTwo ? toVector3(playerTwo.position) : fallbackSpawn.add(new Vector3(1.15, 0, 0))),
  ];
  const playerSpawn = playerSpawns[0].add(playerSpawns[1]).scale(0.5);
  return { stations, bounds, playerSpawn, playerSpawns };
};

/** Robots a custom map placed, in the shape the crowd system wants. */
export const robotsFromMap = (map: MapData): RobotSpawn[] =>
  map.objects
    .filter(object => object.role === "robot")
    .map((object, index) => ({
      id: object.id,
      name: object.robot?.displayName || `Robô-${String(index + 1).padStart(2, "0")}`,
      position: { ...object.position },
      rotationY: object.rotation.y,
      config: sanitizeRobotConfig(object.robot),
    }));

export interface KitchenEnvironmentOptions {
  readonly map?: MapData;
  /** Lighting, reception and menu rules for this shift. */
  readonly scenario?: ScenarioDefinition;
}

/** Asset-built SERVER ROOM 01 assembled from the curated Scenario packs. */
export class KitchenEnvironment {
  readonly root: TransformNode;
  readonly ready: Promise<void>;
  /** Sky, lawn and the town around the level: its own root, never merged, solid or glowing. */
  readonly backdrop: OutdoorBackdrop;
  readonly bounds: Readonly<MovementBounds>;
  readonly playerSpawn: Vector3;
  readonly playerSpawns: readonly [Vector3, Vector3];
  readonly kitchenStations: readonly KitchenStationPlacement[];
  /** Wedding reception floor; null lets the guests pick an area from the bounds. */
  readonly receptionArea: Readonly<MovementBounds> | null;

  private readonly lights: Light[] = [];
  private readonly instances: ModelInstance[] = [];
  private readonly placementRoots: TransformNode[] = [];
  /** Recoloured material clones, shared by every object painted the same. */
  private readonly colorCache = new MaterialOverrideCache();
  private disposed = false;

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetManager,
    options: KitchenEnvironmentOptions = {},
  ) {
    const sequence = environmentSequence++;
    const scenario = options.scenario ?? WEDDING_SCENARIO;
    this.root = new TransformNode(`kitchen-environment-${sequence}`, scene);

    if (options.map) {
      const anchors = deriveAnchorsFromMap(options.map);
      this.bounds = anchors.bounds;
      this.playerSpawn = anchors.playerSpawn.clone();
      this.playerSpawns = [anchors.playerSpawns[0].clone(), anchors.playerSpawns[1].clone()];
      this.kitchenStations = anchors.stations;
      // The scenario's reception only applies if it actually lands inside this map's room;
      // otherwise the carpet would float outside it and the guests walk through a wall.
      this.receptionArea = scenario.receptionArea && areaFitsWithin(scenario.receptionArea, anchors.bounds)
        ? scenario.receptionArea
        : null;
    } else {
      const layout = DEFAULT_KITCHEN_LAYOUT;
      this.bounds = layout.playerBounds;
      this.playerSpawns = [
        new Vector3(layout.spawns[0].x, 0, layout.spawns[0].z),
        new Vector3(layout.spawns[1].x, 0, layout.spawns[1].z),
      ];
      this.playerSpawn = this.playerSpawns[0].add(this.playerSpawns[1]).scale(0.5);
      this.kitchenStations = layout.stations;
      this.receptionArea = scenario.receptionArea ?? layout.receptionArea;
    }

    scene.collisionsEnabled = true;
    // Also sets the clear and fog colour to the horizon, in place of the old black void.
    this.backdrop = new OutdoorBackdrop(scene, assets);
    scene.ambientColor = Color3.FromHexString(
      options.map?.environment.ambient ?? scenario.lighting.ambient,
    );
    this.createLighting(sequence, scenario);

    // The main level is the wedding hall; DECOR_PLACEMENTS (the old server room) now only
    // feeds the editor's catalogue.
    // Custom maps get the cutaway; the built-in hall is authored open on the camera side.
    const centre = { x: (this.bounds.minX + this.bounds.maxX) / 2, z: (this.bounds.minZ + this.bounds.maxZ) / 2 };
    const placements = options.map
      ? placementsFromMap(options.map, {
        target: centre,
        camera: { x: centre.x + GAME_CONFIG.camera.offsetX, z: centre.z + GAME_CONFIG.camera.offsetZ },
      })
      : WEDDING_HALL_PLACEMENTS;
    this.ready = this.loadScenario(placements).then(() => {
      if (!options.map && !this.disposed) this.mergeStaticDecor();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const instance of this.instances) instance.dispose();
    this.instances.length = 0;
    for (const placementRoot of this.placementRoots) placementRoot.dispose(false, false);
    this.placementRoots.length = 0;
    for (const light of this.lights) light.dispose();
    this.backdrop.dispose();
    this.colorCache.dispose();
    this.root.dispose(false, false);
  }

  /**
   * Merges the hall's decor into one mesh per material.
   *
   * The wedding hall is ~1,200 small meshes (every floor tile and wall panel is its own
   * model), and each cost a draw call plus per-frame culling — it took the shift from
   * ~34 to ~17 fps. They never move, so meshes sharing a material and the same collision
   * setup become one: identical pixels, a few dozen draw calls. Merged meshes large enough
   * to be expensive to sweep are then partitioned like any other big collider.
   */
  private mergeStaticDecor(): void {
    const groups = new Map<string, Mesh[]>();
    for (const placementRoot of this.placementRoots) {
      for (const mesh of placementRoot.getChildMeshes(false)) {
        if (!(mesh instanceof Mesh) || mesh.getTotalVertices() === 0 || !mesh.material) continue;
        if (mesh.skeleton || mesh.morphTargetManager || mesh.subMeshes?.length !== 1) continue;
        // Already stood in for by a partitioned collider, which dies with its source.
        if (needsPartitioning(mesh)) continue;
        const key = [
          mesh.material.uniqueId,
          mesh.checkCollisions,
          mesh.collisionGroup,
          mesh.getVerticesDataKinds().sort().join(","),
        ].join("|");
        const group = groups.get(key);
        if (group) group.push(mesh);
        else groups.set(key, [mesh]);
      }
    }
    for (const meshes of groups.values()) {
      if (meshes.length < 2) continue;
      const first = meshes[0]!;
      const solid = first.checkCollisions;
      const collisionGroup = first.collisionGroup;
      const merged = Mesh.MergeMeshes(meshes, true, true);
      if (!merged) continue;
      merged.parent = this.root;
      merged.isPickable = false;
      merged.receiveShadows = true;
      merged.checkCollisions = solid;
      merged.collisionGroup = collisionGroup;
      merged.freezeWorldMatrix();
      if (solid && needsPartitioning(merged)) createPartitionedCollider(merged);
    }
    // What is left of a fully merged model is its empty glTF node tree, which would still be
    // walked and culled every frame.
    for (const placementRoot of this.placementRoots) {
      const drawsSomething = placementRoot.getChildMeshes(false).some((mesh) => mesh.getTotalVertices() > 0);
      if (!drawsSomething) for (const child of placementRoot.getChildren()) child.dispose();
    }
  }

  /**
   * Decor meshes that do not glow. The glow layer runs in exclusion mode, re-drawing every
   * mesh it is not told to skip; for walls, floors and furniture that second pass only
   * paints black, and in the wedding hall it was a large share of each frame.
   */
  nonGlowingDecor(): AbstractMesh[] {
    return this.root.getChildMeshes(false).filter((mesh) => {
      if (mesh.getTotalVertices() === 0 || !mesh.material) return false;
      const material = mesh.material as { emissiveColor?: Color3; emissiveTexture?: unknown };
      const emissive = material.emissiveColor;
      return !material.emissiveTexture && (!emissive || emissive.r + emissive.g + emissive.b < 0.01);
    });
  }

  private async loadScenario(placements: readonly ScenarioPlacement[]): Promise<void> {
    await Promise.all(placements.map((placement, index) => this.placeAsset(placement, index)));
  }

  private async placeAsset(placement: ScenarioPlacement, index: number): Promise<void> {
    const placementRoot = new TransformNode(`scenario-${placement.name}-${index}`, this.scene);
    placementRoot.parent = this.root;
    placementRoot.position.copyFrom(placement.position);
    placementRoot.rotation.copyFrom(placement.rotation ?? Vector3.Zero());
    placementRoot.scaling.copyFrom(placement.scale ?? Vector3.One());
    this.placementRoots.push(placementRoot);

    const authoredSolid = placement.collides !== false;

    const building = createBuildingMesh(placement.assetId, this.scene, placementRoot, placement.color);
    if (building) {
      building.isPickable = false;
      building.receiveShadows = true;
      building.computeWorldMatrix(true);
      const box = building.getBoundingInfo().boundingBox;
      applyPlacementCollision(
        [building],
        placement.assetId,
        authoredSolid,
        measuredHeight(box.minimumWorld.y, box.maximumWorld.y),
      );
      return;
    }
    const instance = await this.assets.instantiateModel(placement.assetId, {
      namePrefix: `${placement.name}-${index}-`,
      parent: placementRoot,
      cloneMaterials: false,
    });
    if (!instance) {
      throw new Error(`Scenario model could not be instantiated: ${placement.assetId}`);
    }
    if (this.disposed) {
      instance.dispose();
      return;
    }
    this.instances.push(instance);
    if (placement.colors) applyColorOverrides(instance.rootNodes, placement.colors, this.colorCache);
    const clip = placement.clipBelowZ === undefined
      ? null
      : new Plane(0, 0, -1, placement.clipBelowZ);

    // Collision follows the art exactly: Babylon sweeps the cook's ellipsoid
    // against these triangles, so every mesh that draws is a mesh that blocks.
    const meshes = instance.rootNodes
      .flatMap((rootNode) => [rootNode, ...rootNode.getDescendants()])
      .filter((node): node is AbstractMesh => node instanceof AbstractMesh);
    applyPlacementCollision(meshes, placement.assetId, authoredSolid, this.measureModelHeight(instance.rootNodes));
    for (const rootNode of instance.rootNodes) {
      for (const node of [rootNode, ...rootNode.getDescendants()]) {
        if (!(node instanceof AbstractMesh)) continue;
        node.isPickable = false;
        node.receiveShadows = true;
        if (clip && node instanceof Mesh) this.clipMesh(node, clip);
        // A collider as wide as the room would be swept in full on every step
        // anywhere in it; its triangles are regrouped by location, once, here.
        if (node.checkCollisions && needsPartitioning(node)) createPartitionedCollider(node);
      }
    }
  }

  /**
   * World-space height of a loaded model.
   *
   * Only the mesh knows whether a placement is a counter or a cable run, so the
   * walk-over decision is taken here rather than guessed from the asset name.
   */
  private measureModelHeight(roots: readonly BabylonNode[]): number {
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (const root of roots) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh) || node.getTotalVertices() === 0) continue;
        node.computeWorldMatrix(true);
        const box = node.getBoundingInfo().boundingBox;
        minimumY = Math.min(minimumY, box.minimumWorld.y);
        maximumY = Math.max(maximumY, box.maximumWorld.y);
      }
    }
    return measuredHeight(minimumY, maximumY);
  }

  /** Scene clip planes are global, so enable one only while this mesh renders. */
  private clipMesh(mesh: Mesh, plane: Plane): void {
    let previous: Nullable<Plane> = null;
    mesh.onBeforeRenderObservable.add(() => {
      previous = this.scene.clipPlane;
      this.scene.clipPlane = plane;
    });
    mesh.onAfterRenderObservable.add(() => {
      this.scene.clipPlane = previous;
    });
  }

  /**
   * Builds the scenario's light rig.
   *
   * StandardMaterial sums every light and clamps the result at 1.0, so a scenario whose
   * intensities add up past that will render as flat white no matter what its colours say.
   */
  private createLighting(sequence: number, scenario: ScenarioDefinition): void {
    const lighting = scenario.lighting;
    const toVector = (value: { x: number; y: number; z: number }): Vector3 =>
      new Vector3(value.x, value.y, value.z);

    const ambient = new HemisphericLight(
      `scenario-ambient-${sequence}`,
      toVector(lighting.hemispheric.direction),
      this.scene,
    );
    ambient.diffuse = Color3.FromHexString(lighting.hemispheric.colour);
    ambient.groundColor = Color3.FromHexString(lighting.hemispheric.groundColour);
    ambient.intensity = lighting.hemispheric.intensity;
    this.lights.push(ambient);

    const key = new DirectionalLight(
      `scenario-key-${sequence}`,
      toVector(lighting.key.direction),
      this.scene,
    );
    if (lighting.key.position) key.position.copyFrom(toVector(lighting.key.position));
    key.diffuse = Color3.FromHexString(lighting.key.colour);
    key.intensity = lighting.key.intensity;
    this.lights.push(key);

    for (const [index, accent] of lighting.accents.entries()) {
      const light = new PointLight(
        `scenario-accent-${sequence}-${index}`,
        toVector(accent.position),
        this.scene,
      );
      light.diffuse = Color3.FromHexString(accent.colour);
      light.intensity = accent.intensity;
      light.range = accent.range;
      this.lights.push(light);
    }
  }
}
