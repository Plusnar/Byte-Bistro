/**
 * The build tools' geometry, kept pure (no Babylon) so it can be unit tested: drawing walls
 * and floors by dragging, the cutaway view, and whether a placement is allowed.
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
}

export const snapTo = (value: number, step: number): number => Math.round(value / step) * step;

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
 * A straight wall from `start` to `end`, along whichever axis the drag mostly followed
 * (no diagonals). Pieces sit between grid lines: centred half a step along the run, on the
 * line across it. Rotation 0 runs along X, π/2 along Z.
 */
export const layoutWallRun = (
  start: Point2,
  end: Point2,
  step: number,
  maxPieces = MAX_DRAG_PIECES,
): PiecePlacement[] => {
  const alongX = Math.abs(end.x - start.x) >= Math.abs(end.z - start.z);
  const from = { x: snapTo(start.x, step), z: snapTo(start.z, step) };
  const length = alongX ? snapTo(end.x, step) - from.x : snapTo(end.z, step) - from.z;
  const direction = length < 0 ? -1 : 1;
  const count = Math.min(maxPieces, Math.max(1, Math.round(Math.abs(length) / step)));
  const pieces: PiecePlacement[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = direction * (index + 0.5) * step;
    pieces.push(alongX
      ? { x: from.x + offset, z: from.z, rotationY: 0 }
      : { x: from.x, z: from.z + offset, rotationY: Math.PI / 2 });
  }
  return pieces;
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
 * looks at, so the room in front of it stays visible — the Sims' "walls cut".
 */
export const isWallCutAway = (wall: Point2, target: Point2, camera: Point2, margin = 0.6): boolean => {
  const viewX = target.x - camera.x;
  const viewZ = target.z - camera.z;
  const length = Math.hypot(viewX, viewZ);
  if (length < 1e-6) return false; // Straight down: nothing is in front of anything.
  const along = ((wall.x - target.x) * viewX + (wall.z - target.z) * viewZ) / length;
  return along < -margin;
};

/** The ground-plane box of a `halfX` × `halfZ` rectangle turned by `rotationY`. */
export const footprintOf = (center: Point2, halfX: number, halfZ: number, rotationY: number): Footprint => {
  const cos = Math.abs(Math.cos(rotationY));
  const sin = Math.abs(Math.sin(rotationY));
  const extentX = cos * halfX + sin * halfZ;
  const extentZ = sin * halfX + cos * halfZ;
  return { minX: center.x - extentX, maxX: center.x + extentX, minZ: center.z - extentZ, maxZ: center.z + extentZ };
};

/** Overlap beyond a hair: pieces that merely touch, or share a joint, do not collide. */
export const footprintsOverlap = (a: Footprint, b: Footprint, tolerance = 0.05): boolean =>
  a.minX < b.maxX - tolerance && a.maxX > b.minX + tolerance &&
  a.minZ < b.maxZ - tolerance && a.maxZ > b.minZ + tolerance;

export const insideLot = (footprint: Footprint, half = BUILD_LOT_HALF): boolean =>
  footprint.minX >= -half - 1e-6 && footprint.maxX <= half + 1e-6 &&
  footprint.minZ >= -half - 1e-6 && footprint.maxZ <= half + 1e-6;

/**
 * Why a placement is refused, or null when it is fine: outside the lot, or overlapping
 * something already there. Callers leave out what may legitimately be under or around it
 * (floors, the room shell, whatever it is being set on top of).
 */
export const placementProblem = (
  candidate: Footprint,
  others: readonly Footprint[],
  half = BUILD_LOT_HALF,
): "outside" | "overlap" | null => {
  if (!insideLot(candidate, half)) return "outside";
  return others.some((other) => footprintsOverlap(candidate, other)) ? "overlap" : null;
};
