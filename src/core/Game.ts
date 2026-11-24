import { applyTranslations, initLanguage, onLanguageChange, t } from "../i18n";
import type { AbstractEngine, Scene as BabylonScene } from "@babylonjs/core";
import { createGameEngine, rendererName } from "./render/createGameEngine";
import { getShiftDuration } from "../config";
import { CHARACTERS, DEFAULT_CHARACTER_ID, RECIPES, getCharacter } from "../data";
import type { CharacterDefinition } from "../data/characters";
import { CHARACTER_ANIMATION_ASSETS } from "../data/characters";
import type { MapData } from "../editor/MapData";
import type { EditorController } from "../editor/EditorController";
import { KitchenScene } from "../scenes/KitchenScene";
import type { PersistentGameState, ShiftResult } from "../types/game";
import { GameUI } from "../ui/GameUI";
import { CharacterPreview } from "../ui/CharacterPreview";
import { LevelMapView } from "../ui/LevelMapView";
import { RANK_ORDER, recordLevelRank } from "../data/levelRanks";
import { achievementProgress, openCollection } from "../ui/Collection";
import { LoadingScreen } from "../ui/LoadingScreen";
import { SCENARIOS, getScenario } from "../data/scenarios";
import { buildLevelCatalog, type LevelEntry } from "../data/levelCatalog";
import { OFFICIAL_LEVELS } from "../data/officialLevels";
import { MapStore } from "../editor/MapStore";
import { getDifficulty } from "../data/difficulty";
import { INGREDIENT_ASSETS } from "../data/ingredientAssets";
import { KITCHEN_ASSETS } from "../data/kitchen";
import { SCENARIO_ASSETS } from "../data/scenarioAssets";
import { MANNEQUIN } from "../systems/WeddingGuests";
import { absoluteUrl, assetCache } from "./assets/AssetCache";
import { describeProgress, type LoadGroup } from "./assets/loadProgress";
import { PerformanceManager } from "./perf/PerformanceManager";
import { installPerfProbe } from "./perf/perfProbe";
import { qualityManager } from "./perf/QualityManager";
import { assetStreaming } from "./assets/AssetStreamingManager";
import { SaveSystem } from "./SaveSystem";
import { SceneManager } from "./SceneManager";
import { GamepadBinder } from "./GamepadBinder";
import type { PhoneHub } from "../net/mp/PhoneHub";
import type { PadState } from "../net/mp/HostSession";
import { MenuNavigator } from "../ui/MenuNavigator";
import type { MenuCommand } from "../ui/menuInput";
import { MAX_PLAYERS } from "../data/players";

/** A different cook for each player, the default one first. */
const DEFAULT_COOP_CHARACTERS: readonly string[] = [
  DEFAULT_CHARACTER_ID,
  ...CHARACTERS.filter(({ id }) => id !== DEFAULT_CHARACTER_ID).map(({ id }) => id),
].slice(0, MAX_PLAYERS);
/** The player-one pad while a menu is up; everyone else waits for it. */
const WAITING: PadState = { layout: "wait", leader: false };
/** Past this, the loader offers to continue into the menu while loading carries on. */
const SLOW_BOOT_MS = 45_000;
/** How often the loading bar re-reads progress; build steps do not emit cache events. */
const PROGRESS_POLL_MS = 100;
/** Wait for the picks to settle before parsing cooks into the kitchen. */
const COOK_PRELOAD_DEBOUNCE_MS = 350;

const urlsOf = (definitions: readonly { url: string }[]): string[] =>
  definitions.map((definition) => absoluteUrl(definition.url));

/** Download totals for the perf probe. */
const summarizeAssetCache = (): { files: number; loadedMb: number; failed: number; pending: number } => {
  const entries = assetCache.snapshot();
  return {
    files: entries.length,
    loadedMb: entries.reduce((sum, entry) => sum + (entry.state === "loaded" ? entry.loaded : 0), 0) / 1048576,
    failed: entries.filter((entry) => entry.state === "failed").length,
    pending: entries.filter((entry) => entry.state === "queued" || entry.state === "loading").length,
  };
};

const whenIdle = (callback: () => void): void => {
  const idle = (window as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void })
    .requestIdleCallback;
  if (idle) idle(callback, { timeout: 800 });
  else window.setTimeout(callback, 50);
};

/**
 * Owns the engine, the scenes and — since loading was reorganised — the order things load in.
 *
 * Three tiers, see `AssetPriority`:
 *   1. critical: the menu. The loader stays up only for the kitchen backdrop, the two cooks
 *      on screen and their idle clip. Everything else waits.
 *   2. gameplay: the first match. Built in the background once the menu is up, so pressing
 *      Start usually finds it ready and only swaps the cooks in.
 *   3. background: cooks nobody picked, levels nobody opened — fetched in idle time or when
 *      asked for.
 */
/** How long the phones vibrate as a disaster breaks out (the protocol allows up to 400). */
const DISASTER_BUZZ_MS = 380;

