import type { AbstractMesh } from "@babylonjs/core";
import { t } from "../i18n";
import { INGREDIENT_ASSETS } from "../data/ingredientAssets";
import { libraryModelsFor } from "../data/assetLibrary";
import { scenarioAssetsFor } from "../data/scenarioAssets";
import { qualityManager } from "../core/perf/QualityManager";
import { canNeverGlow } from "../core/perf/effectBudget";
import { installActiveMeshCandidates } from "../core/render/activeMeshCandidates";
import { WEDDING_BANNER, WEDDING_HALL_ASSET_IDS } from "./weddingHall";
import { nextFrame, runSliced } from "../core/assets/MainThreadQueue";
import {
  Color3,
  GlowLayer,
  Matrix,
  Scene,
  Vector3,
  Viewport,
  type AbstractEngine,
  type Mesh,
} from "@babylonjs/core";
import { DeliveryBeacon, type BeaconTarget } from "../ui/DeliveryBeacon";
import { flightGroundContact } from "../physics/groundProbe";
import { STOREY_REACH } from "../physics/collisionPolicy";
import { NearbyColliders } from "../physics/nearbyColliders";
import { GAME_CONFIG, isDevelopmentMode } from "../config";
import type { AssetManager } from "../core/AssetManager";
import { assetStreaming } from "../core/assets/AssetStreamingManager";
import { AudioManager } from "../core/AudioManager";
import { EventBus } from "../core/EventBus";
import { createInitialRuntimeState } from "../core/GameState";
import {
  InputManager,
  NO_KEYBOARD_BINDINGS,
  PLAYER_ONE_BINDINGS,
  PLAYER_TWO_BINDINGS,
  type InputBindings,
} from "../core/InputManager";
import { MAX_PLAYERS, PLAYER_COLORS, clampPlayerCount, playerLabel } from "../data/players";
import type { ManagedScene } from "../core/SceneManager";
import {
  CHARACTER_ANIMATION_ASSETS,
  CHARACTERS,
  RECIPES,
  createIngredient,
  getCharacter,
} from "../data";
import {
  KITCHEN_ASSETS,
  KITCHEN_TILE,
  STATION_KIND_LABEL,
  cookableState,
  getFoodDefinition,
  type CookwareKind,
} from "../data/kitchen";
import type { KitchenStationPlacement } from "../data/kitchenLayout";
import { Player } from "../entities";
import { OVEN_REACH_PERIOD, type ArmPose } from "../entities/armPose";
import { SprayJet } from "../entities/SprayJet";
import { SynthSfx, type LoopHandle } from "../core/SynthSfx";
import { DisasterOverlay } from "../ui/DisasterOverlay";
import { ChaosMode } from "../systems/ChaosMode";
import { PunishmentSystem } from "../systems/PunishmentSystem";
import { DISASTER_ASSETS } from "../systems/disasters/assets";
import type {
  DisasterCook,
  DisasterHost,
  DisasterKind,
  LooseItem,
  Stealable,
} from "../systems/disasters/types";
import { getIngredient } from "../data/ingredients";
import { impactStunStrength } from "../entities/stun";
import { KitchenItemViews } from "../entities/KitchenItemViews";
import {
  computeQueueGuide,
  type GuideTask,
  type ItemLocation,
  type OrderGuideRequest,
  type QueueGuideResult,
} from "../gameplay/kitchen/KitchenGuide";
import {
  combineItems,
  createCookware,
  createExtinguisher,
  describeItem,
  findMatchingRecipe,
  getCookwareProgress,
  isCookware,
  isCookwareBurnt,
  plateQuality,
  type KitchenItem,
  type PlateItem,
} from "../gameplay/kitchen/KitchenItems";
import {
  KitchenModel,
  type KitchenEvent,
  type StationSpec,
  type WorkOutcome,
  type Workstation,
} from "../gameplay/kitchen/KitchenModel";
import {
  WorkstationResources,
  WorkstationView,
  type WorkstationViewState,
} from "../stations/WorkstationView";
import { WaypointMarker } from "../stations/WaypointMarker";
import { CHARGE_SECONDS, chargeFraction, heightAt, landingPoint, throwLaunch, throwSphereContact, throwStationContact } from "../gameplay/throwArc";
import { starThresholdsFor } from "../data/levelGoals";
import { KitchenMechanisms, type MechanismRider } from "./KitchenMechanisms";
import { phasesReached } from "../gameplay/mechanisms/MechanismSystem";
import {
  expireStreak,
  failOrder as tipFailOrder,
  serve as serveTip,
  NO_STREAK,
  type StreakState,
} from "../systems/TipSystem";
import {
  AIStateSystem,
  DialogueSystem,
  EventSystem,
  OrderSystem,
  QualitySystem,
  RecipeSystem,
  ScoreSystem,
  ShiftSystem,
} from "../systems";
import { selectServeTarget } from "../systems/OrderQueue";
import {
  OrderDirector,
  shiftProgress,
  type OrderDirectorEvent,
  type OrderDirectorResult,
} from "../gameplay/orders/OrderDirector";
import { BALANCE } from "../data/balance";
import { recipeOrderDurationMs } from "../data/recipeTiming";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "../data/difficulty";
import type { GameEvents, PlayerIndex, StationWorkKind } from "../types/events";
import type {
  AIState,
  AIStateKey,
  IngredientInstance,
  Order,
  PersistentGameState,
  RecipeData,
  RuntimeGameState,
  ShiftResult,
  StarThresholds,
} from "../types/game";
import type { GameUI, OrderTicketInfo } from "../ui/GameUI";
import type { MapData } from "../editor/MapData";
import { KitchenEnvironment, robotsFromMap } from "./KitchenEnvironment";
import { WEDDING_SCENARIO, type ScenarioDefinition } from "../data/scenarios";
import { CoopCameraController } from "./CoopCameraController";
import { WeddingGuests, MANNEQUIN } from "../systems/WeddingGuests";
import { ROBOT_VARIANT_ASSETS } from "../data/robotVariants";


/** Each cook's highlight colour; phones show the same one. */
export { PLAYER_COLORS };
const PLAYER_HIGHLIGHT_COLORS: readonly Color3[] = PLAYER_COLORS.map((color) => Color3.FromHexString(color));
/** Keyboard halves: player one on the left of the keyboard, player two on the right. */
const KEYBOARD_BINDINGS: readonly InputBindings[] = [PLAYER_ONE_BINDINGS, PLAYER_TWO_BINDINGS];

const {
  gravity: THROW_GRAVITY,
  restitution: THROW_RESTITUTION,
  friction: THROW_FRICTION,
  angularDamping: THROW_ANGULAR_DAMPING,
  impactRadius: THROW_IMPACT_RADIUS,
} = BALANCE.throw;
/** A fall through a vanished floor knocks a cook down about as hard as a dash shove. */
const FALL_STUN_STRENGTH = 0.35;
/** Long enough that coming out of a portal cannot send anything straight back in. */
const PORTAL_COOLDOWN_SECONDS = 0.6;
/** Stations whose vessel cooks: the stove and the oven both show a heat bar. */
const HEATED_STATION_KINDS: ReadonlySet<string> = new Set(["stove", "oven"]);
/** How long a fire has to burn unanswered before it counts as a meltdown. */
const MELTDOWN_SECONDS = 12;
/** Shortest gap between two call-outs from the same cook. */
const EMOTE_COOLDOWN_MS = 900;
/** How close a dashing cook has to be to shoulder the other one aside. */
const DASH_SHOVE_REACH = 0.95;
/** A shove is a nudge, not a thrown pan: see `stunSlideSpeed`. */
const DASH_SHOVE_STRENGTH = 0.3;
/** A drunk robot's bottle: a real knock, harder than a shove (bottle_fight mechanisms). */
const BOTTLE_STUN_STRENGTH = 0.45;
/** How far ahead of the player the "tile in front" probe sits. */
const REACH_PROBE = 0.85;
/** The wedding's serving counter sits behind the church door. Serve from the aisle. */
const WEDDING_DOOR_REACH_OFFSET = 1.5;
/** Max distance from the probe to a station centre for it to be targetable. */
const STATION_REACH = KITCHEN_TILE * 0.8;
const FLOOR_REACH = 0.8;
const EXTINGUISHER_REACH = 2.6;
const NOTIFY_THROTTLE_MS = 900;
/** How often the task guide and order cards are rebuilt. */
const HUD_REFRESH_SECONDS = 1 / 12;
/** How far above or below a cook's feet a station may stand and still be in reach. */
/** Kept low so the bloom does not wash out speech bubbles and HUD billboards. */
const GLOW_BASE_INTENSITY = 0.34;
const COOK_ASSET_IDS: ReadonlySet<string> = new Set(CHARACTERS.map((character) => character.modelAssetId));

interface FloorItem {
  readonly item: KitchenItem;
  readonly position: Vector3;
  readonly previous: Vector3;
  readonly velocity: Vector3;
  readonly rotation: Vector3;
  readonly angularVelocity: Vector3;
  bounces: number;
  airborne: boolean;
  thrownBy: PlayerIndex | null;
  /** Seconds before it may go through a portal again; unset until it first has. */
  portalCooldown?: number;
}

type KitchenTarget =
  | { readonly kind: "station"; readonly station: Workstation; readonly view: WorkstationView }
  | { readonly kind: "floor"; readonly entry: FloorItem };


interface CoopPlayerState {
  readonly index: PlayerIndex;
  readonly label: string;
  readonly input: InputManager;
  /** This cook as a passenger of the level's moving parts; built once, reused every frame. */
  readonly rider: MechanismRider;
  readonly player: Player;
  held: KitchenItem | null;
  target: KitchenTarget | null;
  highlighted: WorkstationView | null;
  /** Station currently showing this player's keycap, so it can be cleared on retarget. */
  keyPromptView: WorkstationView | null;
  /** Order this player is currently working, to keep their task stable across reorders. */
  focusedOrderId: string | null;
  work: WorkOutcome;
  workStation: Workstation | null;
  /** Seconds left of the reach into the oven, after putting a tray in or taking it out. */
  ovenReach: number;
  /**
   * Tenth of the current job already done, latched so `station:progress` fires on real
   * steps instead of allocating an event object every frame of a two-second chop.
   */
  workProgressStep: number;
  /** Last frame's dash state, so the burst can be sounded once as it starts. */
  wasDashing: boolean;
  /** Seconds the throw has been charging, or null when not aiming. */
  aimSeconds: number | null;
  /** Where this player's throw would land. Created the first time they aim. */
  aimMarker: WaypointMarker | null;
  /** When this cook last called out, so the key cannot be spammed. */
  lastEmoteAt: number;
  /** Seconds before this cook may go through a portal again. */
  portalCooldown: number;
  lastNotifyAt: number;
}

export interface KitchenSceneOptions {
  readonly shiftDuration: number;
  readonly officialWedding?: boolean;
  readonly persistentState: PersistentGameState;
  readonly onShiftComplete: (result: ShiftResult) => void;
  readonly map?: MapData;
  /** Difficulty profile for this shift. Defaults to the standard balance. */
  readonly tuning?: DifficultyTuning;
  /** Lighting, menu and reception rules. Defaults to the wedding. */
  readonly scenario?: ScenarioDefinition;
}

const NO_WORK: WorkOutcome = { kind: "none" };

/** The jolt the whole view gets as a disaster breaks out, in metres and seconds. */
const DISASTER_JOLT_AMOUNT = 0.32;
const DISASTER_JOLT_SECONDS = 0.7;

/** How long a cook reaches into the oven after putting a tray in or taking one out. */
const OVEN_REACH_SECONDS = OVEN_REACH_PERIOD;

/** What a cook's arms do for the work they are at, or for what they hold. */
const armPoseFor = (work: WorkOutcome["kind"], holding: boolean, ovenReach = false): ArmPose => {
  switch (work) {
    case "chopping": return "chop";
    case "washing": return "wash";
    case "extinguishing": return "spray";
    case "mixing": return "mix";
    default: return ovenReach ? "oven" : holding ? "carry" : "none";
  }
};

export class KitchenScene implements ManagedScene {
  readonly scene: Scene;

  private readonly camera: CoopCameraController;
  private readonly cameraFocusTarget = new Vector3(0, 2.2, 6.3);
  private readonly environment: KitchenEnvironment;
  private readonly wedding: WeddingGuests;
  /**
   * The cooks in this shift: the first `cookCount` of `allCooks`, so a cook's index is its
   * position here. Cooks beyond the count are not drawn, updated, or counted anywhere.
   */
  private players: readonly CoopPlayerState[] = [];
  /** Every cook built so far, in slot order; three and four are built only when needed. */
  private readonly allCooks: CoopPlayerState[] = [];
  /** One InputManager per possible cook, built up front so devices can attach in the menu. */
  private readonly inputs: readonly InputManager[];
  private readonly eventBus = new EventBus<GameEvents>();
  /**
   * The kitchen's event bus, for systems that want to react to a shift without this scene
   * having to call them. Read-only on purpose: the scene stays the only thing that emits.
   */
  get events(): Pick<EventBus<GameEvents>, "on"> {
    return this.eventBus;
  }

