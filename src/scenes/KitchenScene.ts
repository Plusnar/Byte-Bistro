import { INGREDIENT_ASSETS } from "../data/ingredientAssets";
import { libraryModelsFor } from "../data/assetLibrary";
import { WEDDING_BANNER, WEDDING_HALL_ASSET_IDS } from "./weddingHall";
import { nextFrame, runSliced } from "../core/assets/MainThreadQueue";
import {
  Color3,
  GlowLayer,
  Scene,
  Vector3,
  type Engine,
  type Mesh,
} from "@babylonjs/core";
import { GAME_CONFIG, isDevelopmentMode } from "../config";
import { AssetManager } from "../core/AssetManager";
import { AudioManager } from "../core/AudioManager";
import { EventBus } from "../core/EventBus";
import { createInitialRuntimeState } from "../core/GameState";
import {
  InputManager,
  PLAYER_ONE_BINDINGS,
  PLAYER_TWO_BINDINGS,
} from "../core/InputManager";
import type { ManagedScene } from "../core/SceneManager";
import {
  CHARACTER_ANIMATION_ASSETS,
  CHARACTERS,
  RECIPES,
  SCENARIO_ASSETS,
  createIngredient,
  getCharacter,
} from "../data";
import {
  KITCHEN_ASSETS,
  KITCHEN_TILE,
  STATION_KIND_LABEL,
  getFoodDefinition,
} from "../data/kitchen";
import type { KitchenStationPlacement } from "../data/kitchenLayout";
import { Player } from "../entities";
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
  getCookwareProgress,
  isCookware,
  isCookwareBurnt,
  isCookwareCooked,
  findMatchingRecipe,
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
import {
  maxConcurrentOrders,
  nextSpawnRecipeId,
  selectServeTarget,
  sortByUrgency,
  spawnIntervalSeconds,
} from "../systems/OrderQueue";
import { BALANCE } from "../data/balance";
import { recipeOrderDurationMs } from "../data/recipeTiming";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "../data/difficulty";
import type { GameEvents } from "../types/events";
import type {
  AIState,
  AIStateKey,
  IngredientInstance,
  Order,
  PersistentGameState,
  RecipeData,
  RuntimeGameState,
  ShiftResult,
} from "../types/game";
import type { GameUI, OrderTicketInfo, StationProgressInfo } from "../ui/GameUI";
import type { MapData } from "../editor/MapData";
import { KitchenEnvironment, robotsFromMap } from "./KitchenEnvironment";
import { WEDDING_SCENARIO, type ScenarioDefinition } from "../data/scenarios";
import { CoopCameraController } from "./CoopCameraController";
import { WeddingGuests, MANNEQUIN } from "../systems/WeddingGuests";

type PlayerIndex = 0 | 1;

const PLAYER_COLORS: readonly [string, string] = ["#74F4FF", "#FFD166"];
const PLAYER_HIGHLIGHT_COLORS: readonly [Color3, Color3] = [
  Color3.FromHexString(PLAYER_COLORS[0]),
  Color3.FromHexString(PLAYER_COLORS[1]),
];

const THROW_GRAVITY = 18;
const THROW_RESTITUTION = 0.42;
const THROW_FRICTION = 0.86;
const THROW_ANGULAR_DAMPING = 0.94;
const THROW_IMPACT_RADIUS = 1.05;
const THROW_LAUNCH_SPEED = 9.5;
const THROW_VERTICAL_KICK = 3.2;
/** How far ahead of the player the "tile in front" probe sits. */
const REACH_PROBE = 0.85;
/** Max distance from the probe to a station centre for it to be targetable. */
const STATION_REACH = KITCHEN_TILE * 0.8;
const FLOOR_REACH = 0.8;
const EXTINGUISHER_REACH = 2.6;
const NOTIFY_THROTTLE_MS = 900;
/** How often the task guide and order cards are rebuilt. */
const HUD_REFRESH_SECONDS = 1 / 12;
/** Drift below this is not worth re-allocating the order queue for. */
const CLOCK_RESTAMP_TOLERANCE_MS = 250;
/** Kept low so the bloom does not wash out speech bubbles and HUD billboards. */
const GLOW_BASE_INTENSITY = 0.34;

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
}

type KitchenTarget =
  | { readonly kind: "station"; readonly station: Workstation; readonly view: WorkstationView }
  | { readonly kind: "floor"; readonly entry: FloorItem };

/** A single order's countdown. `remaining` is the authority; `expiresAt` is derived from it. */
interface OrderClock {
  remaining: number;
  duration: number;
  /** Latches the one-shot `order:expiring` warning. */
  warned: boolean;
}

interface CoopPlayerState {
  readonly index: PlayerIndex;
  readonly label: "P1" | "P2";
  readonly input: InputManager;
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
  lastNotifyAt: number;
}

export interface KitchenSceneOptions {
  readonly shiftDuration: number;
  readonly persistentState: PersistentGameState;
  readonly onShiftComplete: (result: ShiftResult) => void;
  readonly map?: MapData;
  /** Difficulty profile for this shift. Defaults to the standard balance. */
  readonly tuning?: DifficultyTuning;
  /** Lighting, menu and reception rules. Defaults to the wedding. */
  readonly scenario?: ScenarioDefinition;
}

const NO_WORK: WorkOutcome = { kind: "none" };