export class Game {
  private readonly engine: AbstractEngine;
  private readonly sceneManager: SceneManager;
  private readonly performanceManager: PerformanceManager;
  private readonly uninstallPerfProbe: () => void;
  private readonly stopQualitySampling: () => void;
  private readonly saveSystem = new SaveSystem();
  private readonly ui: GameUI;
  /** Level titles and descriptions are copied into the picker's entries; rebuilt on a switch. */
  private readonly stopLanguage = onLanguageChange(() => this.refreshLevels());
  private readonly loading: LoadingScreen | null;
  private characterPreview: CharacterPreview | null = null;
  /** The level picker's 3D map; the first thing the menu shows. */
  private levelMapView: LevelMapView | null = null;
  /** Built after the menu is up; null until then. */
  private kitchenScene: KitchenScene | null = null;
  private editor: EditorController | null = null;
  private openingEditor = false;
  private persistentState: PersistentGameState;
  private account?: import("../ui/AccountPanel").AccountPanel;
  private accountPanel?: Promise<import("../ui/AccountPanel").AccountPanel>;
  private disposed = false;
  private activeMap: MapData | null = null;
  private editorDraft: MapData | null = null;
  private editorSlotId = "";
  private selectedCharacters: readonly string[] = DEFAULT_COOP_CHARACTERS;
  private loadingMap = false;
  /** Lists saved slots for the level picker; the editor keeps its own store. */
  private readonly mapStore = new MapStore();
  private pendingLevel: LevelEntry | null = null;
  /** Which level the live kitchen was built for, so re-picking it costs nothing. */
  private activeLevelKey = "";
  /** Set when preparing a shift failed; the next Start rebuilds the kitchen before retrying. */
  private kitchenNeedsRebuild = false;
  private menuReady = false;
  private cookPreloadTimer = 0;
  /** Gamepads drive the cooks alongside the keyboard. */
  private readonly gamepads = new GamepadBinder();
  /** Phone controllers: the room opens as soon as the menu is up. */
  private phoneHub: PhoneHub | null = null;
  private phoneHubLoading: Promise<PhoneHub> | null = null;
  /** Player one's D-pad through the menus. */
  private readonly navigator: MenuNavigator;

  /**
   * Starts the game. The menu's files are requested first: creating the engine blocks the
   * main thread for a while (the first context is the expensive one), and requests issued
   * before it keep downloading on the network thread meanwhile instead of starting after.
   */
  static async create(canvas: HTMLCanvasElement, uiRoot: HTMLElement): Promise<Game> {
    performance.mark("bb:game-start");
    const defaultCooks = DEFAULT_COOP_CHARACTERS.slice(0, 1)
      .map((id) => getCharacter(id))
      .filter((character): character is CharacterDefinition => character !== undefined);
    for (const url of CharacterPreview.criticalUrls(defaultCooks)) {
      assetCache.prefetch(absoluteUrl(url), "critical");
    }
    return new Game(await createGameEngine(canvas), uiRoot);
  }

