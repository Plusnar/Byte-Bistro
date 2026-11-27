/**
 * Which things in the kitchen are solid, and which the cooks walk straight over.
 *
 * Kept Babylon-free so the rules can be unit tested and shared by the runtime
 * scene, the map editor and saved-map loading without any of them drifting.
 *
 * The collision itself is Babylon's swept-ellipsoid test against real mesh
 * triangles, so a collider is never larger or smaller than the art: this module
 * only decides *whether* a mesh takes part, never invents a shape for it.
 */

/**
 * How high a cook can climb in one step. When a move is blocked it is retried
 * this much higher, and kept only if it lands on a surface no taller than this.
 *
 * Sized from the level's own geometry. The KayKit staircases rise 0.50 m per
 * step, and the lowest solid prop in the kitchen (the reception crate) stands
 * 0.616 m tall. Above the first so every step is climbable, below the second so
 * the crate still blocks.
 */
export const STEP_HEIGHT = 0.58;

/**
 * Props shorter than this get no collider at all and are simply walked over;
 * the cook's collision capsule floats this high above the feet to match.
 *
 * Floor cabling, thresholds, rugs and trim are real geometry, and making them
 * solid would ring the room with invisible walls. Must not exceed
 * STEP_HEIGHT: a prop too tall to step onto has to be solid, or it would be
 * walked through at floor level. Anything between the two is solid and
 * climbable — a low crate a cook can step up onto.
 */
export const STEP_OVER_HEIGHT = 0.3;

/** Assets that are markings or tooling rather than physical objects. */
const NON_SOLID_ASSETS: ReadonlySet<string> = new Set([
  "build-robot-spawn",
]);

/** Library models that are floor tiles or slabs, by file name: KayKit, Kenney, Casamento. */
export const FLOOR_ASSET_PATTERN = /\/(?:floor|piso|basemodule)[^/]*\.(?:glb|gltf)$/i;

/**
 * Floors are what a cook stands on, so they are always solid, however thin: a tile at
 * ground level is harmless (the cook's capsule floats above it), and one up at the next
 * storey is the only thing between the cook and the room below.
 */
export const isFloorAsset = (assetId: string): boolean =>
  assetId === "build-floor" || (assetId.startsWith("library:") && FLOOR_ASSET_PATTERN.test(assetId));

/** Scenery a cook may stand on. Other solid scenery still blocks horizontal motion. */
export const isFootingAsset = (assetId: string): boolean =>
  isFloorAsset(assetId) || assetId === "scenario-room-wide" || assetId === "build-block"
  || /\/[^/]*(?:escada|stairs?|platform|plataforma|stage_deck|stage_module|stage_steps|bloco_terraco|igreja_matriz_completa)[^/]*\.(?:glb|gltf)$/i.test(assetId);

/** Wall-like pieces by file name: walls, pillars, fences, railings, doors and windows. */
export const WALL_ASSET_PATTERN =
  /\/[^/]*(?:parede|wall|pilar|pillar|coluna|column|cerca|fence|grade|railing|muro|mureta|janela|window|porta|door)[^/]*\.(?:glb|gltf)$/i;

/**
 * Whether a piece is a wall for the build tools and the walls-up / cutaway / walls-down
 * views: the room shell, the editor's own wall block, and any library structure piece
 * named like a wall. Floors never count, whatever their name.
 */
export const isWallAsset = (assetId: string, category?: string): boolean => {
  if (assetId === "scenario-room-wide" || assetId === "build-wall") return true;
  if (!assetId.startsWith("library:") || isFloorAsset(assetId)) return false;
  if (category !== undefined && category !== "room") return false;
  // Stairs are walked on; lowering them in the cutaway view would hide the way up.
  if (/\/[^/]*(?:escada|stair)[^/]*$/i.test(assetId)) return false;
  return WALL_ASSET_PATTERN.test(assetId);
};

/**
 * Collision group of floors laid at ground level. Robots never climb and always stand
 * on y = 0, so their sweep leaves this group out rather than grinding along the seams
 * between tiles; cooks, whose mask is the default, still stand on them.
 */
export const GROUND_FLOOR_COLLISION_GROUP = 1 << 1;
/** Everything but ground-level floors: the collision mask a robot moves with. */
export const ROBOT_COLLISION_MASK = ~GROUND_FLOOR_COLLISION_GROUP;

/** Categories a cook passes through by design. */
const NON_SOLID_CATEGORIES: ReadonlySet<string> = new Set(["spawn", "cable"]);

export interface SolidityQuery {
  readonly assetId: string;
  readonly role: string;
  readonly category: string;
}

/**
 * Whether a placed object should be solid at all.
 *
 * Everything a cook could bump into is solid; the exceptions are floors, spawn
 * markers, floor cabling and robots. Robots are excluded here because they move
 * themselves and carry their own moving collider — a static one would freeze
 * them in place the moment the level loaded.
 */
export const isSolidByDefault = ({ assetId, role, category }: SolidityQuery): boolean => {
  if (NON_SOLID_ASSETS.has(assetId)) return false;
  if (NON_SOLID_CATEGORIES.has(category)) return false;
  if (role === "spawn" || role === "robot") return false;
  return true;
};

/**
 * Final say for one placement, combining the authored flag with how high the
 * geometry actually turned out.
 *
 * `authored` is what the map or placement asked for; `height` is measured from
 * the loaded model, because only the mesh knows whether it is a counter or a
 * cable run. A floor is solid at any height: see `isFloorAsset`.
 */
export const shouldCollide = (authored: boolean, height: number, floor = false): boolean =>
  authored && (floor || height >= STEP_OVER_HEIGHT);

/**
 * How high a prop reaches above the ground floor: the top of its world-space box.
 *
 * The top, not the thickness, is what decides whether a cook can walk over it. A
 * 6 cm slab lying on the floor is stepped over; the same slab hung at 3 m is a
 * platform or a ceiling, and treating it as floor clutter left it without a
 * collider, so a cook on the storey above fell straight through it.
 */
export const measuredHeight = (minimumY: number, maximumY: number): number => {
  if (!Number.isFinite(minimumY) || !Number.isFinite(maximumY)) return 0;
  return Math.max(0, maximumY);
};