export class KitchenScene implements ManagedScene {
  readonly scene: Scene;

  private readonly camera: CoopCameraController;
  private readonly cameraFocusTarget = new Vector3(0, 2.2, 6.3);
  private readonly environment: KitchenEnvironment;
  private readonly wedding: WeddingGuests;
  private readonly players: readonly [CoopPlayerState, CoopPlayerState];
  private readonly eventBus = new EventBus<GameEvents>();
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
  private readonly floorItems: FloorItem[] = [];
  private readonly spokenDialogueIds = new Set<string>();
  private readonly activeCriticals = new Set<AIStateKey>();
  private readonly assets: AssetManager;
  private readonly audio: AudioManager;
  private readonly glow: GlowLayer;
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
  /** Per-order countdowns, keyed by order id. The authority over `expiresAt`. */
  private readonly orderClocks = new Map<string, OrderClock>();
  /** Difficulty profile for this shift; injected, never read from a global. */
  private readonly tuning: DifficultyTuning;
  /** This scenario's menu. Orders, the cookbook and the plating checks all read it. */
  private readonly recipeList: readonly RecipeData[];
  private readonly scenario: ScenarioDefinition;
  private spawnTimer = 0;
  private hudAccumulator = HUD_REFRESH_SECONDS;
  private lastQueueGuide: QueueGuideResult | null = null;
  private driftAccumulator = 0;
  private cameraFocusRemaining = 0;
  private cameraDistance = 0;
  private cameraSplitAmount = 0;