  private constructor(engine: AbstractEngine, uiRoot: HTMLElement) {
    this.persistentState = this.saveSystem.load();
    // Before any text is drawn: the save's choice, or the browser's language the first time.
    initLanguage(this.persistentState.settings.language, (language) => {
      this.persistentState = {
        ...this.persistentState,
        settings: { ...this.persistentState.settings, language },
      };
      this.saveProgress();
    });
    this.engine = engine;
    this.sceneManager = new SceneManager(this.engine);
    this.performanceManager = new PerformanceManager(this.engine);
    // createGameEngine registered the engine with the quality manager; frames feed its
    // automatic mode from here.
    this.stopQualitySampling = this.performanceManager.onFrame((interval) => qualityManager.sampleFrame(interval));
    this.uninstallPerfProbe = installPerfProbe({
      performance: this.performanceManager,
      extras: () => ({
        renderer: rendererName(this.engine),
        assets: summarizeAssetCache(),
        streaming: assetStreaming.snapshot(),
        quality: qualityManager.describe(),
      }),
    });
    performance.mark("bb:engine-created");
    this.loading = LoadingScreen.attach();
    this.loading?.show("boot", t("boot.preparingKitchen"));
    this.ui = new GameUI(uiRoot, {
      startVisible: true,
      characters: CHARACTERS,
      recipes: RECIPES,
      selectedCharacterIds: DEFAULT_COOP_CHARACTERS,
      onStart: (characterIds) => this.startShift(characterIds),
      onCharacterChange: (characterIds) => this.onCooksChanged(characterIds),
      onRestart: () => this.kitchenScene?.restartShift(),
      onPause: () => this.kitchenScene?.setManualPaused(true),
      onResume: () => this.kitchenScene?.setManualPaused(false),
      onQuitToMenu: () => this.quitToMenu(),
      onCookbookVisibilityChange: (visible) => this.kitchenScene?.setCookbookOpen(visible),
      onOpenAccount: () => void this.openAccount(),
      onPlayOnComputer: () => this.playOnComputer(),
      onOpenCollection: (view) => openCollection(view, this.persistentState),
      onOpenEditor: () => { void this.openEditor(); },
      onLevelChange: (entry) => this.onLevelChosen(entry),
      onDeleteLevel: (entry) => this.deleteSavedLevel(entry),
      onCharacterPreview: (characterIds) => {
        this.characterPreview?.setSlotCount(characterIds.length);
        for (const [slot, id] of characterIds.entries()) {
          const character = id ? getCharacter(id) : undefined;
          if (character) void this.characterPreview?.showSlot(slot, character);
        }
      },
      onPreviewActiveChange: (active) => this.characterPreview?.setActive(active),
      onConfirmSelection: async () => {
        await this.characterPreview?.playConfirm();
      },
    });
    performance.mark("bb:ui-created");
    this.navigator = new MenuNavigator({
      root: this.ui.root(),
      splashStep: () => (this.ui.isSplashVisible && !this.editor ? this.ui.splashStep : null),
    });
    // Offer phone pairing and local play after loading. Automated runs go straight to a shift.
    const autostarting = new URLSearchParams(window.location.search).has("autostart");
    if (!autostarting) this.ui.setSplashStep("pair");
    // Priority 1: only what the menu shows. The kitchen scene is not built yet.
    this.characterPreview = new CharacterPreview(this.ui.characterPreviewCanvas(), {
      characters: CHARACTERS,
    });
    // The UI decided before the preview existed; the first screen is the level map.
    this.characterPreview.setActive(this.ui.isPreviewActive);
    performance.mark("bb:preview-created");
    this.levelMapView = new LevelMapView(this.ui.levelMapCanvasElement(), {
      onPick: (key) => this.ui.pickMapLevel(key),
    });
    this.ui.attachLevelMap(this.levelMapView);
    this.ui.setLevelRanks(this.persistentState.levelRanks, this.persistentState.levelStars);
    this.ui.refreshCharacterPreview();
    this.refreshLevels();
    const bootLoader = document.getElementById("boot-loader");
    if (bootLoader) applyTranslations(bootLoader);

    window.addEventListener("resize", this.handleResize);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.engine.runRenderLoop(this.frame);

    if (new URLSearchParams(window.location.search).has("autostart")) {
      void this.autostart();
    } else {
      void this.bootMenu();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopLanguage();
    this.gamepads.dispose();
    this.phoneHub?.dispose();
    this.phoneHub = null;
    void this.accountPanel?.then((panel) => panel.dispose());
    window.clearTimeout(this.cookPreloadTimer);
    window.removeEventListener("resize", this.handleResize);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.engine.stopRenderLoop(this.frame);
    this.engine.stopRenderLoop(this.editorFrame);
    this.editor?.dispose();
    this.editor = null;
    this.characterPreview?.dispose();
    this.characterPreview = null;
    this.levelMapView?.dispose();
    this.levelMapView = null;
    this.sceneManager.dispose();
    this.uninstallPerfProbe();
    this.stopQualitySampling();
    this.performanceManager.dispose();
    this.ui.destroy();
    this.engine.dispose();
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    const deltaSeconds = Math.min(this.engine.getDeltaTime() / 1_000, 0.1);
    this.sceneManager.update(deltaSeconds);
    // Automatic quality only judges frames of a shift being played, never menus or loads.
    qualityManager.setAutoActive(!this.ui.isSplashVisible && this.kitchenScene?.isShiftRunning === true);
    // The splash is opaque and covers the whole canvas. Drawing the kitchen behind it —
    // glow layer and all — at 60 fps used to cost every menu frame for nothing.
    if (this.ui.isSplashVisible) return;
    // An automatic quality step decided at the end of the last frame lands here, before
    // drawing: its canvas resize then clears nothing the player was about to see.
    qualityManager.flushPending();
    this.sceneManager.render();
  };

  private readonly handleResize = (): void => {
    this.sceneManager.resize();
    this.characterPreview?.resize();
    this.levelMapView?.resize();
    // A move to a screen with another pixel ratio changes what the cap allows.
    qualityManager.refreshResolution();
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.hidden && !this.editor) this.kitchenScene?.setManualPaused(true);
  };

  // ---------------------------------------------------------------------------------------
  // Priority 1 — the menu

  private cooks(ids: readonly string[] = this.selectedCharacters): CharacterDefinition[] {
    return ids.map((id) => getCharacter(id)).filter((c): c is CharacterDefinition => c !== undefined);
  }

  /** Holds the loader over the menu until its backdrop and both cooks are on screen. */
  private async bootMenu(): Promise<void> {
    const preview = this.characterPreview;
    if (!preview || !this.loading) {
      this.finishBoot();
      return;
    }
    const urls = preview.menuAssetUrls(this.cooks());
    const groups: LoadGroup[] = [
      { status: t("boot.loadingScenery"), urls: urls.scenery },
      { status: t("boot.loadingCooks"), urls: urls.cooks },
      { status: t("boot.loadingAnimations"), urls: urls.animations },
    ];
    const stopTracking = this.trackProgress(() => describeProgress(
      assetCache, groups, { done: preview.stagesDone, total: preview.stageCount }, t("boot.almostReady"),
    ));

    // The map belongs to the level-selection screen and starts loading only when opened.
    const ready = preview.whenReady();
    const slow = window.setTimeout(() => {
      if (this.menuReady) return;
      this.loading?.fail({
        message: t("boot.slow"),
        onContinue: () => this.finishBoot(),
      });
    }, SLOW_BOOT_MS);

    const readiness = await ready;
    window.clearTimeout(slow);
    stopTracking();
    if (this.menuReady || this.disposed) return;
    if (readiness.failed.length === 0) {
      this.finishBoot();
      return;
    }
    // Something the menu shows could not load. Say what, offer to try again, and never make
    // the game unreachable over a missing backdrop.
    this.loading.fail({
      message: t("boot.couldNotLoad", { items: readiness.failed.join(", ") }),
      onRetry: () => {
        assetCache.retryFailed();
        preview.retry(this.cooks());
        void this.bootMenu();
      },
      onContinue: () => this.finishBoot(),
    });
  }

