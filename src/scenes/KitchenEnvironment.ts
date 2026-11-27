import { t } from "../i18n";
import { isConstruction, ConstructionMaterials } from "../core/render/structureVisibility";
import { createBuildingMesh, isBuildingAsset } from "../editor/building";
import { WEDDING_HALL_PLACEMENTS } from "./weddingHall";
import {
  AbstractMesh,
  Color3,
  DirectionalLight,
  HemisphericLight,
  PointLight,
  Scene,
  TransformNode,
  Vector3,
  type Light,
  type Node as BabylonNode,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import type { MovementBounds } from "../entities/Player";
import type { StationId } from "../types/game";
import type { MapData, MapPlacedObject } from "../editor/MapData";
import type { MechanismConfig } from "../data/mechanismConfig";
import { footprintOf, isCrewKind, marchInWorld, type MechanismFootprint } from "../gameplay/mechanisms/MechanismSystem";
import { MarchLine } from "./MarchLine";
import { RobotCrew } from "./RobotCrew";
import {
  DEFAULT_KITCHEN_LAYOUT,
  stationsFromMap,
  type KitchenStationPlacement,
} from "../data/kitchenLayout";
import { WEDDING_SCENARIO, type ScenarioDefinition } from "../data/scenarios";
import { areaFitsWithin } from "../data/receptionFit";
import { sanitizeRobotConfig, type RobotSpawn } from "../data/robotConfig";
import { robotVariantOf } from "../data/robotVariants";
import {
  GROUND_FLOOR_COLLISION_GROUP,
  STEP_OVER_HEIGHT,
  isFloorAsset,
  isFootingAsset,
  isWallAsset,
  isSolidByDefault,
  measuredHeight,
  shouldCollide,
} from "../physics/collisionPolicy";
import { createPartitionedCollider, needsPartitioning } from "../physics/partitionedCollider";
import { excludeFromGroundProbe } from "../physics/groundProbe";
import { batchStaticMeshes } from "../core/render/staticBatching";
import { OutdoorBackdrop } from "./OutdoorBackdrop";
import { BUILD_LOT_HALF, depthNudge, isPostAsset } from "../editor/buildTools";
import { applyColorOverrides, MaterialOverrideCache } from "./materialOverrides";
import { MAX_PAULI_EMITTERS, PauliLighting, isPauliFixture } from "./PauliLighting";

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
  readonly category?: MapPlacedObject["category"];
  readonly collides?: boolean;
  readonly color?: string;
  /** Design-tool colours from the map: material name → hex. */
  readonly colors?: Readonly<Record<string, string>>;
  /**
   * Set only on a moving part. Its presence is what takes this placement out of the static
   * batch and gives it a node of its own to travel in. See AGENTS.md.
   */
  readonly mechanism?: MechanismConfig;
  /** The map object's own id; layout phases name mechanisms by it. */
  readonly objectId?: string;
}

/** One placed moving part: the node that travels, what it does, and where it started. */
export interface MechanismPlacement {
  /** The map object's id, which is how layout phases refer to it. */
  readonly id: string;
  readonly node: TransformNode;
  readonly config: MechanismConfig;
  readonly origin: Vector3;
  /**
   * The yaw the designer placed it at. A turntable spins on top of it and a conveyor pushes
   * relative to it, so rotating a belt in the editor is all it takes to aim it.
   */
  readonly originYaw: number;
  /** Everything it can ever cover, for the robots' navigation. */
  footprint: MechanismFootprint;
  /**
   * Height of the surface a passenger stands on, measured from the model.
   *
   * Without it a platform would only carry something level with its base — which is
   * nothing, since whatever rides it stands on its top.
   */
  topHeight: number;
  /**
   * The model's real size, in its own frame: half its extent along its own x and z, and
   * where its centre sits relative to the node. Measured, because a belt is two metres by
   * one and a fixed square around the node left both its ends dead.
   */
  halfExtentX: number;
  halfExtentZ: number;
  centerX: number;
  centerZ: number;
  /** A German parade's robots; only `march` mechanisms have them. */
  march?: MarchLine;
  /** Bottle throwers, brawlers or a panicking runner; only those kinds have them. */
  crew?: RobotCrew;
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
  canSupport = isFootingAsset(assetId),
): void => {
  const floor = isFloorAsset(assetId);
  const solid = shouldCollide(authoredSolid || floor, height, floor);
  const groundFloor = floor && height <= STEP_OVER_HEIGHT;
  for (const mesh of meshes) {
    mesh.checkCollisions = solid && mesh.getTotalVertices() > 0;
    if (mesh.checkCollisions && !canSupport) excludeFromGroundProbe(mesh);
    if (groundFloor) mesh.collisionGroup = GROUND_FLOOR_COLLISION_GROUP;
  }
};

