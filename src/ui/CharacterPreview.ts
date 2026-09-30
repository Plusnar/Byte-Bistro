import {
  AbstractMesh,
  AnimationGroup,
  ArcRotateCamera,
  Bone,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Node,
  PBRMaterial,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import { AssetManager, type ModelInstance } from "../core/AssetManager";
import { CHARACTER_ANIMATION_ASSETS, type CharacterDefinition } from "../data/characters";
import { buildEmbeddedClips } from "../entities/embeddedClips";

const IDLE_CLIP = "Idle_A";
const CAMERA_TARGET_HEIGHT = 2.05;
const WALK_CLIP = "Walking_A";
const CAMERA_RADIUS = 9.4;
/**
 * Where each player's cook stands.
 *
 * The camera sits on +Z looking back at the origin, so a cook at +X renders on the LEFT of
 * the screen. Player one is therefore the positive slot.
 */
const SLOT_X: readonly [number, number] = [2.15, -2.15];
/** Seconds the pair spends walking forward before the match starts. */
const CONFIRM_SECONDS = 1.2;
/** How far forward they walk on confirm, in metres. */
const CONFIRM_WALK_DISTANCE = 2.6;
const KITCHEN_ASSET = {
  id: "character-selection-kitchen",
  url: new URL("../assets/selection-kitchen/Character Selection Kitchen.glb", import.meta.url).href,
  required: true,
  priority: "critical" as const,
};
/** How long the confirm walk waits for its clip before walking without it. */
const WALK_CLIP_WAIT_MS = 1500;

/** What the loading screen needs to know once the menu has settled. */
export interface PreviewReadiness {
  /** Human-readable names of what could not be shown, empty when everything loaded. */
  readonly failed: readonly string[];
}

/** A promise that can be resolved from outside, once; later calls are ignored. */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
};

/**
 * A surface that carries its own light: no base colour, all of its image in the emissive
 * channel. The kitchen's window view is authored this way, and so is any painted backdrop.
 */
const isSelfLitBackdrop = (source: PBRMaterial): boolean =>
  source.emissiveTexture !== null &&
  source.albedoTexture === null &&
  source.albedoColor.r === 0 &&
  source.albedoColor.g === 0 &&
  source.albedoColor.b === 0;

interface PreviewModel {
  instance: ModelInstance;
  root: TransformNode;
  /** `<slot>-<character>`, the suffix of this model's cloned animation groups. */
  key: string;
  idle: AnimationGroup | null;
  /** Played while the pair walks forward on confirm. */
  walk: AnimationGroup | null;
  /** Playback rate for `walk` that keeps the feet planted over the confirm walk. */
  walkRate: number;
  materials: StandardMaterial[];
}

/** Average speed of the confirm walk, in m/s. */
const CONFIRM_WALK_SPEED = CONFIRM_WALK_DISTANCE / CONFIRM_SECONDS;

/** Which cook is standing in a player's slot. */
interface SlotState {
  characterId: string | null;
  standing: PreviewModel | null;
}

export interface CharacterPreviewOptions {
  readonly characters: readonly CharacterDefinition[];
}

/**
 * Renders a single idle character on its own canvas so the start menu can show
 * the selected model live. It is intentionally independent from the kitchen
 * scene and only ever plays the idle loop.
 */