  private readonly recipes = new RecipeSystem();
  private readonly quality = new QualitySystem();
  private readonly orders: OrderSystem;
  private readonly scores = new ScoreSystem();
  private readonly shifts = new ShiftSystem(this.scores);
  private readonly dialogue = new DialogueSystem();
  private readonly gameEvents = new EventSystem();
  private readonly kitchen: KitchenModel;
  private readonly stationViews = new Map<Workstation, WorkstationView>();
  private readonly workstationResources: WorkstationResources;
  private readonly itemViews: KitchenItemViews;
  /** Each cook's extinguisher jet, made the first time they spray. */
  private readonly sprayJets = new Map<number, SprayJet>();
  /** Synthesised effects for the fire alarm and the disasters. */
  private readonly sfx: SynthSfx;
  /** Seconds to each cook's next knife stroke or scrub while they work a station. */
  private readonly workBeats = new Map<number, number>();
  /** Food frying on a stove; null while every stove is quiet. */
  private sizzle: LoopHandle | null = null;
  private readonly disasterOverlay: DisasterOverlay;
  private readonly chaos: ChaosMode;
  private readonly punishment: PunishmentSystem;
  /** Camera tremble from crashes and strikes: metres, and seconds left of it. */
  private shakeAmount = 0;
  private shakeAmountPeak = 0;
  private shakeLeft = 0;
  private shakeTotal = 0;
  private readonly floorItems: FloorItem[] = [];
  /** "Deliver here": the counters a finished dish should go to, re-chosen with the HUD. */
  private readonly deliveryBeacon: DeliveryBeacon;
  /** Each moving body is swept only against the colliders around it. */
  private readonly nearbyColliders: NearbyColliders;
  private readonly beaconStations: Workstation[] = [];
  private readonly beaconTargets: BeaconTarget[] = [];
  private readonly beaconTransform = Matrix.Identity();
  private readonly beaconWorld = new Vector3();
  private readonly beaconScreen = new Vector3();
  private readonly beaconViewport = new Viewport(0, 0, 1, 1);
  /** HUD-layer pixels per render pixel, and the canvas's offset inside the HUD layer. */
  private readonly beaconFrame = { scaleX: 1, scaleY: 1, left: 0, top: 0, width: 0, height: 0 };
  private readonly spokenDialogueIds = new Set<string>();
  private readonly activeCriticals = new Set<AIStateKey>();
  private readonly assets: AssetManager;
  private readonly audio: AudioManager;
  private readonly glow: GlowLayer;
  private readonly stopQuality: () => void;
  private readonly fogBaseDensity: number;
  private readonly probe = new Vector3();
  private ai: AIStateSystem;
  private runtime: RuntimeGameState;
  private started = false;
  private disposed = false;
  private preparing: Promise<void> | null = null;
  private prepared = false;
  private selection: { key: string; promise: Promise<void> } | null = null;
  /** The picks whose cooks are fully in place. */
  private selectedKey = "";
  private manualPaused = false;
  private cookbookOpen = false;
  private resultShown = false;
  /**
   * Milliseconds of live shift time: stands still while paused, in the cookbook or between
   * shifts. Food freshness is measured on it, so a pause cannot spoil the ingredients.
   */
  private kitchenClockMs = 0;
  /** Owns the per-order countdowns and the spawn cadence; see `OrderDirector`. */
  private readonly director: OrderDirector;
  /** Difficulty profile for this shift; injected, never read from a global. */
  private readonly tuning: DifficultyTuning;
  /** This scenario's menu. Orders, the cookbook and the plating checks all read it. */
  private readonly recipeList: readonly RecipeData[];
  private readonly scenario: ScenarioDefinition;
  /** The serving run: how many in a row, and when the last one landed. */
  private streak: StreakState = NO_STREAK;
  /** Seconds the kitchen has been alight without anyone reaching for the extinguisher. */
  private meltdownClock = 0;
  /** Coins this level wants for one, two and three stars, for this many cooks. */
  private starThresholds: StarThresholds;
  /** Drives the level's moving parts; empty on a level that has none. */
  private mechanisms: KitchenMechanisms | null = null;
  /** Reused rider views, so carrying allocates nothing per frame. */
  private mechanismRiders: readonly MechanismRider[] = [];
  /** Reused every frame: where the shift is, for the layout phases. */
  private readonly shiftClock = { progress: 0, duration: 0 };
  /** How many layout phases have been announced this shift. */
  private phasesAnnounced = 0;
  /** Scratch vector for portal exits; reused so travel allocates nothing. */
  private readonly portalExit = new Vector3();
  /** Scratch vector for the aiming markers; reused so aiming allocates nothing per frame. */
  private readonly aimPosition = new Vector3();
  private readonly aimOrigin = new Vector3();
  private readonly aimPrevious = new Vector3();
  private readonly projectileColliders: AbstractMesh[] = [];
  private readonly reducedMotion = typeof matchMedia === "function"
    ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  private hudAccumulator = HUD_REFRESH_SECONDS;
  private lastQueueGuide: QueueGuideResult | null = null;
  private driftAccumulator = 0;
  private cameraFocusRemaining = 0;
  private cameraDistance = 0;
  private cameraSplitAmount = 0;
  /** Reused every frame: the cooks the camera frames. */
  private readonly cameraPoints: Vector3[] = [];
  private readonly cameraGround: readonly Vector3[] = Array.from({ length: MAX_PLAYERS }, () => new Vector3());

  constructor(
    engine: AbstractEngine,
    private readonly ui: GameUI,
    private readonly options: KitchenSceneOptions,
  ) {
    this.tuning = options.tuning ?? STANDARD_DIFFICULTY;
    this.scenario = options.scenario ?? WEDDING_SCENARIO;
    // A scenario that lists no recipes it recognises would be unplayable, so an empty
    // filter falls back to the full book rather than to an empty menu.
    const menu = RECIPES.filter((recipe) => this.scenario.recipeIds.includes(recipe.id));
    this.recipeList = menu.length > 0 ? menu : RECIPES;
    // Order deadlines are derived per recipe, so the OrderSystem needs the same profile.
    this.orders = new OrderSystem(this.recipeList, Math.random, (recipe) =>
      recipeOrderDurationMs(recipe, this.tuning),
    );
    this.director = new OrderDirector({
      recipes: this.recipeList,
      orders: this.orders,
      tuning: this.tuning,
    });
    // What this level asks for, derived from its own menu and length rather than written
    // down per level; a map's `starCoins` overrides it. See src/data/levelGoals.ts.
    this.starThresholds = this.goalsFor(2);
    this.scene = new Scene(engine);
    this.nearbyColliders = new NearbyColliders(this.scene);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.fogBaseDensity = options.map?.environment.fogDensity ?? 0.008;
    this.scene.fogDensity = this.fogBaseDensity;
    this.scene.fogColor = Color3.FromHexString(options.map?.environment.fog ?? "#06101A");
    this.scene.skipPointerMovePicking = true;
    // Invisible colliders (kept by static batching) stay out of the per-frame mesh pass.
    installActiveMeshCandidates(this.scene);

    const kitchenAssetIds = new Set(KITCHEN_ASSETS.map((asset) => asset.id));
    const placedAssetIds = options.map?.objects.map((object) => object.assetId) ?? WEDDING_HALL_ASSET_IDS;
    this.assets = assetStreaming.createSceneAssets(this.scene, [
      { id: MANNEQUIN.modelAssetId, url: MANNEQUIN.modelUrl, required: true },
      // Lazy: only the two cooks the players picked are ever loaded into the kitchen. This
      // used to preload all six before every shift.
      ...CHARACTERS.map((character) => ({
        id: character.modelAssetId,
        url: character.modelUrl,
        required: true,
        lazy: true,
      })),
      { ...CHARACTER_ANIMATION_ASSETS.general, required: true },
      { ...CHARACTER_ANIMATION_ASSETS.movement, required: true },
      // Ambient robot clips: fetched only when a placed robot asks for one of them, so a
      // level without such robots never downloads the pack. Lazy keeps preloadAll off it.
      { ...CHARACTER_ANIMATION_ASSETS.simulation, required: false, lazy: true },
      // Dressed robots and their clips: only what the map places is ever downloaded.
      { ...CHARACTER_ANIMATION_ASSETS.fest, required: false, lazy: true },
      ...ROBOT_VARIANT_ASSETS,
      ...scenarioAssetsFor(placedAssetIds),
      ...INGREDIENT_ASSETS,
      ...KITCHEN_ASSETS,
      ...DISASTER_ASSETS,
      // Custom maps may reuse kitchen models as decor; register those only once. The main
      // level is decorated with the wedding hall's own models.
      ...libraryModelsFor(placedAssetIds).filter((asset) => !kitchenAssetIds.has(asset.id)),
    ]);

    this.environment = new KitchenEnvironment(this.scene, this.assets, {
      map: options.map,
      scenario: this.scenario,
    });
    // Robots a map placed in the editor become the cast; with none, the wedding's own
    // four are built. The main level's hall is already decorated, so the guests only hang
    // the couple's banner over the arch instead of laying their own carpet.
    this.wedding = new WeddingGuests(
      this.scene,
      this.assets,
      this.environment.bounds,
      this.environment.receptionArea,
      options.map ? robotsFromMap(options.map) : [],
      options.map ? null : WEDDING_BANNER,
      () => this.environment.mechanisms.map((mechanism) => mechanism.footprint),
      options.officialWedding,
    );
    this.wedding.nearbyColliders = this.nearbyColliders;
    this.inputs = Array.from({ length: MAX_PLAYERS }, (_, index) =>
      new InputManager(window, KEYBOARD_BINDINGS[index] ?? NO_KEYBOARD_BINDINGS));
    // Two cooks until the menu says otherwise: the keyboard's two halves, and what the
    // automated benchmarks measure.
    this.setCookCount(2);

    const cameraOffset = new Vector3(
      GAME_CONFIG.camera.offsetX,
      GAME_CONFIG.camera.offsetY,
      GAME_CONFIG.camera.offsetZ,
    );
    this.camera = new CoopCameraController(
      this.scene,
      this.environment.playerSpawn.add(cameraOffset),
      cameraOffset,
      GAME_CONFIG.camera.smoothing,
    );

    this.glow = new GlowLayer("kitchen-emissive-glow", this.scene, {
      blurKernelSize: 24,
    });
    this.glow.intensity = GLOW_BASE_INTENSITY;
    // GlowLayer happily blurs alpha-blended meshes too, which turns speech bubbles and order
    // icons into washed-out smears. Keep the readable UI billboards out of it.
    for (const mesh of this.wedding.glowExcludedMeshes) this.glow.addExcludedMesh(mesh);
    // The sky is emissive white and the town far away: blurring them into the glow pass
    // would wash the horizon out and cost a full redraw of the backdrop every frame.
    const excludeBackdrop = (): void => {
      for (const mesh of this.environment.backdrop.meshes) this.glow.addExcludedMesh(mesh as Mesh);
    };
    excludeBackdrop();
    void this.environment.backdrop.ready.then(() => { if (!this.disposed) excludeBackdrop(); });
    // The glow is decoration: the profile decides its blur, and `low` drops it entirely
    // (emissive surfaces still read bright without it).
    this.stopQuality = qualityManager.subscribe((settings) => {
      this.glow.isEnabled = settings.glow.enabled;
      this.glow.blurKernelSize = settings.glow.blurKernelSize;
    });

    this.audio = new AudioManager(this.scene);
    this.audio.setMasterVolume(options.persistentState.settings.masterVolume);

    this.kitchen = new KitchenModel(
      this.environment.kitchenStations.map((placement, index) => toStationSpec(placement, index)),
      this.recipeList,
    );
    this.workstationResources = new WorkstationResources(this.scene, PLAYER_HIGHLIGHT_COLORS);
    this.itemViews = new KitchenItemViews(this.scene, this.assets, this.recipeList);

    this.sfx = new SynthSfx(0.6 * options.persistentState.settings.masterVolume);
    this.disasterOverlay = new DisasterOverlay(this.ui.disasterLayer);
    const bounds = this.environment.bounds;
    this.chaos = new ChaosMode(
      this.scene,
      this.disasterOverlay,
      this.sfx,
      new Vector3((bounds.minX + bounds.maxX) / 2, 4.5, (bounds.minZ + bounds.maxZ) / 2),
    );
    this.punishment = new PunishmentSystem(this.disasterHost());

    this.deliveryBeacon = new DeliveryBeacon(this.ui.hudLayer);
    this.ai = new AIStateSystem(createInitialRuntimeState(options.shiftDuration).aiState);
    this.runtime = createInitialRuntimeState(options.shiftDuration);
    this.bindEvents();
    for (const slot of this.players) slot.input.enabled = false;
    this.ui.update(this.runtime);
    this.ui.setMenuRecipes(this.recipeList.map((recipe) => recipe.id));
    void Promise.all(this.players.map((slot) => slot.player.prepareCharacterAnimations())).catch((error: unknown) => {
      console.warn("Character animations could not be preloaded.", error);
    });
  }

  /**
   * Everything a shift needs except the cooks: the room, the robots, every station and item
   * model, and the station views built from them.
   *
   * Idempotent and safe to call from the menu — that is the point. `Game` starts it while
   * the players are still choosing cooks, so by the time they press Start the kitchen is
   * already built and only the two cooks are left.
   */
  prepareInBackground(): Promise<void> {
    if (this.preparing) return this.preparing;
    const preparing = (async () => {
      await Promise.all([this.environment.ready, this.wedding.ready, this.assets.preloadAll()]);
      if (this.disposed) return;
      // The level's moving parts exist only once the environment has finished placing them.
      this.mechanisms = new KitchenMechanisms(
        this.environment.mechanisms,
        this.options.map?.meta?.layoutPhases,
      );
      for (const mesh of this.environment.nonGlowingDecor()) this.glow.addExcludedMesh(mesh as Mesh);
      performance.mark("bb:kitchen-assets-loaded");
      // Station models instantiate synchronously from the preloaded containers — sliced
      // across frames, because this runs while the players are still in the menu.
      await this.createStationViews();
      if (this.disposed) return;
      this.environment.pauliLighting?.reserveLightSlots();
      // Counters, crates, boards and stoves are glTF art that cannot glow; the decor above
      // already left the glow pass for the same reason. ~450 draw calls a frame on the
      // official level, each painting black.
      for (const view of this.stationViews.values()) {
        for (const mesh of view.root.getChildMeshes(false)) {
          if (canNeverGlow(mesh)) this.glow.addExcludedMesh(mesh as Mesh);
        }
      }
      performance.mark("bb:stations-built");
      this.prepared = true;
    })();
    this.preparing = preparing;
    // A failed attempt must not be cached: pressing Start again is the retry, and the asset
    // cache has already dropped the failed download so it is fetched afresh.
    preparing.catch(() => { if (this.preparing === preparing) this.preparing = null; });
    return preparing;
  }

  /** True once `prepareInBackground` has finished. */
  get isPrepared(): boolean {
    return this.prepared;
  }

  /**
   * The input of each cook, in slot order, so other devices (phones, gamepads) can be
   * attached to them. The managers live as long as this kitchen.
   */
  get cookInputs(): readonly InputManager[] {
    return this.inputs;
  }

  /** How many cooks this kitchen plays with, 1 to `MAX_PLAYERS`. */
  get cookCount(): number {
    return this.players.length;
  }

  /**
   * Sets how many cooks play: the first `count` cooks are in the kitchen, the rest are
   * switched off entirely (not drawn, updated, targeted by disasters, or carried). Cooks
   * three and four are built the first time they are needed. Call before `startShift`;
   * during a shift it is ignored.
   */
  setCookCount(count: number): void {
    const next = clampPlayerCount(count);
    if (next === this.players.length) return;
    if (this.started && !this.runtime.shiftEnded) return;
    while (this.allCooks.length < next) this.allCooks.push(this.createCook(this.allCooks.length as PlayerIndex));
    this.players = this.allCooks.slice(0, next);
    for (const slot of this.allCooks) {
      const active = slot.index < next;
      slot.player.root.setEnabled(active);
      if (!active) {
        slot.input.enabled = false;
        this.hideAim(slot);
        this.setTarget(slot, null);
      }
    }
    this.mechanismRiders = this.players.map((slot) => slot.rider);
    // Field initialisers run first, but the recipe list is set in the constructor body.
    if (this.recipeList) this.starThresholds = this.goalsFor(next);
    this.selection = null;
    this.selectedKey = "";

  }

  /** What this level asks of `cooks` cooks; a map's own `starCoins` wins. */
  private goalsFor(cooks: number): StarThresholds {
    return this.options.map?.meta?.starCoins ?? starThresholdsFor({
      shiftDurationSeconds: this.options.shiftDuration,
      recipes: this.recipeList,
      tuning: this.tuning,
      cooks,
    });
  }