export const STATION_ASSET_PLACEMENTS_REF: readonly ScenarioPlacement[] = STATION_ASSET_PLACEMENTS;
export const DECOR_PLACEMENTS_REF: readonly ScenarioPlacement[] = DECOR_PLACEMENTS;

const toVector3 = (value: { x: number; y: number; z: number }): Vector3 =>
  new Vector3(value.x, value.y, value.z);

/** Where a piece is drawn: walls and floor tiles a hair apart from their neighbours (see depthNudge). */
const nudged = (object: MapPlacedObject): Vector3 => {
  const position = toVector3(object.position);
  const kind = isFloorAsset(object.assetId)
    ? "floor"
    : object.assetId !== "scenario-room-wide" && isWallAsset(object.assetId, object.category) && !isPostAsset(object.assetId)
      ? "wall"
      : null;
  if (!kind) return position;
  const nudge = depthNudge(kind, object.position, object.rotation.y);
  return position.addInPlaceFromFloats(nudge.x, nudge.y, nudge.z);
};

/** Stations and dispensers are drawn by WorkstationView, so only decor is placed here. */
export const placementsFromMap = (map: MapData): readonly ScenarioPlacement[] =>
  map.objects.filter(object => object.role === "decor" || object.role === "mechanism").map((object, index) => {
    return {
      mechanism: object.mechanism,
      objectId: object.id,
      name: `custom-${object.role}-${index}`,
      assetId: object.assetId,
      category: object.category,
      position: nudged(object),
      rotation: toVector3(object.rotation),
      scale: toVector3(object.scale),
      // Maps saved before scenery was solid stored `false` everywhere, so the
      // category decides unless the object is one the policy never makes solid.
      collides: object.collides || isSolidByDefault(object),
      color: object.color,
      colors: object.colors,
    };
  });


export interface CustomMapAnchors {
  readonly stations: readonly KitchenStationPlacement[];
  readonly bounds: MovementBounds;
  readonly playerSpawn: Vector3;
  /** One per possible cook (`MAX_PLAYERS`), in player order. */
  readonly playerSpawns: readonly Vector3[];
}

/** Cooks are 0.66 m wide; spawns closer than this would start them inside each other. */
const SPAWN_SPACING = 0.8;

/**
 * Spawns for cooks three and four when a map only marks one and two: on the line between
 * those two, which is floor the level already promises a cook can stand on. When one and
 * two stand too close for that, three and four go either side of them instead.
 */
export const extraSpawns = (one: Readonly<Vector3>, two: Readonly<Vector3>): [Vector3, Vector3] => {
  const dx = two.x - one.x;
  const dz = two.z - one.z;
  const distance = Math.hypot(dx, dz);
  // Three gaps of SPAWN_SPACING; the epsilon keeps exactly 2.4 m (the default layout) in.
  if (distance >= SPAWN_SPACING * 3 - 1e-6) {
    return [Vector3.Lerp(one as Vector3, two as Vector3, 1 / 3), Vector3.Lerp(one as Vector3, two as Vector3, 2 / 3)];
  }
  // Perpendicular to the pair (or along x when they coincide).
  const nx = distance > 1e-3 ? -dz / distance : 0;
  const nz = distance > 1e-3 ? dx / distance : 1;
  const midX = (one.x + two.x) / 2;
  const midZ = (one.z + two.z) / 2;
  return [
    new Vector3(midX + nx * SPAWN_SPACING, one.y, midZ + nz * SPAWN_SPACING),
    new Vector3(midX - nx * SPAWN_SPACING, one.y, midZ - nz * SPAWN_SPACING),
  ];
};

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
  const marked = (index: number): Vector3 | null => {
    const spawn = map.objects.find(object => object.role === "spawn" && object.playerIndex === index);
    return spawn ? toVector3(spawn.position) : null;
  };
  // A spawn placed off the lot starts the cook on its edge instead of outside it.
  const one = inside(marked(1) ?? fallbackSpawn.add(new Vector3(-1.15, 0, 0)));
  const two = inside(marked(2) ?? fallbackSpawn.add(new Vector3(1.15, 0, 0)));
  const [three, four] = extraSpawns(one, two);
  const playerSpawns = [one, two, inside(marked(3) ?? three), inside(marked(4) ?? four)];
  const playerSpawn = one.add(two).scale(0.5);
  return { stations, bounds, playerSpawn, playerSpawns };
};

