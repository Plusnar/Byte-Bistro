import { t } from "../i18n";
import {
  AbstractMesh,
  AnimationGroup,
  Bone,
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Node,
  PBRMaterial,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TargetCamera,
  TransformNode,
  Vector3,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { assetStreaming } from "../core/assets/AssetStreamingManager";
import { CHARACTER_ANIMATION_ASSETS, type CharacterDefinition } from "../data/characters";
import { buildEmbeddedClips } from "../entities/embeddedClips";
import { HairPhysics } from "../entities/hairPhysics";
import { qualityManager } from "../core/perf/QualityManager";
import { bundledModelUrl } from "../core/assets/assetRegistry";
import type { QualitySettings } from "../core/perf/qualityProfiles";

const IDLE_CLIP = "Idle_A";
const WALK_CLIP = "Walking_A";

/**
 * The selection street, built in Blender (asset_source/selection_street). Positions below
 * are that scene's, carried over: Blender (x, y, z) is (-x, z, -y) here, because the glTF
 * loader turns Blender's Z-up, right-handed scene into Babylon's Y-up, left-handed one.
 */
const fromBlender = (x: number, y: number, z = 0): Vector3 => new Vector3(-x, z, -y);

/** The validation render's camera: in the street at eye height, looking up it. */
const CAMERA_POSITION = fromBlender(0.8, -4.2, 1.7);
const CAMERA_TARGET = fromBlender(2.6, 22.0, 4.4);
/** A 22 mm lens on Blender's 36 mm sensor, across the width. */
const CAMERA_HORIZONTAL_FOV = 2 * Math.atan(18 / 22);
/**
 * Where each player's cook stands, in front of the camera on either side of the road.
 * The camera looks down -Z, so a cook at higher X renders on the LEFT of the screen:
 * player one is the positive slot.
 */
// Apart enough that the start button, centred below, falls between them.
const SLOTS: readonly [Vector3, Vector3] = [fromBlender(-1.9, 3.0), fromBlender(3.7, 3.1)];
/** Each cook turned a little towards the other, as in the render. */
const SLOT_TURN: readonly [number, number] = [0.21, -0.24];
/** Seconds the pair spends walking forward before the match starts. */
const CONFIRM_SECONDS = 1.2;
/** How far forward they walk on confirm, in metres. */
const CONFIRM_WALK_DISTANCE = 2.6;
const STREET_ASSET = {
  id: "character-selection-street",
  url: bundledModelUrl("src/assets/selection-street/Selection Street.glb"),
  required: true,
  priority: "critical" as const,
};
/** The robots in the street: the same mannequin as the wedding guests. */
const ROBOT_ASSET = {
  id: "selection-street-robot",
  url: bundledModelUrl("Anim/Mannequin Character/characters/Mannequin_Medium.glb"),
  priority: "background" as const,
  lazy: true,
};
const ROBOT_HEIGHT = 1.8;
/** Metres per second for the walkers; Walking_A's stride matches it at this height. */
const ROBOT_WALK_SPEED = 1.05;

/** A robot walking up and down one stretch of pavement, turning at each end. */
interface StreetWalker {
  readonly from: Vector3;
  readonly to: Vector3;
  /** Where along the round trip it starts, 0 to 1, so the walkers do not move in step. */
  readonly phase: number;
}

/**
 * The street's background life. The cooks fill the frame left and right of centre, so the
 * walkers pace the middle (the right-hand pavement by the curb, and further up in front of
 * the town hall) and the greeting pairs stand at the two edges. Blender positions.
 */
const STREET_WALKERS: readonly StreetWalker[] = [
  { from: fromBlender(2.6, 7.0), to: fromBlender(1.4, 22.0), phase: 0.0 },
  { from: fromBlender(3.4, 8.0), to: fromBlender(2.2, 23.0), phase: 0.5 },
  { from: fromBlender(5.0, 22.0), to: fromBlender(-1.0, 32.0), phase: 0.25 },
];
const STREET_GREETERS: readonly (readonly [Vector3, Vector3])[] = [
  [fromBlender(10.0, 9.5), fromBlender(11.2, 10.4)],
  [fromBlender(-7.6, 9.6), fromBlender(-7.2, 11.0)],
];

interface StreetRobot {
  readonly holder: TransformNode;
  readonly instance: ModelInstance;
  readonly materials: StandardMaterial[];
  readonly clip: AnimationGroup | null;
  readonly walker: StreetWalker | null;
  /** Metres along the walker's round trip. */
  travelled: number;
}
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
 * channel. Any painted backdrop is authored this way.
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
  hair: HairPhysics | null;
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
 * The character-select screen: both players' cooks on the São Bento do Sul street, full
 * screen behind the menu, with robots walking and waving in the background. It has its own
 * engine and canvas, independent of the kitchen the shift is played in.
 */
export class CharacterPreview {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: TargetCamera;
  private readonly shadows: ShadowGenerator;
  private readonly robots: StreetRobot[] = [];
  private robotsStarted = false;
  private readonly assets: AssetManager;
  private readonly root: TransformNode;
  private street: ModelInstance | null = null;
  private streetMaterials: StandardMaterial[] = [];
  /** Settles true once the street is on screen, false if it could not load. */
  private streetSettled: Promise<boolean>;
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
  private readonly unregisterQuality: () => void;
  private readonly stopQuality: () => void;

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

    // The Blender camera, as it rendered the approved image. The width is fixed, so a
    // narrower screen shows more sky and street rather than cropping the cooks.
    this.camera = new TargetCamera("character-preview-camera", CAMERA_POSITION.clone(), this.scene);
    this.camera.setTarget(CAMERA_TARGET);
    this.camera.fovMode = Camera.FOVMODE_HORIZONTAL_FIXED;
    this.camera.fov = CAMERA_HORIZONTAL_FOV;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 600;

    /*
     * Daylight, as in the Blender render: sky from above, and the afternoon sun from behind
     * the camera's left shoulder, which also casts the cooks' and robots' shadows.
     *
     * StandardMaterial sums every light and clamps at 1.0, so the two stay close to 1.0
     * together on a face turned to the sun.
     */
    const ambient = new HemisphericLight(
      "character-preview-ambient",
      new Vector3(0, 1, 0),
      this.scene,
    );
    ambient.intensity = 0.62;
    ambient.diffuse = Color3.White();
    ambient.groundColor = Color3.FromHexString("#C9D2DC");
    ambient.specular = Color3.Black();

    // Blender's sun: rotated (52°, 0, -38°), shining along (0.485, 0.621, -0.616) there.
    const sun = new DirectionalLight("character-preview-sun", new Vector3(-0.485, -0.616, -0.621), this.scene);
    sun.position = fromBlender(-24, -30, 30);
    sun.intensity = 0.62;
    sun.diffuse = Color3.FromHexString("#FFF4E2");
    sun.specular = Color3.Black();
    this.shadows = new ShadowGenerator(1024, sun);
    this.shadows.useBlurExponentialShadowMap = true;
    this.shadows.blurKernel = 16;
    this.shadows.darkness = 0.45;

    this.root = new TransformNode("character-preview-root", this.scene);

    // The menu's critical path: the street, the two cooks on screen and their idle clip.
    // Every cook is registered, but only the ones actually shown are ever fetched — the
    // other four load when a player browses to them.
    this.assets = assetStreaming.createSceneAssets(this.scene, [
      STREET_ASSET,
      ...options.characters.map((character) => ({
        id: character.modelAssetId,
        url: character.modelUrl,
        priority: "critical" as const,
        lazy: true,
      })),
      { ...CHARACTER_ANIMATION_ASSETS.general, priority: "critical" },
      // Only the confirm walk and the street's walkers use it, so it must not hold up the menu.
      { ...CHARACTER_ANIMATION_ASSETS.movement, priority: "gameplay" },
      // The greeters' wave, and the robots themselves: background life, fetched last.
      { ...CHARACTER_ANIMATION_ASSETS.simulation, priority: "background", lazy: true },
      ROBOT_ASSET,
    ]);
    this.streetSettled = this.loadStreetSafely();
    this.unregisterQuality = qualityManager.registerEngine(this.engine, { followsDevicePixelRatio: false });
    this.stopQuality = qualityManager.subscribe((settings) => this.applyQuality(settings));
    // The robots come once the menu itself is up, never ahead of it — and not at all on the
    // `low` profile, which leaves the street without its background life.
    void this.streetSettled.then((shown) => {
      if (shown && qualityManager.settings.menuWalkers) void this.loadRobots();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.scene.onBeforeRenderObservable.add(() => {
      const seconds = this.engine.getDeltaTime() / 1000;
      this.updateSlots(seconds);
      this.updateRobots(seconds);
    });
    this.engine.runRenderLoop(() => this.scene.render());
  }

  /**
   * Resolves once the menu is presentable: the street and both players' cooks are on
   * screen, or have definitively failed. Never rejects — the loading screen decides what a
   * failure means, and a missing backdrop should not lock the player out of the game.
   */
  async whenReady(): Promise<PreviewReadiness> {
    const [street, playerOne, playerTwo] = await Promise.all([
      this.streetSettled,
      this.firstSlots[0].promise,
      this.firstSlots[1].promise,
    ]);
    const failed: string[] = [];
    if (!street) failed.push(t("boot.menuScenery"));
    if (!playerOne) failed.push(t("boot.playerOneCook"));
    if (!playerTwo) failed.push(t("boot.playerTwoCook"));
    return { failed };
  }

  /** Steps already done out of `stageCount`, for the loading bar. */
  get stagesDone(): number {
    return (this.street ? 1 : 0) + this.slots.filter((slot) => slot.standing).length;
  }

  readonly stageCount = 3;

  /**
   * The menu's critical files, available before a preview exists: `Game` requests them
   * before creating its engine, so the downloads overlap that work instead of following it.
   */
  static criticalUrls(characters: readonly CharacterDefinition[]): string[] {
    return [
      STREET_ASSET.url,
      CHARACTER_ANIMATION_ASSETS.general.url,
      ...characters.map((character) => character.modelUrl),
    ];
  }

  /** The files the menu cannot be shown without, grouped for the loading screen. */
  menuAssetUrls(characters: readonly CharacterDefinition[]): {
    scenery: string[];
    cooks: string[];
    animations: string[];
  } {
    const urls = (ids: readonly string[]): string[] =>
      ids.map((id) => this.assets.urlOf(id)).filter((url): url is string => url !== null);
    return {
      scenery: urls([STREET_ASSET.id]),
      cooks: urls(characters.map((character) => character.modelAssetId)),
      animations: urls([CHARACTER_ANIMATION_ASSETS.general.id]),
    };
  }

  /** Re-attempts whatever failed to load; `whenReady` then reflects the new attempt. */
  retry(characters: readonly [CharacterDefinition, CharacterDefinition]): void {
    if (!this.street) this.streetSettled = this.loadStreetSafely();
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
    this.placeSlot(preview, slot, 0);
    preview.hair?.reset();
    preview.root.setEnabled(true);
    preview.walk?.stop();
    preview.idle?.start(true, 1);
    this.firstSlots[slot].resolve(true);
    this.warmWhileHidden();
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
      this.placeSlot(state.standing, index as 0 | 1, eased * CONFIRM_WALK_DISTANCE);
    }
  }

  /** `forward` walks the cook toward the camera, which sits on +Z. */
  private placeSlot(model: PreviewModel, slot: 0 | 1, forward: number): void {
    const spot = SLOTS[slot];
    model.root.position.x = spot.x;
    model.root.position.z = spot.z + forward;
    model.root.rotation.set(0, 0, 0);
    // Angled slightly inward while idle; square to the camera once they start walking.
    model.root.rotation.y = SLOT_TURN[slot] * (1 - Math.min(1, forward / 0.8));
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
    preview.hair?.reset();
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
        this.prepareMeshes(instance, "caster");
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
          const hair = character.hair ? HairPhysics.attach(instance.rootNodes, this.scene, character.hair) : null;
          return { instance, root, key, materials, idle, walk: walk?.group ?? null, walkRate, hair };
        }
        idle = source ? this.buildClip(instance, source, key, IDLE_CLIP) : null;
        const model: PreviewModel = { instance, root, key, materials, idle, walk: null, walkRate: 1, hair: null };
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
      // Its canvas was display: none while hidden; take its size before the first frame.
      this.engine.resize();
      this.engine.runRenderLoop(() => this.scene.render());
    } else {
      this.engine.stopRenderLoop();
    }
  }

  /** The graphics profile: the sun shadows' map and blur, and the walking robots. */
  private applyQuality(settings: QualitySettings): void {
    const map = this.shadows.getShadowMap();
    if (map && map.getSize().width !== settings.menuShadows.mapSize) map.resize(settings.menuShadows.mapSize);
    this.shadows.blurKernel = settings.menuShadows.blurKernel;
    for (const robot of this.robots) robot.holder.setEnabled(settings.menuWalkers);
    if (settings.menuWalkers && this.street && !this.robotsStarted) void this.loadRobots();
  }

  /**
   * Compiles the shaders of whatever arrived while the street was hidden, so showing it
   * does not stutter through compilation on its first frame.
   */
  private warmWhileHidden(): void {
    if (this.active || this.disposed) return;
    void this.scene.whenReadyAsync().catch(() => undefined);
  }

  resize(): void {
    if (this.disposed) return;
    this.engine.resize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopQuality();
    this.unregisterQuality();
    this.resizeObserver.disconnect();
    this.street?.dispose();
    for (const material of this.streetMaterials) material.dispose(false, false);
    this.streetMaterials = [];
    this.disposeModel();
    for (const robot of this.robots) {
      robot.clip?.dispose();
      robot.instance.dispose();
      robot.holder.dispose();
      for (const material of robot.materials) material.dispose(false, false);
    }
    this.robots.length = 0;
    this.shadows.dispose();
    for (const pending of this.previews.values()) {
      void pending.then((preview) => {
        if (!preview) return;
        preview.idle?.dispose();
        preview.walk?.dispose();
        preview.hair?.dispose();
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

  private loadStreetSafely(): Promise<boolean> {
    return this.loadStreet().then(() => this.street !== null).catch((error: unknown) => {
      console.error("Character selection street could not be loaded.", error);
      return false;
    });
  }

  private async loadStreet(): Promise<void> {
    const instance = await this.assets.instantiateModel(STREET_ASSET.id, {
      namePrefix: "selection-street-",
    });
    if (!instance) return;
    if (this.disposed) { instance.dispose(); return; }
    this.street = instance;
    this.streetMaterials = this.convertMaterials(instance, "street");
    this.prepareMeshes(instance, "receiver");
    // The street never moves: its 46 world matrices need computing once, not every frame.
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (node instanceof AbstractMesh) node.freezeWorldMatrix();
      }
    }
    this.warmWhileHidden();
  }

  /**
   * The street receives shadows; the cooks and robots cast them. The street itself casts
   * none: its own shading carries the depth, and a shadow map wide enough for the town
   * would be too coarse for the cooks' feet.
   */
  private prepareMeshes(instance: ModelInstance, role: "caster" | "receiver"): void {
    for (const root of instance.rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (!(node instanceof AbstractMesh)) continue;
        node.isPickable = false;
        node.receiveShadows = role === "receiver";
        if (role === "caster" && node.getTotalVertices() > 0) this.shadows.addShadowCaster(node, false);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // The street's robots

  /**
   * Walkers pacing the pavements and pairs waving at each other, behind the cooks. Loaded in
   * the background after the menu is up; any of it missing just leaves the street quieter.
   */
  private async loadRobots(): Promise<void> {
    if (this.robotsStarted || this.disposed) return;
    this.robotsStarted = true;
    try {
      const [movement, simulation] = await Promise.all([
        this.getMovementSource(),
        this.loadClipSource(CHARACTER_ANIMATION_ASSETS.simulation.id),
      ]);
      if (this.disposed) return;
      const spawn = async (key: string, position: Vector3, yaw: number, source: ModelInstance | null,
        clipName: string, walker: StreetWalker | null): Promise<void> => {
        const instance = await this.assets.instantiateModel(ROBOT_ASSET.id, { namePrefix: "", cloneMaterials: true });
        if (!instance) return;
        if (this.disposed) { instance.dispose(); return; }
        const holder = new TransformNode(`street-robot-${key}`, this.scene);
        const body = new TransformNode(`street-robot-${key}-body`, this.scene);
        body.parent = holder;
        for (const node of instance.rootNodes) node.parent = body;
        for (const group of instance.animationGroups) group.stop();
        const materials = this.convertMaterials(instance, `robot-${key}`);
        this.fitToWorld(instance, ROBOT_HEIGHT, body);
        this.prepareMeshes(instance, "caster");
        holder.position.copyFrom(position);
        holder.rotation.y = yaw;
        holder.setEnabled(qualityManager.settings.menuWalkers);
        const clip = source ? this.buildClip(instance, source, `robot-${key}`, clipName) : null;
        if (clip) {
          clip.start(true, 1);
          // Out of step with each other, as people are.
          clip.goToFrame(clip.from + (clip.to - clip.from) * ((this.robots.length * 0.37) % 1));
        }
        this.robots.push({
          holder, instance, materials, clip, walker,
          travelled: walker ? walker.phase * 2 * Vector3.Distance(walker.from, walker.to) : 0,
        });
      };
      const jobs: Promise<void>[] = [];
      STREET_WALKERS.forEach((walker, index) => {
        jobs.push(spawn(`walker-${index}`, walker.from, 0, movement, WALK_CLIP, walker));
      });
      STREET_GREETERS.forEach(([a, b], index) => {
        const facing = (from: Vector3, to: Vector3): number => Math.atan2(to.x - from.x, to.z - from.z);
        jobs.push(spawn(`greeter-${index}-a`, a, facing(a, b), simulation, "Waving", null));
        jobs.push(spawn(`greeter-${index}-b`, b, facing(b, a), simulation, "Waving", null));
      });
      await Promise.all(jobs);
    } catch (error) {
      console.warn("Selection street robots are unavailable.", error);
    }
  }

  /** Loads an animation pack once, hidden, for its clips. */
  private clipSources = new Map<string, Promise<ModelInstance | null>>();

  private loadClipSource(id: string): Promise<ModelInstance | null> {
    const cached = this.clipSources.get(id);
    if (cached) return cached;
    const pending = this.assets.instantiateModel(id, { namePrefix: "" }).then((source) => {
      if (this.disposed || !source) { source?.dispose(); return null; }
      for (const group of source.animationGroups) group.stop(true);
      for (const node of source.rootNodes) node.setEnabled(false);
      return source;
    }).catch((error: unknown) => {
      console.warn("Street robot animations are unavailable.", error);
      return null;
    });
    this.clipSources.set(id, pending);
    return pending;
  }

  /** Walks the walkers along their stretch and back, turning smoothly at each end. */
  private updateRobots(deltaSeconds: number): void {
    const delta = Math.min(0.1, Math.max(0, deltaSeconds));
    for (const robot of this.robots) {
      const walker = robot.walker;
      if (!walker) continue;
      const length = Vector3.Distance(walker.from, walker.to);
      if (length < 0.01) continue;
      robot.travelled = (robot.travelled + ROBOT_WALK_SPEED * delta) % (2 * length);
      const outbound = robot.travelled < length;
      const along = outbound ? robot.travelled / length : 2 - robot.travelled / length;
      Vector3.LerpToRef(walker.from, walker.to, along, robot.holder.position);
      const heading = outbound ? walker.to.subtract(walker.from) : walker.from.subtract(walker.to);
      const target = Math.atan2(heading.x, heading.z);
      let turn = target - robot.holder.rotation.y;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      robot.holder.rotation.y += turn * Math.min(1, delta * 5);
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

    // Only the tracks whose node exists on this model: a track left pointing at nothing
    // (the robots lack some of the pack's helper nodes) makes `start()` throw.
    const group = new AnimationGroup(`preview-${characterId}-${clipName}`, this.scene);
    for (const targeted of sourceGroup.targetedAnimations) {
      const target = resolveTarget(targeted.target);
      if (target) group.addTargetedAnimation(targeted.animation, target);
    }
    if (group.targetedAnimations.length === 0) {
      group.dispose();
      return null;
    }
    group.normalize(sourceGroup.from, sourceGroup.to);
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
          // glTF colour factors are linear and StandardMaterial reads colours as sRGB: an
          // untextured surface (the whole street) would come out dark and oversaturated.
          material.diffuseColor.copyFrom(source.albedoTexture ? source.albedoColor : source.albedoColor.toGammaSpace());
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