  private finishBoot(): void {
    if (this.menuReady) return;
    this.menuReady = true;
    performance.mark("bb:menu-ready");
    void this.loading?.hide();
    this.unloadUnusedAssets();
    if (this.ui.splashStep === "pair") void this.ensurePhoneHub();
    // Priority 2 starts only now, so it never competed with the menu for bandwidth.
    whenIdle(() => {
      void this.preloadGameplay();
      if (import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY && !this.disposed) {
        void this.getAccountPanel().then((panel) => panel.resume()).catch(() => undefined);
      }
    });
  }

  /**
   * Drops downloaded bytes nothing can ask for again. Parsed scenes keep their own copies;
   * the cache's bytes only matter for re-parsing.
   *
   * Deliberately narrow: the menu backdrop is parsed by the preview, which lives for the
   * whole session and is its only user, so its 2 MB can go as soon as it is on screen. The
   * match's files stay cached on purpose — a level change rebuilds the kitchen scene, and
   * re-parsing from memory is what makes that instant instead of a second download.
   */
  private unloadUnusedAssets(): void {
    const preview = this.characterPreview;
    if (!preview || preview.stagesDone === 0) return;
    const [backdrop] = preview.menuAssetUrls([]).scenery;
    if (backdrop && assetCache.isLoaded(backdrop)) assetCache.release((url) => url === backdrop);
  }

  /** Re-reads progress while a phase runs; returns the stop function. */
  private trackProgress(read: () => { fraction: number; status: string }): () => void {
    const update = (): void => {
      const report = read();
      this.loading?.setProgress(report.fraction, report.status);
    };
    update();
    const unsubscribe = assetCache.onChange(update);
    const timer = window.setInterval(update, PROGRESS_POLL_MS);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }

  // ---------------------------------------------------------------------------------------
  // Priority 2 — the first match, built while the players are in the menu

  private async preloadGameplay(): Promise<void> {
    if (this.disposed || this.editor) return;
    performance.mark("bb:kitchen-build-start");
    const kitchen = this.ensureKitchen();
    performance.mark("bb:kitchen-built");
    try {
      await kitchen.prepareInBackground();
      performance.mark("bb:kitchen-prepared");
      // A level change replaced this kitchen while it was loading; the new one runs its own.
      if (kitchen !== this.kitchenScene || this.disposed) return;
      // The cooks go in now too, so Start has nothing left but the confirm walk.
      await kitchen.selectCharacters(this.selectedCharacters);
      if (kitchen !== this.kitchenScene) return;
      await kitchen.warmUp();
      if (kitchen !== this.kitchenScene) return;
      performance.mark("bb:gameplay-ready");
    } catch (error: unknown) {
      // Not fatal here: Start retries whatever failed and reports it then.
      console.warn("Background match preparation failed; it will be retried on Start.", error);
      return;
    }
    // Priority 3: the cooks nobody picked, only once the queue is otherwise idle.
    for (const character of CHARACTERS) {
      if (!this.selectedCharacters.includes(character.id)) {
        assetCache.prefetch(absoluteUrl(character.modelUrl), "background");
      }
    }
  }

  /** Parses the picked cooks into the kitchen shortly after the picks stop changing. */
  private onCooksChanged(characterIds: readonly string[]): void {
    this.selectedCharacters = characterIds;
    window.clearTimeout(this.cookPreloadTimer);
    this.cookPreloadTimer = window.setTimeout(() => {
      const kitchen = this.kitchenScene;
      // Before the match is prepared, preloadGameplay will pick the current cooks up itself.
      if (!kitchen?.isPrepared) return;
      const picks = this.selectedCharacters;
      void kitchen.selectCharacters(picks)
        .then(() => (kitchen === this.kitchenScene ? kitchen.warmUp() : undefined))
        .catch((error: unknown) => console.warn("Could not stage the picked cooks.", error));
    }, COOK_PRELOAD_DEBOUNCE_MS);
  }

  /**
   * A level card was chosen. Rebuild the kitchen for it now, while the players pick cooks,
   * instead of when they press Start.
   */
  private onLevelChosen(entry: LevelEntry): void {
    this.pendingLevel = entry;
    if (!this.menuReady || entry.key === this.activeLevelKey) return;
    void this.applyLevel(entry).then(() => this.preloadGameplay());
  }

  private ensureKitchen(): KitchenScene {
    return this.kitchenScene ?? this.installKitchen(this.pendingLevel, undefined);
  }

  /** Replaces the live kitchen. `map` undefined means "the entry's own map". */
  private installKitchen(entry: LevelEntry | null, map: MapData | null | undefined): KitchenScene {
    const levelMap = map !== undefined ? map : entry ? this.levelMap(entry) : null;
    this.engine.stopRenderLoop(this.frame);
    // Dispose before creating the next scene; SceneManager owns this lifetime.
    this.sceneManager.dispose();
    this.activeMap = levelMap;
    const kitchen = this.createKitchen(this.persistentState, levelMap, entry?.scenarioId);
    kitchen.setCookCount(this.ui.players);
    this.kitchenScene = kitchen;
    // A disaster breaking out shakes the screen (in the scene) and buzzes every phone.
    kitchen.onDisasterStart = () => this.phoneHub?.buzzAll(DISASTER_BUZZ_MS);
    this.sceneManager.set(kitchen);
    // Phones and gamepads move to the new kitchen's cooks.
    this.gamepads.attachKitchen(kitchen.cookInputs);
    this.phoneHub?.attachKitchen(kitchen.cookInputs);
    this.performanceManager.attachScene(kitchen.scene);
    this.activeLevelKey = entry?.key ?? "";
    this.engine.runRenderLoop(this.frame);
    return kitchen;
  }

