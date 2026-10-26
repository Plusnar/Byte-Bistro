import { AbstractMesh, TransformNode, type Scene } from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../../core/AssetManager";

/** A model under a holder node the disaster moves about, with what disposes both. */
export interface Prop {
  readonly root: TransformNode;
  dispose(): void;
}

/**
 * Puts one of the disaster models under a new holder. Until the file has arrived (or
 * if it never does) the holder shows `fallback`, built from primitives, so the
 * disaster still plays.
 */
export const spawnProp = (
  scene: Scene,
  assets: AssetManager,
  id: string,
  name: string,
  fallback: (parent: TransformNode) => void,
): Prop => {
  const root = new TransformNode(name, scene);
  let model: ModelInstance | null = null;
  let disposed = false;
  const stand = new TransformNode(`${name}-fallback`, scene);
  stand.parent = root;
  fallback(stand);

  const adopt = (instance: ModelInstance | null): void => {
    if (!instance) return;
    if (disposed) {
      instance.dispose();
      return;
    }
    model = instance;
    for (const node of instance.rootNodes) {
      for (const child of [node, ...node.getDescendants()]) {
        if (child instanceof AbstractMesh) child.isPickable = false;
      }
    }
    stand.dispose(false, true);
  };
  const options = { namePrefix: `${name}-`, parent: root };
  const loaded = assets.has(id) ? assets.instantiateLoaded(id, options) : null;
  if (loaded) adopt(loaded);
  else if (assets.has(id)) void assets.instantiateModel(id, options).then(adopt).catch(() => undefined);

  return {
    root,
    dispose: () => {
      disposed = true;
      model?.dispose();
      root.dispose(false, true);
    },
  };
};
