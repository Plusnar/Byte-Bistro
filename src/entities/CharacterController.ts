import {
  AbstractMesh,
  AnimationGroup,
  Bone,
  Color3,
  Node,
  PBRMaterial,
  Quaternion,
  StandardMaterial,
  TransformNode,
  Vector3,
  type BaseTexture,
  type Scene,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import {
  CHARACTER_ANIMATION_ASSETS,
  RIG_MEDIUM_JOINTS,
  type AnimationPackKey,
  type CharacterDefinition,
} from "../data/characters";
import {
  buildEmbeddedClips,
  startClip,
  type EmbeddedClipKey,
  type PlayableClip,
} from "./embeddedClips";
import { ArmPoser, type ArmPose } from "./armPose";
import { HairPhysics } from "./hairPhysics";

/** Slowest a locomotion clip plays, so a cook easing off still steps. */
const MIN_LOCOMOTION_RATE = 0.8;

export type CharacterLocomotionState = "idle" | "walk" | "run";

interface AnimationSources {
  readonly general: ModelInstance;
  readonly movement: ModelInstance;
}

const CLIP_BY_STATE: Readonly<Record<CharacterLocomotionState, string>> = {
  idle: "Idle_A",
  walk: "Walking_A",
  run: "Running_A",
};

const SOURCE_BY_STATE: Readonly<Record<CharacterLocomotionState, keyof AnimationSources>> = {
  idle: "general",
  walk: "movement",
  run: "movement",
};

/**
 * Loads the KayKit Rig_Medium characters and retargets the separate animation
 * packs onto their identically named joints.
 */
export class CharacterController {
  private readonly modelRoot: TransformNode;
  private readonly animations = new Map<CharacterLocomotionState, AnimationGroup>();
  private readonly oneShots = new Map<string, AnimationGroup>();
  /** Looping ambient clips (waving, sitting…), built on demand for placed robots. */
  private readonly ambients = new Map<string, AnimationGroup>();
  private readonly extraPacks = new Map<AnimationPackKey, Promise<ModelInstance | null>>();
  private readonly extraPackInstances: ModelInstance[] = [];
  private activeAmbientId: string | null = null;
  private readonly characterMaterials: StandardMaterial[] = [];
  private animationSourcesPromise: Promise<AnimationSources> | null = null;
  private animationSources: AnimationSources | null = null;
  private characterInstance: ModelInstance | null = null;
  private activeAnimation: AnimationGroup | null = null;
  private activeState: CharacterLocomotionState | null = null;
  private selectedCharacterId: string | null = null;
  private debugSummaryValue = "none";
  private selectionSequence = 0;
  private deathPlaying = false;
  /** Clips for a character that ships its own animations; null for KayKit cooks. */
  private embedded: Map<EmbeddedClipKey, PlayableClip> | null = null;
  /** Spring hair, for a cook whose file has hair joints. */
  private hair: HairPhysics | null = null;
  private arms: ArmPoser | null = null;
  private armPose: ArmPose = "none";
  private knifeProp: TransformNode | null = null;
  /** Where a character is in hit, fall, lie. */
  private downedStage: "none" | "falling" | "lying" = "none";
  private gestureActive = false;
  /** A locomotion change asked for mid-gesture, applied once the gesture ends. */
  private pendingLocomotion: { state: CharacterLocomotionState; speed?: number } | null = null;

  /** Each converted material's own colour, before the lift is added (see setLift). */
  private readonly liftSources = new Map<StandardMaterial, { readonly colour: Color3; readonly texture: BaseTexture | null }>();

  /**
   * @param lift Share of the model's own colour it shows regardless of the light (see
   *   setLift); 0 leaves it lit like the room.
   */
  constructor(
    scene: Scene,
    private readonly assets: AssetManager,
    parent: Node,
    private lift = 0,
  ) {
    this.modelRoot = new TransformNode("player-character-model", scene);
    this.modelRoot.parent = parent;
  }

  /**
   * Brightens the model without washing it out: `amount` of its own colour (its texture
   * times its tint) is added as self-illumination. Hues and the shading of the light stay,
   * just with lifted shadows; a white light would instead flatten the colours and burn
   * the lit side to white. Parts that glow on their own keep their glow.
   */
  setLift(amount: number): void {
    this.lift = Math.max(0, amount);
    for (const [material, source] of this.liftSources) this.applyLift(material, source);
  }

  private applyLift(material: StandardMaterial, source: { readonly colour: Color3; readonly texture: BaseTexture | null }): void {
    material.emissiveTexture = this.lift > 0 ? source.texture : null;
    material.emissiveColor.copyFrom(source.colour).scaleInPlace(this.lift);
  }

  get hasCharacter(): boolean {
    return this.characterInstance !== null;
  }

  get characterId(): string | null {
    return this.selectedCharacterId;
  }

  get locomotionState(): CharacterLocomotionState | null {
    return this.activeState;
  }

  get debugSummary(): string {
    if (!this.characterInstance) return this.debugSummaryValue;
    const meshes = this.characterInstance.rootNodes.flatMap((root) =>
      [root, ...root.getDescendants()].filter(
        (node): node is AbstractMesh => node instanceof AbstractMesh,
      ),
    );
    const renderable = meshes.filter(
      (mesh) => mesh.isEnabled() && mesh.isVisible && mesh.visibility > 0,
    );
    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (const mesh of renderable) {
      mesh.computeWorldMatrix(true);
      minimumY = Math.min(minimumY, mesh.getBoundingInfo().boundingBox.minimumWorld.y);
      maximumY = Math.max(maximumY, mesh.getBoundingInfo().boundingBox.maximumWorld.y);
    }
    const height = Number.isFinite(maximumY - minimumY) ? maximumY - minimumY : 0;
    return `${this.debugSummaryValue} V${renderable.length} RH${height.toFixed(2)}`;
  }

  get debugBounds(): string {
    if (!this.characterInstance) return "—";
    const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    for (const root of this.characterInstance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh) || node.getTotalVertices() === 0) continue;
        node.computeWorldMatrix(true);
        minimum.minimizeInPlace(node.getBoundingInfo().boundingBox.minimumWorld);
        maximum.maximizeInPlace(node.getBoundingInfo().boundingBox.maximumWorld);
      }
    }
    return `X${minimum.x.toFixed(1)}/${maximum.x.toFixed(1)} ` +
      `Y${minimum.y.toFixed(1)}/${maximum.y.toFixed(1)} ` +
      `Z${minimum.z.toFixed(1)}/${maximum.z.toFixed(1)}`;
  }

  /**
   * Holds the arms in a pose over whatever the legs are doing: carrying an item,
   * chopping. Throws, falls and getting up take the arms back while they play.
   * Characters without Mixamo arms ignore it.
   */
  setArmPose(pose: ArmPose): void {
    this.armPose = pose;
    this.arms?.setPose(pose);
  }

  /** The knife shown in the cook's right hand while chopping; an unparented node. */
  setKnifeProp(knife: TransformNode | null): void {
    this.knifeProp = knife;
    this.arms?.setKnife(knife);
  }

  /** How far into the chopping pose the arms are, 0..1. */
  get chopBlend(): number {
    return this.arms?.chopBlend ?? 0;
  }

  /** How far into a pose that leans over a counter the arms are, 0..1. */
  get reachBlend(): number {
    return this.arms?.reachBlend ?? 0;
  }

  /** Whether the knife is in the cook's hand, so the board should not show its own. */
  get holdsKnife(): boolean {
    return this.arms?.holdsKnife ?? false;
  }

  /** Lets the hair fall straight into the current pose, as after a cut. */
  resetHair(): void {
    this.hair?.reset();
  }

  async prepare(): Promise<void> {
    await this.getAnimationSources();
  }

  async selectCharacter(definition: CharacterDefinition): Promise<void> {
    if (definition.id === this.selectedCharacterId && this.characterInstance) {
      // Still a new pick: a load for another cook started in between (A → B → A) must see
      // that it is stale and be dropped, or it would replace the cook just chosen again.
      this.selectionSequence += 1;
      return;
    }

    const selection = ++this.selectionSequence;
    const nextInstance = await this.assets.instantiateModel(definition.modelAssetId, {
      namePrefix: "",
      cloneMaterials: false,
    });
    if (!nextInstance) {
      throw new Error(`Character model is unavailable: ${definition.displayName}`);
    }

    if (definition.rig === "Embedded") {
      this.adoptEmbeddedCharacter(nextInstance, definition, selection);
      return;
    }

    let nextMaterials: StandardMaterial[] = [];
    try {
      const sources = await this.getAnimationSources();
      if (selection !== this.selectionSequence) {
        nextInstance.dispose();
        return;
      }

      this.validateRig(nextInstance, definition);
      for (const rootNode of nextInstance.rootNodes) {
        rootNode.parent = this.modelRoot;
      }
      nextMaterials = this.convertMaterials(nextInstance, definition.id);
      this.fitToWorld(nextInstance, definition.targetHeight);

      const nextAnimations = this.createAnimations(nextInstance, sources, definition.id);
      this.disposeCurrentCharacter();
      this.characterInstance = nextInstance;
      this.characterMaterials.push(...nextMaterials);
      this.selectedCharacterId = definition.id;
      for (const [state, animation] of nextAnimations) {
        this.animations.set(state, animation);
      }
      this.setLocomotion("idle");
    } catch (error) {
      for (const material of nextMaterials) material.dispose(false, false);
      nextInstance.dispose();
      throw error;
    }
  }

  /**
   * @param speed Horizontal speed in m/s. Characters with their own clips use it
   *   to match the stride to the ground, which is what keeps the feet planted.
   */
  setLocomotion(state: CharacterLocomotionState, speed?: number): void {
    if (this.embedded) {
      this.setEmbeddedLocomotion(state, speed);
      return;
    }
    if (this.activeState === state && this.activeAnimation?.isPlaying) {
      return;
    }

    const nextAnimation = this.animations.get(state);
    if (!nextAnimation) {
      return;
    }

    this.stopDeath();
    this.activeAnimation?.stop(true);
    this.activeAnimation = nextAnimation;
    this.activeState = state;
    this.activeAmbientId = null;
    nextAnimation.start(true, state === "walk" ? 1.08 : 1);
  }

  /**
   * Loops an arbitrary clip, for robots standing around the room.
   *
   * Idempotent: safe to call every frame, which is how the crowd drives it. Anything from a
   * pack beyond general/movement fetches that pack the first time it is asked for, so a level
   * with no sitting robots never downloads the simulation clips.
   */
  async playAmbientClip(clipId: string, pack: AnimationPackKey): Promise<void> {
    if (!this.characterInstance) return;
    if (this.activeAmbientId === clipId && this.activeAnimation?.isPlaying) return;
    const selection = this.selectionSequence;

    let group = this.ambients.get(clipId);
    if (!group) {
      const source = await this.getPackSource(pack);
      // The character was swapped or disposed while the pack was downloading.
      if (!source || selection !== this.selectionSequence || !this.characterInstance) return;
      if (this.ambients.has(clipId)) {
        group = this.ambients.get(clipId);
      } else {
        group = this.cloneFrom(source, clipId) ?? undefined;
        if (!group) return;
        group.loopAnimation = true;
        this.ambients.set(clipId, group);
      }
    }
    if (!group || this.activeAnimation === group) return;
    this.stopDeath();
    this.activeAnimation?.stop(true);
    this.activeAnimation = group;
    // Null so `setLocomotion` never mistakes an ambient pose for a locomotion state.
    this.activeState = null;
    this.activeAmbientId = clipId;
    group.start(true, 1);
  }

  /**
   * Holds the clip playing now still, or lets it run again; and restarts it from its first
   * frame. A line of robots marching in step needs both: they start together, and stop
   * together when the parade rests.
   */
  setAnimationPaused(paused: boolean): void {
    const group = this.activeAnimation;
    if (!group) return;
    if (paused) group.pause();
    else group.play(group.loopAnimation);
  }

  /** Restarts the playing clip `fraction` of the way through (0 is its first frame). */
  restartAnimation(fraction = 0): void {
    const group = this.activeAnimation;
    if (!group) return;
    group.reset();
    if (fraction > 0) group.goToFrame(group.from + (group.to - group.from) * fraction);
  }

  /** How far through its loop the clip playing now is, 0..1 (0 when nothing plays). */
  animationProgress(): number {
    const group = this.activeAnimation;
    const frame = group?.animatables[0]?.masterFrame;
    if (!group || frame === undefined || group.to <= group.from) return 0;
    return Math.min(1, Math.max(0, (frame - group.from) / (group.to - group.from)));
  }

  /** Playback rate of the clip playing now (1 is as authored). */
  setAnimationSpeed(ratio: number): void {
    if (this.activeAnimation) this.activeAnimation.speedRatio = ratio;
  }

  /**
   * Plays a clip from an animation pack once, such as a robot's throw. Resolves with
   * how long it runs in seconds, or 0 when it cannot be played. Whatever plays next
   * (an ambient clip, locomotion) takes over from its last frame.
   */
  async playOneShot(clipId: string, pack: AnimationPackKey, speed = 1): Promise<number> {
    if (!this.characterInstance) return 0;
    const selection = this.selectionSequence;
    let group = this.oneShots.get(clipId);
    if (!group) {
      const source = await this.getPackSource(pack);
      if (!source || selection !== this.selectionSequence || !this.characterInstance) return 0;
      group = this.oneShots.get(clipId) ?? this.cloneFrom(source, clipId) ?? undefined;
      if (!group) return 0;
      group.loopAnimation = false;
      this.oneShots.set(clipId, group);
    }
    this.stopDeath();
    this.activeAnimation?.stop(true);
    this.activeAnimation = group;
    this.activeState = null;
    this.activeAmbientId = null;
    group.start(false, speed);
    const fps = group.targetedAnimations[0]?.animation.framePerSecond ?? 30;
    return (group.to - group.from) / fps / speed;
  }

  private async getPackSource(pack: AnimationPackKey): Promise<ModelInstance | null> {
    if (pack === "general" || pack === "movement") {
      const sources = await this.getAnimationSources();
      return sources[pack];
    }
    let pending = this.extraPacks.get(pack);
    if (!pending) {
      pending = this.assets
        .instantiateModel(CHARACTER_ANIMATION_ASSETS[pack].id, { namePrefix: "" })
        .then((source) => {
          if (!source) return null;
          for (const group of source.animationGroups) group.stop(true);
          for (const node of source.rootNodes) node.setEnabled(false);
          this.extraPackInstances.push(source);
          return source;
        })
        .catch((error: unknown) => {
          console.warn(`Animation pack is unavailable: ${pack}`, error);
          return null;
        });
      this.extraPacks.set(pack, pending);
    }
    return pending;
  }

  /** Retargets one named clip from `source` onto the live character. */
  private cloneFrom(source: ModelInstance, clipName: string): AnimationGroup | null {
    const instance = this.characterInstance;
    if (!instance) return null;
    const sourceGroup = source.animationGroups.find((group) => group.name === clipName);
    if (!sourceGroup) {
      console.warn(`Animation clip is missing: ${clipName}`);
      return null;
    }
    const nodes = this.collectNodes(instance.rootNodes);
    const bones = new Map<string, Bone>();
    for (const skeleton of instance.skeletons) {
      for (const bone of skeleton.bones) bones.set(bone.name, bone);
    }
    const resolveTarget = (oldTarget: unknown): Node | Bone | undefined => {
      if (!(oldTarget instanceof Node)) return undefined;
      if (oldTarget instanceof Bone) return bones.get(oldTarget.name) ?? nodes.get(oldTarget.name);
      return nodes.get(oldTarget.name) ?? bones.get(oldTarget.name);
    };
    const cloned = sourceGroup.clone(
      `ambient-${this.selectedCharacterId ?? "robot"}-${clipName}`,
      (oldTarget) => resolveTarget(oldTarget) ?? oldTarget,
      true,
      true,
    );
    cloned.enableBlending = true;
    cloned.blendingSpeed = 0.08;
    return cloned;
  }

  /**
   * Idempotent: safe to call every frame while the player is downed.
   *
   * A character with its own clips falls, then loops a lying pose until
   * `playStandUp`; a KayKit cook plays its single death clip.
   */
  playDeath(): void {
    if (this.embedded) {
      this.playEmbeddedDowned();
      return;
    }
    if (this.deathPlaying) return;
    const death = this.oneShots.get("Death_A");
    if (!death) return;
    this.activeAnimation?.stop(true);
    this.activeAnimation = null;
    this.activeState = null;
    this.deathPlaying = true;
    death.start(false, 1);
  }

  private stopDeath(): void {
    if (!this.deathPlaying) return;
    this.deathPlaying = false;
    // Cleared first: stopping a group fires its end event, and the fall's end
    // handler must not start the lying loop on the way out.
    this.downedStage = "none";
    this.oneShots.get("Death_A")?.stop(true);
    this.embedded?.get("knockDown")?.group.stop();
    this.embedded?.get("downed")?.group.stop();
  }

  /**
   * Plays the throw-or-set-down gesture over whatever the legs are doing.
   *
   * Characters without a gesture clip ignore it, which is how the KayKit cooks
   * behaved before.
   */
  playGesture(): void {
    const clip = this.embedded?.get("gesture");
    if (!clip || this.deathPlaying || !this.characterInstance) return;
    // Retriggering: drop the flag first so the stop below does not count as
    // the gesture finishing and restart the legs under the new one.
    this.gestureActive = false;
    clip.group.stop();
    this.gestureActive = true;
    startClip(clip);
  }

  /**
   * Starts getting up off the floor. Returns how long it takes in seconds, or
   * 0 when the character has no clip for it and the caller should time it.
   */
  playStandUp(): number {
    const clip = this.embedded?.get("standUp");
    if (!clip) return 0;
    this.cancelGesture();
    // The floor pose stays on the skeleton after these stop, and the stand-up
    // blends out of it rather than snapping back to standing first.
    this.stopDeath();
    this.activeAnimation?.stop(true);
    this.activeAnimation = clip.group;
    // Null, so the next setLocomotion always takes over once they are up.
    this.activeState = null;
    startClip(clip);
    return clip.seconds;
  }

  dispose(): void {
    this.selectionSequence++;
    this.disposeCurrentCharacter();
    if (this.animationSources) {
      this.animationSources.general.dispose();
      this.animationSources.movement.dispose();
      this.animationSources = null;
    }
    for (const source of this.extraPackInstances) source.dispose();
    this.extraPackInstances.length = 0;
    this.extraPacks.clear();
    this.modelRoot.dispose(false, false);
  }

  private async getAnimationSources(): Promise<AnimationSources> {
    if (this.animationSourcesPromise) {
      return this.animationSourcesPromise;
    }

    this.animationSourcesPromise = Promise.all([
      this.assets.instantiateModel(CHARACTER_ANIMATION_ASSETS.general.id, {
        namePrefix: "",
      }),
      this.assets.instantiateModel(CHARACTER_ANIMATION_ASSETS.movement.id, {
        namePrefix: "",
      }),
    ]).then(([general, movement]) => {
      if (!general || !movement) {
        general?.dispose();
        movement?.dispose();
        throw new Error("Rig_Medium animation packs could not be loaded.");
      }

      for (const source of [general, movement]) {
        for (const animationGroup of source.animationGroups) animationGroup.stop(true);
        for (const rootNode of source.rootNodes) rootNode.setEnabled(false);
      }

      const sources = { general, movement };
      this.animationSources = sources;
      return sources;
    });
    // A failed load must not be cached: the next pick or Start retries it.
    const pending = this.animationSourcesPromise;
    pending.catch(() => {
      if (this.animationSourcesPromise === pending) this.animationSourcesPromise = null;
    });

    return this.animationSourcesPromise;
  }

  private validateRig(instance: ModelInstance, definition: CharacterDefinition): void {
    const jointNames = new Set(
      instance.skeletons.flatMap((skeleton) => skeleton.bones.map((bone) => bone.name)),
    );
    // Mannequin_Medium has the same deforming bones but omits the two prop
    // sockets. Recreate those empty nodes so socket tracks never target another rig.
    const missing = RIG_MEDIUM_JOINTS.filter((joint) => !joint.startsWith('handslot.') && !jointNames.has(joint));
    if (missing.length > 0) {
      throw new Error(
        `${definition.displayName} is not compatible with Rig_Medium; missing joints: ${missing.join(", ")}`,
      );
    }
    const nodes = this.collectNodes(instance.rootNodes);
    for (const side of ['l', 'r']) {
      const name = `handslot.${side}`;
      if (jointNames.has(name) || nodes.has(name)) continue;
      const hand = nodes.get(`hand.${side}`);
      if (!hand) throw new Error(`Missing hand transform: ${side}`);
      const socket = new TransformNode(name, this.modelRoot.getScene());
      socket.rotationQuaternion = Quaternion.Identity();
      socket.parent = hand;
    }
  }

  private createAnimations(
    character: ModelInstance,
    sources: AnimationSources,
    characterId: string,
  ): Map<CharacterLocomotionState, AnimationGroup> {
    const nodes = this.collectNodes(character.rootNodes);
    const bones = new Map<string, Bone>();
    for (const skeleton of character.skeletons) {
      for (const bone of skeleton.bones) bones.set(bone.name, bone);
    }

    const resolveTarget = (oldTarget: unknown): Node | Bone | undefined => {
      if (!(oldTarget instanceof Node)) return undefined;
      if (oldTarget instanceof Bone) return bones.get(oldTarget.name) ?? nodes.get(oldTarget.name);
      return nodes.get(oldTarget.name) ?? bones.get(oldTarget.name);
    };

    const result = new Map<CharacterLocomotionState, AnimationGroup>();
    try {
      for (const state of ["idle", "walk", "run"] as const) {
        const source = sources[SOURCE_BY_STATE[state]];
        const clipName = CLIP_BY_STATE[state];
        const sourceGroup = source.animationGroups.find((group) => group.name === clipName);
        if (!sourceGroup) {
          throw new Error(`Animation clip is missing: ${clipName}`);
        }

        const unmapped = new Set<string>();
        for (const targeted of sourceGroup.targetedAnimations) {
          const target = targeted.target;
          if (target instanceof Node && !resolveTarget(target)) unmapped.add(target.name);
        }
        if (unmapped.size > 0) {
          throw new Error(
            `Rig_Medium retarget failed for ${clipName}: ${[...unmapped].join(", ")}`,
          );
        }

        const group = sourceGroup.clone(
          `player-${characterId}-${clipName}`,
          (oldTarget) => resolveTarget(oldTarget) ?? oldTarget,
          true,
          true,
        );
        group.enableBlending = true;
        group.blendingSpeed = 0.08;
        result.set(state, group);
      }

      const generalSource = sources.general;
      const cloneOneShot = (name: string): AnimationGroup => {
        const sourceGroup = generalSource.animationGroups.find((group) => group.name === name);
        if (!sourceGroup) {
          throw new Error(`One-shot animation clip missing: ${name}`);
        }
        const unmapped = new Set<string>();
        for (const targeted of sourceGroup.targetedAnimations) {
          const target = targeted.target;
          if (target instanceof Node && !resolveTarget(target)) unmapped.add(target.name);
        }
        if (unmapped.size > 0) {
          throw new Error(
            `Rig_Medium retarget failed for ${name}: ${[...unmapped].join(", ")}`,
          );
        }
        const cloned = sourceGroup.clone(
          `player-${characterId}-${name}`,
          (oldTarget) => resolveTarget(oldTarget) ?? oldTarget,
          true,
          true,
        );
        cloned.enableBlending = true;
        cloned.blendingSpeed = 0.12;
        return cloned;
      };
      this.oneShots.set("Death_A", cloneOneShot("Death_A"));

      return result;
    } catch (error) {
      for (const animation of result.values()) animation.dispose();
      for (const oneShot of this.oneShots.values()) oneShot.dispose();
      this.oneShots.clear();
      throw error;
    }
  }

  /**
   * Takes on a character that ships its own animations. Nothing is retargeted
   * and the Rig_Medium packs are not needed: its clips are built from the file
   * with the slicing, pacing and floor fixes its definition asks for.
   */
  private adoptEmbeddedCharacter(
    instance: ModelInstance,
    definition: Extract<CharacterDefinition, { rig: "Embedded" }>,
    selection: number,
  ): void {
    if (selection !== this.selectionSequence) {
      instance.dispose();
      return;
    }
    let materials: StandardMaterial[] = [];
    try {
      for (const rootNode of instance.rootNodes) rootNode.parent = this.modelRoot;
      for (const group of instance.animationGroups) group.stop();
      materials = this.convertMaterials(instance, definition.id);
      this.fitToWorld(instance, definition.targetHeight);
      const clips = buildEmbeddedClips(
        instance,
        definition.clips,
        `player-${definition.id}`,
        this.modelRoot.getScene(),
      );

      this.disposeCurrentCharacter();
      this.characterInstance = instance;
      this.characterMaterials.push(...materials);
      this.selectedCharacterId = definition.id;
      this.embedded = clips;
      if (this.modelRoot.parent instanceof TransformNode) {
        // Attached before the hair, so the hair is simulated after the lean. A throw,
        // a fall or getting up owns the arms while it plays; getting up is the clip
        // with no locomotion state.
        this.arms = ArmPoser.attach(
          instance.rootNodes,
          this.modelRoot.getScene(),
          this.modelRoot.parent,
          () => this.gestureActive || this.deathPlaying || this.activeState === null,
        );
        this.arms?.setPose(this.armPose);
        this.arms?.setKnife(this.knifeProp);
      }
      if (definition.hair) {
        this.hair = HairPhysics.attach(instance.rootNodes, this.modelRoot.getScene(), definition.hair);
      }

      // One persistent listener each, keyed off state rather than added per play,
      // so a retriggered clip never leaves a stale handler behind.
      clips.get("gesture")?.group.onAnimationGroupEndObservable.add(() => this.onGestureEnded());
      clips.get("knockDown")?.group.onAnimationGroupEndObservable.add(() => this.onFallLanded());
      this.setLocomotion("idle");
    } catch (error) {
      for (const material of materials) material.dispose(false, false);
      instance.dispose();
      throw error;
    }
  }

  private setEmbeddedLocomotion(state: CharacterLocomotionState, speed?: number): void {
    const clip = this.embedded?.get(state);
    if (!clip) return;
    const rate = this.locomotionRate(clip, speed);

    if (this.gestureActive) {
      // Starting a new clip now would be evaluated after the gesture and take
      // the arms back from it. Keep pace with the one already playing instead.
      this.pendingLocomotion = { state, speed };
      if (this.activeState === state && this.activeAnimation) this.activeAnimation.speedRatio = rate;
      return;
    }
    if (this.activeState === state && this.activeAnimation === clip.group && clip.group.isPlaying) {
      clip.group.speedRatio = rate;
      return;
    }

    this.stopDeath();
    this.activeAnimation?.stop(true);
    this.activeAnimation = clip.group;
    this.activeState = state;
    this.activeAmbientId = null;
    startClip(clip, rate);
  }

  /**
   * Playback rate that makes planted feet travel at the character's speed.
   *
   * Clips authored in place say how fast their feet move; dividing the real
   * speed by that, at the model's fitted scale, is what keeps the soles from
   * skating. Clamped so a cook easing to a halt still visibly steps.
   */
  private locomotionRate(clip: PlayableClip, speed?: number): number {
    const footSpeed = clip.spec.footSpeed;
    if (!footSpeed || speed === undefined || speed <= 0) return clip.speed;
    const natural = footSpeed * this.modelRoot.scaling.x;
    return Math.min(clip.spec.maxSpeed ?? 2, Math.max(MIN_LOCOMOTION_RATE, speed / natural));
  }

  /**
   * The gesture only drove the upper body. Handing it back to locomotion by
   * restarting that clip at the frame it had reached keeps arms and legs in
   * step, and the restart's blending eases the arms out of the throw.
   */
  private onGestureEnded(): void {
    if (!this.gestureActive) return;
    this.gestureActive = false;
    const group = this.activeAnimation;
    const clip = this.activeState ? this.embedded?.get(this.activeState) : undefined;
    if (group && clip && group === clip.group) {
      const frame = group.animatables[0]?.masterFrame;
      const rate = group.speedRatio;
      group.stop();
      startClip(clip, rate);
      if (frame !== undefined) group.goToFrame(frame);
    }
    const pending = this.pendingLocomotion;
    this.pendingLocomotion = null;
    if (pending) this.setLocomotion(pending.state, pending.speed);
  }

  private cancelGesture(): void {
    if (!this.gestureActive) return;
    this.gestureActive = false;
    this.pendingLocomotion = null;
    this.embedded?.get("gesture")?.group.stop();
  }

  private playEmbeddedDowned(): void {
    if (this.deathPlaying) return;
    this.cancelGesture();
    this.activeAnimation?.stop(true);
    this.activeAnimation = null;
    this.activeState = null;
    this.deathPlaying = true;
    const fall = this.embedded?.get("knockDown");
    if (fall) {
      this.downedStage = "falling";
      startClip(fall);
    } else {
      this.onFallLanded();
    }
  }

  /** The fall has landed: lie there reaching out until it is time to get up. */
  private onFallLanded(): void {
    if (!this.deathPlaying || this.downedStage === "lying") return;
    if (this.downedStage !== "falling" && this.embedded?.get("knockDown")) return;
    this.downedStage = "lying";
    const lying = this.embedded?.get("downed");
    if (lying) startClip(lying);
  }

  private collectNodes(rootNodes: readonly Node[]): Map<string, Node> {
    const result = new Map<string, Node>();
    for (const root of rootNodes) {
      result.set(root.name, root);
      for (const descendant of root.getDescendants()) {
        if (!result.has(descendant.name)) result.set(descendant.name, descendant);
      }
    }
    return result;
  }

  private convertMaterials(
    instance: ModelInstance,
    characterId: string,
  ): StandardMaterial[] {
    const converted = new Map<number, StandardMaterial>();
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh) || !(node.material instanceof PBRMaterial)) continue;
        const source = node.material;
        let material = converted.get(source.uniqueId);
        if (!material) {
          material = new StandardMaterial(
            `character-${characterId}-${source.name}`,
            this.modelRoot.getScene(),
          );
          material.diffuseTexture = source.albedoTexture;
          material.diffuseColor.copyFrom(source.albedoColor);
          material.emissiveTexture = source.emissiveTexture;
          material.emissiveColor.copyFrom(source.emissiveColor);
          // Glowing parts (eyes, screens) keep their own emissive; the rest may be lifted.
          if (!source.emissiveTexture && source.emissiveColor.toLuminance() < 0.01) {
            const lifted = { colour: source.albedoColor.clone(), texture: source.albedoTexture };
            this.liftSources.set(material, lifted);
            this.applyLift(material, lifted);
          }
          material.specularColor.copyFrom(Color3.White().scale(0.12));
          material.alpha = source.alpha;
          material.backFaceCulling = source.backFaceCulling;
          material.useAlphaFromDiffuseTexture = false;
          converted.set(source.uniqueId, material);
        }
        node.material = material;
      }
    }
    return [...converted.values()];
  }

  private fitToWorld(instance: ModelInstance, targetHeight: number): void {
    this.modelRoot.position.setAll(0);
    this.modelRoot.scaling.setAll(1);
    this.modelRoot.computeWorldMatrix(true);

    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    for (const root of instance.rootNodes) {
      const candidates = [root, ...root.getDescendants()];
      for (const node of candidates) {
        if (!(node instanceof AbstractMesh) || node.getTotalVertices() === 0) continue;
        node.computeWorldMatrix(true);
        const boundingBox = node.getBoundingInfo().boundingBox;
        minimumY = Math.min(minimumY, boundingBox.minimumWorld.y);
        maximumY = Math.max(maximumY, boundingBox.maximumWorld.y);
      }
    }

    const measuredHeight = maximumY - minimumY;
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0.001) {
      throw new Error("Character bounds could not be measured.");
    }

    const anchorY = this.modelRoot.getAbsolutePosition().y;
    const scale = targetHeight / measuredHeight;
    this.modelRoot.scaling.copyFrom(new Vector3(scale, scale, scale));
    this.modelRoot.position.y = -(minimumY - anchorY) * scale;
    this.modelRoot.computeWorldMatrix(true);
    const meshCount = instance.rootNodes.reduce(
      (count, root) =>
        count + [root, ...root.getDescendants()].filter((node) => node instanceof AbstractMesh).length,
      0,
    );
    this.debugSummaryValue =
      `S${scale.toFixed(2)} H${measuredHeight.toFixed(2)} ` +
      `Y${this.modelRoot.position.y.toFixed(2)} M${meshCount}`;
  }

  private disposeCurrentCharacter(): void {
    this.activeAnimation?.stop(true);
    this.activeAnimation = null;
    this.activeState = null;
    this.deathPlaying = false;
    for (const animation of this.animations.values()) animation.dispose();
    this.animations.clear();
    for (const oneShot of this.oneShots.values()) oneShot.dispose();
    this.oneShots.clear();
    for (const ambient of this.ambients.values()) ambient.dispose();
    this.ambients.clear();
    this.activeAmbientId = null;
    for (const clip of this.embedded?.values() ?? []) clip.group.dispose();
    this.embedded = null;
    this.hair?.dispose();
    this.hair = null;
    this.arms?.dispose();
    this.arms = null;
    this.downedStage = "none";
    this.gestureActive = false;
    this.pendingLocomotion = null;
    for (const material of this.characterMaterials) material.dispose(false, false);
    this.characterMaterials.length = 0;
    this.characterInstance?.dispose();
    this.characterInstance = null;
    this.selectedCharacterId = null;
  }
}
