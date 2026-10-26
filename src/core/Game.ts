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

const DEFAULT_COOP_CHARACTERS: readonly [string, string] = [
  DEFAULT_CHARACTER_ID,
  CHARACTERS.find(({ id }) => id !== DEFAULT_CHARACTER_ID)?.id ?? DEFAULT_CHARACTER_ID,
];
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
  private disposed = false;
  private activeMap: MapData | null = null;
  private editorDraft: MapData | null = null;
  private editorSlotId = "";
  private selectedCharacters: readonly [string, string] = DEFAULT_COOP_CHARACTERS;
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

  /**
   * Starts the game. The menu's files are requested first: creating the engine blocks the
   * main thread for a while (the first context is the expensive one), and requests issued
   * before it keep downloading on the network thread meanwhile instead of starting after.
   */
  static async create(canvas: HTMLCanvasElement, uiRoot: HTMLElement): Promise<Game> {
    performance.mark("bb:game-start");
    assetCache.prefetch(absoluteUrl(LevelMapView.assetUrl), "critical");
    const defaultCooks = DEFAULT_COOP_CHARACTERS
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
      this.saveSystem.save(this.persistentState);
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
      onResume: () => this.kitchenScene?.setManualPaused(false),
      onQuitToMenu: () => this.quitToMenu(),
      onCookbookVisibilityChange: (visible) => this.kitchenScene?.setCookbookOpen(visible),
      onOpenEditor: () => { void this.openEditor(); },
      onLevelChange: (entry) => this.onLevelChosen(entry),
      onDeleteLevel: (entry) => this.deleteSavedLevel(entry),
      onCharacterPreview: (playerOneId, playerTwoId) => {
        for (const [slot, id] of ([playerOneId, playerTwoId] as const).entries()) {
          const character = id ? getCharacter(id) : undefined;
          if (character) void this.characterPreview?.showSlot(slot as 0 | 1, character);
        }
      },
      onPreviewActiveChange: (active) => this.characterPreview?.setActive(active),
      onConfirmSelection: async () => {
        await this.characterPreview?.playConfirm();
      },
    });
    performance.mark("bb:ui-created");
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
      { status: t("boot.openingMap"), urls: [absoluteUrl(LevelMapView.assetUrl)] },
      { status: t("boot.loadingScenery"), urls: urls.scenery },
      { status: t("boot.loadingCooks"), urls: urls.cooks },
      { status: t("boot.loadingAnimations"), urls: urls.animations },
    ];
    const stopTracking = this.trackProgress(() => describeProgress(
      assetCache, groups, { done: preview.stagesDone, total: preview.stageCount }, t("boot.almostReady"),
    ));

    // The map is the first screen, so the loader waits for it along with the cooks.
    const mapReady = this.levelMapView?.whenReady() ?? Promise.resolve(true);
    const ready = Promise.all([preview.whenReady(), mapReady]).then(([readiness, map]) => ({
      failed: map ? readiness.failed : [t("boot.levelMap"), ...readiness.failed],
    }));
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
        const [one, two] = this.cooks();
        if (one && two) preview.retry([one, two]);
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
    // Priority 2 starts only now, so it never competed with the menu for bandwidth.
    whenIdle(() => { void this.preloadGameplay(); });
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
  private onCooksChanged(characterIds: readonly [string, string]): void {
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
    this.kitchenScene = kitchen;
    this.sceneManager.set(kitchen);
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
      this.saveSystem.save(this.persistentState);
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
      await this.startShift(DEFAULT_COOP_CHARACTERS);
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

  private async startShift(characterIds: readonly [string, string]): Promise<void> {
    const cookIds: readonly [string, string] = [
      characterIds[0] || DEFAULT_COOP_CHARACTERS[0],
      characterIds[1] || DEFAULT_COOP_CHARACTERS[1],
    ];
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

  private saveShiftResult(result: ShiftResult): void {
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
    if (!this.saveSystem.save(this.persistentState)) {
      this.ui.notify(t("game.saveFailed"), "warning");
    }
    this.ui.setLevelRanks(this.persistentState.levelRanks, this.persistentState.levelStars);
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
    return new KitchenScene(this.engine, this.ui, {
      shiftDuration: map?.meta?.shiftDurationSeconds ?? scenario.shiftDurationSeconds ?? getShiftDuration(),
      tuning: getDifficulty(map?.meta?.difficultyId ?? scenario.difficultyId),
      scenario,
      persistentState,
      map: map ?? undefined,
      onShiftComplete: (result) => this.saveShiftResult(result),
    });
  }
}

