import {
  Mesh,
  SubMesh,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
} from "@babylonjs/core";
import { partitionTriangles } from "./spatialPartition";

/** Cell edge in metres: a little over a cook's reach, so a step touches a few cells. */
const CELL_SIZE = 2;

/**
 * Colliders this big are worth partitioning. Small props are only tested when
 * someone is already next to them, so splitting them would add sub-meshes for
 * nothing; a mesh this wide is tested on every step anywhere in the room.
 */
const MIN_TRIANGLES = 256;
const MIN_RADIUS = 3;

export const needsPartitioning = (mesh: AbstractMesh): boolean =>
  mesh.getTotalIndices() / 3 >= MIN_TRIANGLES &&
  mesh.getBoundingInfo().boundingSphere.radiusWorld >= MIN_RADIUS;

/**
 * Hands a large collider's collision over to an invisible copy of its
 * triangles, grouped by location.
 *
 * The copy is what Babylon sweeps against, so a step only tests the cells
 * around the cook instead of the whole room. It is a separate mesh on purpose:
 * splitting the visible mesh into sub-meshes would turn one draw call into one
 * per cell, and drawing is already where the other half of each frame goes.
 *
 * The source must be static: its world transform is baked into the copy.
 */
export const createPartitionedCollider = (source: AbstractMesh): Mesh | null => {
  const positions = source.getVerticesData(VertexBuffer.PositionKind);
  if (!positions || positions.length === 0) return null;
  const indices = source.getIndices() ?? Array.from({ length: positions.length / 3 }, (_, i) => i);

  const world = source.computeWorldMatrix(true);
  const baked = new Float32Array(positions.length);
  const point = new Vector3();
  for (let offset = 0; offset < positions.length; offset += 3) {
    Vector3.TransformCoordinatesFromFloatsToRef(
      positions[offset]!, positions[offset + 1]!, positions[offset + 2]!, world, point,
    );
    baked[offset] = point.x;
    baked[offset + 1] = point.y;
    baked[offset + 2] = point.z;
  }

  const partition = partitionTriangles(baked, indices, CELL_SIZE);
  const scene = source.getScene();
  const collider = new Mesh(`${source.name}-collision`, scene);
  const data = new VertexData();
  data.positions = partition.positions;
  data.indices = partition.indices;
  data.applyToMesh(collider, false);

  collider.subMeshes = [];
  for (const cell of partition.cells) {
    const first = cell.firstTriangle * 3;
    const count = cell.triangleCount * 3;
    // Vertex and index runs coincide because every triangle owns its vertices.
    new SubMesh(0, first, count, first, count, collider);
  }
  // Picks the few cells near a moving body straight out of a tree instead of
  // bounds-testing every cell; the ground probe's ray uses the same tree.
  collider.createOrUpdateSubmeshesOctree(64, 2);
  collider.useOctreeForCollisions = true;
  collider.useOctreeForPicking = true;

  collider.isVisible = false;
  collider.isPickable = false;
  collider.checkCollisions = true;
  // Stands in for the source, so it is filtered the same way (robots skip ground floors).
  collider.collisionGroup = source.collisionGroup;
  collider.freezeWorldMatrix();
  collider.metadata = { ...(collider.metadata ?? {}), collisionProxyFor: source.name };

  source.checkCollisions = false;
  source.onDisposeObservable.addOnce(() => collider.dispose());
  return collider;
};