  private createCook(index: PlayerIndex): CoopPlayerState {
    const player = new Player(this.scene, {
      spawnPosition: this.environment.playerSpawns[index]!.clone(),
      walkSpeed: GAME_CONFIG.player.walkSpeed,
      runSpeed: GAME_CONFIG.player.walkSpeed * GAME_CONFIG.player.runMultiplier,
      movementRotation: Math.atan2(-GAME_CONFIG.camera.offsetX, -GAME_CONFIG.camera.offsetZ),
      assetManager: this.assets,
      tag: { label: playerLabel(index), color: PLAYER_COLORS[index] ?? "#ffffff" },
    });
    const slot: CoopPlayerState = {
      index,
      label: playerLabel(index),
      input: this.inputs[index]!,
      player,
      // The cooks are the only passengers, and a mechanism asks each frame where they are
      // rather than being told.
      rider: {
        position: player.position,
        carry: (x: number, z: number) => player.applyCarry(x, z),
        fell: () => this.fallFromFloor(slot),
        hit: (fromX: number, fromZ: number) => this.knockCook(slot, fromX, fromZ, BOTTLE_STUN_STRENGTH),
      },
      held: null,
      target: null,
      highlighted: null,
      keyPromptView: null,
      focusedOrderId: null,
      work: NO_WORK,
      workStation: null,
      ovenReach: 0,
      workProgressStep: -1,
      wasDashing: false,
      aimSeconds: null,
      aimMarker: null,
      lastEmoteAt: 0,
      portalCooldown: 0,
      lastNotifyAt: 0,
    };
    slot.input.enabled = false;
    // Built after the constructor (a third cook): its animations load now.
    if (this.allCooks.length >= 2) {
      void player.prepareCharacterAnimations().catch((error: unknown) => {
        console.warn("Character animations could not be preloaded.", error);
      });
    }
    return slot;
  }

  /** Where the shift stands, for the phone controllers' screens. */
  get shiftPhase(): "lobby" | "playing" | "paused" | "results" {
    if (!this.started) return "lobby";
    if (this.runtime.shiftEnded) return "results";
    return this.runtime.paused ? "paused" : "playing";
  }

  /** A shift is being played right now: started, not over, not paused. */
  get isShiftRunning(): boolean {
    return this.started && !this.runtime.shiftEnded && !this.runtime.paused;
  }

  get scenarioId(): string {
    return this.scenario.id;
  }

  get shiftElapsedSeconds(): number {
    return this.runtime.shiftDuration - this.runtime.shiftTimeRemaining;
  }

  /** Every file a shift with these cooks needs, for the match loading bar. */
  requiredUrls(characterIds: readonly string[]): string[] {
    const cooks = characterIds
      .map((characterId) => getCharacter(characterId)?.modelAssetId)
      .map((id) => (id ? this.assets.urlOf(id) : null))
      .filter((url): url is string => url !== null);
    return [...new Set([...this.assets.eagerUrls(), ...cooks])];
  }

  /**
   * Compiles every material's shaders before the first frame is drawn, so the first second
   * of the shift is not spent stuttering through shader compilation.
   *
   * Sliced across frames, because this runs while the players are in the menu.
   * `isReady(true)` is the exact check the renderer makes before drawing, so it compiles the
   * same shaders the first frame would. Where the browser supports parallel shader
   * compilation (Chrome, Edge and Firefox on real GPUs), the first pass only queues the
   * compiles and later passes poll without blocking. Without it (software GL) each call
   * compiles synchronously, and slicing keeps that to one mesh's shaders per frame instead
   * of every shader in the kitchen at once.
   *
   * Capped: a texture that never finishes loading would otherwise keep the scene "not
   * ready" forever and hold the shift hostage.
   */
  async warmUp(timeoutMs = 6000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    let pending = this.scene.meshes.filter((mesh) => mesh.isEnabled() && mesh.material);
    while (pending.length > 0 && !this.disposed && performance.now() < deadline) {
      const notReady: typeof pending = [];
      await runSliced(pending, (mesh) => {
        if (!mesh.isReady(true)) notReady.push(mesh);
      }, () => this.disposed || performance.now() > deadline);
      pending = notReady;
      if (pending.length > 0) await nextFrame();
    }
  }

