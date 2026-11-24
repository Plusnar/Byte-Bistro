import { AnimationGroup, Bone, Node, type Scene } from "@babylonjs/core";
import type { ModelInstance } from "../core/AssetManager";

/** Bind shared Rig_Medium tracks to the matching nodes and bones of one instance. */
export function bindModelClip(
  scene: Scene, instance: ModelInstance, source: AnimationGroup, name: string,
): AnimationGroup | null {
  const nodes = new Map<string, Node>();
  for (const root of instance.rootNodes) {
    nodes.set(root.name, root);
    for (const descendant of root.getDescendants()) {
      if (!nodes.has(descendant.name)) nodes.set(descendant.name, descendant);
    }
  }
  const bones = new Map<string, Bone>();
  for (const skeleton of instance.skeletons) {
    for (const bone of skeleton.bones) bones.set(bone.name, bone);
  }

  const group = new AnimationGroup(name, scene);
  for (const { target, animation } of source.targetedAnimations) {
    if (!(target instanceof Node)) continue;
    const match = target instanceof Bone
      ? bones.get(target.name) ?? nodes.get(target.name)
      : nodes.get(target.name) ?? bones.get(target.name);
    if (match) group.addTargetedAnimation(animation, match);
  }
  if (!group.targetedAnimations.length) {
    group.dispose();
    return null;
  }
  group.normalize(source.from, source.to);
  return group;
}