export class CharacterPreview {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly assets: AssetManager;
  private readonly root: TransformNode;
  private kitchen: ModelInstance | null = null;
  private kitchenMaterials: StandardMaterial[] = [];
  /** Settles true once the kitchen is on screen, false if it could not load. */
  private kitchenSettled: Promise<boolean>;
  /** Settles the first time each player's slot shows a cook, or fails to. */
  private firstSlots = [deferred<boolean>(), deferred<boolean>()] as const;
  private readonly previews = new Map<string, Promise<PreviewModel | null>>();
  private current: PreviewModel | null = null;
  private readonly slots: [SlotState, SlotState] = [
    { characterId: null, standing: null },
    { characterId: null, standing: null },
  ];
  /** 0 while choosing, ramps to 1 as the pair walks together on confirm. */
  private confirmProgress = 0;
  private confirming = false;
  private readonly resizeObserver: ResizeObserver;
  private model: ModelInstance | null = null;
  private idle: AnimationGroup | null = null;
  private animationSource: ModelInstance | null = null;
  private movementSource: ModelInstance | null = null;
  private movementSourcePromise: Promise<ModelInstance | null> | null = null;
  private animationSourcePromise: Promise<ModelInstance | null> | null = null;
  private sequence = 0;
  private active = true;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: CharacterPreviewOptions) {
    this.engine = new Engine(canvas, true, {
      alpha: true,
      preserveDrawingBuffer: false,
      stencil: false,
      antialias: true,
    });

    this.scene = new Scene(this.engine);
    // Transparent: the menu's own backdrop shows through instead of a flat bright fill.
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.scene.skipPointerMovePicking = true;

    this.camera = new ArcRotateCamera(
      "character-preview-camera",
      Math.PI / 2,
      Math.PI / 2.1,
      CAMERA_RADIUS,
      new Vector3(0, CAMERA_TARGET_HEIGHT, 0),
      this.scene,
    );
    this.camera.fov = 0.72;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 60;

    /*
     * Flat, shadowless lighting, to render the kitchen the way it is authored in Blender.
     *
     * Three things were tinting it brown. The worst was the hemispheric light's ground
     * colour: a vertical wall takes a 50/50 mix of sky and ground, so a brown ground turned
     * cream tiles tan no matter how bright the rig was. The warm sky and pendant colours
     * pushed the rest of the way, and the shadow map added a hard pool on the floor.
     *
     * StandardMaterial still sums every light and clamps at 1.0, so the total stays at ~1.0.
     */
    const ambient = new HemisphericLight(
      "character-preview-ambient",
      new Vector3(0, 1, 0),
      this.scene,
    );
    ambient.intensity = 0.88;
    ambient.diffuse = Color3.White();
    // Barely below white: enough to keep undersides readable, not enough to tint anything.
    ambient.groundColor = Color3.FromHexString("#E4E9EF");
    ambient.specular = Color3.Black();

    // A soft fill from the camera side so the cooks keep a silhouette against the room.
    // Deliberately not a key light and deliberately casting nothing.
    const fill = new DirectionalLight(
      "character-preview-fill",
      new Vector3(-0.12, -0.42, -1),
      this.scene,
    );
    fill.intensity = 0.14;
    fill.diffuse = Color3.White();
    fill.specular = Color3.Black();

    this.root = new TransformNode("character-preview-root", this.scene);

    // The menu's critical path: the kitchen, the two cooks on screen and their idle clip.
    // Every cook is registered, but only the ones actually shown are ever fetched — the
    // other four load when a player browses to them.
    this.assets = new AssetManager(this.scene, [
      KITCHEN_ASSET,
      ...options.characters.map((character) => ({
        id: character.modelAssetId,
        url: character.modelUrl,
        priority: "critical" as const,
        lazy: true,
      })),
      { ...CHARACTER_ANIMATION_ASSETS.general, priority: "critical" },
      // Only the confirm walk uses it, so it must not hold up the menu.
      { ...CHARACTER_ANIMATION_ASSETS.movement, priority: "gameplay" },
    ]);
    this.kitchenSettled = this.loadKitchenSafely();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.scene.onBeforeRenderObservable.add(() => {
      this.updateSlots(this.engine.getDeltaTime() / 1000);
    });
    this.engine.runRenderLoop(() => this.scene.render());
  }

  /**
   * Resolves once the menu is presentable: the kitchen and both players' cooks are on
   * screen, or have definitively failed. Never rejects — the loading screen decides what a
   * failure means, and a missing backdrop should not lock the player out of the game.
   */
  async whenReady(): Promise<PreviewReadiness> {
    const [kitchen, playerOne, playerTwo] = await Promise.all([
      this.kitchenSettled,
      this.firstSlots[0].promise,
      this.firstSlots[1].promise,
    ]);
    const failed: string[] = [];
    if (!kitchen) failed.push("cenário do menu");
    if (!playerOne) failed.push("cozinheiro do jogador 1");
    if (!playerTwo) failed.push("cozinheiro do jogador 2");
    return { failed };
  }

  /** Steps already done out of `stageCount`, for the loading bar. */
  get stagesDone(): number {
    return (this.kitchen ? 1 : 0) + this.slots.filter((slot) => slot.standing).length;
  }

  readonly stageCount = 3;

  /**
   * The menu's critical files, available before a preview exists: `Game` requests them
   * before creating its engine, so the downloads overlap that work instead of following it.
   */
  static criticalUrls(characters: readonly CharacterDefinition[]): string[] {
    return [
      KITCHEN_ASSET.url,
      CHARACTER_ANIMATION_ASSETS.general.url,
      ...characters.map((character) => character.modelUrl),
    ];
  }

  /** The files the menu cannot be shown without, grouped for the loading screen. */
  menuAssetUrls(characters: readonly CharacterDefinition[]): {
    kitchen: string[];
    cooks: string[];
    animations: string[];
  } {
    const urls = (ids: readonly string[]): string[] =>
      ids.map((id) => this.assets.urlOf(id)).filter((url): url is string => url !== null);
    return {
      kitchen: urls([KITCHEN_ASSET.id]),
      cooks: urls(characters.map((character) => character.modelAssetId)),
      animations: urls([CHARACTER_ANIMATION_ASSETS.general.id]),
    };
  }

  /** Re-attempts whatever failed to load; `whenReady` then reflects the new attempt. */
  retry(characters: readonly [CharacterDefinition, CharacterDefinition]): void {
    if (!this.kitchen) this.kitchenSettled = this.loadKitchenSafely();
    for (const slot of [0, 1] as const) {
      if (this.slots[slot].standing) continue;
      this.firstSlots = slot === 0
        ? [deferred<boolean>(), this.firstSlots[1]]
        : [this.firstSlots[0], deferred<boolean>()];
      this.slots[slot].characterId = null;
      void this.showSlot(slot, characters[slot]);
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Puts `character` in a player's slot, replacing whoever was standing there. */
  async showSlot(slot: 0 | 1, character: CharacterDefinition): Promise<void> {
    if (this.disposed) return;
    const state = this.slots[slot];
    if (state.characterId === character.id) return;
    state.characterId = character.id;

    const preview = await this.prepare(character, slot);
    if (this.disposed) return;
    if (!preview) {
      this.firstSlots[slot].resolve(false);
      return;
    }
    // Another change landed while this model was loading.
    if (state.characterId !== character.id) return;

    const previous = state.standing;
    if (previous && previous !== preview) {
      previous.idle?.stop();
      previous.walk?.stop();
      previous.root.setEnabled(false);
    }
    state.standing = preview;
    this.placeSlot(preview, SLOT_X[slot], slot, 0);
    preview.root.setEnabled(true);
    preview.walk?.stop();
    preview.idle?.start(true, 1);
    this.firstSlots[slot].resolve(true);
  }

  /** Both cooks walk forward; resolves once they have finished the walk. */
  async playConfirm(): Promise<void> {
    if (this.disposed) return;
    const standing = this.slots.map((state) => state.standing).filter(
      (model): model is PreviewModel => model !== null,
    );
    await Promise.race([
      Promise.all(standing.map((model) => this.ensureWalk(model))),
      new Promise((resolve) => window.setTimeout(resolve, WALK_CLIP_WAIT_MS)),
    ]);
    if (this.disposed) return;
    this.confirming = true;
    for (const model of standing) {
      model.idle?.stop();
      // Without the clip they still step forward, just without leg animation.
      model.walk?.start(true, model.walkRate);
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, CONFIRM_SECONDS * 1000);
    });
  }

  /** Puts everyone back in their slot after a cancelled confirm. */
  resetConfirm(): void {
    this.confirming = false;
    this.confirmProgress = 0;
    for (const state of this.slots) {
      if (!state.standing) continue;
      state.standing.walk?.stop();
      state.standing.idle?.start(true, 1);
    }
  }

  /** Drives the walk-forward on confirm. */
  private updateSlots(deltaSeconds: number): void {
    const delta = Math.min(0.05, Math.max(0, deltaSeconds));
    this.confirmProgress = Math.min(
      1,
      Math.max(0, this.confirmProgress + (this.confirming ? delta / CONFIRM_SECONDS : -delta * 4)),
    );
    if (this.confirmProgress === 0 && !this.confirming) return;

    // Smoothstep so the walk starts and stops gently.
    const eased = this.confirmProgress * this.confirmProgress * (3 - 2 * this.confirmProgress);
    for (const [index, state] of this.slots.entries()) {
      if (!state.standing) continue;
      this.placeSlot(state.standing, SLOT_X[index as 0 | 1], index as 0 | 1, eased * CONFIRM_WALK_DISTANCE);
    }
  }

  /** `forward` walks the cook toward the camera, which sits on +Z. */
  private placeSlot(model: PreviewModel, x: number, slot: 0 | 1, forward: number): void {
    model.root.position.x = x;
    model.root.position.z = forward;
    model.root.rotation.set(0, 0, 0);
    // Angled slightly inward while idle; square to the camera once they start walking.
    const inward = slot === 0 ? -0.2 : 0.2;
    model.root.rotation.y = inward * (1 - Math.min(1, forward / 0.8));
  }

  /** Loads the character and starts playing its idle loop. */
  async show(character: CharacterDefinition): Promise<void> {
    if (this.disposed) return;
    if (this.current?.instance === this.model && this.current?.root.name === `preview-${character.id}`) return;
    const selection = ++this.sequence;

    this.disposeModel();
    const preview = await this.prepare(character);
    if (this.disposed || selection !== this.sequence || !preview) return;
    this.current = preview;
    this.model = preview.instance;
    this.idle = preview.idle;
    preview.root.setEnabled(true);
    preview.idle?.start(true, 1);
    this.resize();
  }

  private prepare(character: CharacterDefinition, slot: 0 | 1 = 0): Promise<PreviewModel | null> {
    // Keyed per slot: both players may pick the same cook and each needs its own model.
    const key = `${slot}:${character.id}`;
    const cached = this.previews.get(key);
    if (cached) return cached;
    const pending = (async (): Promise<PreviewModel | null> => {
      let instance: ModelInstance | null = null;
      let root: TransformNode | null = null;
      let materials: StandardMaterial[] = [];
      let idle: AnimationGroup | null = null;
      try {
        // A character with its own clips does not wait on the shared pack.
        const source = character.rig === "Embedded" ? null : await this.getAnimationSource();
        if (this.disposed) return null;
        instance = await this.assets.instantiateModel(character.modelAssetId, { namePrefix: "", cloneMaterials: true });
        if (!instance) return null;
        if (this.disposed) { instance.dispose(); return null; }
        root = new TransformNode(`preview-${slot}-${character.id}`, this.scene);
        root.parent = this.root;
        root.setEnabled(false);
        for (const node of instance.rootNodes) node.parent = root;
        for (const group of instance.animationGroups) group.stop();
        materials = this.convertMaterials(instance, character.id);
        this.fitToWorld(instance, character.targetHeight, root);
        root.position.y += 0.045;
        this.prepareMeshes(instance);
        const key = `${slot}-${character.id}`;
        if (character.rig === "Embedded") {
          // Their showcase clip stands in for the idle here, and only here; the
          // confirm walk is their own walk, paced to how far the pair moves.
          const clips = buildEmbeddedClips(
            instance, character.clips, `preview-${key}`, this.scene, ["showcase", "walk"],
          );
          const walk = clips.get("walk");
          const natural = (walk?.spec.footSpeed ?? 0) * root.scaling.x;
          const walkRate = natural > 0
            ? Math.min(walk?.spec.maxSpeed ?? 2, CONFIRM_WALK_SPEED / natural)
            : 1;
          idle = clips.get("showcase")?.group ?? null;
          return { instance, root, key, materials, idle, walk: walk?.group ?? null, walkRate };
        }
        idle = source ? this.buildClip(instance, source, key, IDLE_CLIP) : null;
        const model: PreviewModel = { instance, root, key, materials, idle, walk: null, walkRate: 1 };
        // The walk clip only plays on confirm; fetch it behind the menu, not in front of it.
        void this.ensureWalk(model);
        return model;
      } catch (error) {
        idle?.dispose();
        instance?.dispose();
        root?.dispose();
        for (const material of materials) material.dispose(false, false);
        console.warn("Character preview could not be prepared.", error);
        return null;
      }
    })();
    this.previews.set(key, pending);
    // Do not cache a failure: the next attempt (a retry, or browsing back) must load again.
    void pending.then((model) => { if (!model) this.previews.delete(key); });
    return pending;
  }

  /** Attaches the walk clip once the movement pack is in; safe to call repeatedly. */
  private async ensureWalk(model: PreviewModel): Promise<void> {
    if (model.walk) return;
    const movement = await this.getMovementSource();
    if (this.disposed || model.walk || !movement) return;
    model.walk = this.buildClip(model.instance, movement, model.key, WALK_CLIP);
  }

  clear(): void {
    this.sequence += 1;
    this.disposeModel();
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (active) {
      this.engine.runRenderLoop(() => this.scene.render());
    } else {
      this.engine.stopRenderLoop();
    }
  }

  resize(): void {
    if (this.disposed) return;
    this.engine.resize();
    const aspect = this.engine.getAspectRatio(this.camera) || 1.6;
    this.camera.fov = Math.min(0.72, 2 * Math.atan(Math.tan(1.05 / 2) / aspect));
    this.camera.radius = Math.max(CAMERA_RADIUS, 2.65 / Math.tan(this.camera.fov / 2));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.kitchen?.dispose();
    for (const material of this.kitchenMaterials) material.dispose(false, false);
    this.kitchenMaterials = [];
    this.disposeModel();
    for (const pending of this.previews.values()) {
      void pending.then((preview) => {
        if (!preview) return;
        preview.idle?.dispose();
        preview.walk?.dispose();
        preview.instance.dispose();
        preview.root.dispose();
        for (const material of preview.materials) material.dispose(false, false);
      });
    }
    this.previews.clear();
    this.animationSource?.dispose();
    this.animationSource = null;
    this.movementSource?.dispose();
    this.movementSource = null;
    this.assets.dispose();
    this.scene.dispose();
    this.engine.dispose();
  }

  /** The walk clip lives in the movement pack, which the preview loads lazily. */
  private async getMovementSource(): Promise<ModelInstance | null> {
    if (this.movementSourcePromise) return this.movementSourcePromise;
    this.movementSourcePromise = this.assets
      .instantiateModel(CHARACTER_ANIMATION_ASSETS.movement.id, { namePrefix: "" })
      .then((source) => {
        if (this.disposed || !source) { source?.dispose(); return null; }
        for (const group of source.animationGroups) group.stop(true);
        for (const node of source.rootNodes) node.setEnabled(false);
        this.movementSource = source;
        return source;
      })
      .catch((error: unknown) => {
        console.warn("Preview walk animation is unavailable.", error);
        return null;
      });
    return this.movementSourcePromise;
  }

  private async getAnimationSource(): Promise<ModelInstance | null> {
    if (this.animationSourcePromise) return this.animationSourcePromise;

    this.animationSourcePromise = this.assets
      .instantiateModel(CHARACTER_ANIMATION_ASSETS.general.id, { namePrefix: "" })
      .then((source) => {
        if (this.disposed) { source?.dispose(); return null; }
        if (!source) {
          console.warn("Character preview animation pack is unavailable.");
          return null;
        }
        for (const group of source.animationGroups) group.stop(true);
        for (const node of source.rootNodes) node.setEnabled(false);
        this.animationSource = source;
        return source;
      });

    return this.animationSourcePromise;
  }

  private loadKitchenSafely(): Promise<boolean> {
    return this.loadKitchen().then(() => this.kitchen !== null).catch((error: unknown) => {
      console.error("Character selection kitchen could not be loaded.", error);
      return false;
    });
  }

  private async loadKitchen(): Promise<void> {
    const instance = await this.assets.instantiateModel(KITCHEN_ASSET.id, {
      namePrefix: "selection-kitchen-",
    });
    if (!instance) return;
    if (this.disposed) { instance.dispose(); return; }
    this.kitchen = instance;
    this.kitchenMaterials = this.convertMaterials(instance, "kitchen");
    this.prepareMeshes(instance);
  }

  /**
   * Nothing casts or receives here: the room is lit flat, like the Blender viewport it was
   * built in, so a shadow map would only put a pool on the floor that the art does not have.
   */
  private prepareMeshes(instance: ModelInstance): void {
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh)) continue;
        node.isPickable = false;
        node.receiveShadows = false;
      }
    }
  }

  private buildClip(
    instance: ModelInstance,
    source: ModelInstance,
    characterId: string,
    clipName: string,
  ): AnimationGroup | null {
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

    const sourceGroup = source.animationGroups.find((group) => group.name === clipName);
    if (!sourceGroup) return null;

    const group = sourceGroup.clone(
      `preview-${characterId}-${clipName}`,
      (oldTarget) => resolveTarget(oldTarget) ?? null,
      true,
      true,
    );
    group.enableBlending = true;
    group.blendingSpeed = 0.08;
    group.loopAnimation = true;
    return group;
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

  private convertMaterials(instance: ModelInstance, characterId: string): StandardMaterial[] {
    const converted = new Map<number, StandardMaterial>();
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh) || !(node.material instanceof PBRMaterial)) continue;
        const source = node.material;
        let material = converted.get(source.uniqueId);
        if (!material) {
          material = new StandardMaterial(
            `preview-${characterId}-${source.name}`,
            this.scene,
          );
          material.diffuseTexture = source.albedoTexture;
          material.diffuseColor.copyFrom(source.albedoColor);
          material.emissiveTexture = source.emissiveTexture;
          material.emissiveColor.copyFrom(source.emissiveColor);
          // The GLB uses KHR_materials_emissive_strength, which Babylon folds into the
          // emissive colour and can push past 1. Unclamped, the lamp strips render as hot
          // yellow bars that are not in the Blender art.
          material.emissiveColor.set(
            Math.min(1, material.emissiveColor.r),
            Math.min(1, material.emissiveColor.g),
            Math.min(1, material.emissiveColor.b),
          );
          material.specularColor.copyFrom(Color3.White().scale(0.04));
          material.alpha = source.alpha;
          material.backFaceCulling = source.backFaceCulling;
          material.useAlphaFromDiffuseTexture = false;
          material.maxSimultaneousLights = 6;
          if (source.unlit || isSelfLitBackdrop(source)) {
            /*
             * Render it flat, at exactly the authored pixels.
             *
             * The window panorama is a self-lit backdrop: black base colour plus an emissive
             * texture. Left on the emissive channel it blew out to near-white, because the
             * glTF loader hands the texture over flagged linear (`gammaSpace === false`)
             * while StandardMaterial treats its textures as gamma space and re-encodes
             * nothing. Multiplying those un-re-encoded values by the emissive factor lifts
             * the midtones and clips the highlights.
             *
             * Through the diffuse channel with lighting off, the shader resolves to
             * `clamp(diffuseColor + emissiveColor) * texture`, i.e. the texture 1:1 — which
             * is what a painted backdrop should be, and what it looks like in Blender.
             */
            const backdrop = source.emissiveTexture ?? source.albedoTexture;
            material.disableLighting = true;
            material.diffuseTexture = backdrop;
            material.emissiveTexture = null;
            material.diffuseColor = Color3.White();
            material.emissiveColor = Color3.White();
            if (!backdrop) {
              material.diffuseColor.copyFrom(source.albedoColor);
              material.emissiveColor.copyFrom(source.albedoColor);
            }
          }
          converted.set(source.uniqueId, material);
        }
        node.material = material;
      }
    }
    return [...converted.values()];
  }

  private fitToWorld(instance: ModelInstance, targetHeight: number, root: TransformNode): void {
    root.position.setAll(0);
    root.scaling.setAll(1);
    root.computeWorldMatrix(true);

    let minimumY = Number.POSITIVE_INFINITY;
    let maximumY = Number.NEGATIVE_INFINITY;
    let minimumX = Number.POSITIVE_INFINITY;
    let maximumX = Number.NEGATIVE_INFINITY;
    let minimumZ = Number.POSITIVE_INFINITY;
    let maximumZ = Number.NEGATIVE_INFINITY;

    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh) || node.getTotalVertices() === 0) continue;
        node.computeWorldMatrix(true);
        const box = node.getBoundingInfo().boundingBox;
        minimumY = Math.min(minimumY, box.minimumWorld.y);
        maximumY = Math.max(maximumY, box.maximumWorld.y);
        minimumX = Math.min(minimumX, box.minimumWorld.x);
        maximumX = Math.max(maximumX, box.maximumWorld.x);
        minimumZ = Math.min(minimumZ, box.minimumWorld.z);
        maximumZ = Math.max(maximumZ, box.maximumWorld.z);
      }
    }

    const measuredHeight = maximumY - minimumY;
    if (!Number.isFinite(measuredHeight) || measuredHeight <= 0.001) {
      throw new Error("Character preview bounds could not be measured.");
    }

    const scale = targetHeight / measuredHeight;
    root.scaling.setAll(scale);
    root.position.x = -((minimumX + maximumX) / 2) * scale;
    root.position.z = -((minimumZ + maximumZ) / 2) * scale;
    root.position.y = -minimumY * scale;
    root.computeWorldMatrix(true);
  }

  private disposeModel(): void {
    this.idle?.stop();
    this.current?.root.setEnabled(false);
    this.current = null;
    this.idle = null;
    this.model = null;
  }
}
