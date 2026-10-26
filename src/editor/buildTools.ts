/**
 * The build tools' geometry, kept pure (no Babylon) so it can be unit tested: drawing walls
 * and floors by dragging, the cutaway view, and where a placed object comes to rest.
 *
 * Positions are world metres on the ground plane (x, z). Walls snap to grid lines and
 * floors to cell centres, so a wall drawn along a floor's edge meets it exactly, as in the
 * Sims' build mode.
 */

/** Half the side of the buildable lot, centred on the origin: 40 × 40 m. */
export const BUILD_LOT_HALF = 20;
/** The editor's grid step. */
export const GRID_STEP = 0.25;
/** Most pieces one wall or floor drag may lay, so a stray drag cannot flood the map. */
export const MAX_DRAG_PIECES = 200;

export interface Point2 {
  readonly x: number;
  readonly z: number;
}

export interface Footprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface PiecePlacement {
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
  /** How much the piece is stretched along its run: √2 on a grid diagonal, else 1. */
  readonly stretch?: number;
}

/** Shortest turn from angle `a` to angle `b`, in radians, in [0, π]. */
export const angleBetween = (a: number, b: number): number => {
  const turn = Math.abs(((b - a) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI);
  return turn;
};

/**
 * Of a wall's two faces, the turn whose front is nearest `facing`. A wall piece is the
 * same line turned either way; which way only says which of its sides faces where.
 * A tie (the facing square across the wall) keeps the turn in [0, π).
 */
export const wallSide = (runRotation: number, facing: number): number => {
  const a = runRotation;
  const b = runRotation + Math.PI;
  const da = angleBetween(a, facing);
  const db = angleBetween(b, facing);
  const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
  if (Math.abs(da - db) < 1e-6) return wrap(a) >= -1e-9 && wrap(a) < Math.PI - 1e-9 ? wrap(a) : wrap(b);
  return wrap(da < db ? a : b);
};

export interface WallRunOptions {
  /** Any angle from wherever the drag starts, no grid: the "free" placement switch. */
  readonly free?: boolean;
  /**
   * The turn the designer chose (the , . keys): picks which side of the wall faces
   * which way, and the direction of a single piece laid with a click.
   */
  readonly facing?: number;
  readonly maxPieces?: number;
}

export const snapTo = (value: number, step: number): number => Math.round(value / step) * step;

/** Drops the float dust a turn leaves (cos 90° is not quite 0), so pieces land on round numbers. */
const tidy = (value: number): number => Math.round(value * 1e6) / 1e6;

/** The centre of the cell of size `step` that contains `value`. */
export const snapToCellCenter = (value: number, step: number): number =>
  (Math.floor(value / step) + 0.5) * step;

/**
 * How far apart consecutive pieces go: the piece's size along the run, rounded to the grid.
 * Pack walls are ~2 cm wider than their module on purpose (the joints overlap), so rounding
 * rather than ceiling is what makes them tile.
 */
export const pieceStep = (size: number, grid = GRID_STEP): number =>
  Math.max(grid, Math.round(size / grid) * grid);

/**
 * A straight wall from `start` to `end`, drawn as in the Sims: it starts on a grid point
 * and runs along a grid line or a diagonal, whichever of the eight the drag is nearest,
 * each piece turned to the run. A diagonal piece is stretched by √2 so the run still
 * meets the grid points, corner to corner. Free, it runs at any angle from the very
 * point the drag began. A click with no drag lays one piece along `facing`.
 *
 * Rotation 0 runs along X; a piece's front is its local +Z, and `facing` picks which
 * side of the line that is (see `wallSide`).
 */
export const layoutWallRun = (
  start: Point2,
  end: Point2,
  step: number,
  { free = false, facing = 0, maxPieces = MAX_DRAG_PIECES }: WallRunOptions = {},
): PiecePlacement[] => {
  const from = free ? { x: start.x, z: start.z } : { x: snapTo(start.x, step), z: snapTo(start.z, step) };
  const dx = end.x - from.x;
  const dz = end.z - from.z;
  // Babylon turns +X by θ to (cos θ, −sin θ): a run along angle a is rotation −a.
  let angle = Math.hypot(dx, dz) < step / 2 ? -facing : Math.atan2(dz, dx);
  if (!free) angle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
  const diagonal = !free && Math.abs(Math.round(angle / (Math.PI / 4))) % 2 === 1;
  const stretch = diagonal ? Math.SQRT2 : 1;
  const spacing = step * stretch;
  const ux = Math.cos(angle);
  const uz = Math.sin(angle);
  const length = Math.max(0, dx * ux + dz * uz);
  const count = Math.min(maxPieces, Math.max(1, Math.round(length / spacing)));
  const rotationY = wallSide(-angle, facing);
  const pieces: PiecePlacement[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = (index + 0.5) * spacing;
    pieces.push({ x: tidy(from.x + ux * offset), z: tidy(from.z + uz * offset), rotationY, ...(diagonal ? { stretch } : {}) });
  }
  return pieces;
};

/** A wall piece as a line on the ground: its centre, its turn and half its length. */
export interface WallLine {
  readonly x: number;
  readonly z: number;
  readonly rotationY: number;
  readonly halfLength: number;
}

/**
 * The Sims' wall snapping: set down near a wall, an object squares up to it, at any
 * angle the wall runs at. Returns the turn, of the four square to the nearest wall
 * within `reach`, nearest the one the designer chose; null with no wall in reach.
 */
export const alignToWall = (point: Point2, rotation: number, walls: readonly WallLine[], reach = 0.75): number | null => {
  let best: WallLine | null = null;
  let bestDistance = reach;
  for (const wall of walls) {
    const ux = Math.cos(wall.rotationY);
    const uz = -Math.sin(wall.rotationY);
    const along = (point.x - wall.x) * ux + (point.z - wall.z) * uz;
    const clamped = Math.max(-wall.halfLength, Math.min(wall.halfLength, along));
    const distance = Math.hypot(point.x - (wall.x + ux * clamped), point.z - (wall.z + uz * clamped));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = wall;
    }
  }
  if (!best) return null;
  let turn = best.rotationY;
  for (let quarter = 1; quarter < 4; quarter += 1) {
    const candidate = best.rotationY + quarter * Math.PI / 2;
    if (angleBetween(candidate, rotation) < angleBetween(turn, rotation) - 1e-9) turn = candidate;
  }
  return Math.atan2(Math.sin(turn), Math.cos(turn));
};