  /** Rebuilds the level picker from the built-in scenarios, the shipped levels and the slots. */
  private refreshLevels(): void {
    const entries = buildLevelCatalog(SCENARIOS, this.mapStore.list(), OFFICIAL_LEVELS);
    this.ui.setLevels(entries);
    if (!this.pendingLevel || !entries.some((entry) => entry.key === this.pendingLevel?.key)) {
      this.pendingLevel = entries[0] ?? null;
    }
  }

  /**
   * Removes one of the player's maps for good, with everything that pointed at it: its
   * best rank, the menu's pick and the editor's link to the slot.
   */
  private deleteSavedLevel(entry: LevelEntry): boolean {
    if (entry.kind !== "saved" || !entry.slotId) return false;
    if (!this.mapStore.delete(entry.slotId)) return false;
    if (this.editorSlotId === entry.slotId) this.editorSlotId = "";
    if (entry.key in this.persistentState.levelRanks) {
      // A deleted map takes its whole record with it: rank, stars and best coins.
      const { [entry.key]: _removedRank, ...levelRanks } = this.persistentState.levelRanks;
      const { [entry.key]: _removedStars, ...levelStars } = this.persistentState.levelStars;
      const { [entry.key]: _removedCoins, ...levelBestScore } = this.persistentState.levelBestScore;
      this.persistentState = { ...this.persistentState, levelRanks, levelStars, levelBestScore };
      this.saveProgress();
      this.ui.setLevelRanks(levelRanks, levelStars);
    }
    // refreshLevels falls back to the first level when the pick no longer exists.
    this.refreshLevels();
    return true;
  }

  /** The level-picker entry for a saved map slot, if it is still saved. */
  private savedLevel(slotId: string): LevelEntry | null {
    if (!slotId) return null;
    return buildLevelCatalog(SCENARIOS, this.mapStore.list(), OFFICIAL_LEVELS)
      .find((entry) => entry.kind === "saved" && entry.slotId === slotId) ?? null;
  }

  /** The map a level entry plays; null means the scenario's own built-in layout. */
  private levelMap(entry: LevelEntry): MapData | null {
    if (entry.map) return entry.map;
    if (entry.kind === "saved" && entry.slotId) return this.mapStore.load(entry.slotId);
    return null;
  }

  /**
   * Swaps the kitchen over to `entry`, unless it is already the live one.
   *
   * A saved slot that has since been deleted falls back to its scenario rather than failing
   * the start: the player picked a level from a list, and refusing to start would be worse
   * than starting the scenario it was built on.
   */
  private async applyLevel(entry: LevelEntry | null): Promise<void> {
    if (!entry || (this.kitchenScene && entry.key === this.activeLevelKey)) return;
    const map = this.levelMap(entry);
    if (entry.kind === "saved" && !map) {
      this.ui.notify(t("game.mapGone"), "warning");
    }
    this.installKitchen(entry, map);
  }

  /** The files a shift still needs, grouped by what the loader should call them. */
  private matchGroups(kitchen: KitchenScene, cookIds: readonly string[]): LoadGroup[] {
    const needed = new Set(kitchen.requiredUrls(cookIds));
    const pick = (urls: readonly string[]): string[] => urls.filter((url) => needed.has(url));
    const ingredients = pick(urlsOf(INGREDIENT_ASSETS));
    const guests = pick([absoluteUrl(MANNEQUIN.modelUrl)]);
    const cooks = pick(this.cooks(cookIds).map((character) => absoluteUrl(character.modelUrl)));
    const animations = pick(urlsOf(Object.values(CHARACTER_ANIMATION_ASSETS)));
    const named = new Set([...ingredients, ...guests, ...cooks, ...animations]);
    const room = [...needed].filter((url) => !named.has(url));
    return [
      { status: t("boot.preparingIngredients"), urls: ingredients },
      { status: t("boot.buildingKitchen"), urls: [...pick(urlsOf([...KITCHEN_ASSETS, ...SCENARIO_ASSETS])), ...room] },
      { status: t("boot.callingGuests"), urls: guests },
      { status: t("boot.loadingCooks"), urls: cooks },
      { status: t("boot.loadingAnimations"), urls: animations },
    ];
  }

  private async autostart(): Promise<void> {
    this.menuReady = true;
    this.ui.showSplash(false);
    try {
      await this.startShift(DEFAULT_COOP_CHARACTERS.slice(0, this.ui.players));
    } catch (error: unknown) {
      console.error("Autostart character initialization failed.", error);
      this.ui.showSplash(true);
      void this.loading?.hide();
    }
  }

  /**
   * Pause or results → the level and cook picker. Without it, changing level or cooks after
   * the first shift needed a page reload. The kitchen stays built; Start resets it.
   */
  private quitToMenu(): void {
    const kitchen = this.kitchenScene;
    if (!kitchen || this.editor) return;
    kitchen.abortShift();
    this.characterPreview?.resetConfirm();
    this.ui.showSplash(true);
  }

