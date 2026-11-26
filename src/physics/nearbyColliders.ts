import type { AbstractMesh, Observer, Scene } from "@babylonjs/core";
import { ColliderGrid } from "./colliderGrid";

/** How far around a body its candidate colliders reach, beyond its own step. */
const REACH = 4;
/** After the scene's meshes change, wait this long before re-indexing (a level loads in bursts). */
const REBUILD_DELAY_MS = 250;

/**
 * Hands each moving body only the colliders around it.
 *
 * Babylon sweeps a `moveWithCollisions` against every mesh in the scene, colliders or not,
 * up to five times per move, unless the body lists its `surroundingMeshes`. A big editor
 * level is thousands of meshes (the wedding garden: ~6,500, ~4,300 of them colliders), and
 * that loop was most of each frame's CPU. Static colliders (frozen world matrix: batched
 * scenery, partitioned proxies) go into a grid once; everything else that collides (cooks,
 * robots, stations, mechanisms) is listed for every body, since it may move. Collision
 * itself is unchanged: the same meshes are tested, minus ones too far to touch.
 *
 * While the scene is still changing the list is left unset, which is Babylon's own
 * "test everything", so a body is never handed a stale list.
 */
export class NearbyColliders {
  private readonly grid = new ColliderGrid<AbstractMesh>(4);
  private readonly dynamic: AbstractMesh[] = [];
  private readonly lists = new Map<AbstractMesh, AbstractMesh[]>();
  private readonly box = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private readonly added: Observer<AbstractMesh>;
  private readonly removed: Observer<AbstractMesh>;
  private dirtySince = 0;
  private ready = false;

  constructor(private readonly scene: Scene) {
    const markDirty = (): void => {
      this.ready = false;
      this.dirtySince = performance.now();
    };
    this.added = scene.onNewMeshAddedObservable.add(markDirty);
    this.removed = scene.onMeshRemovedObservable.add(markDirty);
    this.dirtySince = performance.now();
  }

  /**
   * Re-indexes now. Call when something that collides changed without adding or removing
   * a mesh (the static batch freezing the scenery's colliders, a collider switched off).
   */
  invalidate(): void {
    this.ready = false;
    this.dirtySince = performance.now() - REBUILD_DELAY_MS;
  }

  /** Sets `body.surroundingMeshes` to the colliders within reach of where it stands. */
  assign(body: AbstractMesh): void {
    if (!this.ready) {
      if (performance.now() - this.dirtySince < REBUILD_DELAY_MS) {
        body.surroundingMeshes = null;
        return;
      }
      this.rebuild();
    }
    let list = this.lists.get(body);
    if (!list) {
      list = [];
      this.lists.set(body, list);
      body.onDisposeObservable.addOnce(() => this.lists.delete(body));
    }
    list.length = 0;
    const position = body.position;
    this.box.minX = position.x - REACH;
    this.box.maxX = position.x + REACH;
    this.box.minZ = position.z - REACH;
    this.box.maxZ = position.z + REACH;
    this.grid.collect(this.box, list);
    for (const mesh of this.dynamic) if (mesh !== body) list.push(mesh);
    body.surroundingMeshes = list;
  }

  dispose(): void {
    this.scene.onNewMeshAddedObservable.remove(this.added);
    this.scene.onMeshRemovedObservable.remove(this.removed);
    for (const body of this.lists.keys()) body.surroundingMeshes = null;
    this.lists.clear();
    this.grid.clear();
    this.dynamic.length = 0;
  }

  private rebuild(): void {
    this.grid.clear();
    this.dynamic.length = 0;
    for (const mesh of this.scene.meshes) {
      if (!mesh.checkCollisions || !mesh.subMeshes) continue;
      if (!mesh.isWorldMatrixFrozen) {
        this.dynamic.push(mesh);
        continue;
      }
      const box = mesh.getBoundingInfo().boundingBox;
      this.grid.insert(mesh, {
        minX: box.minimumWorld.x,
        maxX: box.maximumWorld.x,
        minZ: box.minimumWorld.z,
        maxZ: box.maximumWorld.z,
      });
    }
    this.ready = true;
  }
}