  /**
   * Draws the kitchen behind the loading screen until everything the first frame asks for
   * is compiled.
   *
   * `warmUp` compiles materials without drawing, but the glow layer and the cartoon
   * passes only request their shaders once a frame is actually drawn, and that request
   * recompiles most of the room. Without this the shift opened on that first frame: the
   * counters stayed invisible and the cooks stood in T-pose for the first seconds of a
   * freshly built map. The splash is opaque, so these frames are never seen.
   */
  async primeFirstFrames(timeoutMs = 6000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!this.disposed && performance.now() < deadline) {
      this.scene.render();
      const ready = this.scene.meshes.every(
        (mesh) => !mesh.isEnabled() || !mesh.material || mesh.isReady(true),
      );
      if (ready) return;
      await nextFrame();
    }
  }

  /**
   * Puts the picked cooks into the kitchen. `Game` calls it from the menu as soon as the
   * picks settle, and again on Start; the same picks share one promise, so Start usually
   * finds the work already done.
   */
  selectCharacters(requested: readonly string[]): Promise<void> {
    // One pick per cook in the kitchen: extra picks are ignored, missing ones repeat the last.
    const characterIds = this.players.map((_, index) => requested[index] ?? requested.at(-1) ?? "");
    const key = characterIds.join("|");
    if (this.selection?.key !== key) {
      const cooks = this.players;
      const promise = Promise.all([
        this.prepareInBackground(),
        ...characterIds.map(async (characterId, index) => {
          const character = getCharacter(characterId);
          if (!character) throw new Error(`Unknown character: ${characterId}`);
          await cooks[index]!.player.selectCharacter(character.id);
        }),
      ]).then(() => {
        this.selectedKey = key;
        // Cooks browsed past in the menu were parsed into this scene; with nobody wearing
        // them any more, their meshes and textures leave the GPU (the bytes stay cached).
        const picked = new Set(characterIds.map((id) => getCharacter(id)?.modelAssetId));
        this.assets.releaseUnused((assetId) => COOK_ASSET_IDS.has(assetId) && !picked.has(assetId));
      });
      const selection = { key, promise };
      this.selection = selection;
      // A failed attempt must not be cached: Start retries by asking again.
      promise.catch(() => { if (this.selection === selection) this.selection = null; });
    }
    return this.selection!.promise;
  }

  /** True when a shift with these cooks could start without loading anything. */
  isReadyFor(characterIds: readonly string[]): boolean {
    return this.prepared && characterIds.length === this.players.length && this.selectedKey === characterIds.join("|");
  }


  startShift(): void {
    if (this.started && !this.runtime.shiftEnded) return;
    this.resetShift();
  }

  restartShift(): void {
    this.resetShift();
  }

  /**
   * Leaves the shift for the menu: the kitchen goes back to its pre-shift state, with the
   * clock stopped and no overlay up. The next `startShift` resets everything as usual.
   */
  abortShift(): void {
    this.started = false;
    this.environment.stopCampusStorm();
    this.resultShown = false;
    this.manualPaused = false;
    if (this.cookbookOpen) this.ui.toggleCookbook(false);
    this.cookbookOpen = false;
    this.syncPauseState();
    this.ui.hideResults();
    this.ui.setPausedVisible(false);
    for (const slot of this.players) {
      slot.input.enabled = false;
      this.setStationKeyPrompt(slot, null);
    }
  }

  setEditorInputSuspended(suspended: boolean): void {
    for (const slot of this.players) {
      slot.input.clear();
      slot.input.enabled = !suspended && this.started && !this.runtime.shiftEnded;
    }
  }

  setManualPaused(paused: boolean): void {
    if (!this.started || this.runtime.shiftEnded) return;
    this.manualPaused = paused;
    this.syncPauseState();
  }

  setCookbookOpen(open: boolean): void {
    this.cookbookOpen = open;
    this.syncPauseState();
  }

  update(deltaSeconds: number): void {
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    // Phones and gamepads feed the same InputManagers as the keyboard; read them first.
    for (const slot of this.players) slot.input.poll(delta);
    this.handleOverlayInput();

    if (!this.started || this.runtime.shiftEnded || this.runtime.paused) {
      // Re-stamping the deadlines against wall time while paused is what stops a pause from
      // burning order time.
      this.syncOrderClocks();
      // Nothing fries or chops while the kitchen is stopped.
      this.stopKitchenSounds();
      this.updateCamera(delta);
      this.syncKitchenVisuals(0);
      this.ui.update(this.runtime);
      this.updateDebug();
      this.endInputFrame();
      return;
    }

    const previousTimeRemaining = this.runtime.shiftTimeRemaining;
    const previousOrders = this.runtime.activeOrders;
    this.runtime = this.shifts.tick(this.runtime, delta);
    this.shiftClock.progress = shiftProgress(this.runtime.shiftTimeRemaining, this.runtime.shiftDuration);
    this.shiftClock.duration = this.runtime.shiftDuration;
    this.wedding.updateCeremony(this.shiftClock.progress);
    if (previousTimeRemaining > 0 && this.runtime.shiftEnded) {
      // ShiftSystem has no EventBus, so the orders it just failed are diffed out here.
      this.reportOrdersLostAtBuzzer(previousOrders);
      this.deliveryBeacon.hideAll();
      this.finishShift();
      this.updateCamera(delta);
      this.ui.update(this.runtime);
      this.updateDebug();
      this.endInputFrame();
      return;
    }

    this.kitchenClockMs += delta * 1_000;
    if (this.environment.campusStorm?.update(
      this.runtime.shiftDuration - this.runtime.shiftTimeRemaining, this.reducedMotion?.matches ?? false,
    )) {
      this.sfx.play("thunder", 0.35);
      this.notify(t("kitchen.stormPowerDip"), "warning", 2600);
    }
    this.environment.pauliLighting?.update(delta, this.environment.campusStorm?.powerLevel);
    this.updateOrders(delta);
    this.wedding.syncOrders(this.runtime.activeOrders, this.orderUrgencySeconds());
    this.wedding.update(delta);
    // Moving parts first: a cook carried by a platform has to be where the platform put
    // them before their own step is resolved, or they fight it every frame.
    this.mechanisms?.update(this.kitchenClockMs / 1_000, this.mechanismRiders, this.shiftClock);
    this.announceLayoutPhases();
    for (const slot of this.players) {
      this.nearbyColliders.assign(slot.player.root);
      slot.player.update(delta, slot.input, this.environment.bounds);
      this.updateTarget(slot);
      this.handleGameplayInput(slot, delta);
      this.playWorkSounds(slot, delta);
    }
    this.travelThroughPortals(delta);
    this.kitchen.update(delta);
    this.updateSizzle();
    this.punishment.update(delta);
    const burning = this.kitchen.stations.reduce((count, station) => count + (station.onFire ? 1 : 0), 0);
    this.updateMeltdowns(burning, delta);
    const chaos = this.chaos.update(delta, burning);
    this.glow.intensity = GLOW_BASE_INTENSITY + chaos.glow;
    this.updateShake(delta, chaos.shake);
    this.handleKitchenEvents(this.kitchen.takeEvents());
    this.resolveDashes();
    this.updateFloorItems(delta);
    this.updateAI(delta);
    this.gameEvents.update(Date.now());

    // The task guide and the order cards are O(orders x components x world items) and none
    // of what they show changes meaningfully between frames, so they run at ~12Hz instead
    // of 60. The time bars move slowly enough that the stepping is invisible.
    // A run that nobody fed for long enough lapses on its own; see TipSystem.
    const lapsed = expireStreak(this.streak, this.kitchenClockMs);
    if (lapsed !== this.streak) {
      this.streak = lapsed;
      this.runtime = { ...this.runtime, combo: 0 };
    }

    this.hudAccumulator += delta;
    if (this.hudAccumulator >= HUD_REFRESH_SECONDS) {
      this.hudAccumulator = 0;
      this.updateGuide();
      this.updateHUD();
      this.chooseDeliveryBeacons();
    }

    this.updateCamera(delta);
    this.updateDeliveryBeacons();
    this.syncKitchenVisuals(delta);
    this.ui.update(this.runtime);
    this.updateDebug();
    this.endInputFrame();
  }

  dispose(): void {
    this.disposed = true;
    this.ui.setMenuRecipes([]);
    this.deliveryBeacon.dispose();
    this.punishment.reset();
    this.stopKitchenSounds();
    this.chaos.dispose();
    this.disasterOverlay.dispose();
    this.sfx.dispose();
    this.wedding.dispose();
    this.nearbyColliders.dispose();
    for (const input of this.inputs) input.dispose();
    for (const slot of this.allCooks) {
      slot.held = null;
      slot.aimMarker?.dispose();
      slot.aimMarker = null;
      slot.player.dispose();
    }
    this.floorItems.length = 0;
    this.itemViews.dispose();
    for (const view of this.stationViews.values()) view.dispose();
    this.stationViews.clear();
    for (const jet of this.sprayJets.values()) jet.dispose();
    this.sprayJets.clear();
    this.workstationResources.dispose();
    this.camera.dispose();
    this.stopQuality();
    this.glow.dispose();
    this.audio.dispose();
    this.assets.dispose();
    this.environment.dispose();
    this.eventBus.clear();
    this.scene.dispose();
  }

  private resetShift(): void {
    this.started = true;
    this.resultShown = false;
    this.manualPaused = false;
    if (this.cookbookOpen) this.ui.toggleCookbook(false);
    this.cookbookOpen = false;
    this.ui.hideResults();
    this.ui.setPausedVisible(false);
    if (this.stationViews.size === 0) this.createStationViews();
    for (const slot of this.players) {
      slot.held = null;
      slot.work = NO_WORK;
      slot.workStation = null;
      slot.aimSeconds = null;
      this.hideAim(slot);
      slot.keyPromptView?.setKeyPrompt(null);
      slot.keyPromptView = null;
      this.setTarget(slot, null);
    }
    this.floorItems.length = 0;
    this.kitchen.reset();
    this.mechanisms?.reset(this.kitchenClockMs / 1_000);
    this.phasesAnnounced = 0;
    for (const slot of this.players) {
      slot.player.teleport(this.environment.playerSpawns[slot.index]!);
      slot.player.setExpression("^_^");
    }
    this.runtime = this.shifts.start(
      createInitialRuntimeState(this.options.shiftDuration),
      this.options.shiftDuration,
    );
    this.ai = new AIStateSystem(this.runtime.aiState);
    this.director.reset();
    this.driftAccumulator = 0;
    this.cameraFocusRemaining = 0;
    for (const slot of this.players) slot.focusedOrderId = null;
    this.scene.fogDensity = this.fogBaseDensity;
    this.glow.intensity = GLOW_BASE_INTENSITY;
    this.environment.campusStorm?.reset();
    this.spokenDialogueIds.clear();
    this.activeCriticals.clear();
    for (const slot of this.players) slot.input.enabled = true;
    this.wedding.reset(this.runtime.shiftDuration);
    this.punishment.reset();
    this.chaos.reset();
    this.disasterOverlay.reset();
    this.shakeAmount = 0;
    this.shakeLeft = 0;
    for (const slot of this.players) slot.input.invertMovement = false;
    // The cheapest recipe opens the shift as a tutorial ticket; the scheduler takes over.
    // Taken from this scenario's own menu: an id outside it would make OrderSystem throw
    // inside startShift for any scenario that does not serve gelato.
    const opener = this.recipeList.find((recipe) => recipe.id === "cooling_gelato")
      ?? this.recipeList.reduce<RecipeData | undefined>(
        (cheapest, recipe) => (!cheapest || recipe.reward < cheapest.reward ? recipe : cheapest),
        undefined,
      );
    this.createOrder(opener?.id);
    this.speak("shift:start");
    this.sfx.play("start");
    this.eventBus.emit("shift:started", { duration: this.options.shiftDuration });
    this.notify(t("kitchen.shiftIntro", { level: this.scenario.displayName }), "info", 6000);
    this.ui.update(this.runtime);
  }

  private async createStationViews(): Promise<void> {
    if (this.stationViews.size > 0) return;
    // Model stations were built from kitchenStations in the same order.
    await runSliced([...this.kitchen.stations.entries()], ([index, station]) => {
      const placement = this.environment.kitchenStations[index];
      if (!placement || this.stationViews.has(station)) return;
      this.stationViews.set(
        station,
        new WorkstationView(this.scene, this.assets, this.workstationResources, placement),
      );
    }, () => this.disposed);
  }

  // -------------------------------------------------------------------------
  // Targeting and input

  private updateTarget(slot: CoopPlayerState): void {
    if (slot.player.isDowned()) {
      this.setTarget(slot, null);
      return;
    }
    const yaw = slot.player.facingYaw;
    const position = slot.player.position;
    this.probe.set(
      position.x + Math.sin(yaw) * REACH_PROBE,
      0,
      position.z + Math.cos(yaw) * REACH_PROBE,
    );

    let best: KitchenTarget | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestHeightGap = Number.POSITIVE_INFINITY;
    for (const [station, view] of this.stationViews) {
      const heightGap = Math.abs((station.spec.y ?? 0) - position.y);
      if (heightGap > STOREY_REACH) continue;
      const dx = station.spec.x - this.probe.x;
      const dz = this.stationInteractionZ(station) - this.probe.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance < STATION_REACH &&
          (distance < bestDistance || (distance === bestDistance && heightGap < bestHeightGap))) {
        best = { kind: "station", station, view };
        bestDistance = distance;
        bestHeightGap = heightGap;
      }
    }
    for (const entry of this.floorItems) {
      if (entry.airborne || Math.abs(entry.position.y - position.y) > 0.7) continue;
      const dx = entry.position.x - this.probe.x;
      const dz = entry.position.z - this.probe.z;
      // Items on the floor win ties so dropped food is easy to recover.
      const distance = Math.sqrt(dx * dx + dz * dz) * 0.8;
      if (distance < FLOOR_REACH && distance < bestDistance) {
        best = { kind: "floor", entry };
        bestDistance = distance;
      }
    }
    this.setTarget(slot, best);
  }

  private stationInteractionZ(station: Workstation): number {
    return this.options.officialWedding && station.spec.kind === "delivery"
      ? station.spec.z - WEDDING_DOOR_REACH_OFFSET
      : station.spec.z;
  }

  private setTarget(slot: CoopPlayerState, target: KitchenTarget | null): void {
    slot.target = target;
    const view = target?.kind === "station" ? target.view : null;
    if (view === slot.highlighted) return;
    slot.highlighted?.setHighlighted(slot.index, false);
    view?.setHighlighted(slot.index, true);
    slot.highlighted = view;
  }

  private handleGameplayInput(slot: CoopPlayerState, deltaSeconds: number): void {
    if (slot.player.isDowned()) {
      slot.work = NO_WORK;
      // Knocked over mid-aim: the marker has to go with the throw it was promising.
      slot.aimSeconds = null;
      this.hideAim(slot);
      return;
    }
    if (slot.input.consumePressed("interact")) this.handleGrab(slot);
    if (slot.input.consumePressed("emote")) this.emote(slot);

    const actionPressed = slot.input.consumePressed("carry");
    // Holding food, the carry key aims instead of working: `KitchenModel.canWork` refuses
    // every station to a cook with full hands, so there is nothing for it to clash with.
    if (actionPressed && slot.held?.kind === "food") slot.aimSeconds = 0;
    if (actionPressed && slot.held && slot.held.kind !== "extinguisher") {
      this.notifyPlayer(slot, t("kitchen.onlyIngredientsThrow"), "info");
    }
    if (slot.aimSeconds !== null) {
      if (slot.held?.kind === "food" && slot.input.isDown("carry")) {
        slot.aimSeconds = Math.min(CHARGE_SECONDS, slot.aimSeconds + deltaSeconds);
        this.showAim(slot, chargeFraction(slot.aimSeconds));
        slot.work = NO_WORK;
        return;
      }
      // Let go, or lost the item to a shove: either way the aim is over.
      const charge = chargeFraction(slot.aimSeconds);
      slot.aimSeconds = null;
      this.hideAim(slot);
      if (slot.held?.kind === "food") {
        this.throwHeldItem(slot, charge);
        slot.work = NO_WORK;
        return;
      }
    }

    const previous = slot.work.kind;
    slot.work = NO_WORK;
    slot.workStation = null;
    if (!slot.input.isDown("carry")) {
      slot.workProgressStep = -1;
      return;
    }
    const station = slot.held?.kind === "extinguisher"
      ? this.findSprayTarget(slot)
      : slot.target?.kind === "station" ? slot.target.station : null;
    if (!station) {
      slot.workProgressStep = -1;
      return;
    }
    slot.work = this.kitchen.work(station, slot.held, deltaSeconds);
    if (slot.work.kind !== "none") slot.workStation = station;
    this.reportWork(slot, station, previous);
  }

  /**
   * Publishes a cook's hands-on job on the bus. Progress is reported in tenths rather than
   * every frame, so a two-second chop costs a handful of events instead of a hundred and
   * twenty.
   */
  private reportWork(
    slot: CoopPlayerState,
    station: Workstation,
    previousKind: WorkOutcome["kind"],
  ): void {
    if (slot.work.kind === "none") {
      slot.workProgressStep = -1;
      return;
    }
    const work: StationWorkKind = slot.work.kind;
    if (previousKind !== slot.work.kind) {
      slot.workProgressStep = -1;
      this.eventBus.emit("station:started", {
        stationKind: station.spec.kind,
        work,
        playerIndex: slot.index,
      });
    }
    const step = Math.floor(slot.work.progress * 10);
    if (step === slot.workProgressStep) return;
    slot.workProgressStep = step;
    this.eventBus.emit("station:progress", {
      stationKind: station.spec.kind,
      work,
      progress: slot.work.progress,
      playerIndex: slot.index,
    });
  }

  private handleGrab(slot: CoopPlayerState): void {
    const target = slot.target;
    const now = this.kitchenClockMs;
    if (target?.kind === "station") {
      const outcome = this.kitchen.grab(target.station, slot.held, now);
      if (outcome.kind === "blocked") {
        this.notifyPlayer(slot, outcome.message, "warning");
        return;
      }
      this.eventBus.emit("station:used", { stationKind: target.station.spec.kind });
      if (outcome.kind === "deliver") {
        slot.held = null;
        slot.player.playThrowGesture();
        this.deliverPlate(slot, outcome.plate, outcome.recipe);
        return;
      }
      const pickedUp = !slot.held && outcome.held;
      // Something left the hands: into a machine, onto a counter, or swapped.
      if (slot.held && slot.held !== outcome.held) {
        this.eventBus.emit("ingredient:dropped", { item: slot.held, playerIndex: slot.index });
        slot.player.playThrowGesture();
      }
      if (pickedUp && outcome.held) {
        this.eventBus.emit("ingredient:picked", { item: outcome.held, playerIndex: slot.index });
      }
      // A tray going into the oven or coming out: the door swings and the cook reaches in.
      if (target.station.spec.kind === "oven" && slot.held !== outcome.held) {
        this.stationViews.get(target.station)?.swingDoor();
        slot.ovenReach = OVEN_REACH_SECONDS;
      }
      slot.held = outcome.held;
      this.sfx.play(pickedUp ? "pickup" : target.station.spec.kind === "trash" ? "trash" : "place");
      if (outcome.message) this.notifyPlayer(slot, outcome.message, "info");
      slot.player.setExpression(slot.held ? "O_O" : "^_^");
      return;
    }

    if (target?.kind === "floor") {
      const entry = target.entry;
      if (!slot.held) {
        this.removeFloorItem(entry);
        slot.held = entry.item;
        this.eventBus.emit("ingredient:picked", { item: entry.item, playerIndex: slot.index });
        this.sfx.play("pickup");
        return;
      }
      const combined = combineItems(slot.held, entry.item, this.recipeList);
      if (combined) {
        slot.held = combined.held;
        if (!combined.target) this.removeFloorItem(entry);
        this.sfx.play("place");
      } else {
        this.notifyPlayer(slot, t("kitchen.handsFull"), "info");
      }
      return;
    }

    // No target, nothing happens: Overcooked has no "set it down on the floor". Items only
    // reach the floor by being thrown, and they stay pickable once there.
  }

  private findSprayTarget(slot: CoopPlayerState): Workstation | null {
    // The spray covers the aimed tile and its neighbours (see KitchenModel.extinguish), so
    // the aimed tile only counts when a fire is within that reach; otherwise facing a cold
    // counter next to the blaze would spray nothing.
    if (slot.target?.kind === "station") {
      const aimed = slot.target.station;
      const reach = KITCHEN_TILE * 1.05;
      const covers = this.kitchen.stations.some((station) =>
        station.onFire &&
        Math.abs((station.spec.y ?? 0) - (aimed.spec.y ?? 0)) <= STOREY_REACH &&
        (station.spec.x - aimed.spec.x) ** 2 + (station.spec.z - aimed.spec.z) ** 2 <= reach * reach);
      if (covers) return aimed;
    }
    let best: Workstation | null = null;
    let bestDistance = EXTINGUISHER_REACH;
    for (const station of this.kitchen.stations) {
      if (!station.onFire) continue;
      if (Math.abs((station.spec.y ?? 0) - slot.player.position.y) > STOREY_REACH) continue;
      const dx = station.spec.x - this.probe.x;
      const dz = station.spec.z - this.probe.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance < bestDistance) {
        best = station;
        bestDistance = distance;
      }
    }
    return best;
  }

  private handleKitchenEvents(events: readonly KitchenEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "chopped":
          this.sfx.play("ding", 0.7);
          break;
        case "washed":
          this.sfx.play("ding", 0.5);
          break;
        case "cook":
          if (event.event === "cooked") {
            this.sfx.play("ding");
            const item = event.station.item;
            if (isCookware(item)) {
              this.notify(t("kitchen.foodReady", {
                count: item.contents.length,
                station: STATION_KIND_LABEL[event.station.spec.kind],
              }), "success", 2200);
            }
          } else if (event.event === "burnt") {
            this.sfx.play("burnt");
            this.notify(t("kitchen.burnt"), "error", 2600);
          }
          break;
        case "fire":
          this.sfx.play("ignite");
          this.notify(t("kitchen.fire"), "error", 3500);
          break;
        case "extinguished":
          this.sfx.play("puff");
          this.notify(t("kitchen.fireOut"), "success", 1800);
          break;
        case "dirtyReturned":
          break;
      }
      this.eventBus.emit("station:completed", {
        stationKind: event.station.spec.kind,
        outcome: event.type === "cook" ? event.event : event.type,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Floor items and throwing

  private addFloorItem(
    item: KitchenItem,
    x: number,
    y: number,
    z: number,
    thrownBy: PlayerIndex | null,
    airborne: boolean,
  ): FloorItem {
    const entry: FloorItem = {
      item,
      position: new Vector3(x, y, z),
      previous: new Vector3(x, y, z),
      velocity: new Vector3(),
      rotation: new Vector3(),
      angularVelocity: new Vector3(),
      bounces: 0,
      airborne,
      thrownBy,
    };
    this.floorItems.push(entry);
    return entry;
  }

  private removeFloorItem(entry: FloorItem): void {
    const index = this.floorItems.indexOf(entry);
    if (index >= 0) this.floorItems.splice(index, 1);
  }

  /** Shows where `slot` would land their throw at the charge they have built up. */
  private showAim(slot: CoopPlayerState, charge: number): void {
    const marker = slot.aimMarker ?? new WaypointMarker(this.scene, {
      label: "aim",
      color: PLAYER_COLORS[slot.index] ?? PLAYER_COLORS[0]!,
      playerIndex: slot.index,
      beam: false,
    });
    slot.aimMarker = marker;
    const yaw = slot.player.facingYaw;
    const anchor = slot.player.carryAnchor.getAbsolutePosition();
    const dx = Math.sin(yaw), dz = Math.cos(yaw);
    const launch = throwLaunch(charge);
    const origin = this.aimOrigin.set(anchor.x + dx * 0.3, anchor.y, anchor.z + dz * 0.3);
    const landing = landingPoint(origin, dx, dz, launch);
    const bounds = this.environment.bounds;
    const previous = this.aimPrevious.copyFrom(origin);
    for (let time = Math.min(1 / 30, landing.seconds); ; time = Math.min(time + 1 / 30, landing.seconds)) {
      const next = this.aimPosition.set(
        Math.max(bounds.minX - 1.4, Math.min(bounds.maxX + 1.4, origin.x + dx * launch.speed * time)),
        heightAt(origin.y, launch, time),
        Math.max(bounds.minZ - 1.4, Math.min(bounds.maxZ + 1.4, origin.z + dz * launch.speed * time)),
      );
      const floor = this.groundContact(previous, next);
      const station = this.stationContact(previous, next, floor);
      const touch = station ? this.stationContactTime : floor;
      if (Number.isFinite(touch)) {
        Vector3.LerpToRef(previous, next, touch, next);
        next.y += 0.02;
        break;
      }
      if (time >= landing.seconds) { next.y = 0.02; break; }
      previous.copyFrom(next);
    }
    marker.setPosition(this.aimPosition);
    marker.setVisible(true);
  }

  private hideAim(slot: CoopPlayerState): void {
    slot.aimMarker?.setVisible(false);
  }

  private throwHeldItem(slot: CoopPlayerState, charge = 0): void {
    const item = slot.held;
    if (!item) return;
    slot.player.playThrowGesture();
    this.sfx.play("toss");
    const yaw = slot.player.facingYaw;
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const anchor = slot.player.carryAnchor.getAbsolutePosition();
    const entry = this.addFloorItem(
      item,
      anchor.x + forwardX * 0.3,
      anchor.y,
      anchor.z + forwardZ * 0.3,
      slot.index,
      true,
    );
    // No random scatter on an aimed throw: the marker promised a spot, so it has to be
    // the spot. See src/gameplay/throwArc.ts.
    const launch = throwLaunch(charge);
    const launchSpeed = launch.speed;
    entry.velocity.set(forwardX * launchSpeed, launch.verticalKick, forwardZ * launchSpeed);
    entry.angularVelocity.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.5) * 12,
    );
    slot.held = null;
    this.runtime = {
      ...this.runtime,
      componentsThrown: this.runtime.componentsThrown + 1,
    };
    slot.player.setExpression("-_-");
  }

  private updateFloorItems(deltaSeconds: number): void {
    const bounds = this.environment.bounds;
    // Thrown items may fly a little past the walkable area (over counters).
    const minX = bounds.minX - 1.4;
    const maxX = bounds.maxX + 1.4;
    const minZ = bounds.minZ - 1.4;
    const maxZ = bounds.maxZ + 1.4;

    for (let index = this.floorItems.length - 1; index >= 0; index -= 1) {
      const entry = this.floorItems[index];
      if (!entry) continue;
      // An ingredient at rest on a belt still travels; this is the thing that most makes a
      // kitchen feel like it is working against you.
      if (!entry.airborne) {
        this.mechanisms?.pushItem(entry.position, deltaSeconds, minX, maxX, minZ, maxZ);
        continue;
      }
      const { position, velocity } = entry;
      entry.previous.copyFrom(position);
      position.x += velocity.x * deltaSeconds;
      position.y += (velocity.y - THROW_GRAVITY * deltaSeconds * 0.5) * deltaSeconds;
      position.z += velocity.z * deltaSeconds;
      velocity.y -= THROW_GRAVITY * deltaSeconds;
      entry.rotation.x += entry.angularVelocity.x * deltaSeconds;
      entry.rotation.y += entry.angularVelocity.y * deltaSeconds;
      entry.rotation.z += entry.angularVelocity.z * deltaSeconds;
      entry.angularVelocity.scaleInPlace(THROW_ANGULAR_DAMPING);

      if (position.x < minX || position.x > maxX) {
        position.x = Math.min(maxX, Math.max(minX, position.x));
        velocity.x = -velocity.x * THROW_RESTITUTION;
        entry.bounces += 1;
      }
      if (position.z < minZ || position.z > maxZ) {
        position.z = Math.min(maxZ, Math.max(minZ, position.z));
        velocity.z = -velocity.z * THROW_RESTITUTION;
        entry.bounces += 1;
      }

      const floor = this.groundContact(entry.previous, position);
      const station = this.stationContact(entry.previous, position, floor);
      const obstacle = station ? this.stationContactTime : floor;
      const target = entry.item.kind === "food"
        ? this.findPlayerImpactTarget(entry, obstacle)
        : null;
      if (target) {
        Vector3.LerpToRef(entry.previous, position, this.playerContactTime, position);
        if (!target.held && !target.player.isDowned()) this.catchItem(entry, target);
        else this.applyPlayerHit(entry, target);
        continue;
      }

      if (station) {
        const top = this.stationTop(station);
        Vector3.LerpToRef(entry.previous, position, this.stationContactTime, position);
        if (velocity.y < 0 && entry.previous.y >= top && position.y >= top - 0.002 &&
            this.kitchen.land(station, entry.item)) {
          this.floorItems.splice(index, 1);
          this.sfx.play(station.spec.kind === "trash" ? "trash" : "place");
          continue;
        }
        // Back off from the side so the next step starts outside the box.
        if (position.y < top - 0.002) {
          position.x = entry.previous.x;
          position.z = entry.previous.z;
        } else {
          position.y = top + 0.003;
          velocity.y = Math.max(0.7, -velocity.y * THROW_RESTITUTION);
          if (entry.bounces >= 2) {
            // A full station cannot trap an item bouncing vertically above it.
            position.y = station.spec.y ?? 0;
            this.keepOutOfStations(entry);
            velocity.y = 0;
          }
        }
        velocity.x *= -0.35;
        velocity.z *= -0.35;
        entry.bounces += 1;
        continue;
      }

      if (Number.isFinite(floor)) {
        Vector3.LerpToRef(entry.previous, position, floor, position);
        if (position.y < 0 && entry.previous.y < 0) position.y = 0;
        if (Math.abs(velocity.y) < 1.4 || entry.bounces > 2) {
          velocity.setAll(0);
          entry.angularVelocity.setAll(0);
          entry.rotation.x = 0;
          entry.rotation.z = 0;
          entry.airborne = false;
          entry.thrownBy = null;
          this.keepOutOfStations(entry);
        } else {
          velocity.y = -velocity.y * THROW_RESTITUTION;
          velocity.x *= THROW_FRICTION;
          velocity.z *= THROW_FRICTION;
          entry.bounces += 1;
        }
      }
    }
  }

  private groundContact(from: Vector3, to: Vector3): number {
    if (to.y >= from.y) return Infinity;
    const candidates = this.nearbyColliders.collect(
      Math.min(from.x, to.x), Math.max(from.x, to.x),
      Math.min(from.z, to.z), Math.max(from.z, to.z), this.projectileColliders,
    );
    return flightGroundContact(from, to, candidates);
  }

  private stationTop(station: Workstation): number {
    return (station.spec.y ?? 0) + (this.stationViews.get(station)?.topHeight ?? 0.9);
  }

  private readonly supportFrom = new Vector3();
  private readonly supportTo = new Vector3();

  private supportNear(x: number, y: number, z: number, rise = 0.3, drop = rise): number | null {
    const from = this.supportFrom.set(x, y + rise, z);
    const to = this.supportTo.set(x, y - drop, z);
    const time = this.groundContact(from, to);
    return Number.isFinite(time) ? from.y + (to.y - from.y) * time : null;
  }

  private stationContactTime = Infinity;
  private stationContact(from: Vector3, to: Vector3, before: number): Workstation | null {
    this.stationContactTime = before;
    let hit: Workstation | null = null;
    for (const station of this.kitchen.stations) {
      const { x, y = 0, z } = station.spec;
      const time = throwStationContact(from, to, x, z, KITCHEN_TILE * 0.5, y, this.stationTop(station));
      if (time < this.stationContactTime) {
        this.stationContactTime = time;
        hit = station;
      }
    }
    return hit;
  }

  private stationAt(x: number, y: number, z: number): Workstation | null {
    const half = KITCHEN_TILE * 0.5;
    for (const station of this.kitchen.stations) {
      if (Math.abs((station.spec.y ?? 0) - y) < 0.45 &&
          Math.abs(station.spec.x - x) < half && Math.abs(station.spec.z - z) < half) return station;
    }
    return null;
  }

  /**
   * Items resting behind the counters or inside a station footprint would be unreachable —
   * a lost plate, the only pot or the extinguisher can make a shift unwinnable. The item is
   * brought back inside the walkable bounds, then moved to the nearest free side of any
   * station it still sits in.
   */
  private keepOutOfStations(entry: FloorItem): void {
    const bounds = this.environment.bounds;
    const inBounds = (x: number, z: number): boolean =>
      x >= bounds.minX && x <= bounds.maxX && z >= bounds.minZ && z <= bounds.maxZ;
    const position = entry.position;
    position.x = Math.min(bounds.maxX, Math.max(bounds.minX, position.x));
    position.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, position.z));

    const push = KITCHEN_TILE * 0.5 + 0.2;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const station = this.stationAt(position.x, position.y, position.z);
      if (!station) return;
      const candidates = [
        { x: station.spec.x + push, z: position.z },
        { x: station.spec.x - push, z: position.z },
        { x: position.x, z: station.spec.z + push },
        { x: position.x, z: station.spec.z - push },
      ].flatMap(candidate => {
        if (!inBounds(candidate.x, candidate.z)) return [];
        const y = this.supportNear(candidate.x, position.y, candidate.z);
        return y === null ? [] : [{ ...candidate, y }];
      });
      if (candidates.length === 0) return;
      const distance = (candidate: { x: number; z: number }): number =>
        (candidate.x - position.x) ** 2 + (candidate.z - position.z) ** 2;
      // A free spot wins; failing that, step to the nearest side and try again from there.
      const free = candidates.filter((candidate) => !this.stationAt(candidate.x, candidate.y, candidate.z));
      const pool = free.length > 0 ? free : candidates;
      const best = pool.reduce((a, b) => (distance(b) < distance(a) ? b : a));
      position.set(best.x, best.y, best.z);
      if (free.length > 0) return;
    }
  }

  private playerContactTime = Infinity;
  private findPlayerImpactTarget(entry: FloorItem, before: number): CoopPlayerState | null {
    if (entry.velocity.lengthSquared() <= 1.2 ** 2) return null;
    let best: CoopPlayerState | null = null;
    this.playerContactTime = before;
    for (const slot of this.players) {
      if (slot.index === entry.thrownBy || slot.player.isDowned()) continue;
      const { x, y, z } = slot.player.position;
      const time = throwSphereContact(entry.previous, entry.position, x, y + 0.9, z, THROW_IMPACT_RADIUS);
      if (time < this.playerContactTime) {
        this.playerContactTime = time;
        best = slot;
      }
    }
    return best;
  }

  /** Told when a disaster breaks out, for what lives outside the scene (the phones' buzz). */
  onDisasterStart: ((kind: DisasterKind) => void) | null = null;

  /**
   * Sets off a disaster at once, skipping the wait for a failed order. For testing
   * from the console in development: `__bbGame.kitchenScene.punish("tesla")`.
   */
  punish(kind?: DisasterKind): void {
    this.punishment.punish(kind);
  }

  private updateShake(deltaSeconds: number, chaosShake: number): void {
    let amount = 0;
    if (this.shakeLeft > 0) {
      this.shakeLeft = Math.max(0, this.shakeLeft - deltaSeconds);
      amount = this.shakeTotal > 0 ? this.shakeAmountPeak * (this.shakeLeft / this.shakeTotal) : 0;
    }
    this.shakeAmount = Math.max(amount, chaosShake);
  }

  private shake(amount: number, seconds: number): void {
    // A stronger jolt replaces a weaker one; a weaker one never cuts a stronger short.
    const current = this.shakeTotal > 0 ? this.shakeAmountPeak * (this.shakeLeft / this.shakeTotal) : 0;
    if (amount < current) return;
    this.shakeAmountPeak = amount;
    this.shakeLeft = seconds;
    this.shakeTotal = seconds;
  }

  /** What the disasters may touch in this kitchen. */
  private disasterHost(): DisasterHost {
    const slotOf = (cook: DisasterCook): CoopPlayerState => this.allCooks[cook.index]!;
    // The cooks in play right now: the count can change between shifts, the host cannot.
    const cookViews = new Map<CoopPlayerState, DisasterCook>();
    let cooks: DisasterCook[] = [];
    let cooksOf: readonly CoopPlayerState[] | null = null;
    const players = (): readonly CoopPlayerState[] => this.players;
    return {
      scene: this.scene,
      assets: this.assets,
      sfx: this.sfx,
      overlay: this.disasterOverlay,
      get cooks(): DisasterCook[] {
        const current = players();
        if (current !== cooksOf) {
          cooksOf = current;
          cooks = current.map((slot) => {
            let view = cookViews.get(slot);
            if (!view) {
              view = { index: slot.index, label: slot.label, player: slot.player, input: slot.input };
              cookViews.set(slot, view);
            }
            return view;
          });
        }
        return cooks;
      },
      bounds: this.environment.bounds,
      robots: this.wedding,
      juiceTexture: this.workstationResources.fireTexture,
      hitCook: (cook, fromX, fromZ, strength) => this.knockCook(slotOf(cook), fromX, fromZ, strength),
      dropHeld: (cook) => this.scatterHeld(slotOf(cook), 0, 0),
      notify: (message, tone) => this.notify(message, tone, 2_400),
      shake: (amount, seconds) => this.shake(amount, seconds),
      alarm: (kind) => {
        this.shake(DISASTER_JOLT_AMOUNT, DISASTER_JOLT_SECONDS);
        this.onDisasterStart?.(kind);
      },
      stationViews: () => [...this.stationViews.values()].map((view) => ({
        root: view.root,
        x: view.placement.x,
        z: view.placement.z,
        topHeight: view.topHeight,
        kind: view.placement.kind,
      })),
      scatterFloorItems: (x, y, z, radius, power) => this.scatterFloorItems(x, y, z, radius, power),
      floorHeight: (x, y, z) => this.supportNear(x, y, z, 0.35, STOREY_REACH) ?? y,
      spawnPoint: (cook) => (this.environment.playerSpawns[cook.index] ?? this.environment.playerSpawns[0]!).clone(),
      stealables: () => this.stealables(),
      dropLoose: (item, x, y, z) => {
        const floor = this.supportNear(x, y, z, 0.35, STOREY_REACH) ?? y;
        const entry = this.addFloorItem(item as unknown as KitchenItem, x, floor + 0.25, z, null, true);
        entry.velocity.set((Math.random() - 0.5) * 1.2, 1.6, (Math.random() - 0.5) * 1.2);
      },
    };
  }

  /**
   * Food a rat may run off with: lying on the floor, or on a counter no cook is
   * working at or standing at. A board mid-chop, or the counter in front of a cook,
   * is left alone.
   */
  private stealables(): Stealable[] {
    const busy = new Set<Workstation>();
    for (const slot of this.players) {
      if (slot.work.kind !== "none" && slot.workStation) busy.add(slot.workStation);
      if (slot.target?.kind === "station") busy.add(slot.target.station);
    }
    const label = (ingredientId: string): string => getIngredient(ingredientId)?.displayName ?? ingredientId;
    const list: Stealable[] = [];
    for (const station of this.kitchen.stations) {
      const item = station.item;
      if (item?.kind !== "food" || station.onFire || busy.has(station)) continue;
      list.push({
        id: item.uid,
        x: station.spec.x,
        z: station.spec.z,
        y: this.stationTop(station),
        floorY: station.spec.y ?? 0,
        label: label(item.ingredientId),
        take: () => {
          if (station.item !== item) return null;
          station.item = null;
          return item as unknown as LooseItem;
        },
      });
    }
    for (const entry of this.floorItems) {
      const item = entry.item;
      if (item.kind !== "food" || entry.airborne) continue;
      list.push({
        id: item.uid,
        x: entry.position.x,
        z: entry.position.z,
        y: entry.position.y,
        floorY: entry.position.y,
        label: label(item.ingredientId),
        take: () => {
          if (!this.floorItems.includes(entry)) return null;
          this.removeFloorItem(entry);
          return item as unknown as LooseItem;
        },
      });
    }
    return list;
  }

  /** The rhythm of work: a knife stroke, a scrub or a puff of the extinguisher. */
  private playWorkSounds(slot: CoopPlayerState, delta: number): void {
    const kind = slot.work.kind;
    if (kind === "none") {
      this.workBeats.delete(slot.index);
      return;
    }
    const left = (this.workBeats.get(slot.index) ?? 0) - delta;
    if (left > 0) {
      this.workBeats.set(slot.index, left);
      return;
    }
    if (kind === "chopping") this.sfx.play("chop", 0.9);
    else if (kind === "washing") this.sfx.play("scrub", 0.8);
    else this.sfx.play("spray", 0.7);
    this.workBeats.set(slot.index, kind === "chopping" ? 0.26 : kind === "washing" ? 0.42 : 0.3);
  }

  /** Frying on any stove with food in its pan or pot, louder the more are going. */
  private updateSizzle(): void {
    const frying = this.kitchen.stations.filter((station) =>
      station.spec.kind === "stove" && isCookware(station.item) && station.item.contents.length > 0 &&
      !isCookwareBurnt(station.item)).length;
    if (frying === 0) {
      this.sizzle?.stop(0.5);
      this.sizzle = null;
      return;
    }
    this.sizzle ??= this.sfx.loop("sizzle", 0);
    this.sizzle.setLevel(Math.min(1, 0.55 + 0.2 * frying));
  }

  private stopKitchenSounds(): void {
    this.sizzle?.stop(0.3);
    this.sizzle = null;
    this.workBeats.clear();
  }

  /** Knocks a cook over away from (fromX, fromZ), scattering what they carry. */
  private knockCook(slot: CoopPlayerState, fromX: number, fromZ: number, strength: number): void {
    if (slot.player.isDowned()) return;
    this.sfx.play("bonk");
    const dx = slot.player.position.x - fromX;
    const dz = slot.player.position.z - fromZ;
    const length = Math.hypot(dx, dz);
    const hx = length > 0.01 ? dx / length : 1;
    const hz = length > 0.01 ? dz / length : 0;
    slot.player.stun(hx, hz, strength);
    this.scatterHeld(slot, hx, hz);
  }

  /** Drops what a cook holds, tossed a little along (hx, hz). */
  private scatterHeld(slot: CoopPlayerState, hx: number, hz: number): void {
    const carried = slot.held;
    if (!carried) return;
    const anchor = slot.player.carryAnchor.getAbsolutePosition();
    const scattered = this.addFloorItem(carried, anchor.x, anchor.y, anchor.z, slot.index, true);
    scattered.velocity.set(hx * 2.2, 1.8, hz * 2.2);
    scattered.angularVelocity.set((Math.random() - 0.5) * 12, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 12);
    slot.held = null;
  }

  private scatterFloorItems(x: number, y: number, z: number, radius: number, power: number): void {
    for (const entry of this.floorItems) {
      if (Math.abs(entry.position.y - y) > STOREY_REACH) continue;
      const dx = entry.position.x - x;
      const dz = entry.position.z - z;
      const distance = Math.hypot(dx, dz);
      if (distance > radius) continue;
      const push = power * (1 - distance / radius) + 1;
      const nx = distance > 0.01 ? dx / distance : Math.random() - 0.5;
      const nz = distance > 0.01 ? dz / distance : Math.random() - 0.5;
      entry.velocity.set(nx * push, 3 + Math.random() * 3, nz * push);
      entry.angularVelocity.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14);
      entry.airborne = true;
    }
  }

  /**
   * Sounds each dash as it starts and shoves whoever is in the way.
   *
   * The shove is deliberately weaker than a thrown pan: it knocks the other cook over and
   * spills what they carry, which is the Overcooked way of asking someone to move, but it
   * slides them a fraction of the distance a real hit would.
   */
  private resolveDashes(): void {
    for (const slot of this.players) {
      const dashing = slot.player.isDashing;
      if (dashing && !slot.wasDashing) this.sfx.play("toss", 0.5);
      slot.wasDashing = dashing;
      if (!dashing) continue;

      // Every other cook within reach and ahead of the dash goes over.
      for (const other of this.players) {
        if (other === slot || other.player.isDowned()) continue;
        const dx = other.player.position.x - slot.player.position.x;
        const dz = other.player.position.z - slot.player.position.z;
        if (dx * dx + dz * dz > DASH_SHOVE_REACH * DASH_SHOVE_REACH) continue;
        // Only a dash that is actually heading into them counts, so brushing past while
        // dashing away does not knock anybody down.
        if (dx * slot.player.dashDirection.x + dz * slot.player.dashDirection.z <= 0) continue;

        other.player.stun(slot.player.dashDirection.x, slot.player.dashDirection.z, DASH_SHOVE_STRENGTH);
        this.scatterHeldOf(other, slot.player.dashDirection.x, slot.player.dashDirection.z);
        this.sfx.play("bonk", 0.7);
        this.notify(t("kitchen.shoved", { name: other.label }), "warning", 1_800);
      }
    }
  }

  /** Spills what `slot` is carrying onto the floor beside them, heading (hx, hz). */
  private scatterHeldOf(slot: CoopPlayerState, hx: number, hz: number): void {
    const carried = slot.held;
    if (!carried) return;
    const anchor = slot.player.carryAnchor.getAbsolutePosition();
    const scattered = this.addFloorItem(carried, anchor.x, anchor.y, anchor.z, slot.index, true);
    scattered.velocity.set(hx * 2.2, 1.8, hz * 2.2);
    scattered.angularVelocity.set(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 12,
    );
    slot.held = null;
    this.eventBus.emit("ingredient:dropped", { item: carried, playerIndex: slot.index });
  }

  /**
   * "Hey!": a cook calls across the kitchen.
   *
   * What the call says depends on what they are doing, so a ping is worth reading rather
   * than just noise — carrying something names it, working an order points at that ticket,
   * and an empty-handed cook is asking for work.
   */
  private emote(slot: CoopPlayerState): void {
    const now = performance.now();
    if (now - slot.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
    slot.lastEmoteAt = now;

    const text = slot.held
      ? t("kitchen.heyCarrying", { item: describeItem(slot.held, this.recipeList) })
      : slot.focusedOrderId
        ? t("kitchen.heyOnIt")
        : t("kitchen.hey");
    this.ui.showPlayerCallout(slot.index, text);
    // The ticket they are on lights up, so the partner can see what was meant.
    if (slot.focusedOrderId) this.ui.flashOrder(slot.focusedOrderId);
    slot.player.playThrowGesture();
    slot.player.setExpression("O_O");
    this.sfx.play("hey");
  }

  /**
   * A cook's floor vanished from under them: they go down and lose what they carried.
   *
   * There is no void to fall into here — the ground is solid at every height — so this is
   * the Overcooked penalty rather than a respawn: knocked over, hands emptied, a few
   * seconds lost. A raised floor still drops them to the level below, by plain gravity.
   */
  private fallFromFloor(slot: CoopPlayerState): void {
    if (slot.player.isDowned()) return;
    slot.player.stun(0, 1, FALL_STUN_STRENGTH);
    this.scatterHeldOf(slot, 0, 0);
    this.sfx.play("bonk", 0.8);
    this.notify(t("kitchen.fell", { name: slot.label }), "warning", 2_000);
  }

  /**
   * Announces each layout phase as the shift crosses it.
   *
   * The kitchen changing shape is the single biggest thing that can happen mid-shift, and
   * it has to be impossible to miss: a notice, a sound and a jolt of the camera.
   */
  private announceLayoutPhases(): void {
    const reached = phasesReached(this.options.map?.meta?.layoutPhases, this.shiftClock.progress);
    if (reached <= this.phasesAnnounced) return;
    this.phasesAnnounced = reached;
    this.notify(t("kitchen.layoutChanged"), "warning", 3_200);
    this.sfx.play("warning");
    this.shake(0.12, 0.45);
  }

  /** Moves cooks and thrown items that have stepped into an open portal. */
  private travelThroughPortals(deltaSeconds: number): void {
    const mechanisms = this.mechanisms;
    if (!mechanisms || mechanisms.isEmpty) return;
    for (const slot of this.players) {
      slot.portalCooldown = Math.max(0, slot.portalCooldown - deltaSeconds);
      if (slot.portalCooldown > 0 || slot.player.isDowned()) continue;
      if (!mechanisms.findPortalExit(slot.player.position, this.portalExit)) continue;
      // A teleport, not a sweep: the whole point of a portal is to skip what lies between.
      this.portalExit.y = slot.player.position.y;
      slot.player.teleport(this.portalExit);
      slot.portalCooldown = PORTAL_COOLDOWN_SECONDS;
      this.sfx.play("zap", 0.6);
    }
    // A thrown ingredient goes through too, keeping its speed — that is what makes a
    // portal a way to pass things across the kitchen, not just to walk.
    for (const entry of this.floorItems) {
      if (!entry.airborne) continue;
      entry.portalCooldown = Math.max(0, (entry.portalCooldown ?? 0) - deltaSeconds);
      if (entry.portalCooldown > 0) continue;
      if (!mechanisms.findPortalExit(entry.position, this.portalExit)) continue;
      entry.position.x = this.portalExit.x;
      entry.position.z = this.portalExit.z;
      entry.previous.copyFrom(entry.position);
      entry.portalCooldown = PORTAL_COOLDOWN_SECONDS;
    }
  }

  /** The other cook takes a thrown ingredient out of the air. */
  private catchItem(entry: FloorItem, target: CoopPlayerState): void {
    this.removeFloorItem(entry);
    target.held = entry.item;
    target.player.setExpression("O_O");
    this.sfx.play("pickup");
    this.eventBus.emit("ingredient:picked", { item: entry.item, playerIndex: target.index });
    this.notify(t("kitchen.caught", { name: target.label }), "success", 1_800);
  }

  private applyPlayerHit(entry: FloorItem, target: CoopPlayerState): void {
    const itemMass = entry.item.kind === "food" ? estimateItemMass(entry.item.ingredientId) : 0.8;
    const projectileSpeed = entry.velocity.length();
    const dx = target.player.position.x - entry.position.x;
    const dz = target.player.position.z - entry.position.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    const hx = length > 0.01 ? dx / length : 1;
    const hz = length > 0.01 ? dz / length : 0;
    // A hit knocks the chef over where they stand. Nothing here lifts them off the floor.
    target.player.stun(hx, hz, impactStunStrength(itemMass, projectileSpeed));

    // The projectile drops where it hit.
    entry.velocity.set(-hx * 1.2, 1.5, -hz * 1.2);
    entry.thrownBy = target.index;

    // Drops near the victim rather than flying across the kitchen.
    this.scatterHeldOf(target, hx, hz);
    this.sfx.play("bonk");
    this.notify(t("kitchen.hit", { name: target.label }), "warning", 2_000);
  }

  // -------------------------------------------------------------------------
  // Rendering sync

  private syncKitchenVisuals(deltaSeconds: number): void {
    if (this.stationViews.size === 0) return;
    this.itemViews.beginFrame();
    for (const [station, view] of this.stationViews) {
      if (station.item) this.itemViews.place(station.item, view.itemAnchor);
      view.update(deltaSeconds, this.stationViewState(station));
    }
    for (const slot of this.players) {
      if (slot.held) this.itemViews.place(slot.held, slot.player.carryAnchor);
      slot.ovenReach = Math.max(0, slot.ovenReach - deltaSeconds);
      slot.player.setArmPose(armPoseFor(slot.work.kind, slot.held !== null, slot.ovenReach > 0));
      this.updateSprayJet(slot);
    }
    for (const entry of this.floorItems) {
      const root = this.itemViews.place(entry.item, null);
      root.position.copyFrom(entry.position);
      root.rotation.copyFrom(entry.rotation);
    }
    this.itemViews.endFrame();
  }

  /** Points the cook's extinguisher jet at the fire they are putting out, or stops it. */
  private updateSprayJet(slot: CoopPlayerState): void {
    const station = slot.work.kind === "extinguishing" ? slot.workStation : null;
    let jet = this.sprayJets.get(slot.index);
    if (!station) {
      jet?.stop();
      return;
    }
    if (!jet) {
      jet = new SprayJet(this.scene, this.workstationResources.fireTexture, `spray-jet-${slot.index}`);
      this.sprayJets.set(slot.index, jet);
    }
    // The nozzle on top of the canister, which the cook holds at the carry anchor.
    const yaw = slot.player.facingYaw;
    const anchor = slot.player.carryAnchor.getAbsolutePosition();
    const nozzle = new Vector3(anchor.x + Math.sin(yaw) * 0.22, anchor.y + 0.56, anchor.z + Math.cos(yaw) * 0.22);
    jet.aim(nozzle, new Vector3(station.spec.x, this.stationTop(station) + 0.25, station.spec.z));
  }

  private stationViewState(station: Workstation): WorkstationViewState {
    const item = station.item;
    let progress: number | null = null;
    let tone: WorkstationViewState["tone"] = "work";
    let warning = false;
    const choppers = this.players.filter(
      (slot) => slot.workStation === station && slot.work.kind === "chopping",
    );
    const chopping = choppers.length > 0;
    const knifeInHand = choppers.some((slot) => slot.player.holdsKnife);
    const washing = this.players.some(
      (slot) => slot.workStation === station && slot.work.kind === "washing",
    );
    const mixing = this.players.some(
      (slot) => slot.workStation === station && slot.work.kind === "mixing",
    );

    if (station.spec.kind === "cutting_board" && item?.kind === "food" && item.chopProgress > 0) {
      progress = item.chopProgress;
    } else if (station.spec.kind === "sink" && station.washProgress > 0) {
      progress = station.washProgress;
    } else if (station.spec.kind === "mixer" && station.mixProgress > 0) {
      progress = station.mixProgress;
    } else if (HEATED_STATION_KINDS.has(station.spec.kind) && isCookware(item) &&
      item.contents.length > 0) {
      const cooking = getCookwareProgress(item);
      if (cooking.cook < 1) {
        progress = cooking.cook;
        tone = "cook";
      } else if (!isCookwareBurnt(item)) {
        progress = Math.max(0.001, cooking.burn);
        tone = "burn";
        warning = cooking.burn > 0.35;
      }
    }
    return {
      progress,
      tone,
      warning,
      onFire: station.onFire,
      cleanPlates: station.cleanPlates,
      dirtyPlates: station.dirtyPlates,
      chopping,
      knifeInHand,
      washing,
      mixing,
    };
  }

  // -------------------------------------------------------------------------
  // Orders, delivery and guidance

  private deliverPlate(slot: CoopPlayerState, plate: PlateItem, recipe: RecipeData): void {
    const createdAt = plate.contents.reduce(
      (oldest, food) => Math.min(oldest, food.createdAt),
      this.kitchenClockMs,
    );
    const dish = createIngredient(recipe.finalItemId, {
      createdAt,
      ...plateQuality(plate),
    });
    this.eventBus.emit("dish:created", { recipe, playerIndex: slot.index });
    this.serveDish(slot, dish, recipe);
  }

  private updateGuide(): void {
    const requests: OrderGuideRequest[] = [];
    for (const order of this.runtime.activeOrders) {
      if (order.status !== "active" || !order.requestedRecipeId) continue;
      const recipe = this.recipes.getRecipe(order.requestedRecipeId);
      if (!recipe) continue;
      requests.push({
        orderId: order.id,
        recipe,
        secondsRemaining: this.director.clockFor(order.id)?.remaining ?? 0,
      });
    }
    if (requests.length === 0) {
      this.lastQueueGuide = null;
      for (const slot of this.players) slot.focusedOrderId = null;
      return;
    }

    const queue = computeQueueGuide(requests, this.collectItemLocations());
    // Cached so the HUD's per-ticket step counter reuses this frame's plan.
    this.lastQueueGuide = queue;
    // Tasks are still claimed per player, but only so each card can show who is working
    // it. The on-screen step-by-step guide and its 3D waypoint were removed: the order
    // cards now carry that information.
    const assigned = new Set<string>();
    for (const slot of this.players) {
      const task = this.pickTask(slot, queue.tasks, assigned);
      if (!task) {
        slot.focusedOrderId = null;
        continue;
      }
      assigned.add(task.key);
      slot.focusedOrderId = task.orderId ?? null;
    }
  }


  /**
   * Prefers the task matching what the player holds, then an unclaimed one.
   *
   * `tasks` arrives sorted by order urgency, so both players naturally converge on the
   * ticket closest to expiring without any explicit prioritisation here.
   */
  private pickTask(
    slot: CoopPlayerState,
    tasks: readonly GuideTask[],
    assigned: ReadonlySet<string>,
  ): GuideTask | null {
    const free = tasks.filter((task) => !assigned.has(task.key));
    const held = slot.held;
    if (held?.kind === "food") {
      const definition = getFoodDefinition(held.ingredientId);
      // Ready for a vessel: whichever station a task wants it at (stove, oven or mixer).
      const prepared = definition !== undefined && held.state === cookableState(definition);
      const wanted: readonly string[] = held.state === "raw" && definition?.chop
        ? ["cutting_board"]
        : prepared
          ? ["stove", "oven", "mixer", "plate_rack"]
          : ["plate_rack"];
      const match = this.preferFocused(slot, free.filter((task) => wanted.includes(task.stationKind)));
      if (match) return match;
    }
    if (held?.kind === "plate" && !held.dirty && held.contents.length > 0) {
      const deliver = this.preferFocused(
        slot,
        free.filter((task) => task.stationKind === "delivery"),
      );
      if (deliver) return deliver;
    }
    return free[0] ?? tasks[0] ?? null;
  }

  /**
   * Keeps a player on the order they were already working, so a change in which ticket is
   * most urgent does not yank them mid-task.
   */
  private preferFocused(
    slot: CoopPlayerState,
    candidates: readonly GuideTask[],
  ): GuideTask | null {
    if (candidates.length === 0) return null;
    const focused = slot.focusedOrderId;
    return candidates.find((task) => task.orderId === focused) ?? candidates[0] ?? null;
  }

  private collectItemLocations(): ItemLocation[] {
    const locations: ItemLocation[] = [];
    for (const station of this.kitchen.stations) {
      const item = station.item;
      if (!item) continue;
      const processing = isCookware(item) && (HEATED_STATION_KINDS.has(station.spec.kind)
        ? item.heat > 0 : station.spec.kind === "mixer" && station.mixProgress > 0);
      locations.push({ item, holder: null, processing });
    }
    for (const slot of this.players) {
      if (slot.held) locations.push({ item: slot.held, holder: slot.index });
    }
    for (const entry of this.floorItems) locations.push({ item: entry.item, holder: null });
    return locations;
  }

  // -------------------------------------------------------------------------
  // Delivery beacon

  /**
   * Which delivery counters to point at: the nearest one to each finished plate that some
   * open order is waiting for, wherever that plate is (in a cook's hands, on a counter or
   * on the floor). Runs with the HUD (~12Hz); the beacons themselves move every frame.
   */
  private chooseDeliveryBeacons(): void {
    this.beaconStations.length = 0;
    const wanted = new Set<string>();
    let anyDish = false;
    for (const order of this.runtime.activeOrders) {
      if (order.status !== "active") continue;
      if (order.requestedRecipeId) wanted.add(order.requestedRecipeId);
      else anyDish = true;
    }
    if (wanted.size > 0 || anyDish) {
      const consider = (item: KitchenItem | null, x: number, y: number, z: number): void => {
        if (item?.kind !== "plate" || item.dirty || item.contents.length === 0) return;
        const recipe = findMatchingRecipe(item.contents, this.recipeList);
        if (!recipe || !(anyDish || wanted.has(recipe.id))) return;
        let nearest: Workstation | null = null;
        let sameFloor = false;
        let best = Infinity;
        for (const station of this.kitchen.stations) {
          if (station.spec.kind !== "delivery") continue;
          const dy = (station.spec.y ?? 0) - y;
          const onFloor = Math.abs(dy) <= STOREY_REACH;
          if (sameFloor && !onFloor) continue;
          const distance = (station.spec.x - x) ** 2 + dy * dy + (this.stationInteractionZ(station) - z) ** 2;
          if ((onFloor && !sameFloor) || distance < best) {
            sameFloor = onFloor;
            best = distance;
            nearest = station;
          }
        }
        if (nearest && !this.beaconStations.includes(nearest)) this.beaconStations.push(nearest);
      };
      for (const slot of this.players) {
        const { x, y, z } = slot.player.position;
        consider(slot.held, x, y, z);
      }
      for (const station of this.kitchen.stations) {
        if (station.spec.kind !== "delivery") consider(station.item, station.spec.x, station.spec.y ?? 0, station.spec.z);
      }
      for (const entry of this.floorItems) consider(entry.item, entry.position.x, entry.position.y, entry.position.z);
    }
    // The canvas's place in the HUD layer only changes on resize; reading it here, not per
    // frame, keeps layout reads off the render loop.
    const canvas = this.scene.getEngine().getRenderingCanvas();
    const hud = this.ui.hudLayer;
    if (canvas && this.beaconStations.length > 0) {
      const engine = this.scene.getEngine();
      const canvasRect = canvas.getBoundingClientRect();
      const hudRect = hud.getBoundingClientRect();
      const frame = this.beaconFrame;
      frame.scaleX = canvasRect.width / Math.max(1, engine.getRenderWidth());
      frame.scaleY = canvasRect.height / Math.max(1, engine.getRenderHeight());
      frame.left = canvasRect.left - hudRect.left;
      frame.top = canvasRect.top - hudRect.top;
      frame.width = hudRect.width;
      frame.height = hudRect.height;
    }
  }

  private updateDeliveryBeacons(): void {
    const camera = this.scene.activeCamera;
    const targets = this.beaconTargets;
    targets.length = 0;
    if (!camera || this.beaconStations.length === 0) {
      this.deliveryBeacon.hideAll();
      return;
    }
    const engine = this.scene.getEngine();
    const frame = this.beaconFrame;
    const cameras = this.scene.activeCameras;
    for (let index = 0; index < (cameras?.length || 1); index += 1) {
      const view = cameras?.[index] ?? camera;
      const viewport = this.beaconViewport;
      view.viewport.toGlobalToRef(engine.getRenderWidth(), engine.getRenderHeight(), viewport);
      view.getViewMatrix().multiplyToRef(view.getProjectionMatrix(), this.beaconTransform);
      const left = Math.max(0, frame.left + viewport.x * frame.scaleX);
      const right = Math.min(frame.width, frame.left + (viewport.x + viewport.width) * frame.scaleX);
      if (right - left < 100) continue;
      for (const station of this.beaconStations) {
        this.beaconWorld.set(station.spec.x, this.stationTop(station) + 1.2, this.stationInteractionZ(station));
        Vector3.ProjectToRef(this.beaconWorld, Matrix.IdentityReadOnly, this.beaconTransform, viewport, this.beaconScreen);
        const screen = this.beaconScreen;
        targets.push({
          x: frame.left + screen.x * frame.scaleX,
          y: frame.top + screen.y * frame.scaleY,
          inFront: screen.z >= 0 && screen.z <= 1,
          left,
          right,
        });
      }
    }
    this.deliveryBeacon.update(targets, frame.height);
  }

  // -------------------------------------------------------------------------
  // HUD

  private updateHUD(): void {
    this.ui.setOrderTickets(this.buildOrderTickets());
    for (const slot of this.players) {
      this.setStationKeyPrompt(slot, slot.player.isDowned() ? null : this.describeAction(slot));
    }
  }

  /** Derives the HUD's ticket rows; the scene owns the clocks, guests and assignments. */
  private buildOrderTickets(): OrderTicketInfo[] {
    const guide = this.lastQueueGuide;
    return this.runtime.activeOrders
      .filter((order) => order.status === "active")
      .map((order) => {
        const clock = this.director.clockFor(order.id);
        const recipe = order.requestedRecipeId
          ? this.recipes.getRecipe(order.requestedRecipeId)
          : undefined;
        const steps = guide?.byOrder.get(order.id);
        const assigned = this.players.find((slot) => slot.focusedOrderId === order.id);
        // Before the first updateGuide there is no plan yet, so fall back to "nothing done".
        const components = steps?.componentStages
          ?? recipe?.components.map((component) => ({
            ingredientId: component.ingredientId,
            state: component.state,
            stage: "fetch" as const,
          }))
          ?? [];
        return {
          orderId: order.id,
          recipeId: order.requestedRecipeId ?? null,
          title: recipe?.displayName ?? t("kitchen.specialOrder"),
          secondsRemaining: clock?.remaining ?? 0,
          totalSeconds: clock?.duration ?? 0,
          readyToDeliver: components.length > 0 && components.every((c) => c.stage === "plated"),
          components,
          assignedTo: assigned?.index ?? null,
        };
      });
  }

  /**
   * Floats this player's keycap above the station they are facing, so it is obvious *which*
   * object the prompt refers to. Cleared when they look away or have nothing to do there.
   */
  private setStationKeyPrompt(
    slot: CoopPlayerState,
    action: { prompt: string | null; action: "interact" | "carry" } | null,
  ): void {
    // `action` is null at the end of a shift; `action?.prompt !== null` would be true then
    // (undefined !== null) and leave the keycap floating over the results screen.
    const view = slot.target?.kind === "station" && action !== null && action.prompt !== null
      ? slot.target.view
      : null;
    if (slot.keyPromptView && slot.keyPromptView !== view) {
      slot.keyPromptView.setKeyPrompt(null);
    }
    slot.keyPromptView = view;
    if (view && action) view.setKeyPrompt(slot.input.labelFor(action.action));
  }

  /**
   * Context prompt for what the grab or work button will do. Returns the input *action*, not
   * a keycap, so each player's prompt resolves against their own bindings.
   */
  private describeAction(
    slot: CoopPlayerState,
  ): { prompt: string | null; action: "interact" | "carry" } {
    const held = slot.held;
    const target = slot.target;
    if (held?.kind === "extinguisher" && this.kitchen.anyFire) {
      return { prompt: t("kitchen.holdExtinguish"), action: "carry" };
    }
    if (target?.kind === "floor") {
      return { prompt: held ? t("kitchen.combine") : t("kitchen.pickUp", { item: describeItem(target.entry.item, this.recipeList) }), action: "interact" };
    }
    if (target?.kind !== "station") {
      // Nothing in reach: no prompt, because there is nowhere to put anything down.
      return { prompt: null, action: "interact" };
    }
    const station = target.station;
    const label = STATION_KIND_LABEL[station.spec.kind];
    if (station.onFire) return { prompt: t("kitchen.onFire"), action: "carry" };
    if (this.kitchen.canWork(station, held)) {
      const holdPrompt = station.spec.kind === "sink"
        ? t("kitchen.holdWash")
        : station.spec.kind === "mixer"
          ? t("kitchen.holdToMix")
          : t("kitchen.holdChop");
      return { prompt: holdPrompt, action: "carry" };
    }
    switch (station.spec.kind) {
      case "crate":
        return { prompt: held ? label : t("kitchen.pickUp", { item: describeItem({ kind: "food", uid: "", ingredientId: station.spec.ingredientId ?? "", state: "raw", chopProgress: 0, createdAt: 0 }, this.recipeList) }), action: "interact" };
      case "delivery":
        return { prompt: held?.kind === "plate" ? t("kitchen.deliverPlate") : label, action: "interact" };
      case "trash":
        return { prompt: held ? t("kitchen.throwAway") : label, action: "interact" };
      case "plate_rack":
        return { prompt: held ? t("kitchen.returnPlate") : t("kitchen.takePlate", { count: station.cleanPlates }), action: "interact" };
      case "sink":
        return { prompt: held ? t("kitchen.putInSink") : t("kitchen.takeCleanPlate"), action: "interact" };
      case "dirty_return":
        return { prompt: t("kitchen.dirtyPlates", { count: station.dirtyPlates }), action: "interact" };
      default:
        if (!held && station.item) return { prompt: t("kitchen.pickUp", { item: describeItem(station.item, this.recipeList) }), action: "interact" };
        if (held && station.item) {
          return { prompt: held.kind === "extinguisher" ? label : t("kitchen.combine"), action: "interact" };
        }
        if (held) return { prompt: t("kitchen.putOn", { station: label }), action: "interact" };
        return { prompt: label, action: "interact" };
    }
  }

  private notifyPlayer(slot: CoopPlayerState, message: string, tone: "info" | "success" | "warning" | "error"): void {
    const now = performance.now();
    if (now - slot.lastNotifyAt < NOTIFY_THROTTLE_MS) return;
    slot.lastNotifyAt = now;
    this.notify(t("kitchen.playerNotice", { player: slot.label, message }), tone, 1_600);
  }

  // -------------------------------------------------------------------------
  // Shift systems (unchanged gameplay rules)

  private handleOverlayInput(): void {
    if (!this.started || this.runtime.shiftEnded) return;
    // Any cook may pause: player two's keyboard has no pause key, but a phone or a
    // gamepad on that cook does.
    let pausePressed = false;
    let cookbookPressed = false;
    for (const slot of this.players) {
      if (slot.input.consumePressed("pause")) pausePressed = true;
      if (slot.input.consumePressed("cookbook")) cookbookPressed = true;
    }

    if (pausePressed) {
      if (this.cookbookOpen) {
        this.ui.toggleCookbook(false);
      } else {
        this.manualPaused = !this.manualPaused;
        this.syncPauseState();
      }
    }

    if (cookbookPressed) {
      this.ui.toggleCookbook();
    }
  }

  private updateAI(deltaSeconds: number): void {
    this.driftAccumulator += deltaSeconds;
    if (this.driftAccumulator < 1) return;

    const ticks = Math.floor(this.driftAccumulator);
    this.driftAccumulator -= ticks;
    // A backlog does not only show on CORE's face: it heats her up and destabilises her, so
    // a sustained queue walks temperature into the existing >80 critical on its own.
    const backlog = Math.max(0, this.activeOrderCount - 1);
    this.ai.applyEffects(
      {
        memory: -0.055 * ticks,
        stability: (-0.025 - 0.012 * backlog) * ticks,
        temperature: (0.065 + 0.03 * backlog) * ticks,
        energy: -0.08 * ticks,
      },
      1,
    );
    this.syncAIState();
  }

  private get activeOrderCount(): number {
    return this.runtime.activeOrders.filter((order) => order.status === "active").length;
  }

  /** Seconds left on the most urgent ticket, for guests deciding whether to complain. */
  private orderUrgencySeconds(): ReadonlyMap<string, number> {
    return this.director.urgencySeconds();
  }

  /**
   * CORE reacts to the queue filling up the same way she reacts to hunger: once per band,
   * on the way up only, leaving the expression ladder to restore itself afterwards.
   */
  /** Emits one `order:failed` per ticket ShiftSystem just failed at the buzzer. */
  private reportOrdersLostAtBuzzer(previous: readonly Order[]): void {
    const wasActive = new Set(
      previous.filter((order) => order.status === "active").map((order) => order.id),
    );
    for (const order of this.runtime.activeOrders) {
      if (order.status !== "failed" || !wasActive.has(order.id)) continue;
      this.eventBus.emit("order:failed", order);
      this.wedding.resolveOrder(order.id, false);
    }
    this.director.reset();
  }

  /**
   * Counts meltdowns: a fire that nobody put out in time.
   *
   * The field has always been in `ShiftResult` and on the results screen, and has always
   * read zero because nothing ever wrote it. A blaze left burning is the thing in this
   * kitchen that most deserves the name, so that is what it counts now — once per fire
   * that goes unanswered, not once per frame it burns.
   */
  private updateMeltdowns(burning: number, deltaSeconds: number): void {
    if (burning <= 0) {
      this.meltdownClock = 0;
      return;
    }
    this.meltdownClock += deltaSeconds;
    if (this.meltdownClock < MELTDOWN_SECONDS) return;
    this.meltdownClock = 0;
    this.runtime = { ...this.runtime, meltdowns: this.runtime.meltdowns + 1 };
  }

  /** Runs one frame of the order clock and cadence, then reacts to what it reports. */
  private updateOrders(deltaSeconds: number): void {
    this.applyOrders(
      this.director.tick({
        deltaSeconds,
        orders: this.runtime.activeOrders,
        shiftTimeRemaining: this.runtime.shiftTimeRemaining,
        shiftDuration: this.runtime.shiftDuration,
        now: Date.now(),
      }),
    );
  }

  /**
   * Writes the director's new queue into the runtime and turns its events into everything
   * that needs the world: sound, notifications, score and the guests.
   */
  private applyOrders(result: OrderDirectorResult): void {
    if (result.changed) {
      this.runtime = { ...this.runtime, activeOrders: result.orders };
    }
    for (const event of result.events) this.handleOrderEvent(event);
    if (result.changed) this.emitOrdersChanged();
  }

  private handleOrderEvent(event: OrderDirectorEvent): void {
    switch (event.kind) {
      case "created":
        this.eventBus.emit("order:created", event.order);
        break;
      case "expiring":
        this.eventBus.emit("order:expiring", {
          order: event.order,
          secondsRemaining: event.secondsRemaining,
        });
        this.speak("order:expiring");
        this.sfx.play("tick");
        break;
      case "failed": {
        this.wedding.resolveOrder(event.order.id, false);
        const lost = tipFailOrder();
        this.streak = lost.streak;
        this.runtime = {
          ...this.runtime,
          failedOrders: this.runtime.failedOrders + 1,
          score: Math.max(0, this.runtime.score - lost.penalty),
          combo: 0,
        };
        this.eventBus.emit("order:failed", event.order);
        this.notify(t("kitchen.lost"), "error");
        this.speak("order:failed");
        this.sfx.play("fail");
        // The punishment mode: every plate that goes unserved glitches the kitchen.
        this.punishment.punish();
        break;
      }
      case "removed":
        break;
    }
  }

  private updateCamera(deltaSeconds: number): void {
    const focus = this.cameraFocusRemaining > 0
      ? Math.min(0.42, this.cameraFocusRemaining / 2.5)
      : 0;
    if (this.cameraFocusRemaining > 0) {
      this.cameraFocusRemaining = Math.max(0, this.cameraFocusRemaining - deltaSeconds);
    }
    // A cook up in the saucer is not followed into the sky: the camera keeps to the
    // ones still in the kitchen (or, if every cook is up there, to where they were).
    const points = this.cameraPoints;
    points.length = 0;
    for (const slot of this.players) if (!slot.player.isAbducted) points.push(slot.player.position);
    if (points.length === 0) {
      for (const slot of this.players) {
        const ground = this.cameraGround[slot.index]!;
        ground.copyFrom(this.environment.playerSpawns[slot.index] ?? this.environment.playerSpawns[0]!);
        points.push(ground);
      }
    }
    this.camera.shake = this.reducedMotion?.matches ? 0 : this.shakeAmount;
    const snapshot = this.camera.updateGroup(deltaSeconds, points, this.cameraFocusTarget, focus);
    this.cameraDistance = snapshot.distance;
    this.cameraSplitAmount = snapshot.splitAmount;
    this.ui.setSplitScreen(snapshot.splitAmount, snapshot.distance);
  }

  private updateDebug(): void {
    if (!isDevelopmentMode() && !this.options.persistentState.settings.showDebug) {
      this.ui.updateDebug(null);
      return;
    }
    const target = this.players[0]!.target;
    const queued = this.runtime.activeOrders
      .filter((order) => order.status === "active")
      .map((order) => {
        const id = order.requestedRecipeId;
        return id ? this.recipes.getRecipe(id)?.shortName ?? id : "OBJETIVO";
      })
      .join(" · ");
    this.ui.updateDebug({
      fps: this.scene.getEngine().getFps(),
      playerPosition: this.players[0]!.player.position,
      carrying: this.players.map((slot) =>
        `${slot.label}: ${slot.held ? describeItem(slot.held, this.recipeList) : "empty"}`,
      ).join(" / "),
      character: this.players.map((slot) =>
        `${slot.label} ${slot.player.selectedCharacterId ?? "placeholder"}`,
      ).join(" / "),
      characterBounds: this.players[0]!.player.characterDebugBounds,
      characterAnimation: this.players.map((slot) =>
        `${slot.label}:${slot.player.characterAnimation}`,
      ).join(" / "),
      nearbyStation: target?.kind === "station" ? target.station.spec.id : target ? "floor" : null,
      orders: queued.length > 0 ? queued : null,
      aiState: this.runtime.aiState,
      shiftTimeRemaining: this.runtime.shiftTimeRemaining,
      score: this.runtime.score,
      cameraDistance: this.cameraDistance,
      splitAmount: this.cameraSplitAmount,
    });
  }

  private serveDish(slot: CoopPlayerState, dish: IngredientInstance, recipe: RecipeData): void {
    const now = Date.now();
    // Freshness runs on the pausable kitchen clock the food was stamped with, not wall time.
    const breakdown = this.quality.fromItem(dish, this.kitchenClockMs);
    const addressesCritical = this.recipeAddressesCriticalNeed(recipe.effects, this.runtime.aiState);
    const effectMultiplier = 0.65 + breakdown.total * 0.35;
    this.ai.applyEffects(recipe.effects, effectMultiplier);
    this.ai.applyEffects({ mood: breakdown.total >= 0.65 ? 8 : breakdown.total < 0.4 ? -10 : 1 });
    this.syncAIState();

    // Among the outstanding tickets asking for this recipe, close the one nearest its
    // deadline. See OrderQueue.selectServeTarget for why not the most valuable one.
    const target = selectServeTarget(this.runtime.activeOrders, recipe.id, now);
    const completedOrder = target ? this.orders.complete(target, now) : null;
    const matched = completedOrder?.status === "completed";

    // A dish nobody ordered scores nothing; only a real ticket has a deadline to score against.
    // The difficulty's payout scale: a harder map is worth more per dish.
    const baseAward = target
      ? Math.round(this.scores.calculateDishScore({
        order: target,
        quality: breakdown,
        servedAt: now,
        matchedOrder: matched,
        addressesCriticalNeed: addressesCritical,
      }) * this.tuning.rewardMultiplier)
      : 0;

    // Soonest-expiry matching always pays the smallest speed bonus of the candidates, so a
    // genuine last-second save is topped up rather than punished.
    const remainingFraction = target ? this.director.fractionRemaining(target.id) : null;
    const rescued = matched && remainingFraction !== null &&
      remainingFraction <= BALANCE.order.rescueThreshold;
    const rescueBonus = rescued ? BALANCE.order.rescueBonus : 0;

    // The dish is paid for above; serving it promptly and in a row is paid for here.
    const tip = serveTip(this.streak, {
      matchedOrder: matched,
      remainingFraction,
      nowMs: this.kitchenClockMs,
    });
    this.streak = tip.streak;
    const combo = tip.streak.streak;
    const awarded = baseAward + tip.total + rescueBonus;
    this.runtime = {
      ...this.runtime,
      score: Math.max(0, this.runtime.score + awarded),
      combo,
      maxCombo: Math.max(this.runtime.maxCombo, combo),
      servedDishes: [
        ...this.runtime.servedDishes,
        {
          recipeId: recipe.id,
          quality: breakdown.total,
          servedAt: now,
          matchedOrder: matched,
          scoreAwarded: awarded,
        },
      ],
    };
    this.eventBus.emit("dish:served", {
      dish,
      recipeId: recipe.id,
      quality: breakdown,
    });
    if (awarded !== 0) {
      this.eventBus.emit("score:changed", {
        score: this.runtime.score,
        delta: awarded,
        reason: matched ? "order completed" : "dish sampled",
      });
    }

    this.sfx.play(matched ? "serve" : "wrong");
    if (combo >= 2) this.sfx.play("combo");
    this.cameraFocusRemaining = 2.2;
    slot.player.setExpression(breakdown.total >= 0.65 ? "^_^" : ">_<");
    this.speakForQuality(breakdown.label);
    // The tip is its own number on screen: the plate's own worth and what the pair earned
    // for the way they served it are different things, and only one of them is a skill.
    if (tip.total > 0) this.ui.showTip(slot.index, tip.total, combo);
    this.notify(
      t("kitchen.served", { player: slot.label, dish: recipe.displayName, points: `${awarded >= 0 ? "+" : ""}${awarded}` }) +
        (combo >= 2 ? t("kitchen.servedCombo", { combo }) : "") +
        (rescued ? t("kitchen.servedRescue") : ""),
      matched ? "success" : "warning",
      4_200,
    );

    if (matched && completedOrder) {
      this.wedding.resolveOrder(completedOrder.id, true);
      this.runtime = {
        ...this.runtime,
        completedOrders: this.runtime.completedOrders + 1,
      };
      this.eventBus.emit("order:completed", { order: completedOrder, reward: awarded });
      this.notify(t("kitchen.delivered"), "success");
      if (rescued) this.speak("order:rescued");
      // Spawning is the scheduler's job now, so the queue is not refilled here.
      this.removeOrder(completedOrder.id);
    } else {
      this.notify(t("kitchen.wrongDish", { dish: recipe.shortName }), "warning");
    }
  }

  private createOrder(recipeId?: string): void {
    this.applyOrders(
      this.director.create(
        this.runtime.activeOrders,
        { now: Date.now(), shiftTimeRemaining: this.runtime.shiftTimeRemaining },
        recipeId,
      ),
    );
  }

  /** Drops an order from the queue and forgets its clock. */
  private removeOrder(orderId: string): void {
    this.applyOrders(this.director.remove(this.runtime.activeOrders, orderId));
  }

  private emitOrdersChanged(): void {
    this.eventBus.emit("orders:changed", {
      active: this.runtime.activeOrders,
      maxConcurrent: this.director.maxConcurrent(
        shiftProgress(this.runtime.shiftTimeRemaining, this.runtime.shiftDuration),
      ),
    });
  }

  /**
   * Re-stamps the deadlines against wall time without advancing any countdown, which is
   * what stops a pause from burning order time while still giving ScoreSystem honest
   * createdAt/expiresAt to derive its speed bonus from.
   */
  private syncOrderClocks(): void {
    if (this.runtime.activeOrders.length === 0) return;
    const next = this.director.syncClocks(this.runtime.activeOrders, Date.now());
    if (next !== this.runtime.activeOrders) this.runtime = { ...this.runtime, activeOrders: next };
  }

  private finishShift(): void {
    if (this.resultShown) return;
    this.resultShown = true;
    this.environment.stopCampusStorm();
    for (const slot of this.players) slot.input.enabled = false;
    for (const slot of this.players) {
      this.setStationKeyPrompt(slot, null);
    }
    const result = this.shifts.createResult(this.runtime, this.starThresholds);
    this.eventBus.emit("shift:ended", result);
    this.stopKitchenSounds();
    this.sfx.play(result.rank === "D" ? "lose" : "win");
    this.ui.showResults(result);
    this.options.onShiftComplete(result);
  }

  private syncAIState(): void {
    this.runtime = { ...this.runtime, aiState: this.ai.getState() };
    this.eventBus.emit("ai:stateChanged", this.runtime.aiState);
    const conditions = this.ai.getCriticalConditions();
    const activeKeys = new Set(conditions.map((condition) => condition.key));
    for (const key of this.activeCriticals) {
      if (!activeKeys.has(key)) this.activeCriticals.delete(key);
    }
    for (const condition of conditions) {
      if (this.activeCriticals.has(condition.key)) continue;
      this.activeCriticals.add(condition.key);
      this.eventBus.emit("ai:critical", { key: condition.key, message: condition.message });
      this.notify(condition.message, "warning");
      this.speak(condition.trigger);
    }
  }

  private syncPauseState(): void {
    const paused = this.manualPaused || this.cookbookOpen;
    this.runtime = { ...this.runtime, paused };
    this.wedding.setCeremonyPaused(paused);
    this.environment.campusStorm?.setPaused(paused);
    this.ui.setPausedVisible(this.manualPaused && !this.cookbookOpen);
    this.eventBus.emit("pause:changed", { paused });
  }

  private bindEvents(): void {
    this.eventBus.on("notification", ({ message, tone }) => this.ui.notify(message, tone));
    // The HUD keeps a card alive past its order so it can play an exit animation.
    this.eventBus.on("order:completed", ({ order }) => {
      this.ui.flagOrderOutcome(order.id, "delivered");
    });
    this.eventBus.on("order:failed", (order) => {
      this.ui.flagOrderOutcome(order.id, "expired");
    });
    this.eventBus.on("dialogue", ({ text, expression }) => {
      this.ui.showDialogue(text, expression);
    });
  }

  private notify(
    message: string,
    tone: "info" | "success" | "warning" | "error",
    duration?: number,
  ): void {
    if (duration === undefined) {
      this.eventBus.emit("notification", { message, tone });
    } else {
      this.ui.notify(message, tone, duration);
    }
  }

  private speak(trigger: string): void {
    const line = this.dialogue.select(
      trigger,
      this.options.persistentState.chapter,
      this.spokenDialogueIds,
    );
    if (!line) return;
    this.spokenDialogueIds.add(line.id);
    this.eventBus.emit("dialogue", { text: line.text, expression: line.expression });
  }

  private speakForQuality(label: Parameters<DialogueSystem["selectForQuality"]>[0]): void {
    const line = this.dialogue.selectForQuality(
      label,
      this.options.persistentState.chapter,
      this.spokenDialogueIds,
    );
    if (!line) return;
    this.spokenDialogueIds.add(line.id);
    this.eventBus.emit("dialogue", { text: line.text, expression: line.expression });
  }

  private endInputFrame(): void {
    for (const slot of this.players) slot.input.endFrame();
  }

  private recipeAddressesCriticalNeed(
    effects: Partial<Record<AIStateKey, number>>,
    state: AIState,
  ): boolean {
    return (
      (state.memory < 25 && (effects.memory ?? 0) > 0) ||
      (state.energy < 20 && (effects.energy ?? 0) > 0) ||
      (state.stability < 30 && (effects.stability ?? 0) > 0) ||
      (state.temperature > 80 && (effects.temperature ?? 0) < 0)
    );
  }
}

const toStationSpec = (placement: KitchenStationPlacement, index: number): StationSpec => ({
  id: `${placement.kind}:${index}`,
  kind: placement.kind,
  x: placement.x,
  y: placement.y ?? 0,
  z: placement.z,
  rotationY: placement.rotationY,
  ingredientId: placement.ingredientId,
  initialItem: placement.initial === "extinguisher"
    ? createExtinguisher
    : placement.initial
      ? () => createCookware(placement.initial as CookwareKind)
      : undefined,
});

const ITEM_MASS: Readonly<Record<string, number>> = {
  ram_module: 0.7,
  binary_sugar: 0.4,
  cache_cream: 0.6,
  cache_fragment: 0.5,
  cooling_fluid: 0.7,
  data_cream: 0.6,
};

const estimateItemMass = (ingredientId: string): number =>
  ITEM_MASS[ingredientId] ?? 0.5;