  private async startShift(characterIds: readonly string[]): Promise<void> {
    // One cook per player: the picks the menu sent, any missing filled with the defaults.
    const cookIds = Array.from({ length: this.ui.players }, (_, index) =>
      characterIds[index] || DEFAULT_COOP_CHARACTERS[index] || DEFAULT_COOP_CHARACTERS[0]!);
    this.selectedCharacters = cookIds;
    if (this.kitchenNeedsRebuild) {
      // The last attempt failed somewhere inside the kitchen (a room model, the guests, a
      // cook). Its promises remember that failure, so the retry starts from a fresh kitchen
      // of the same level instead of awaiting them again.
      this.kitchenNeedsRebuild = false;
      const entry = this.pendingLevel?.key === this.activeLevelKey ? this.pendingLevel : null;
      this.installKitchen(entry, this.activeMap);
    }
    // A kitchen built from the editor with no saved slot has no catalogue key; it is the
    // one to play, so the menu's pick must not replace it.
    if (this.pendingLevel || this.activeLevelKey) await this.applyLevel(this.pendingLevel);
    const kitchen = this.ensureKitchen();
    kitchen.setCookCount(cookIds.length);

    const cookUrls = this.cooks(cookIds).map((character) => absoluteUrl(character.modelUrl));
    const ready = kitchen.isReadyFor(cookIds);
    let stopTracking = (): void => undefined;
    let steps = 0;
    if (!ready) {
      // The player is now waiting on exactly this: everything queued for the match jumps
      // ahead of anything else, and a short loader shows what is left.
      assetCache.promoteAll("gameplay", "critical");
      for (const url of cookUrls) assetCache.prefetch(url, "critical");
      this.loading?.show("match", t("boot.preparingIngredients"));
      const groups = this.matchGroups(kitchen, cookIds);
      stopTracking = this.trackProgress(() => describeProgress(
        assetCache, groups, { done: steps + (kitchen.isPrepared ? 1 : 0), total: 3 }, t("boot.heatingStove"),
      ));
    }
    try {
      await kitchen.selectCharacters(cookIds);
      steps = 1;
      await kitchen.warmUp();
      // Then draw it once for real, still behind the splash: see primeFirstFrames.
      await kitchen.primeFirstFrames();
      steps = 2;
    } catch (error: unknown) {
      stopTracking();
      const failed = assetCache.snapshot().filter((entry) => entry.state === "failed");
      console.error("A partida não pôde ser preparada.", failed.map((entry) => entry.url), error);
      void this.loading?.hide();
      // GameUI shows the error and re-enables Start. Pressing it again is the retry: a failed
      // download is fetched afresh the next time anything asks for it, in a rebuilt kitchen.
      this.kitchenNeedsRebuild = true;
      // The cooks walked forward for the start that did not happen; send them back.
      this.characterPreview?.resetConfirm();
      throw error;
    }
    stopTracking();
    if (!ready) await this.loading?.hide();
    performance.mark("bb:match-start");
    kitchen.startShift();
  }

  /** Loads the phone feature and opens the room on the pairing panel. */
  private async ensurePhoneHub(): Promise<PhoneHub | null> {
    try {
      this.phoneHubLoading ??= import("../net/mp/PhoneHub").then(({ PhoneHub }) => {
        const hub = new PhoneHub({
          panel: this.ui.pairPanel(),
          characters: () => CHARACTERS.map((character) => ({ id: character.id, name: character.displayName })),
          notify: (message, tone) => this.ui.notify(message, tone),
          phase: () => (this.ui.isSplashVisible ? "lobby" : this.kitchenScene?.shiftPhase ?? "lobby"),
          padFor: (slot) => this.padFor(slot),
          onMenuCommand: (slot, command) => this.onMenuCommand(slot, command),
        });
        if (this.kitchenScene) hub.attachKitchen(this.kitchenScene.cookInputs);
        return hub;
      });
      const hub = await this.phoneHubLoading;
      if (this.disposed || this.ui.splashStep !== "pair") {
        hub.dispose();
        return null;
      }
      this.phoneHub = hub;
      await hub.open();
      if (this.phoneHub !== hub) return null;
      // A reloaded page takes its room back, possibly locked from an earlier pairing.
      if (this.ui.isSplashVisible && this.ui.splashStep === "pair") hub.unlock();
      return hub;
    } catch (error: unknown) {
      this.phoneHubLoading = null;
      if (this.disposed || this.ui.splashStep !== "pair") return null;
      console.error("Phone controllers could not be opened.", error);
      this.ui.notify(t("mp.failed"), "error");
      return null;
    }
  }

  private playOnComputer(): void {
    if (!this.ui.isSplashVisible || this.ui.splashStep !== "pair") return;
    this.phoneHub?.dispose();
    this.phoneHub = null;
    this.phoneHubLoading = null;
    this.finishPairing(1);
  }

  /** Player one pressed A on their phone: the connected phones become the players. */
  private settlePairing(): void {
    const players = this.phoneHub?.settlePlayers() ?? 0;
    if (players === 0) {
      this.ui.notify(t("pair.needOne"), "warning");
      return;
    }
    this.finishPairing(players);
  }

  private finishPairing(players: number): void {
    this.ui.setPlayerCount(players);
    this.kitchenScene?.setCookCount(players);
    this.navigator.clearFocus();
    this.ui.setSplashStep("home");
    this.phoneHub?.refreshPads();
  }