  constructor(
    engine: Engine,
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
    this.scene = new Scene(engine);
    this.scene.fogMode = Scene.FOGMODE_EXP2;
    this.fogBaseDensity = options.map?.environment.fogDensity ?? 0.008;
    this.scene.fogDensity = this.fogBaseDensity;
    this.scene.fogColor = Color3.FromHexString(options.map?.environment.fog ?? "#06101A");
    this.scene.skipPointerMovePicking = true;

    const kitchenAssetIds = new Set(KITCHEN_ASSETS.map((asset) => asset.id));
    this.assets = new AssetManager(this.scene, [
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
      ...SCENARIO_ASSETS,
      ...INGREDIENT_ASSETS,
      ...KITCHEN_ASSETS,
      // Custom maps may reuse kitchen models as decor; register those only once. The main
      // level is decorated with the wedding hall's own models.
      ...libraryModelsFor(options.map?.objects.map((object) => object.assetId) ?? WEDDING_HALL_ASSET_IDS)
        .filter((asset) => !kitchenAssetIds.has(asset.id)),
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
    );
    const movementRotation = Math.atan2(
      -GAME_CONFIG.camera.offsetX,
      -GAME_CONFIG.camera.offsetZ,
    );
    const createPlayer = (
      index: PlayerIndex,
      label: "P1" | "P2",
      input: InputManager,
    ): CoopPlayerState => ({
      index,
      label,
      input,
      player: new Player(this.scene, {
        spawnPosition: this.environment.playerSpawns[index].clone(),
        walkSpeed: GAME_CONFIG.player.walkSpeed,
        runSpeed: GAME_CONFIG.player.walkSpeed * GAME_CONFIG.player.runMultiplier,
        movementRotation,
        assetManager: this.assets,
      }),
      held: null,
      target: null,
      highlighted: null,
      keyPromptView: null,
      focusedOrderId: null,
      work: NO_WORK,
      workStation: null,
      lastNotifyAt: 0,
    });
    this.players = [
      createPlayer(0, "P1", new InputManager(window, PLAYER_ONE_BINDINGS)),
      createPlayer(1, "P2", new InputManager(window, PLAYER_TWO_BINDINGS)),
    ];

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

    this.audio = new AudioManager(this.scene);
    this.audio.setMasterVolume(options.persistentState.settings.masterVolume);

    this.kitchen = new KitchenModel(
      this.environment.kitchenStations.map((placement, index) => toStationSpec(placement, index)),
      this.recipeList,
    );
    this.workstationResources = new WorkstationResources(this.scene, PLAYER_HIGHLIGHT_COLORS);
    this.itemViews = new KitchenItemViews(this.scene, this.assets, this.recipeList);

    this.ai = new AIStateSystem(createInitialRuntimeState(options.shiftDuration).aiState);
    this.runtime = createInitialRuntimeState(options.shiftDuration);
    this.bindEvents();
    for (const slot of this.players) slot.input.enabled = false;
    this.ui.update(this.runtime);
    this.ui.setRecipes(this.recipeList);
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
      for (const mesh of this.environment.nonGlowingDecor()) this.glow.addExcludedMesh(mesh as Mesh);
      performance.mark("bb:kitchen-assets-loaded");
      // Station models instantiate synchronously from the preloaded containers — sliced
      // across frames, because this runs while the players are still in the menu.
      await this.createStationViews();
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
  selectCharacters(characterIds: readonly [string, string]): Promise<void> {
    const key = characterIds.join("|");
    if (this.selection?.key !== key) {
      const promise = Promise.all([
        this.prepareInBackground(),
        ...characterIds.map(async (characterId, index) => {
          const character = getCharacter(characterId);
          if (!character) throw new Error(`Unknown character: ${characterId}`);
          await this.players[index as PlayerIndex].player.selectCharacter(character.id);
        }),
      ]).then(() => { this.selectedKey = key; });
      const selection = { key, promise };
      this.selection = selection;
      // A failed attempt must not be cached: Start retries by asking again.
      promise.catch(() => { if (this.selection === selection) this.selection = null; });
    }
    return this.selection!.promise;
  }

  /** True when a shift with these cooks could start without loading anything. */
  isReadyFor(characterIds: readonly string[]): boolean {
    return this.prepared && this.selectedKey === characterIds.join("|");
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
    this.resultShown = false;
    this.manualPaused = false;
    if (this.cookbookOpen) this.ui.toggleCookbook(false);
    this.cookbookOpen = false;
    this.syncPauseState();
    this.ui.hideResults();
    this.ui.setPausedVisible(false);
    this.ui.setStationProgress(null);
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
    this.handleOverlayInput();

    if (!this.started || this.runtime.shiftEnded || this.runtime.paused) {
      // Re-stamping the deadlines against wall time while paused is what stops a pause from
      // burning order time.
      this.syncOrderClocks();
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
    if (previousTimeRemaining > 0 && this.runtime.shiftEnded) {
      // ShiftSystem has no EventBus, so the orders it just failed are diffed out here.
      this.reportOrdersLostAtBuzzer(previousOrders);
      this.finishShift();
      this.updateCamera(delta);
      this.ui.update(this.runtime);
      this.updateDebug();
      this.endInputFrame();
      return;
    }

    this.kitchenClockMs += delta * 1_000;
    this.updateOrders(delta);
    this.wedding.syncOrders(this.runtime.activeOrders, this.orderUrgencySeconds());
    this.wedding.update(delta);
    for (const slot of this.players) {
      slot.player.update(delta, slot.input, this.environment.bounds);
      this.updateTarget(slot);
      this.handleGameplayInput(slot, delta);
    }
    this.kitchen.update(delta);
    this.handleKitchenEvents(this.kitchen.takeEvents());
    this.updateFloorItems(delta);
    this.updateAI(delta);
    this.gameEvents.update(Date.now());

    // The task guide and the order cards are O(orders x components x world items) and none
    // of what they show changes meaningfully between frames, so they run at ~12Hz instead
    // of 60. The time bars move slowly enough that the stepping is invisible.
    this.hudAccumulator += delta;
    if (this.hudAccumulator >= HUD_REFRESH_SECONDS) {
      this.hudAccumulator = 0;
      this.updateGuide();
      this.updateHUD();
    }

    this.updateCamera(delta);
    this.syncKitchenVisuals(delta);
    this.ui.update(this.runtime);
    this.updateDebug();
    this.endInputFrame();
  }

  dispose(): void {
    this.disposed = true;
    this.wedding.dispose();
    for (const slot of this.players) {
      slot.input.dispose();
      slot.held = null;
      slot.player.dispose();
    }
    this.floorItems.length = 0;
    this.itemViews.dispose();
    for (const view of this.stationViews.values()) view.dispose();
    this.stationViews.clear();
    this.workstationResources.dispose();
    this.camera.dispose();
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
      slot.keyPromptView?.setKeyPrompt(null);
      slot.keyPromptView = null;
      this.setTarget(slot, null);
    }
    this.floorItems.length = 0;
    this.kitchen.reset();
    this.players[0].player.teleport(this.environment.playerSpawns[0]);
    this.players[1].player.teleport(this.environment.playerSpawns[1]);
    for (const slot of this.players) slot.player.setExpression("^_^");
    this.runtime = this.shifts.start(
      createInitialRuntimeState(this.options.shiftDuration),
      this.options.shiftDuration,
    );
    this.ai = new AIStateSystem(this.runtime.aiState);
    this.orderClocks.clear();
    this.driftAccumulator = 0;
    this.cameraFocusRemaining = 0;
    for (const slot of this.players) slot.focusedOrderId = null;
    this.scene.fogDensity = this.fogBaseDensity;
    this.glow.intensity = GLOW_BASE_INTENSITY;
    this.spokenDialogueIds.clear();
    this.activeCriticals.clear();
    for (const slot of this.players) slot.input.enabled = true;
    this.wedding.reset();
    // The cheapest recipe opens the shift as a tutorial ticket; the scheduler takes over.
    // Taken from this scenario's own menu: an id outside it would make OrderSystem throw
    // inside startShift for any scenario that does not serve gelato.
    const opener = this.recipeList.find((recipe) => recipe.id === "cooling_gelato")
      ?? this.recipeList.reduce<RecipeData | undefined>(
        (cheapest, recipe) => (!cheapest || recipe.reward < cheapest.reward ? recipe : cheapest),
        undefined,
      );
    this.createOrder(opener?.id);
    this.spawnTimer = spawnIntervalSeconds(0, this.tuning);
    this.speak("shift:start");
    this.eventBus.emit("shift:started", { duration: this.options.shiftDuration });
    this.notify("CASAMENTO CHATGPT + GEMINI // Corte, cozinhe, monte e entregue os pratos", "info", 6000);
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
    for (const [station, view] of this.stationViews) {
      const dx = station.spec.x - this.probe.x;
      const dz = station.spec.z - this.probe.z;
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance < STATION_REACH && distance < bestDistance) {
        best = { kind: "station", station, view };
        bestDistance = distance;
      }
    }
    for (const entry of this.floorItems) {
      if (entry.airborne) continue;
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
      return;
    }
    if (slot.input.consumePressed("interact")) this.handleGrab(slot);

    const actionPressed = slot.input.consumePressed("carry");
    if (actionPressed && slot.held?.kind === "food") {
      this.throwHeldItem(slot);
      slot.work = NO_WORK;
      return;
    }
    if (actionPressed && slot.held && slot.held.kind !== "extinguisher") {
      this.notifyPlayer(slot, "Só ingredientes podem ser arremessados", "info");
    }

    slot.work = NO_WORK;
    slot.workStation = null;
    if (!slot.input.isDown("carry")) return;
    const station = slot.held?.kind === "extinguisher"
      ? this.findSprayTarget(slot)
      : slot.target?.kind === "station" ? slot.target.station : null;
    if (!station) return;
    slot.work = this.kitchen.work(station, slot.held, deltaSeconds);
    if (slot.work.kind !== "none") slot.workStation = station;
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
      if (outcome.kind === "deliver") {
        slot.held = null;
        slot.player.playThrowGesture();
        this.deliverPlate(slot, outcome.plate, outcome.recipe);
        return;
      }
      const pickedUp = !slot.held && outcome.held;
      // Something left the hands: into a machine, onto a counter, or swapped.
      if (slot.held && slot.held !== outcome.held) slot.player.playThrowGesture();
      slot.held = outcome.held;
      this.audio.play(pickedUp ? "ingredient:pickup" : "station:insert");
      if (outcome.message) this.notifyPlayer(slot, outcome.message, "info");
      slot.player.setExpression(slot.held ? "O_O" : "^_^");
      return;
    }

    if (target?.kind === "floor") {
      const entry = target.entry;
      if (!slot.held) {
        this.removeFloorItem(entry);
        slot.held = entry.item;
        this.audio.play("ingredient:pickup");
        return;
      }
      const combined = combineItems(slot.held, entry.item);
      if (combined) {
        slot.held = combined.held;
        if (!combined.target) this.removeFloorItem(entry);
        this.audio.play("station:insert");
      } else {
        this.notifyPlayer(slot, "Mãos ocupadas", "info");
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
        (station.spec.x - aimed.spec.x) ** 2 + (station.spec.z - aimed.spec.z) ** 2 <= reach * reach);
      if (covers) return aimed;
    }
    let best: Workstation | null = null;
    let bestDistance = EXTINGUISHER_REACH;
    for (const station of this.kitchen.stations) {
      if (!station.onFire) continue;
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
          this.audio.play("station:complete");
          break;
        case "washed":
          this.audio.play("station:insert");
          break;
        case "cook":
          if (event.event === "cooked") {
            this.audio.play("station:complete");
            this.notify("Comida pronta no fogão! Tire antes de queimar", "success", 2200);
          } else if (event.event === "burnt") {
            this.notify("QUEIMOU! Jogue fora no lixo", "error", 2600);
          }
          break;
        case "fire":
          this.notify("FOGO NA COZINHA! Use o extintor (segure a ação)", "error", 3500);
          break;
        case "extinguished":
          this.notify("Fogo apagado", "success", 1800);
          break;
        case "dirtyReturned":
          break;
      }
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

  private throwHeldItem(slot: CoopPlayerState): void {
    const item = slot.held;
    if (!item) return;
    slot.player.playThrowGesture();
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
    const launchSpeed = THROW_LAUNCH_SPEED + Math.random() * 1.2;
    entry.velocity.set(forwardX * launchSpeed, THROW_VERTICAL_KICK, forwardZ * launchSpeed);
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
      if (!entry || !entry.airborne) continue;
      const { position, velocity } = entry;
      entry.previous.copyFrom(position);
      velocity.y -= THROW_GRAVITY * deltaSeconds;
      position.x += velocity.x * deltaSeconds;
      position.y += velocity.y * deltaSeconds;
      position.z += velocity.z * deltaSeconds;
      entry.rotation.addInPlace(entry.angularVelocity.scale(deltaSeconds));
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

      const station = this.stationAt(position.x, position.z);
      if (station) {
        const top = this.stationViews.get(station)?.topHeight ?? 0.9;
        if (position.y <= top + 0.05) {
          if (entry.previous.y >= top - 0.05 && this.kitchen.land(station, entry.item)) {
            this.floorItems.splice(index, 1);
            this.audio.play("station:insert");
            continue;
          }
          // Hit the side of the station: bounce back the way it came.
          position.x = entry.previous.x;
          position.z = entry.previous.z;
          velocity.x *= -0.35;
          velocity.z *= -0.35;
          entry.bounces += 1;
          if (position.y < top) {
            position.y = Math.max(position.y, 0);
          }
        }
      }

      if (entry.item.kind === "food") {
        const target = this.findPlayerImpactTarget(position, entry.thrownBy, velocity.length());
        if (target) {
          this.applyPlayerHit(entry, target);
          continue;
        }
      }

      if (position.y <= 0) {
        position.y = 0;
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

  private stationAt(x: number, z: number): Workstation | null {
    const half = KITCHEN_TILE * 0.5;
    for (const station of this.kitchen.stations) {
      if (Math.abs(station.spec.x - x) < half && Math.abs(station.spec.z - z) < half) return station;
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
      const station = this.stationAt(position.x, position.z);
      if (!station) return;
      const candidates = [
        { x: station.spec.x + push, z: position.z },
        { x: station.spec.x - push, z: position.z },
        { x: position.x, z: station.spec.z + push },
        { x: position.x, z: station.spec.z - push },
      ].filter((candidate) => inBounds(candidate.x, candidate.z));
      if (candidates.length === 0) return;
      const distance = (candidate: { x: number; z: number }): number =>
        (candidate.x - position.x) ** 2 + (candidate.z - position.z) ** 2;
      // A free spot wins; failing that, step to the nearest side and try again from there.
      const free = candidates.filter((candidate) => !this.stationAt(candidate.x, candidate.z));
      const pool = free.length > 0 ? free : candidates;
      const best = pool.reduce((a, b) => (distance(b) < distance(a) ? b : a));
      position.x = best.x;
      position.z = best.z;
      if (free.length > 0) return;
    }
  }

  // TODO(swept-impact): this tests only the projectile's current position, so a fast item
  // can tunnel past a player between frames. Fix is a segment-vs-capsule test using
  // `entry.previous`. Low priority now that a hit is a short slide, not a launch.
  private findPlayerImpactTarget(
    position: Vector3,
    thrownBy: PlayerIndex | null,
    projectileSpeed: number,
  ): CoopPlayerState | null {
    if (projectileSpeed <= 1.2) return null;
    let best: CoopPlayerState | null = null;
    let bestDistance = THROW_IMPACT_RADIUS;
    for (const slot of this.players) {
      if (slot.index === thrownBy || slot.player.isDowned()) continue;
      const dx = slot.player.position.x - position.x;
      const dy = slot.player.position.y + 0.9 - position.y;
      const dz = slot.player.position.z - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = slot;
      }
    }
    return best;
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

    const carried = target.held;
    if (carried) {
      const anchor = target.player.carryAnchor.getAbsolutePosition();
      const scattered = this.addFloorItem(carried, anchor.x, anchor.y, anchor.z, target.index, true);
      // Drops near the victim rather than flying across the kitchen.
      scattered.velocity.set(hx * 2.2, 1.8, hz * 2.2);
      scattered.angularVelocity.set(
        (Math.random() - 0.5) * 12,
        (Math.random() - 0.5) * 6,
        (Math.random() - 0.5) * 12,
      );
      target.held = null;
    }
    this.audio.play("station:complete");
    this.notify(`${target.label} FOI ATINGIDO!`, "warning", 2_000);
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
    }
    for (const entry of this.floorItems) {
      const root = this.itemViews.place(entry.item, null);
      root.position.copyFrom(entry.position);
      root.rotation.copyFrom(entry.rotation);
    }
    this.itemViews.endFrame();
  }

  private stationViewState(station: Workstation): WorkstationViewState {
    const item = station.item;
    let progress: number | null = null;
    let tone: WorkstationViewState["tone"] = "work";
    let warning = false;
    const chopping = this.players.some(
      (slot) => slot.workStation === station && slot.work.kind === "chopping",
    );

    if (station.spec.kind === "cutting_board" && item?.kind === "food" && item.chopProgress > 0) {
      progress = item.chopProgress;
    } else if (station.spec.kind === "sink" && station.washProgress > 0) {
      progress = station.washProgress;
    } else if (station.spec.kind === "stove" && isCookware(item) && item.contents.length > 0) {
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
    };
  }

  // -------------------------------------------------------------------------
  // Orders, delivery and guidance

  private deliverPlate(slot: CoopPlayerState, plate: PlateItem, recipe: RecipeData): void {
    const createdAt = plate.contents.reduce(
      (oldest, food) => Math.min(oldest, food.createdAt),
      this.kitchenClockMs,
    );
    const dish = createIngredient(recipe.finalItemId, { createdAt, presentation: 0.9 });
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
        secondsRemaining: this.orderClocks.get(order.id)?.remaining ?? 0,
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
      const wanted = held.state === "raw" && definition?.chop
        ? "cutting_board"
        : definition?.cook && held.state !== "cooked"
          ? "stove"
          : "plate_rack";
      const match = this.preferFocused(slot, free.filter((task) => task.stationKind === wanted));
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
      if (station.item) locations.push({ item: station.item, holder: null });
    }
    for (const slot of this.players) {
      if (slot.held) locations.push({ item: slot.held, holder: slot.index });
    }
    for (const entry of this.floorItems) locations.push({ item: entry.item, holder: null });
    return locations;
  }

