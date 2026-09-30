/**
 * Navigation for the reception robots: where they can walk, how they get
 * there, and how they behave when another robot is in the way.
 *
 * Kept Babylon-free so every rule here is unit testable. The caller collects
 * obstacle rectangles from the scene and feeds them in; nothing in this module
 * knows what a mesh is.
 */

export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface NavPoint {
  readonly x: number;
  readonly z: number;
}

/** Grid resolution. Half a metre resolves kitchen gaps without a huge search. */
const DEFAULT_CELL = 0.5;
/** Keeps a path off the very edge of furniture, so robots do not scrape walls. */
const DEFAULT_CLEARANCE = 0.42;
/** A* gives up after this many cells, so a walled-in robot cannot stall a frame. */
const MAX_EXPANSIONS = 4000;

const DIAGONAL_COST = Math.SQRT2;

/**
 * Walkability grid with A* routing.
 *
 * Obstacles are inflated by the robot's radius rather than the robot being
 * tested against them at every step: it makes the robot a point, which is what
 * lets a plain grid search produce paths it can actually fit through.
 */
export class NavGrid {
  readonly columns: number;
  readonly rows: number;
  private readonly blocked: Uint8Array;

  constructor(
    private readonly bounds: Rect,
    obstacles: readonly Rect[],
    private readonly cell: number = DEFAULT_CELL,
    clearance: number = DEFAULT_CLEARANCE,
  ) {
    this.columns = Math.max(1, Math.ceil((bounds.maxX - bounds.minX) / cell));
    this.rows = Math.max(1, Math.ceil((bounds.maxZ - bounds.minZ) / cell));
    this.blocked = new Uint8Array(this.columns * this.rows);

    for (const obstacle of obstacles) {
      const minColumn = this.columnAt(obstacle.minX - clearance);
      const maxColumn = this.columnAt(obstacle.maxX + clearance);
      const minRow = this.rowAt(obstacle.minZ - clearance);
      const maxRow = this.rowAt(obstacle.maxZ + clearance);
      for (let column = minColumn; column <= maxColumn; column += 1) {
        for (let row = minRow; row <= maxRow; row += 1) {
          this.blocked[row * this.columns + column] = 1;
        }
      }
    }
  }

  /** Cells touching the outer wall are blocked too, so paths keep a margin. */
  private columnAt(x: number): number {
    const raw = Math.floor((x - this.bounds.minX) / this.cell);
    return Math.max(0, Math.min(this.columns - 1, raw));
  }

  private rowAt(z: number): number {
    const raw = Math.floor((z - this.bounds.minZ) / this.cell);
    return Math.max(0, Math.min(this.rows - 1, raw));
  }

  private centreOf(column: number, row: number): NavPoint {
    return {
      x: this.bounds.minX + (column + 0.5) * this.cell,
      z: this.bounds.minZ + (row + 0.5) * this.cell,
    };
  }

  private isBlockedCell(column: number, row: number): boolean {
    if (column < 0 || row < 0 || column >= this.columns || row >= this.rows) return true;
    return this.blocked[row * this.columns + column] === 1;
  }

  isWalkable(point: NavPoint): boolean {
    if (point.x < this.bounds.minX || point.x > this.bounds.maxX) return false;
    if (point.z < this.bounds.minZ || point.z > this.bounds.maxZ) return false;
    return !this.isBlockedCell(this.columnAt(point.x), this.rowAt(point.z));
  }

  /**
   * Closest free spot to `point`, searched in rings.
   *
   * Targets are picked at random and furniture is solid, so without this a
   * robot would regularly be sent to stand inside a counter.
   */
  nearestWalkable(point: NavPoint, maxRings = 8): NavPoint | null {
    const startColumn = this.columnAt(point.x);
    const startRow = this.rowAt(point.z);
    if (!this.isBlockedCell(startColumn, startRow)) return this.centreOf(startColumn, startRow);

    for (let ring = 1; ring <= maxRings; ring += 1) {
      for (let column = startColumn - ring; column <= startColumn + ring; column += 1) {
        for (let row = startRow - ring; row <= startRow + ring; row += 1) {
          // Only the ring's perimeter is new work.
          const onRing = Math.abs(column - startColumn) === ring || Math.abs(row - startRow) === ring;
          if (!onRing || this.isBlockedCell(column, row)) continue;
          return this.centreOf(column, row);
        }
      }
    }
    return null;
  }