  /** What each player's phone shows: their cook's stick in play, else player one's D-pad. */
  private padFor(slot: number): PadState {
    const leader = slot === 0;
    if (this.editor) return WAITING;
    const menu: PadState = leader ? { layout: "menu", leader } : WAITING;
    if (this.ui.isSplashVisible) {
      const step = this.ui.splashStep;
      if (step === "characters" && !this.overlayOpen()) return slot < this.ui.players ? { layout: "select", leader } : WAITING;
      return menu;
    }
    const kitchen = this.kitchenScene;
    if (!kitchen || kitchen.shiftPhase !== "playing" || this.overlayOpen()) return menu;
    return slot < kitchen.cookCount ? { layout: "game", leader } : WAITING;
  }

  /** A dialog (account, collection, confirm box) is open over the game. */
  private overlayOpen(): boolean {
    return document.querySelector("dialog[open], .confirm-dialog-backdrop") !== null;
  }

  /** A player pressed something on their D-pad. */
  private onMenuCommand(slot: number, command: MenuCommand): void {
    if (this.editor) return;
    if (this.ui.isSplashVisible && !this.overlayOpen()) {
      if (this.ui.splashStep === "pair") {
        if (slot === 0 && command === "confirm") this.settlePairing();
        return;
      }
      if (this.ui.splashStep === "characters") {
        this.ui.selectionCommand(slot, command);
        return;
      }
    }
    if (slot !== 0) return;
    this.navigator.command(command);
  }

  private getAccountPanel() {
    return this.accountPanel ??= import("../ui/AccountPanel").then(({ AccountPanel }) => {
      const panel = new AccountPanel(
        () => this.saveSystem.load(),
        (state) => {
          if (this.disposed) return;
          this.persistentState = state ?? this.saveSystem.load();
          this.ui.setLevelRanks(this.persistentState.levelRanks, this.persistentState.levelStars);
        },
      );
      this.account = panel;
      return panel;
    });
  }

  private async openAccount(): Promise<void> {
    try {
      const panel = await this.getAccountPanel();
      await panel.resume();
      if (!this.disposed) panel.show();
    } catch {
      this.ui.notify(t("account.failed"), "warning");
    }
  }

  private saveProgress(): boolean {
    return this.account?.update(this.persistentState) || this.saveSystem.save(this.persistentState);
  }

  private updateCollection(update: Partial<PersistentGameState>): void {
    const previous = achievementProgress(this.persistentState);
    this.persistentState = { ...this.persistentState, ...update };
    if (!this.saveProgress()) {
      this.ui.notify(t("game.saveFailed"), "warning");
    }
    for (const [index, entry] of achievementProgress(this.persistentState).entries()) {
      if (entry.count >= entry.goal && previous[index]!.count < entry.goal) {
        this.ui.notify(`${t("collection.unlocked")} · ${t(entry.key)}`, "success");
      }
    }
  }

  private discover(id: string): void {
    const discoveries = this.persistentState.discoveries ?? [];
    if (!discoveries.includes(id)) this.updateCollection({ discoveries: [...discoveries, id] });
  }

  private saveShiftResult(result: ShiftResult): void {
    const before = achievementProgress(this.persistentState)[1]!;

    const currentRankIndex = this.persistentState.highestRank
      ? RANK_ORDER.indexOf(this.persistentState.highestRank)
      : Number.POSITIVE_INFINITY;
    const newRankIndex = RANK_ORDER.indexOf(result.rank);
    const key = this.activeLevelKey;
    // Stars and coins only ever go up: a worse run on a level already three-starred must
    // not take anything away from it.
    const bestStars = Math.max(this.persistentState.levelStars[key] ?? 0, result.stars);
    const bestCoins = Math.max(this.persistentState.levelBestScore[key] ?? 0, Math.round(result.coins));
    this.persistentState = {
      ...this.persistentState,
      credits: this.persistentState.credits + result.creditsEarned,
      levelRanks: recordLevelRank(this.persistentState.levelRanks, key, result.rank),
      levelStars: key ? { ...this.persistentState.levelStars, [key]: bestStars } : this.persistentState.levelStars,
      levelBestScore: key
        ? { ...this.persistentState.levelBestScore, [key]: bestCoins }
        : this.persistentState.levelBestScore,
      highestRank:
        newRankIndex >= 0 && newRankIndex < currentRankIndex
          ? result.rank
          : this.persistentState.highestRank,
    };
    if (!this.saveProgress()) {
      this.ui.notify(t("game.saveFailed"), "warning");
    }
    this.ui.setLevelRanks(this.persistentState.levelRanks, this.persistentState.levelStars);
    const after = achievementProgress(this.persistentState)[1]!;
    if (before.count < after.goal && after.count >= after.goal) {
      this.ui.notify(`${t("collection.unlocked")} · ${t(after.key)}`, "success");
    }
  }

  // ---------------------------------------------------------------------------------------
  // Editor — loaded only when opened