/** Every cell of the rectangle spanned by `a` and `b`, both included, capped at `maxPieces`. */
export const layoutFloorRect = (
  a: Point2,
  b: Point2,
  stepX: number,
  stepZ: number,
  maxPieces = MAX_DRAG_PIECES,
): PiecePlacement[] => {
  const x0 = snapToCellCenter(a.x, stepX);
  const z0 = snapToCellCenter(a.z, stepZ);
  const x1 = snapToCellCenter(b.x, stepX);
  const z1 = snapToCellCenter(b.z, stepZ);
  const countX = Math.round(Math.abs(x1 - x0) / stepX) + 1;
  const countZ = Math.round(Math.abs(z1 - z0) / stepZ) + 1;
  const signX = x1 < x0 ? -1 : 1;
  const signZ = z1 < z0 ? -1 : 1;
  const pieces: PiecePlacement[] = [];
  for (let i = 0; i < countX; i += 1) {
    for (let j = 0; j < countZ; j += 1) {
      if (pieces.length >= maxPieces) return pieces;
      pieces.push({ x: x0 + signX * i * stepX, z: z0 + signZ * j * stepZ, rotationY: 0 });
    }
  }
  return pieces;
};

/**
 * Cutaway view: a wall is lowered when it stands on the camera's side of what the camera
 * looks at and faces the camera, so the room in front of it stays visible — the Sims'
 * "walls cut". A wall running along the view (`rotationY` given, the piece's own turn)
 * hides nothing and stays up: cutting those too lowered the side walls of a room down
 * to the bottom corners of the screen, as if they had gone missing. A post or column
 * (no `rotationY`) is cut wherever it stands.
 */
export const isWallCutAway = (
  wall: Point2,
  target: Point2,
  camera: Point2,
  margin = 0.6,
  rotationY?: number,
): boolean => {
  const viewX = target.x - camera.x;
  const viewZ = target.z - camera.z;
  const length = Math.hypot(viewX, viewZ);
  if (length < 1e-6) return false; // Straight down: nothing is in front of anything.
  const along = ((wall.x - target.x) * viewX + (wall.z - target.z) * viewZ) / length;
  if (along >= -margin) return false;
  if (rotationY === undefined) return true;
  // The piece's face points along its local Z: (sin θ, cos θ) on the ground.
  const facing = Math.abs(Math.sin(rotationY) * viewX + Math.cos(rotationY) * viewZ) / length;
  return facing >= CUT_FACING;
};