  /**
   * A* over the grid, returned as world-space waypoints with the redundant
   * ones pulled out so the robot walks in straight lines instead of stair-
   * stepping along the cell diagonals.
   *
   * Returns an empty array when the goal cannot be reached.
   */
  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    const startColumn = this.columnAt(from.x);
    const startRow = this.rowAt(from.z);
    const goalColumn = this.columnAt(to.x);
    const goalRow = this.rowAt(to.z);
    if (this.isBlockedCell(goalColumn, goalRow)) return [];

    const total = this.columns * this.rows;
    const start = startRow * this.columns + startColumn;
    const goal = goalRow * this.columns + goalColumn;
    if (start === goal) return [{ x: to.x, z: to.z }];

    const cameFrom = new Int32Array(total).fill(-1);
    const costSoFar = new Float32Array(total).fill(Number.POSITIVE_INFINITY);
    const open: { index: number; priority: number }[] = [];
    costSoFar[start] = 0;
    open.push({ index: start, priority: 0 });

    let expansions = 0;
    let found = false;
    while (open.length > 0 && expansions < MAX_EXPANSIONS) {
      // Small frontier: a linear scan beats the bookkeeping of a real heap.
      let bestSlot = 0;
      for (let slot = 1; slot < open.length; slot += 1) {
        if (open[slot]!.priority < open[bestSlot]!.priority) bestSlot = slot;
      }
      const current = open.splice(bestSlot, 1)[0]!.index;
      if (current === goal) {
        found = true;
        break;
      }
      expansions += 1;

      const column = current % this.columns;
      const row = Math.floor(current / this.columns);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (dx === 0 && dz === 0) continue;
          const nextColumn = column + dx;
          const nextRow = row + dz;
          if (this.isBlockedCell(nextColumn, nextRow)) continue;
          // Never cut a corner between two blocked cells: the robot is wider
          // than the zero-width diagonal the grid would happily route through.
          if (dx !== 0 && dz !== 0) {
            if (this.isBlockedCell(column + dx, row) || this.isBlockedCell(column, row + dz)) continue;
          }
          const next = nextRow * this.columns + nextColumn;
          const step = dx !== 0 && dz !== 0 ? DIAGONAL_COST : 1;
          const candidate = costSoFar[current]! + step;
          if (candidate >= costSoFar[next]!) continue;
          costSoFar[next] = candidate;
          cameFrom[next] = current;
          const heuristic = Math.hypot(nextColumn - goalColumn, nextRow - goalRow);
          open.push({ index: next, priority: candidate + heuristic });
        }
      }
    }

    if (!found) return [];

    const cells: number[] = [];
    for (let at = goal; at !== -1 && at !== start; at = cameFrom[at]!) cells.push(at);
    cells.reverse();

    const waypoints = cells.map((index) =>
      this.centreOf(index % this.columns, Math.floor(index / this.columns)));
    if (waypoints.length > 0) waypoints[waypoints.length - 1] = { x: to.x, z: to.z };
    return this.smooth(from, waypoints);
  }

  /** Drops waypoints that the robot can already see past. */
  private smooth(from: NavPoint, waypoints: readonly NavPoint[]): NavPoint[] {
    const result: NavPoint[] = [];
    let anchor = from;
    let index = 0;
    while (index < waypoints.length) {
      let furthest = index;
      for (let candidate = waypoints.length - 1; candidate > index; candidate -= 1) {
        if (this.hasLineOfSight(anchor, waypoints[candidate]!)) {
          furthest = candidate;
          break;
        }
      }
      const chosen = waypoints[furthest]!;
      result.push(chosen);
      anchor = chosen;
      index = furthest + 1;
    }
    return result;
  }

  /** Samples the segment at half-cell steps; good enough for a 0.5 m grid. */
  hasLineOfSight(from: NavPoint, to: NavPoint): boolean {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(distance / (this.cell * 0.5)));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / steps;
      if (!this.isWalkable({ x: from.x + dx * t, z: from.z + dz * t })) return false;
    }
    return true;
  }
}

