/**
 * A flat grid of boxes (x/z only) for "what is near here?".
 *
 * Pure: it stores whatever items it is given with their footprint and hands back the ones
 * whose footprint overlaps a query box, each once. `NearbyColliders` fills it with the
 * level's static colliders so a moving body is only tested against those around it.
 */
export interface Footprint {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export class ColliderGrid<T> {
  private readonly cells = new Map<number, T[]>();
  /** Items too big to bucket (a room shell): returned by every query. */
  private readonly everywhere: T[] = [];
  private readonly seen = new Map<T, number>();
  private query = 0;
  private count = 0;

  constructor(
    private readonly cellSize = 4,
    /** An item covering more cells than this goes to `everywhere` instead. */
    private readonly maxCells = 64,
  ) {}

  get size(): number {
    return this.count;
  }

  clear(): void {
    this.cells.clear();
    this.everywhere.length = 0;
    this.seen.clear();
    this.count = 0;
  }

  insert(item: T, box: Footprint): void {
    this.count += 1;
    const x0 = this.cell(box.minX);
    const x1 = this.cell(box.maxX);
    const z0 = this.cell(box.minZ);
    const z1 = this.cell(box.maxZ);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) > this.maxCells) {
      this.everywhere.push(item);
      return;
    }
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const key = ColliderGrid.key(x, z);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
  }

  /** Appends to `out` every item overlapping the box, once each; returns `out`. */
  collect(box: Footprint, out: T[]): T[] {
    this.query += 1;
    const stamp = this.query;
    for (const item of this.everywhere) {
      this.seen.set(item, stamp);
      out.push(item);
    }
    const x0 = this.cell(box.minX);
    const x1 = this.cell(box.maxX);
    const z0 = this.cell(box.minZ);
    const z1 = this.cell(box.maxZ);
    for (let x = x0; x <= x1; x += 1) {
      for (let z = z0; z <= z1; z += 1) {
        const bucket = this.cells.get(ColliderGrid.key(x, z));
        if (!bucket) continue;
        for (const item of bucket) {
          if (this.seen.get(item) === stamp) continue;
          this.seen.set(item, stamp);
          out.push(item);
        }
      }
    }
    return out;
  }

  private cell(value: number): number {
    return Math.floor(value / this.cellSize);
  }

  /** Packs two cell coordinates (±32k) into one number key, without a string. */
  private static key(x: number, z: number): number {
    return (x + 32768) * 65536 + (z + 32768);
  }
}
