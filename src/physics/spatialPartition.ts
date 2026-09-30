/**
 * Groups a mesh's triangles by where they are, so collision only looks at the
 * ones near whoever is moving.
 *
 * Babylon tests a moving ellipsoid against every triangle of any collider whose
 * bounds it touches. A room shell surrounds the whole kitchen, so its bounds are
 * always touched and all of its triangles were tested on every step of every
 * cook and robot. Split into cells, each cell has its own tight bounds and
 * Babylon skips the ones out of reach.
 *
 * Nothing is simplified: the output holds exactly the input's triangles, only
 * reordered. Pure maths on arrays, so it is tested without a scene.
 */

export interface PartitionedTriangles {
  /** World-space xyz triplets, three vertices per triangle, grouped by cell. */
  readonly positions: Float32Array;
  /** 0..n-1: every triangle owns its three vertices, which keeps cells contiguous. */
  readonly indices: Uint32Array;
  /** Each cell's run of triangles, in the order they appear above. */
  readonly cells: readonly { readonly firstTriangle: number; readonly triangleCount: number }[];
}

/**
 * Buckets triangles into a cubic grid by centroid.
 *
 * Triangles are copied rather than shared between cells. Babylon caches and
 * bounds a sub-mesh over a contiguous *vertex* range, so a cell whose triangles
 * pointed at vertices scattered through the buffer would get bounds covering
 * the whole room and never be skipped.
 */
export const partitionTriangles = (
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  cellSize: number,
): PartitionedTriangles => {
  const size = cellSize > 0 ? cellSize : 1;
  const triangleCount = Math.floor(indices.length / 3);
  const buckets = new Map<string, number[]>();

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = indices[triangle * 3 + corner]! * 3;
      cx += positions[vertex]!;
      cy += positions[vertex + 1]!;
      cz += positions[vertex + 2]!;
    }
    const key = `${Math.floor(cx / 3 / size)},${Math.floor(cy / 3 / size)},${Math.floor(cz / 3 / size)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(triangle);
  }

  const outPositions = new Float32Array(triangleCount * 9);
  const outIndices = new Uint32Array(triangleCount * 3);
  const cells: { firstTriangle: number; triangleCount: number }[] = [];
  let written = 0;
  for (const bucket of buckets.values()) {
    cells.push({ firstTriangle: written, triangleCount: bucket.length });
    for (const triangle of bucket) {
      for (let corner = 0; corner < 3; corner += 1) {
        const source = indices[triangle * 3 + corner]! * 3;
        const target = (written * 3 + corner) * 3;
        outPositions[target] = positions[source]!;
        outPositions[target + 1] = positions[source + 1]!;
        outPositions[target + 2] = positions[source + 2]!;
        outIndices[written * 3 + corner] = written * 3 + corner;
      }
      written += 1;
    }
  }

  return { positions: outPositions, indices: outIndices, cells };
};