// --- Right of way ----------------------------------------------------------

export interface Mover {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  /** Unit heading. Zero length means "not going anywhere". */
  readonly headingX: number;
  readonly headingZ: number;
  /** Metres per second actually covered recently, not the configured speed. */
  readonly speed: number;
}

export type YieldMode = "go" | "follow" | "wait" | "sidestep";

export interface YieldDecision {
  readonly mode: YieldMode;
  /** Multiplier on the robot's speed this frame. */
  readonly speedScale: number;
  /** Unit sideways nudge, only meaningful for "sidestep". */
  readonly sideX: number;
  readonly sideZ: number;
}

/** How far ahead a robot looks for someone in its way. */
export const LOOKAHEAD = 1.5;
/** Half-width of that corridor: a little over one robot. */
export const CORRIDOR_HALF_WIDTH = 0.55;
/** Below this speed another robot counts as standing still. */
const STOPPED_SPEED = 0.25;
/** Closer than this and following turns into stopping. */
const PERSONAL_SPACE = 0.75;

const GO: YieldDecision = { mode: "go", speedScale: 1, sideX: 0, sideZ: 0 };

/**
 * What a robot should do about whoever is in front of it.
 *
 * The rule the reception needed is "queue, do not scatter": a robot whose way
 * is blocked slows to the pace of the one ahead and keeps its destination,
 * rather than abandoning it. Only a genuine standoff makes anyone step aside,
 * and then exactly one of the pair does, chosen by id so the two robots can
 * never both dodge the same way and lock.
 */
export const decideRightOfWay = (self: Mover, others: readonly Mover[]): YieldDecision => {
  const headingLength = Math.hypot(self.headingX, self.headingZ);
  if (headingLength < 1e-4) return GO;
  const forwardX = self.headingX / headingLength;
  const forwardZ = self.headingZ / headingLength;

  let blocker: Mover | null = null;
  let blockerDistance = Number.POSITIVE_INFINITY;
  for (const other of others) {
    if (other.id === self.id) continue;
    const toOtherX = other.x - self.x;
    const toOtherZ = other.z - self.z;
    const ahead = toOtherX * forwardX + toOtherZ * forwardZ;
    if (ahead <= 0 || ahead > LOOKAHEAD) continue;
    // Distance from our path line, so someone walking beside us is ignored.
    const lateral = Math.abs(toOtherX * forwardZ - toOtherZ * forwardX);
    if (lateral > CORRIDOR_HALF_WIDTH) continue;
    if (ahead < blockerDistance) {
      blockerDistance = ahead;
      blocker = other;
    }
  }

  if (!blocker) return GO;

  const blockerMoving = blocker.speed > STOPPED_SPEED;
  if (blockerMoving) {
    const sameWay = blocker.headingX * forwardX + blocker.headingZ * forwardZ > 0;
    if (sameWay) {
      // Walking the same way: match their pace and keep the gap. This is the
      // queue the reception should read as.
      if (blockerDistance < PERSONAL_SPACE) {
        return { mode: "wait", speedScale: 0, sideX: 0, sideZ: 0 };
      }
      return { mode: "follow", speedScale: 0.55, sideX: 0, sideZ: 0 };
    }
    // Coming at us: let them through rather than both shuffling.
    return { mode: "wait", speedScale: 0, sideX: 0, sideZ: 0 };
  }

  // They are standing still. Two different situations look the same here.
  const blockerParked = Math.hypot(blocker.headingX, blocker.headingZ) < 1e-4;
  const sidestep: YieldDecision = {
    // Right-hand side, so a pair always separates instead of mirroring.
    mode: "sidestep", speedScale: 0.6, sideX: forwardZ, sideZ: -forwardX,
  };

  // A parked robot — serving a guest, or one that simply never walks — is not
  // going to move out of the way, so waiting on it would wait forever.
  if (blockerParked) return sidestep;

  // Both of us are trying to go somewhere and both have stopped: a standoff.
  // Exactly one may step aside, or we mirror each other and lock.
  return self.id < blocker.id ? sidestep : { mode: "wait", speedScale: 0, sideX: 0, sideZ: 0 };
};
