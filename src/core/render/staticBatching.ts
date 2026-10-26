import { Mesh, type AbstractMesh, type TransformNode } from "@babylonjs/core";
import { runSliced } from "../assets/MainThreadQueue";
import { markRenderless } from "./activeMeshCandidates";

/**
 * Static batching: draws many meshes that never move and share a material as one.
 *
 * A level built in the editor is hundreds of small models — every floor tile and wall
 * panel is its own glTF — and the official wedding level came to ~1,550 visible meshes,
 * one draw call each plus per-frame culling, which was most of every frame on an
 * integrated GPU. Batched, the same pixels take one draw call per material.
 *
 * What it does NOT change: collision and navigation. The robots' walkability grid stamps
 * each collider's bounding box and the ground probe ray-casts colliders, so one giant
 * merged collider would block whole corridors. The merged copy therefore never collides;
 * solid sources stay in the scene as invisible colliders with frozen world matrices,
 * exactly as solid as before. Sources nothing else needs are disposed.
 *
 * Only for geometry that is static for the rest of the scene's life: the world transform
 * is baked into the batch.
 */
export interface StaticBatchOptions {
  /** Meshes to leave alone, e.g. ones with a per-mesh clip plane. */
  readonly skip?: (mesh: Mesh) => boolean;
  /** Stop between batches (the scene was disposed). */
  readonly shouldStop?: () => boolean;
  /** Smallest group worth merging. */
  readonly minGroupSize?: number;
}

export interface StaticBatchReport {
  readonly batches: number;
  /** Meshes now drawn through a batch. */
  readonly mergedMeshes: number;
  /** Merged sources kept, invisible, because they collide. */
  readonly keptColliders: number;
  readonly disposedSources: number;
}

/** Set on a mesh whose collision was handed to a stand-in (see partitionedCollider). */
export const COLLISION_PROXY_SOURCE = "collisionProxySource";

const hasCollisionProxy = (mesh: AbstractMesh): boolean =>
  Boolean((mesh.metadata as Record<string, unknown> | null)?.[COLLISION_PROXY_SOURCE]);

const isEligible = (mesh: AbstractMesh, skip?: (mesh: Mesh) => boolean): mesh is Mesh => {
  if (!(mesh instanceof Mesh) || !mesh.material || !mesh.isVisible) return false;
  if (mesh.getTotalVertices() === 0 || mesh.skeleton || mesh.morphTargetManager) return false;
  if (mesh.subMeshes?.length !== 1 || mesh.hasInstances || mesh.hasThinInstances) return false;
  if (skip?.(mesh)) return false;
  // Every glTF mesh has a negative determinant (the loader's right- to left-handed flip);
  // VertexData.transform reverses the winding when it bakes one, so mirrored is fine.
  mesh.computeWorldMatrix(true);
  return true;
};

const batchKey = (mesh: Mesh): string => [
  mesh.material!.uniqueId,
  mesh.getVerticesDataKinds().sort().join(","),
  mesh.receiveShadows,
  mesh.layerMask,
  mesh.renderingGroupId,
  mesh.visibility,
].join("|");

export const batchStaticMeshes = async (
  sources: readonly AbstractMesh[],
  parent: TransformNode,
  options: StaticBatchOptions = {},
): Promise<StaticBatchReport> => {
  const groups = new Map<string, Mesh[]>();
  for (const mesh of sources) {
    if (!isEligible(mesh, options.skip)) continue;
    const key = batchKey(mesh);
    const group = groups.get(key);
    if (group) group.push(mesh);
    else groups.set(key, [mesh]);
  }

  const minGroupSize = Math.max(2, options.minGroupSize ?? 2);
  let batches = 0;
  let mergedMeshes = 0;
  let keptColliders = 0;
  let disposedSources = 0;
  const stop = options.shouldStop ?? (() => false);

  // One group per step, so a large level is merged across frames instead of in one freeze.
  await runSliced([...groups.values()].filter((group) => group.length >= minGroupSize), (group) => {
    const first = group[0]!;
    // disposeSource=false: the solid ones are still needed as colliders.
    const batch = Mesh.MergeMeshes(group, false, true);
    if (!batch) return;
    batch.name = `static-batch-${first.material!.name}-${batches}`;
    batch.parent = parent;
    batch.isPickable = false;
    batch.checkCollisions = false;
    batch.receiveShadows = first.receiveShadows;
    batch.layerMask = first.layerMask;
    batch.renderingGroupId = first.renderingGroupId;
    batch.visibility = first.visibility;
    batch.freezeWorldMatrix();
    batches += 1;
    mergedMeshes += group.length;

    for (const source of group) {
      if (source.checkCollisions || hasCollisionProxy(source)) {
        source.isVisible = false;
        source.freezeWorldMatrix();
        markRenderless(source);
        keptColliders += 1;
      } else if (source.getChildren().length === 0) {
        source.dispose(false, false);
        disposedSources += 1;
      } else {
        // Its children still hang off it: keep the node, stop drawing it.
        source.isVisible = false;
        source.freezeWorldMatrix();
        markRenderless(source);
      }
    }
  }, stop);

  return { batches, mergedMeshes, keptColliders, disposedSources };
};