/** Robots a custom map placed, in the shape the crowd system wants. */
export const robotsFromMap = (map: MapData): RobotSpawn[] =>
  map.objects
    .filter(object => object.role === "robot")
    .map((object, index) => ({
      id: object.id,
      name: object.robot?.displayName || t("wedding.robotName", { number: String(index + 1).padStart(2, "0") }),
      position: { ...object.position },
      rotationY: object.rotation.y,
      config: sanitizeRobotConfig(object.robot),
      variant: robotVariantOf(object.assetId),
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
  /** One per possible cook, in player order. */
  readonly playerSpawns: readonly Vector3[];
  readonly kitchenStations: readonly KitchenStationPlacement[];
  /** Wedding reception floor; null lets the guests pick an area from the bounds. */
  readonly receptionArea: Readonly<MovementBounds> | null;

  private readonly lights: Light[] = [];
  readonly pauliLighting: PauliLighting | null;
  private readonly instances: ModelInstance[] = [];
  private readonly placementRoots: TransformNode[] = [];
  /** Recoloured material clones, shared by every object painted the same. */
  private readonly colorCache = new MaterialOverrideCache();
  private readonly constructionMaterials = new ConstructionMaterials();
  /**
   * The level's moving parts. They are deliberately outside `placementRoots`, which is
   * what keeps them out of the static batch and out of `freezeWorldMatrix` — see the
   * mechanism exception in AGENTS.md.
   */
  private readonly mechanismPlacements: MechanismPlacement[] = [];
  private readonly marchLines: MarchLine[] = [];
  private readonly crews: RobotCrew[] = [];
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
      this.playerSpawns = anchors.playerSpawns.map((spawn) => spawn.clone());
      this.kitchenStations = anchors.stations;
      // The scenario's reception only applies if it actually lands inside this map's room;
      // otherwise the carpet would float outside it and the guests walk through a wall.
      this.receptionArea = scenario.receptionArea && areaFitsWithin(scenario.receptionArea, anchors.bounds)
        ? scenario.receptionArea
        : null;
    } else {
      const layout = DEFAULT_KITCHEN_LAYOUT;
      this.bounds = layout.playerBounds;
      const one = new Vector3(layout.spawns[0].x, 0, layout.spawns[0].z);
      const two = new Vector3(layout.spawns[1].x, 0, layout.spawns[1].z);
      this.playerSpawns = [one, two, ...extraSpawns(one, two)];
      this.playerSpawn = one.add(two).scale(0.5);
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
    const placements = options.map ? placementsFromMap(options.map) : WEDDING_HALL_PLACEMENTS;
    this.pauliLighting = placements.some(({ assetId }) => isPauliFixture(assetId)) ? new PauliLighting(scene, this.root) : null;
    // Every level is batched, the editor's maps included: the official wedding is one, and
    // skipping them left its ~1,550 decor meshes as separate draw calls.
    this.ready = this.loadScenario(placements).then(() => { if (!this.disposed) this.batchStaticDecor(); });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const instance of this.instances) instance.dispose();
    this.instances.length = 0;
    for (const line of this.marchLines) line.dispose();
    this.marchLines.length = 0;
    for (const crew of this.crews) crew.dispose();
    this.crews.length = 0;
    for (const placementRoot of this.placementRoots) placementRoot.dispose(false, false);
    this.placementRoots.length = 0;
    this.pauliLighting?.dispose();
    for (const light of this.lights) light.dispose();
    this.backdrop.dispose();
    this.constructionMaterials.dispose();
    this.colorCache.dispose();
    this.root.dispose(false, false);
  }

  /**
   * Draws the level's decor as one batch per material (see `batchStaticMeshes`).
   *
   * Every floor tile and wall panel is its own model, and drawing them one by one was most
   * of each frame. Collision is untouched: solid pieces stay as invisible colliders, so the
   * cooks, the ground probe and the robots' navigation see exactly the same obstacles.
   */
  /** The level's moving parts, for `KitchenMechanisms` to drive and the robots to avoid. */
  get mechanisms(): readonly MechanismPlacement[] {
    return this.mechanismPlacements;
  }

  private async batchStaticDecor(): Promise<void> {
    if (this.disposed) return;
    // Each mechanism is batched inside its own node: it leaves the static batch, but it
    // still travels as one or two draw calls rather than one per plank. See AGENTS.md.
    for (const mechanism of this.mechanismPlacements) {
      await batchStaticMeshes(mechanism.node.getChildMeshes(false), mechanism.node, {
        shouldStop: () => this.disposed,
      });
      if (this.disposed) return;
    }
    const decor = this.placementRoots.flatMap((placementRoot) => placementRoot.getChildMeshes(false));
    await batchStaticMeshes(decor, this.root, {
      shouldStop: () => this.disposed,
    });
    if (this.disposed) return;
    // A model whose meshes all went into batches leaves its glTF node tree behind; frozen,
    // it costs nothing to keep for the colliders hanging off it.
    for (const placementRoot of this.placementRoots) placementRoot.freezeWorldMatrix();
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
    let remainingEmitters = MAX_PAULI_EMITTERS;
    await Promise.all(placements.map((placement, index) => {
      const fixture = this.pauliLighting && isPauliFixture(placement.assetId);
      // Newer maps can be opened in older clients. Their optional unknown decorations
      // remain in the JSON and the editor, but are omitted during the match.
      if (placement.name.startsWith("custom-decor-") &&
          !isBuildingAsset(placement.assetId) && !this.assets.has(placement.assetId)) return;
      return this.placeAsset(placement, index, fixture ? remainingEmitters-- > 0 : false);
    }));
  }

  private async placeAsset(placement: ScenarioPlacement, index: number, poweredFixture: boolean): Promise<void> {
    const placementRoot = new TransformNode(`scenario-${placement.name}-${index}`, this.scene);
    placementRoot.parent = this.root;
    placementRoot.position.copyFrom(placement.position);
    placementRoot.rotation.copyFrom(placement.rotation ?? Vector3.Zero());
    placementRoot.scaling.copyFrom(placement.scale ?? Vector3.One());
    // A parade's route is stored in its own frame; the runtime works in the world.
    const mechanism = placement.mechanism ? marchInWorld(placement.mechanism, placement.rotation?.y ?? 0) : undefined;
    if (mechanism) {
      this.mechanismPlacements.push({
        id: placement.objectId ?? placement.name,
        node: placementRoot,
        config: mechanism,
        origin: placement.position.clone(),
        originYaw: placement.rotation?.y ?? 0,
        // Measured below, once the model is in the scene; these hold until then.
        topHeight: 0,
        halfExtentX: Math.max(0.5, (placement.scale?.x ?? 1) * 0.6),
        halfExtentZ: Math.max(0.5, (placement.scale?.z ?? 1) * 0.6),
        centerX: 0,
        centerZ: 0,
        footprint: footprintOf(
          mechanism,
          { x: placement.position.x, z: placement.position.z },
          Math.max(0.5, (placement.scale?.x ?? 1) * 0.6),
        ),
      });
    } else {
      this.placementRoots.push(placementRoot);
    }

    // The parade is its robots, not the placed model: seven animated marchers under their
    // own node (skinned meshes have no place in the static batch). Nothing to collide
    // with either: KitchenMechanisms pushes cooks out of the column instead.
    if (mechanism?.kind === "march") {
      const line = new MarchLine(this.scene, this.assets, this.root, mechanism);
      this.marchLines.push(line);
      const entry = this.mechanismPlacements.find((candidate) => candidate.node === placementRoot);
      if (entry) entry.march = line;
      await line.ready.catch((error: unknown) => console.warn("German parade could not be loaded.", error));
      return;
    }
    // Likewise the party crews: robots, not the placed model.
    if (mechanism && isCrewKind(mechanism.kind)) {
      const crew = new RobotCrew(this.scene, this.assets, this.root, mechanism);
      this.crews.push(crew);
      const entry = this.mechanismPlacements.find((candidate) => candidate.node === placementRoot);
      if (entry) entry.crew = crew;
      await crew.ready.catch((error: unknown) => console.warn("Robot crew could not be loaded.", error));
      return;
    }

    const authoredSolid = placement.collides !== false;
    const construction = isConstruction(placement.assetId, placement.category);
    const building = createBuildingMesh(placement.assetId, this.scene, placementRoot, placement.color);
    if (building) {
      building.isPickable = false;
      if (construction) this.constructionMaterials.apply(building);
      building.receiveShadows = true;
      building.computeWorldMatrix(true);
      const box = building.getBoundingInfo().boundingBox;
      const height = measuredHeight(box.minimumWorld.y, box.maximumWorld.y);
      applyPlacementCollision([building], placement.assetId, authoredSolid, height,
        Boolean(mechanism) || isFootingAsset(placement.assetId));
      // The editor's own floor tile is the natural vanishing floor, and it is built here
      // rather than loaded, so its top has to be measured here too.
      if (placement.mechanism) this.setMechanismTop(placementRoot, height);
      return;
    }
    const instance = await this.assets.instantiateModel(placement.assetId, {
      namePrefix: `${placement.name}-${index}-`,
      parent: placementRoot,
      cloneMaterials: false,
    });
    if (this.disposed) {
      instance?.dispose();
      return;
    }
    if (!instance) throw new Error("Scenario model could not be instantiated: " + placement.assetId);
    this.instances.push(instance);
    if (placement.colors) applyColorOverrides(instance.rootNodes, placement.colors, this.colorCache);
    // Collision follows the art exactly: Babylon sweeps the cook's ellipsoid
    // against these triangles, so every mesh that draws is a mesh that blocks.
    const meshes = instance.rootNodes
      .flatMap((rootNode) => [rootNode, ...rootNode.getDescendants()])
      .filter((node): node is AbstractMesh => node instanceof AbstractMesh);
    const fixture = isPauliFixture(placement.assetId);
    if (fixture) this.pauliLighting?.attach(placement.assetId, placementRoot, meshes, poweredFixture);
    const modelHeight = this.measureModelHeight(instance.rootNodes);
    applyPlacementCollision(meshes, placement.assetId, authoredSolid && !fixture, modelHeight,
      Boolean(mechanism) || isFootingAsset(placement.assetId));
    if (placement.mechanism) this.setMechanismTop(placementRoot, modelHeight);
    for (const rootNode of instance.rootNodes) {
      for (const node of [rootNode, ...rootNode.getDescendants()]) {
        if (!(node instanceof AbstractMesh)) continue;
        node.isPickable = false;
        if (construction) this.constructionMaterials.apply(node);
        node.receiveShadows = true;
        // A collider as wide as the room would be swept in full on every step
        // anywhere in it; its triangles are regrouped by location, once, here.
        if (node.checkCollisions && needsPartitioning(node)) createPartitionedCollider(node);
      }
    }
  }

  /**
   * Records a mechanism's real shape once its model is in the scene: the surface a
   * passenger stands on, and its size and centre in its own frame.
   */
  private setMechanismTop(node: TransformNode, height: number): void {
    const mechanism = this.mechanismPlacements.find((entry) => entry.node === node);
    if (!mechanism) return;
    mechanism.topHeight = height;

    // Measured with its own turn taken off, so the box lines up with its own axes.
    const turn = node.rotation.y;
    node.rotation.y = 0;
    node.computeWorldMatrix(true);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const mesh of node.getChildMeshes(false)) {
      if (mesh.getTotalVertices() === 0) continue;
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      minX = Math.min(minX, box.minimumWorld.x);
      maxX = Math.max(maxX, box.maximumWorld.x);
      minZ = Math.min(minZ, box.minimumWorld.z);
      maxZ = Math.max(maxZ, box.maximumWorld.z);
    }
    node.rotation.y = turn;
    node.computeWorldMatrix(true);
    if (!Number.isFinite(minX) || maxX <= minX || maxZ <= minZ) return;

    mechanism.halfExtentX = Math.max(0.3, (maxX - minX) / 2);
    mechanism.halfExtentZ = Math.max(0.3, (maxZ - minZ) / 2);
    mechanism.centerX = (maxX + minX) / 2 - node.position.x;
    mechanism.centerZ = (maxZ + minZ) / 2 - node.position.z;
    // The robots keep clear of everywhere it can reach, whichever way it is turned.
    mechanism.footprint = footprintOf(
      mechanism.config,
      { x: mechanism.origin.x, z: mechanism.origin.z },
      Math.hypot(mechanism.halfExtentX, mechanism.halfExtentZ),
    );
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
