import {
  Animation,
  AnimationGroup,
  Node,
  Quaternion,
  TransformNode,
  Vector3,
  type IAnimationKey,
  type Scene,
} from "@babylonjs/core";
import type { ModelInstance } from "../core/AssetManager";
import type { EmbeddedClip, EmbeddedClipSet } from "../data/characters";
import { groundingOffsets, type Joint, type KeyTrack, type Quat, type Vec3 } from "./clipGrounding";

export type EmbeddedClipKey = Exclude<keyof EmbeddedClipSet, "rootJoint" | "upperBodyJoint">;

export const EMBEDDED_CLIP_KEYS: readonly EmbeddedClipKey[] = [
  "idle", "walk", "run", "gesture", "knockDown", "downed", "standUp", "showcase",
];

const LOOPING: ReadonlySet<EmbeddedClipKey> = new Set(["idle", "walk", "run", "downed", "showcase"]);

/** Lowest a joint may sit: the toe joints stand this high in the bind pose. */
export const FLOOR_CLEARANCE = 0.05;

/**
 * How quickly each clip fades in. The fall into the floor pose and the stand
 * back up are slower on purpose: a snap there reads as a glitch, not a hit.
 */
const BLENDING_SPEED: Readonly<Record<EmbeddedClipKey, number>> = {
  idle: 0.08,
  walk: 0.1,
  run: 0.1,
  gesture: 0.18,
  knockDown: 0.2,
  downed: 0.04,
  standUp: 0.06,
  showcase: 0.08,
};

/** A clip ready to start: its own group, the frames to play and at what pace. */
export interface PlayableClip {
  readonly group: AnimationGroup;
  readonly fromFrame: number;
  readonly toFrame: number;
  readonly speed: number;
  readonly loop: boolean;
  /** Real seconds one pass takes at `speed`. */
  readonly seconds: number;
  readonly spec: EmbeddedClip;
}

export const startClip = (clip: PlayableClip, speed: number = clip.speed): void => {
  clip.group.start(clip.loop, speed, clip.fromFrame, clip.toFrame);
};

const toVec3 = (value: Vector3): Vec3 => [value.x, value.y, value.z];
const toQuat = (value: Quaternion): Quat => [value.x, value.y, value.z, value.w];

/** Every node the clip moves, parents first, with the tracks that move it. */
const collectJoints = (group: AnimationGroup): Joint[] => {
  const byNode = new Map<Node, { translation?: KeyTrack<Vec3>; rotation?: KeyTrack<Quat> }>();
  for (const targeted of group.targetedAnimations) {
    if (!(targeted.target instanceof TransformNode)) continue;
    const animation = targeted.animation;
    const fps = animation.framePerSecond;
    const keys = animation.getKeys();
    const times = keys.map((key) => key.frame / fps);
    const entry = byNode.get(targeted.target) ?? {};
    if (animation.targetProperty === "position") {
      entry.translation = { times, values: keys.map((key) => toVec3(key.value as Vector3)) };
    } else if (animation.targetProperty === "rotationQuaternion") {
      entry.rotation = { times, values: keys.map((key) => toQuat(key.value as Quaternion)) };
    }
    byNode.set(targeted.target, entry);
  }

  const depth = (node: Node): number => {
    let count = 0;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (byNode.has(parent)) count += 1;
    }
    return count;
  };
  const ordered = [...byNode.keys()].sort((a, b) => depth(a) - depth(b));
  const indexOf = new Map(ordered.map((node, index) => [node, index] as const));

  return ordered.map((node) => {
    const transform = node as TransformNode;
    const tracks = byNode.get(node)!;
    const rotation = transform.rotationQuaternion ?? Quaternion.FromEulerVector(transform.rotation);
    return {
      name: node.name,
      parent: node.parent ? indexOf.get(node.parent) ?? -1 : -1,
      restTranslation: toVec3(transform.position),
      restRotation: toQuat(rotation),
      restScale: toVec3(transform.scaling),
      ...tracks,
    };
  });
};

/** The animation that moves the root joint's position, if the clip has one. */
const rootTrackOf = (group: AnimationGroup, rootJoint: string) =>
  group.targetedAnimations.find(
    (targeted) => targeted.target?.name === rootJoint && targeted.animation.targetProperty === "position",
  );