  // -------------------------------------------------------------------------
  // HUD

  private updateHUD(): void {
    this.ui.setOrderTickets(
      this.buildOrderTickets(),
      this.wedding.guests.filter((g) => g.active).length,
    );
    for (const slot of this.players) {
      const action = this.describeAction(slot);
      const downed = slot.player.isDowned();
      // Standing up is automatic now, so a downed player has no key to press.
      const prompt = downed ? "Atordoado…" : action.prompt;
      const key = (downed ? null : slot.input.labelFor(action.action)) ?? "—";
      this.ui.setPlayerStatus(slot.index, {
        prompt,
        key,
        carrying: slot.held ? describeItem(slot.held, this.recipeList) : null,
        // What this item still needs, read off the live recipe plan.
        nextStep: downed ? null : this.describeHeldNextStep(slot),
      });
      this.setStationKeyPrompt(slot, downed ? null : action);
    }
    this.ui.setStationProgress(this.getStationProgress());
  }

  /** Derives the HUD's ticket rows; the scene owns the clocks, guests and assignments. */
  private buildOrderTickets(): OrderTicketInfo[] {
    const guestByOrder = new Map(
      this.wedding.ticketedGuests.map((entry) => [entry.orderId, entry.guest.name]),
    );
    const guide = this.lastQueueGuide;
    return this.runtime.activeOrders
      .filter((order) => order.status === "active")
      .map((order) => {
        const clock = this.orderClocks.get(order.id);
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
          title: recipe?.displayName ?? "PEDIDO ESPECIAL",
          guestName: guestByOrder.get(order.id) ?? null,
          secondsRemaining: clock?.remaining ?? 0,
          totalSeconds: clock?.duration ?? 0,
          reward: order.reward,
          stepsCompleted: steps?.completed ?? 0,
          // No "+1 for delivery": stepsCompleted counts plated components and could never
          // reach it, so every finished order used to read N/N+1 forever.
          stepsTotal: steps?.total ?? recipe?.components.length ?? 0,
          readyToDeliver: components.length > 0 && components.every((c) => c.stage === "plated"),
          components,
          assignedTo: assigned?.index ?? null,
        };
      });
  }

  /**
   * What the held item still needs before it can be plated — "Cortar", "Cozinhar",
   * "Montar no prato" — so the player is told the next step by the thing in their hands
   * rather than by a separate checklist.
   */
  private describeHeldNextStep(slot: CoopPlayerState): string | null {
    const held = slot.held;
    if (!held) return null;

    if (held.kind === "plate") {
      if (held.dirty) return "Levar à pia";
      if (held.contents.length === 0) return "Montar o prato";
      return findMatchingRecipe(held.contents, this.recipeList) ? "Entregar o prato" : "Montar o prato";
    }
    if (isCookware(held)) {
      if (isCookwareBurnt(held)) return "Queimou — jogar no lixo";
      if (held.contents.length === 0) return "Levar ao fogão";
      return isCookwareCooked(held) ? "Despejar no prato" : "Levar ao fogão";
    }
    if (held.kind !== "food") return null;

    const definition = getFoodDefinition(held.ingredientId);
    if (!definition) return null;
    if (held.state === "burnt") return "Queimou — jogar no lixo";
    if (definition.chop && held.state === "raw") return "Cortar na tábua";
    if (definition.cook && held.state !== "cooked") return "Cozinhar no fogão";
    return "Montar no prato";
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
      return { prompt: "Segure para apagar o fogo", action: "carry" };
    }
    if (target?.kind === "floor") {
      return { prompt: held ? "Combinar" : `Pegar ${describeItem(target.entry.item, this.recipeList)}`, action: "interact" };
    }
    if (target?.kind !== "station") {
      // Nothing in reach: no prompt, because there is nowhere to put anything down.
      return { prompt: null, action: "interact" };
    }
    const station = target.station;
    const label = STATION_KIND_LABEL[station.spec.kind];
    if (station.onFire) return { prompt: "Em chamas! Use o extintor", action: "carry" };
    if (this.kitchen.canWork(station, held)) {
      return { prompt: station.spec.kind === "sink" ? "Segure para lavar" : "Segure para cortar", action: "carry" };
    }
    switch (station.spec.kind) {
      case "crate":
        return { prompt: held ? label : `Pegar ${describeItem({ kind: "food", uid: "", ingredientId: station.spec.ingredientId ?? "", state: "raw", chopProgress: 0, createdAt: 0 }, this.recipeList)}`, action: "interact" };
      case "delivery":
        return { prompt: held?.kind === "plate" ? "Entregar prato" : label, action: "interact" };
      case "trash":
        return { prompt: held ? "Jogar fora" : label, action: "interact" };
      case "plate_rack":
        return { prompt: held ? "Devolver prato" : `Pegar prato (${station.cleanPlates})`, action: "interact" };
      case "sink":
        return { prompt: held ? "Colocar na pia" : "Pegar prato limpo", action: "interact" };
      case "dirty_return":
        return { prompt: `Pratos sujos (${station.dirtyPlates})`, action: "interact" };
      default:
        if (!held && station.item) return { prompt: `Pegar ${describeItem(station.item, this.recipeList)}`, action: "interact" };
        if (held && station.item) {
          return { prompt: held.kind === "extinguisher" ? label : "Combinar", action: "interact" };
        }
        if (held) return { prompt: `Colocar: ${label}`, action: "interact" };
        return { prompt: label, action: "interact" };
    }
  }

  private getStationProgress(): StationProgressInfo | null {
    for (const slot of this.players) {
      const target = slot.target;
      if (target?.kind !== "station") continue;
      const station = target.station;
      const state = this.stationViewState(station);
      if (state.progress === null && !station.onFire) continue;
      const label = STATION_KIND_LABEL[station.spec.kind].toUpperCase();
      if (station.onFire) {
        return { label, progress: 1 - station.fireHealth, status: "FOGO", detail: "Use o extintor", tone: "danger" };
      }
      const progress = state.progress ?? 0;
      if (state.tone === "burn") {
        return { label, progress, status: "PRONTO", detail: "Tire do fogo antes de queimar!", tone: "warning" };
      }
      return {
        label,
        progress,
        status: state.tone === "cook" ? "COZINHANDO" : "TRABALHANDO",
        detail: `${Math.round(progress * 100)}%`,
        tone: "active",
      };
    }
    return null;
  }

  private notifyPlayer(slot: CoopPlayerState, message: string, tone: "info" | "success" | "warning" | "error"): void {
    const now = performance.now();
    if (now - slot.lastNotifyAt < NOTIFY_THROTTLE_MS) return;
    slot.lastNotifyAt = now;
    this.notify(`${slot.label} // ${message}`, tone, 1_600);
  }

  // -------------------------------------------------------------------------
  // Shift systems (unchanged gameplay rules)

  private handleOverlayInput(): void {
    if (!this.started || this.runtime.shiftEnded) return;
    const input = this.players[0].input;

    if (input.consumePressed("pause")) {
      if (this.cookbookOpen) {
        this.ui.toggleCookbook(false);
      } else {
        this.manualPaused = !this.manualPaused;
        this.syncPauseState();
      }
    }

    if (input.consumePressed("cookbook")) {
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
    const map = new Map<string, number>();
    for (const [id, clock] of this.orderClocks) map.set(id, clock.remaining);
    return map;
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
    this.orderClocks.clear();
  }

  private updateOrders(deltaSeconds: number): void {
    // Expired ids are collected first: failOrder mutates activeOrders.
    const expired: string[] = [];
    for (const order of this.runtime.activeOrders) {
      if (order.status !== "active") continue;
      const clock = this.orderClocks.get(order.id);
      if (!clock) continue;
      clock.remaining = Math.max(0, clock.remaining - deltaSeconds);
      if (clock.remaining <= 0) {
        expired.push(order.id);
        continue;
      }
      if (!clock.warned && clock.remaining <= BALANCE.order.expiringWarningSeconds) {
        clock.warned = true;
        this.eventBus.emit("order:expiring", { order, secondsRemaining: clock.remaining });
        this.speak("order:expiring");
      }
    }
    this.syncOrderClocks();
    for (const id of expired) this.failOrder(id);
    this.updateOrderSpawning(deltaSeconds);
  }

  /**
   * Spawns tickets on a cadence instead of one-in-one-out, which is what lets orders pile
   * up. The timer holds at the cap rather than banking, so clearing a backlog does not
   * immediately dump a fresh batch on the players.
   */
  private updateOrderSpawning(deltaSeconds: number): void {
    const progress = this.runtime.shiftDuration > 0
      ? 1 - this.runtime.shiftTimeRemaining / this.runtime.shiftDuration
      : 0;
    const active = this.runtime.activeOrders.filter((order) => order.status === "active");
    if (active.length >= maxConcurrentOrders(progress, this.tuning)) {
      this.spawnTimer = Math.max(this.spawnTimer, 2);
      return;
    }
    this.spawnTimer -= deltaSeconds;
    if (this.spawnTimer > 0) return;
    // A ticket spawned in the last stretch could not be finished, and an unavoidable
    // timeout would drag the shift's completion score down through no fault of the players.
    if (this.runtime.shiftTimeRemaining <= BALANCE.order.noSpawnTailSeconds) return;
    this.createOrder();
    this.spawnTimer = spawnIntervalSeconds(progress, this.tuning);
  }

  private updateCamera(deltaSeconds: number): void {
    const focus = this.cameraFocusRemaining > 0
      ? Math.min(0.42, this.cameraFocusRemaining / 2.5)
      : 0;
    if (this.cameraFocusRemaining > 0) {
      this.cameraFocusRemaining = Math.max(0, this.cameraFocusRemaining - deltaSeconds);
    }
    const snapshot = this.camera.update(
      deltaSeconds,
      this.players[0].player.position,
      this.players[1].player.position,
      this.cameraFocusTarget,
      focus,
    );
    this.cameraDistance = snapshot.distance;
    this.cameraSplitAmount = snapshot.splitAmount;
    this.ui.setSplitScreen(snapshot.splitAmount, snapshot.distance);
  }

  private updateDebug(): void {
    if (!isDevelopmentMode() && !this.options.persistentState.settings.showDebug) {
      this.ui.updateDebug(null);
      return;
    }
    const target = this.players[0].target;
    const queued = this.runtime.activeOrders
      .filter((order) => order.status === "active")
      .map((order) => {
        const id = order.requestedRecipeId;
        return id ? this.recipes.getRecipe(id)?.shortName ?? id : "OBJETIVO";
      })
      .join(" · ");
    this.ui.updateDebug({
      fps: this.scene.getEngine().getFps(),
      playerPosition: this.players[0].player.position,
      carrying: this.players.map((slot) =>
        `${slot.label}: ${slot.held ? describeItem(slot.held, this.recipeList) : "empty"}`,
      ).join(" / "),
      character: this.players.map((slot) =>
        `${slot.label} ${slot.player.selectedCharacterId ?? "placeholder"}`,
      ).join(" / "),
      characterBounds: this.players[0].player.characterDebugBounds,
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
    const clock = target ? this.orderClocks.get(target.id) : undefined;
    const rescued = matched && clock !== undefined && clock.duration > 0 &&
      clock.remaining / clock.duration <= BALANCE.order.rescueThreshold;
    const rescueBonus = rescued ? BALANCE.order.rescueBonus : 0;

    const combo = matched ? this.runtime.combo + 1 : 0;
    const comboBonus = combo >= 2 ? 40 * 2 ** Math.min(2, combo - 2) : 0;
    const wrongDishPenalty = matched ? 0 : 50;
    const awarded = baseAward + comboBonus + rescueBonus - wrongDishPenalty;
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

    this.audio.play("station:complete");
    this.cameraFocusRemaining = 2.2;
    slot.player.setExpression(breakdown.total >= 0.65 ? "^_^" : ">_<");
    this.speakForQuality(breakdown.label);
    this.notify(
      `${slot.label} // ${recipe.displayName} // ${awarded >= 0 ? "+" : ""}${awarded} PONTOS${combo >= 2 ? ` // COMBO X${combo}` : ""}${rescued ? " // RESGATE!" : ""}`,
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
      this.notify("PEDIDO ENTREGUE", "success");
      if (rescued) this.speak("order:rescued");
      // Spawning is the scheduler's job now, so the queue is not refilled here.
      this.removeOrder(completedOrder.id);
    } else {
      this.notify(`PRATO ERRADO // ninguém pediu ${recipe.shortName}`, "warning");
    }
  }

  private createOrder(recipeId?: string): void {
    const now = Date.now();
    const chosen = recipeId
      ?? nextSpawnRecipeId(this.runtime.activeOrders, this.recipeList, Math.random);
    const order = this.orders.createRecipeOrder(chosen, now);

    // Never hand out a deadline the shift cannot honour.
    const recipeSeconds = (order.expiresAt - order.createdAt) / 1_000;
    const duration = Math.max(
      1,
      Math.min(recipeSeconds, this.runtime.shiftTimeRemaining - 2),
    );
    const clamped: Order = { ...order, expiresAt: now + duration * 1_000 };

    this.orderClocks.set(clamped.id, { remaining: duration, duration, warned: false });
    this.runtime = {
      ...this.runtime,
      activeOrders: sortByUrgency([...this.runtime.activeOrders, clamped]),
    };
    this.eventBus.emit("order:created", clamped);
    this.emitOrdersChanged();
  }

  /** Drops an order from the queue and forgets its clock. */
  private removeOrder(orderId: string): void {
    this.orderClocks.delete(orderId);
    this.runtime = {
      ...this.runtime,
      activeOrders: this.runtime.activeOrders.filter((order) => order.id !== orderId),
    };
    this.emitOrdersChanged();
  }

  private failOrder(orderId: string): void {
    const active = this.runtime.activeOrders.find((order) => order.id === orderId);
    if (!active || active.status !== "active") return;
    const failed = this.orders.fail(active);
    this.wedding.resolveOrder(orderId, false);
    this.runtime = {
      ...this.runtime,
      failedOrders: this.runtime.failedOrders + 1,
      score: Math.max(0, this.runtime.score - 30),
      combo: 0,
    };
    this.eventBus.emit("order:failed", failed);
    this.notify("PEDIDO PERDIDO // PENALIDADE", "error");
    this.speak("order:failed");
    this.removeOrder(orderId);
  }

  private emitOrdersChanged(): void {
    const progress = this.runtime.shiftDuration > 0
      ? 1 - this.runtime.shiftTimeRemaining / this.runtime.shiftDuration
      : 0;
    this.eventBus.emit("orders:changed", {
      active: this.runtime.activeOrders,
      maxConcurrent: maxConcurrentOrders(progress, this.tuning),
    });
  }

  /**
   * Rewrites each order's wall-clock stamps from its delta-accumulated countdown. The
   * countdown is the authority, so pausing the game does not burn order time, while
   * ScoreSystem still gets honest createdAt/expiresAt to derive its speed bonus from.
   */
  private syncOrderClocks(): void {
    if (this.runtime.activeOrders.length === 0) return;
    const now = Date.now();
    let changed = false;
    const next = this.runtime.activeOrders.map((order) => {
      const clock = this.orderClocks.get(order.id);
      if (!clock || order.status !== "active" || clock.duration <= 0) return order;
      const elapsedMs = Math.max(0, clock.duration - clock.remaining) * 1_000;
      const expiresAt = now + clock.remaining * 1_000;
      // Only re-stamp on a real drift. Rewriting every frame would re-allocate the whole
      // queue 60 times a second for sub-millisecond differences.
      if (Math.abs(expiresAt - order.expiresAt) < CLOCK_RESTAMP_TOLERANCE_MS) return order;
      changed = true;
      return { ...order, createdAt: now - elapsedMs, expiresAt };
    });
    if (changed) this.runtime = { ...this.runtime, activeOrders: next };
  }

  private finishShift(): void {
    if (this.resultShown) return;
    this.resultShown = true;
    for (const slot of this.players) slot.input.enabled = false;
    this.ui.setStationProgress(null);
    for (const slot of this.players) {
      this.setStationKeyPrompt(slot, null);
      this.ui.setPlayerStatus(slot.index, {
        prompt: null,
        key: slot.input.labelFor("interact") ?? "—",
        carrying: slot.held ? describeItem(slot.held, this.recipeList) : null,
      });
    }
    const result = this.shifts.createResult(this.runtime);
    this.eventBus.emit("shift:ended", result);
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
  z: placement.z,
  rotationY: placement.rotationY,
  ingredientId: placement.ingredientId,
  initialItem: placement.initial === "extinguisher"
    ? createExtinguisher
    : placement.initial
      ? () => createCookware(placement.initial as "pan" | "pot")
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