/** How square to the view a wall must face to be cut: within 60° of facing the camera. */
const CUT_FACING = 0.5;

/** Posts and columns: wall-like, but with no side that faces anywhere in particular. */
export const isPostAsset = (assetId: string): boolean =>
  /\/[^/]*(?:pilar|pillar|coluna|column|poste|post)[^/]*$/i.test(assetId);

/**
 * How far apart coplanar pieces are pushed so they never fight over the same depth.
 *
 * Wall pieces overlap where they meet (pack walls are a little longer than their module)
 * and wherever two were set down closer than a module apart; floor tiles overlap at their
 * edges. Two faces in the same plane flicker against each other as the camera moves, and
 * worse the further away it is. Neighbouring pieces are nudged opposite ways by a few
 * millimetres, too little to see and plenty for the depth buffer.
 */
export const DEPTH_NUDGE = 0.002;

/**
 * The nudge for one piece, in world metres: along its face for a wall, up or down for a
 * floor tile. Alternates with the piece's place along its run (walls) or on the grid
 * (floors), so any two pieces a module or less apart go opposite ways, whichever way
 * each faces and in whatever order they were laid.
 */
export const depthNudge = (
  kind: "wall" | "floor",
  position: Point2,
  rotationY: number,
  step = GRID_STEP * 5,
): { x: number; y: number; z: number } => {
  if (kind === "floor") {
    const parity = Math.abs(Math.round(position.x / step) + Math.round(position.z / step)) % 2;
    return { x: 0, y: parity ? DEPTH_NUDGE / 2 : -DEPTH_NUDGE / 2, z: 0 };
  }
  // One sign for a line whichever way its pieces face: the normal is made to point to +x
  // (or +z, for a wall running along x).
  let normalX = Math.sin(rotationY);
  let normalZ = Math.cos(rotationY);
  if (normalX < -1e-6 || (Math.abs(normalX) <= 1e-6 && normalZ < 0)) {
    normalX = -normalX;
    normalZ = -normalZ;
  }
  // Along the run, measured the same way for both turns of the line.
  const along = position.x * normalZ - position.z * normalX;
  const parity = Math.abs(Math.round(along / step)) % 2;
  const sign = parity ? 1 : -1;
  return { x: normalX * sign * DEPTH_NUDGE, y: 0, z: normalZ * sign * DEPTH_NUDGE };
};

/** The ground-plane box of a `halfX` × `halfZ` rectangle turned by `rotationY`. */
export const footprintOf = (center: Point2, halfX: number, halfZ: number, rotationY: number): Footprint => {
  const cos = Math.abs(Math.cos(rotationY));
  const sin = Math.abs(Math.sin(rotationY));
  const extentX = cos * halfX + sin * halfZ;
  const extentZ = sin * halfX + cos * halfZ;
  return { minX: center.x - extentX, maxX: center.x + extentX, minZ: center.z - extentZ, maxZ: center.z + extentZ };
};

/** Whether a footprint lies on the lot: the area the cooks can walk. Off it is scenery. */
export const insideLot = (footprint: Footprint, half = BUILD_LOT_HALF): boolean =>
  footprint.minX >= -half - 1e-6 && footprint.maxX <= half + 1e-6 &&
  footprint.minZ >= -half - 1e-6 && footprint.maxZ <= half + 1e-6;

/** What the pointer's ray met in the scene: the point's height and how upright that face is. */
export interface SurfaceHit {
  readonly y: number;
  /** Y of the face's unit normal: 1 is a flat top, 0 a wall's side. */
  readonly normalY: number;
}

/** A face at least this upright can carry an object: a table top, a shelf, a box's lid. */
export const UPRIGHT_SURFACE = 0.6;

/**
 * Where a placed object rests, as with the Sims' moveobjects: anything goes anywhere, and an
 * object pointed at an upward face sits on top of it. A wall's side or open ground puts it
 * on the ground.
 */
export const restingHeight = (hit: SurfaceHit | null): number =>
  hit && hit.normalY >= UPRIGHT_SURFACE && hit.y > 0 ? hit.y : 0;
