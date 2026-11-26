import type { AbstractMesh, ISmartArrayLike, Scene } from "@babylonjs/core";

/**
 * Leaves meshes that can never be drawn out of Babylon's per-frame active-mesh pass.
 *
 * Static batching keeps solid decor as invisible colliders (~1,200 on the official level),
 * and Babylon still walked every one of them each frame — readiness, enabled state, world
 * matrix — only to find them invisible: a measurable share of the 8.5 ms the active-mesh
 * evaluation took. Collisions, the ground probe and the robots' navigation read
 * `scene.meshes` directly and are unaffected.
 *
 * Uses the documented `scene.getActiveMeshCandidates` hook. A mesh is excluded only while
 * it is marked (`markRenderless`) AND invisible, so making one visible again just works.
 */
const RENDERLESS = "renderless";

export const markRenderless = (mesh: AbstractMesh): void => {
  mesh.metadata = { ...(mesh.metadata ?? {}), [RENDERLESS]: true };
};

const isRenderless = (mesh: AbstractMesh): boolean =>
  !mesh.isVisible && Boolean((mesh.metadata as Record<string, unknown> | null)?.[RENDERLESS]);

export const installActiveMeshCandidates = (scene: Scene): (() => void) => {
  const candidates: AbstractMesh[] = [];
  const list: ISmartArrayLike<AbstractMesh> = { data: candidates, length: 0 };
  let dirty = true;
  const markDirty = (): void => { dirty = true; };
  const added = scene.onNewMeshAddedObservable.add(markDirty);
  const removed = scene.onMeshRemovedObservable.add(markDirty);
  let original = scene.getActiveMeshCandidates;
  let frames = 0;

  const filtered = (): ISmartArrayLike<AbstractMesh> => {
    // Visibility can change without an event; a cheap periodic refresh catches it.
    if (dirty || ++frames % 120 === 0) {
      candidates.length = 0;
      for (const mesh of scene.meshes) if (!isRenderless(mesh)) candidates.push(mesh);
      list.length = candidates.length;
      dirty = false;
    }
    return list;
  };

  // Babylon's octree component assigns its own `getActiveMeshCandidates` the first time any
  // mesh builds a sub-mesh octree (a partitioned collider does, for a level's biggest
  // piece), which silently dropped this filter: on a large level every collider came back
  // into the per-frame pass. Its assignment is kept aside instead (the game uses no
  // selection octree), and restored on uninstall.
  Object.defineProperty(scene, "getActiveMeshCandidates", {
    configurable: true,
    get: () => filtered,
    set: (replacement: typeof original) => { original = replacement; },
  });

  return () => {
    delete (scene as { getActiveMeshCandidates?: unknown }).getActiveMeshCandidates;
    scene.getActiveMeshCandidates = original;
    scene.onNewMeshAddedObservable.remove(added);
    scene.onMeshRemovedObservable.remove(removed);
  };
};