  private async openEditor(): Promise<void> {
    if (this.editor || this.loadingMap || this.openingEditor) return;
    this.openingEditor = true;
    performance.mark("bb:editor-requested");
    try {
      // Split into its own chunk: most sessions never open the editor, so its code (and the
      // gizmos and catalogue thumbnails it pulls in) is not part of the boot download.
      const [{ EditorController }, { createDefaultMap }] = await Promise.all([
        import("../editor/EditorController"),
        import("../editor/defaults"),
      ]);
      if (this.disposed || this.editor) return;
      performance.mark("bb:editor-code-loaded");
      this.kitchenScene?.setEditorInputSuspended(true);
      this.ui.setEditorVisible(true);
      this.engine.stopRenderLoop(this.frame);
      if (this.kitchenScene) this.detachScene(this.kitchenScene.scene);
      this.editor = new EditorController({
        engine: this.engine,
        host: this.ui.root(),
        initialMap: this.editorDraft ?? this.activeMap ?? createDefaultMap(),
        initialSlotId: this.editorSlotId,
        onPlay: (map) => this.playMap(map),
        onExit: () => this.exitEditor(),
      });
      this.engine.runRenderLoop(this.editorFrame);
      performance.mark("bb:editor-open");
    } catch (error: unknown) {
      console.error("O editor não pôde ser carregado.", error);
      this.ui.notify(t("game.editorFailed"), "error");
    } finally {
      this.openingEditor = false;
    }
  }

  private exitEditor(): void {
    if (!this.editor) return;
    const editor = this.editor;
    this.editorDraft = editor.getCurrentMap();
    this.editorSlotId = editor.getCurrentSlotId();
    // Any slot may have been saved in the editor, so a kitchen built from a saved slot may be
    // stale; forgetting its key makes the next Start rebuild it from what is stored now.
    if (this.activeLevelKey.startsWith("slot:")) this.activeLevelKey = "";
    this.editor = null;
    this.engine.stopRenderLoop(this.editorFrame);
    editor.dispose();
    this.refreshLevels();
    if (this.kitchenScene) {
      this.attachScene(this.kitchenScene.scene);
      this.kitchenScene.setEditorInputSuspended(false);
      this.sceneManager.set(this.kitchenScene);
    }
    this.engine.runRenderLoop(this.frame);
    this.ui.setEditorVisible(false);
  }

  private async playMap(map: MapData): Promise<void> {
    if (this.loadingMap) return;
    this.loadingMap = true;
    const played = structuredClone(map);
    this.editorDraft = played;
    if (this.editor) {
      this.editorSlotId = this.editor.getCurrentSlotId();
      this.engine.stopRenderLoop(this.editorFrame);
      this.editor.dispose();
      this.editor = null;
    }
    this.ui.setEditorVisible(false);
    this.ui.showSplash(true);
    this.ui.setMapLoading(true);
    try {
      // "Salvar e jogar" saved the map first, so it is now one of the player's levels.
      // Making it the chosen level is what keeps startShift on it: before, the menu's
      // pending level (the main scenario) did not match the editor's kitchen, and
      // startShift swapped the map the player had just built for the scenario.
      this.refreshLevels();
      const saved = this.savedLevel(this.editorSlotId);
      this.pendingLevel = saved;
      if (saved) this.ui.markLevelSelected(saved.key);
      this.installKitchen(saved, played);
      await this.startShift(this.selectedCharacters);
      if (!this.disposed) this.ui.showSplash(false);
    } catch (error) {
      console.error("Custom map shift initialization failed.", error);
      if (!this.disposed) {
        this.ui.showSplash(true);
        this.ui.notify(t("game.levelFailed"), "error");
      }
    } finally {
      this.loadingMap = false;
      if (!this.disposed) this.ui.setMapLoading(false);
    }
  }

  private readonly editorFrame = (): void => {
    if (this.disposed || !this.editor) return;
    const deltaSeconds = Math.min(this.engine.getDeltaTime() / 1_000, 0.1);
    this.editor.update(deltaSeconds);
  };

  private detachScene(babylonScene: BabylonScene): void {
    const engine = babylonScene.getEngine();
    if (engine.scenes.includes(babylonScene)) {
      engine.scenes = engine.scenes.filter((entry) => entry !== babylonScene);
    }
  }

  private attachScene(babylonScene: BabylonScene): void {
    const engine = babylonScene.getEngine();
    if (!engine.scenes.includes(babylonScene)) {
      engine.scenes.push(babylonScene);
    }
  }

  private createKitchen(
    persistentState: PersistentGameState,
    map: MapData | null = null,
    scenarioId?: string,
  ): KitchenScene {
    // A map carries its own level settings, so a level built in the editor plays by its
    // own rules rather than the global defaults.
    const scenario = getScenario(scenarioId ?? map?.scenarioId);
    const kitchen = new KitchenScene(this.engine, this.ui, {
      shiftDuration: map?.meta?.shiftDurationSeconds ?? scenario.shiftDurationSeconds ?? getShiftDuration(),
      tuning: getDifficulty(map?.meta?.difficultyId ?? scenario.difficultyId),
      scenario,
      persistentState,
      map: map ?? undefined,
      onShiftComplete: (result) => this.saveShiftResult(result),
    });
    kitchen.events.on("ingredient:picked", ({ item }) => {
      if (item.kind === "food") this.discover(item.ingredientId);
    });
    kitchen.events.on("station:used", ({ stationKind }) => this.discover(`station:${stationKind}`));
    kitchen.events.on("station:started", ({ stationKind }) => this.discover(`station:${stationKind}`));
    kitchen.events.on("station:completed", ({ stationKind }) => this.discover(`station:${stationKind}`));
    kitchen.events.on("order:completed", () => this.updateCollection({
      lifetimeOrders: (this.persistentState.lifetimeOrders ?? 0) + 1,
    }));
    return kitchen;
  }
}