/**
 * A private copy of the root track with the clip's fixes applied.
 *
 * Copied, never edited in place: instances of one model share their Animation
 * objects, so an in-place edit would apply twice to the second cook who picks
 * the same character.
 */
const fixRootTrack = (
  group: AnimationGroup,
  spec: EmbeddedClip,
  rootJoint: string,
  stance: Vec3 | null,
): Animation | null => {
  const root = rootTrackOf(group, rootJoint);
  if (!root) return null;
  const keys = root.animation.getKeys();
  const fps = root.animation.framePerSecond;
  const offsets = spec.grounded
    ? groundingOffsets(
      collectJoints(group),
      keys.map((key) => key.frame / fps),
      { floor: FLOOR_CLEARANCE, maxHop: spec.maxHop },
    )
    : keys.map(() => 0);

  const fixed = root.animation.clone();
  fixed.setKeys(keys.map((key, index): IAnimationKey => {
    const value = (key.value as Vector3).clone();
    value.y += offsets[index] ?? 0;
    if (spec.inPlace && stance) {
      value.x = stance[0];
      value.z = stance[2];
    }
    return { ...key, value };
  }));
  return fixed;
};

/** Names of `jointName` and everything under it. */
const subtreeNames = (instance: ModelInstance, jointName: string): Set<string> => {
  const names = new Set<string>();
  for (const root of instance.rootNodes) {
    for (const node of [root, ...root.getDescendants()]) {
      if (node.name !== jointName) continue;
      names.add(node.name);
      for (const descendant of node.getDescendants()) names.add(descendant.name);
    }
  }
  return names;
};

/**
 * Builds playable clips from the animations inside a character's own file.
 *
 * Each clip becomes a new group rather than the file's own, for three reasons:
 * the root track may need fixing, the gesture must only touch the upper body so
 * the legs keep walking underneath it, and the model's original groups are
 * shared with every other instance of the same file.
 */
export const buildEmbeddedClips = (
  instance: ModelInstance,
  clips: EmbeddedClipSet,
  label: string,
  scene: Scene,
  keys: readonly EmbeddedClipKey[] = EMBEDDED_CLIP_KEYS,
): Map<EmbeddedClipKey, PlayableClip> => {
  const source = (name: string): AnimationGroup | undefined =>
    instance.animationGroups.find((group) => group.name === name);

  // Where the body stands at rest. Clips with root drift are pinned here, so
  // falling over never moves the model off its collider.
  const idleRoot = source(clips.idle.name);
  const stanceKey = idleRoot ? rootTrackOf(idleRoot, clips.rootJoint)?.animation.getKeys()[0] : undefined;
  const stance = stanceKey ? toVec3(stanceKey.value as Vector3) : null;

  const upperBody = subtreeNames(instance, clips.upperBodyJoint);
  const result = new Map<EmbeddedClipKey, PlayableClip>();

  for (const key of keys) {
    const spec = clips[key];
    const original = source(spec.name);
    if (!original) {
      console.warn(`Embedded clip is missing: ${spec.name}`);
      continue;
    }

    const fixedRoot = spec.inPlace || spec.grounded
      ? fixRootTrack(original, spec, clips.rootJoint, stance)
      : null;
    const group = new AnimationGroup(`${label}-${key}`, scene);
    for (const targeted of original.targetedAnimations) {
      const target = targeted.target as Node | null;
      if (!target) continue;
      // Upper body only: the legs stay with whatever locomotion is playing.
      if (key === "gesture" && !upperBody.has(target.name)) continue;
      const isRoot = target.name === clips.rootJoint && targeted.animation.targetProperty === "position";
      group.addTargetedAnimation(isRoot && fixedRoot ? fixedRoot : targeted.animation, target);
    }
    group.enableBlending = true;
    group.blendingSpeed = BLENDING_SPEED[key];
    group.loopAnimation = LOOPING.has(key);

    const fps = original.targetedAnimations[0]?.animation.framePerSecond ?? 60;
    const fromFrame = Math.max(group.from, (spec.from ?? 0) * fps);
    const toFrame = spec.to === undefined ? group.to : Math.min(group.to, spec.to * fps);
    const speed = spec.speed ?? 1;
    result.set(key, {
      group,
      fromFrame,
      toFrame,
      speed,
      loop: LOOPING.has(key),
      seconds: (toFrame - fromFrame) / fps / speed,
      spec,
    });
  }
  return result;
};
