import { ingredientIllustration } from "./illustrations";
import type {
  AIState,
  FoodState,
  MiraExpression,
  RecipeData,
  RuntimeGameState,
  ShiftResult,
  StationId,
} from "../types/game";
import type { PlayerIndex } from "../types/events";
import { MAX_PLAYERS, PLAYER_COLORS, clampPlayerCount, playerLabel } from "../data/players";
import type { MenuCommand } from "./menuInput";
import type { CharacterDefinition } from "../data/characters";
import { formatShiftDuration, type LevelEntry } from "../data/levelCatalog";
import { mapLevels } from "../data/levelMap";
import { starsForRank, type LevelRanks } from "../data/levelRanks";
import { nextStarTarget } from "../data/levelGoals";
import { confirmDialog } from "./confirmDialog";
import { FOOD_STATE_LABEL, STATION_KIND_LABEL } from "../data/kitchen";
import type { ComponentStage } from "../gameplay/kitchen/KitchenGuide";
import { preparationSteps, stepStatus, type PrepStation } from "./orderTicketSteps";
import { getIngredient } from "../data/ingredients";
import {
  LANGUAGES,
  applyTranslations,
  formatNumber,
  getLanguage,
  onLanguageChange,
  setLanguage,
  t,
  translate,
  type Language,
} from "../i18n";
import { publicUrl } from "../utils/assetUrl";
import { qualityManager } from "../core/perf/QualityManager";
import { QUALITY_MODES, isQualityMode } from "../core/perf/qualityProfiles";
import "../styles/game.css";
import "../styles/phones.css";
import "../styles/tech-theme.css";
// Imported last: the order queue deliberately overrides the older HUD-card styling.
import "../styles/orders.css";
import "../styles/selection-street.css";
import "../styles/levels.css";
// Last: extends the order card's look to the overlays, the prompts and the editor.
import "../styles/cartoon.css";
// Presentation only: the reference-inspired skin leaves game state and callbacks intact.
import "../styles/cosmic.css";
import "../styles/level-map.css";
import "../styles/disaster.css";
import "../styles/bistro-theme.css";
import "../styles/players.css";

export type NotificationTone = "info" | "success" | "warning" | "error";
export interface DebugVector3 {
  x: number;
  y: number;
  z: number;
}

export interface GameUIDebugSnapshot {
  fps?: number;
  playerPosition?: DebugVector3 | readonly [number, number, number];
  carrying?: string | null;
  character?: string;
  characterBounds?: string;
  characterAnimation?: string;
  nearbyStation?: string | null;
  orders?: string | null;
  shiftTimeRemaining?: number;
  aiState?: Readonly<AIState>;
  score?: number;
  cameraDistance?: number;
  splitAmount?: number;
}

/** One recipe component on a ticket, with how far along it is. */
export interface OrderTicketComponent {
  ingredientId: string;
  /** The state the recipe wants it in. */
  state: FoodState;
  stage: ComponentStage;
}

/** One row of the order queue. All values are pre-derived; GameUI stays Babylon-free. */
export interface OrderTicketInfo {
  orderId: string;
  recipeId: string | null;
  title: string;
  secondsRemaining: number;
  totalSeconds: number;
  /** Every component is plated — the dish just needs carrying to the pass. */
  readyToDeliver: boolean;
  components: readonly OrderTicketComponent[];
  assignedTo: PlayerIndex | null;
}

/** How a card leaves the queue, which drives its exit animation. */
export type OrderOutcome = "delivered" | "expired";

/** One ingredient on a ticket, with the stations it still has to visit stacked under it. */
interface ChipNode {
  root: HTMLElement;
  tile: HTMLElement;
  steps: { station: PrepStation; icon: HTMLElement }[];
}

/** Cached DOM for one ticket row, plus the last values written, to skip no-op writes. */
interface TicketNode {
  root: HTMLElement;
  name: HTMLElement;
  dish: HTMLImageElement;
  chips: HTMLElement;
  plated: HTMLElement;
  stamp: HTMLElement;
  /** Keyed by `index:ingredientId:state` so duplicate components keep separate nodes. */
  chipNodes: Map<string, ChipNode>;
  last: {
    title: string; recipeId: string | null; chipKey: string; progress: number;
  };
  /** Set while the card is playing its exit animation and no longer tracks an order. */
  leaving: boolean;
}

/**
 * Identity of a ticket's whole chip row. Prefixing by index matters: cache_cookies has
 * three identical cache_fragment components, and without the index they would collapse
 * into one chip and lose their individual stages.
 */
export const ticketChipKey = (components: readonly OrderTicketComponent[]): string =>
  components.map((c, i) => `${i}:${c.ingredientId}:${c.state}:${c.stage}`).join("|");

/** Must match the exit animation length in game.css. */
const ORDER_EXIT_MS = 620;

/**
 * Collapses the guide's fine-grained stage into the four states a player needs to read at
 * a glance: not started, being prepared, ready to plate, already on the plate.
 */
export const chipState = (
  stage: OrderTicketComponent["stage"],
): "pending" | "preparing" | "ready" | "used" => {
  switch (stage) {
    case "fetch":
      return "pending";
    case "chop":
    case "cutting":
    case "cook":
    case "cooking":
      return "preparing";
    case "plate":
      return "ready";
    case "plated":
      return "used";
  }
};

/** The menu's steps, in the order a session goes through them. */
export type SplashStep = "pair" | "home" | "level" | "characters";

export interface GameUICallbacks {
  /** One character id per player, in player order. */
  onStart?: (characterIds: readonly string[]) => void | Promise<void>;
  onCharacterChange?: (characterIds: readonly string[]) => void;
  onRestart?: () => void;
  onResume?: () => void;
  onPause?: () => void;
  onMusicMuteChange?: (muted: boolean) => void;
  /** Leaves the running shift for the level and cook picker. */
  onQuitToMenu?: () => void;
  /** The shift was started from the map editor: back to it, with the map as it was. */
  onBackToEditor?: () => void;
  onCookbookVisibilityChange?: (visible: boolean) => void;
  onOpenEditor?: () => void;
  onOpenAccount?: () => void;
  /** The project's story and credits. */
  onOpenCredits?: () => void;
  /** "Criar mapa" or "Meus mapas" was pressed while signed out. */
  onMapsLocked?: () => void;
  onPlayOnComputer?: () => void;
  onOpenCollection?: (view: "items" | "achievements") => void;
  /** Fires when a level card is chosen, before the cooks are picked. */
  onLevelChange?: (entry: LevelEntry) => void;
  /** Deletes one of the player's saved maps, after they confirmed; false if it failed. */
  onDeleteLevel?: (entry: LevelEntry) => boolean;
  /** Fires with the character that should be shown live in the menu preview. */
  onCharacterPreview?: (characterIds: readonly (string | null)[]) => void;
  /** Tells the preview whether the start menu is currently on screen. */
  onPreviewActiveChange?: (active: boolean) => void;
  /** Plays the "walk together" set piece; resolves when the cooks have met. */
  onConfirmSelection?: () => Promise<void>;
}

/**
 * What the level picker needs from the 3D map. Declared here so the UI stays free of
 * Babylon; `LevelMapView` implements it.
 */
export interface LevelMapPort {
  setLevels(keys: readonly string[]): void;
  select(key: string | null): void;
  focusSelectedLevel(): Promise<boolean>;
  /** The landmark an arrow key leads to from `key`, or null when none lies that way. */
  neighbour(key: string | null, dx: number, dy: number): string | null;
  setActive(active: boolean): void;
  retry(): void;
}

export interface GameUIOptions extends GameUICallbacks {
  readonly gameplaySurface?: HTMLCanvasElement | null;
  characters?: readonly CharacterDefinition[];
  selectedCharacterIds?: readonly string[];
  /** @deprecated Use selectedCharacterIds. */
  selectedCharacterId?: string;
  recipes?: readonly RecipeData[];
  startVisible?: boolean;
}

interface NotificationEntry {
  element: HTMLElement;
  timeoutId: number;
}

const stationLabel = (id: StationId): string => translate(`stations.${id}`);
const effectLabel = (key: keyof AIState): string => translate(`effects.${key}`);

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const formatClock = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
};

const createElement = <TTag extends keyof HTMLElementTagNameMap>(
  tagName: TTag,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[TTag] => {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

/**
 * DOM-only interface for Byte Bistro. It deliberately knows nothing about Babylon.js
 * and communicates gameplay intent exclusively through callbacks.
 */
export class GameUI {
  private readonly host: HTMLElement;
  private readonly shell: HTMLElement;
  private readonly callbacks: GameUICallbacks;
  private readonly listenerController = new AbortController();
  private readonly menuVideo: HTMLVideoElement;
  private readonly menuPortrait = window.matchMedia("(max-aspect-ratio: 4/3)");
  private readonly menuReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly menuNetwork = (navigator as Navigator & {
    connection?: EventTarget & { saveData?: boolean; effectiveType?: string };
  }).connection;
  private menuBootObserver?: MutationObserver;
  private readonly notifications = new Map<number, NotificationEntry>();
  private readonly recipeById = new Map<string, RecipeData>();

  private characters: readonly CharacterDefinition[] = [];
  /** One pick per player slot (all `MAX_PLAYERS`, so a returning player keeps theirs). */
  private selectedCharacterIds: (string | null)[] = Array.from({ length: MAX_PLAYERS }, () => null);
  /** How many players this session has: set on the pairing screen. */
  private playerCount = 2;
  /** Players who confirmed their cook on the selection screen. */
  private readonly readySlots: boolean[] = Array.from({ length: MAX_PLAYERS }, () => false);
  private recipes: readonly RecipeData[] = [];
  /** Every recipe in the game; the book always lists them all. */
  private allRecipes: readonly RecipeData[] = [];
  /** The recipes the level being played serves: listed first and marked in the book. */
  private menuRecipeIds: ReadonlySet<string> = new Set();
  private selectedRecipeId: string | null = null;
  private cookbookVisible = false;
  private dialogueTimeoutId: number | null = null;
  private notificationSequence = 0;
  private readonly gameplaySurface: HTMLCanvasElement | null;
  private activeOverlay: HTMLElement | null = null;
  private lastFocusedElement: HTMLElement | null = null;
  private destroyed = false;
  /** The shown results, kept so a language change can write them out again. */
  private lastResult: Readonly<ShiftResult> | null = null;
  private readonly stopLanguage: () => void;

  private readonly splash: HTMLElement;
  private readonly characterStatus: HTMLElement;
  private readonly selectionScreen: HTMLElement;
  private readonly levelList: HTMLElement;
  private levels: readonly LevelEntry[] = [];
  private selectedLevelKey = "";
  private levelRanks: LevelRanks = {};
  private levelStars: Readonly<Record<string, number>> = {};
  private levelMap: LevelMapPort | null = null;
  private editorVisible = false;
  /** Last value sent through onPreviewActiveChange; the preview starts out drawing. */
  private previewActive = true;
  private readonly levelMapCanvas: HTMLCanvasElement;
  private readonly levelWindow: HTMLElement;
  private readonly myMaps: HTMLDetailsElement;
  private mapsLocked = true;
  private readonly startButton: HTMLButtonElement;
  private readonly hud: HTMLElement;
  private readonly pauseOverlay: HTMLElement;
  private readonly cookbookOverlay: HTMLElement;
  private readonly resultsOverlay: HTMLElement;
  private readonly cookbookNavigation: HTMLElement;
  private readonly cookbookDetail: HTMLElement;
  private readonly notificationRegion: HTMLElement;
  /** Where the disaster warnings, the chaos vignette and the screen flashes are drawn. */
  readonly disasterLayer: HTMLElement;
  private readonly orderPanel: HTMLElement;
  private readonly orderTickets: HTMLElement;
  /** Recipe ids currently drawn in the preview strip, to skip redundant rebuilds. */
  /** Live ticket rows, keyed by order id, so the list reconciles instead of rebuilding. */
  private readonly ticketNodes = new Map<string, TicketNode>();
  /** Pending exit animations, so a card is not removed while it is still playing one. */
  private readonly orderExitTimers = new Map<string, number>();
  private readonly shiftTimer: HTMLElement;
  private readonly playerStatusPanels: readonly HTMLElement[];
  /** Dismissal timers for the per-player speech bubbles, one slot each. */
  private readonly calloutTimers: (number | undefined)[] = Array.from({ length: MAX_PLAYERS }, () => undefined);
  private readonly splitDivider: HTMLElement;
  private readonly debugPanel: HTMLElement;
  private readonly debugRows: HTMLElement;
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly previewName: HTMLElement;
  private readonly previewRole: HTMLElement;
  /** The name plate beside each player's cook on the selection street. */
  private readonly pickHints: readonly HTMLElement[];

  constructor(root: HTMLElement, options: GameUIOptions = {}) {
    this.gameplaySurface = options.gameplaySurface ?? null;
    this.host = root;
    this.callbacks = options;
    this.shell = createElement("div", "game-ui");
    this.shell.dataset.gameVisible = "true";
    this.shell.style.setProperty("--pick-players", String(this.playerCount));
    this.shell.innerHTML = this.createMarkup();
    this.menuVideo = this.requireElement<HTMLVideoElement>(".bistro-home-video");
    this.menuVideo.muted = true;
    this.host.append(this.shell);

    this.splash = this.requireElement("[data-ui='splash']");
    this.selectionScreen = this.requireElement(".selection-screen");
    this.levelList = this.requireElement("[data-ui='level-list']");
    this.levelMapCanvas = this.requireElement<HTMLCanvasElement>("[data-ui='level-map-canvas']");
    this.levelWindow = this.requireElement("[data-ui='level-window']");
    this.myMaps = this.requireElement<HTMLDetailsElement>("[data-ui='my-maps']");
    this.characterStatus = this.requireElement("[data-ui='character-status']");
    this.startButton = this.requireElement("[data-action='start']");
    this.hud = this.requireElement("[data-ui='hud']");
    this.pauseOverlay = this.requireElement("[data-ui='pause']");
    this.cookbookOverlay = this.requireElement("[data-ui='cookbook']");
    this.resultsOverlay = this.requireElement("[data-ui='results']");
    this.cookbookNavigation = this.requireElement("[data-ui='cookbook-nav']");
    this.cookbookDetail = this.requireElement("[data-ui='cookbook-detail']");
    this.notificationRegion = this.requireElement("[data-ui='notifications']");
    this.disasterLayer = this.requireElement("[data-ui='disaster']");
    this.orderPanel = this.requireElement("[data-ui='order']");
    this.orderTickets = this.requireElement("[data-ui='order-tickets']");
    this.shiftTimer = this.requireElement("[data-ui='shift-timer']");
    this.playerStatusPanels = Array.from({ length: MAX_PLAYERS }, (_, index) => this.requireElement(`[data-player-status='${index}']`));
    this.splitDivider = this.requireElement("[data-ui='split-divider']");
    this.debugPanel = this.requireElement("[data-ui='debug']");
    this.debugRows = this.requireElement("[data-ui='debug-rows']");
    this.previewCanvas = this.requireElement<HTMLCanvasElement>("[data-ui='preview-canvas']");
    this.previewName = this.requireElement("[data-ui='preview-name']");
    this.previewRole = this.requireElement("[data-ui='preview-role']");
    this.pickHints = Array.from({ length: MAX_PLAYERS }, (_, index) => this.requireElement(`[data-pick-slot='${index}']`));

    this.setCharacters(
      options.characters ?? [],
      options.selectedCharacterIds ?? (options.selectedCharacterId
        ? [options.selectedCharacterId]
        : undefined),
    );
    applyTranslations(this.shell);
    this.syncLanguageButtons();
    this.bindActions();
    this.stopLanguage = onLanguageChange(() => this.retranslate());
    this.setRecipes(options.recipes ?? []);
    this.showSplash(options.startVisible ?? true);
    // The stage is chosen before the cooks. Set once here rather than on every
    // showSplash, so using the splash as a loading veil cannot flash the level list.
    this.setSplashStep("home");
    this.bindMenuVideo();
  }

  update(state: Readonly<RuntimeGameState>): void {
    if (this.destroyed) return;

    const time = formatClock(state.shiftTimeRemaining);
    if (this.shiftTimer.textContent !== time) this.shiftTimer.textContent = time;
    this.shiftTimer.closest(".round-clock")?.classList.toggle("is-urgent", state.shiftTimeRemaining <= 30);
    // The order queue is pushed imperatively from KitchenScene, which owns the countdowns.
    this.shell.dataset.shiftEnded = state.shiftEnded ? "true" : "false";
  }

  /**
   * Floats the tip a delivery earned over the cook who served it, so the reward for the
   * run and the reward for the plate read as two different things.
   */
  showTip(index: PlayerIndex, amount: number, streak: number): void {
    if (this.destroyed) return;
    const text = streak >= 2
      ? t("hud.tipWithStreak", { coins: formatNumber(amount), streak: String(streak) })
      : t("hud.tip", { coins: formatNumber(amount) });
    this.showPlayerCallout(index, text, 1_500);
  }

  /**
   * Pops a speech bubble over one cook's status card: the "Hey!" emote, and anything else
   * a cook says to their partner. Retriggering restarts the timer instead of stacking.
   */
  showPlayerCallout(index: PlayerIndex, text: string, duration = 1_800): void {
    if (this.destroyed) return;
    const bubble = this.playerStatusPanels[index]?.querySelector<HTMLElement>("[data-player-callout]");
    if (!bubble) return;
    const previous = this.calloutTimers[index];
    if (previous !== undefined) window.clearTimeout(previous);
    bubble.textContent = text;
    bubble.hidden = false;
    // Restart the pop animation: without the reflow the class is already there and a
    // second "Hey!" in a row would not move at all.
    bubble.classList.remove("is-new");
    void bubble.offsetWidth;
    bubble.classList.add("is-new");
    this.calloutTimers[index] = window.setTimeout(() => {
      bubble.hidden = true;
      this.calloutTimers[index] = undefined;
    }, Math.max(600, duration));
  }

  /** The HUD layer over the game view, for markers the scene positions itself. */
  get hudLayer(): HTMLElement {
    return this.hud;
  }

  setSplitScreen(amount: number, distance: number): void {
    if (this.destroyed) return;
    const split = clamp(amount, 0, 1);
    this.splitDivider.style.setProperty("--split-opacity", split.toFixed(3));
    this.splitDivider.hidden = split < 0.01;
    this.splitDivider.setAttribute("aria-label", t("hud.splitAria", { distance: formatNumber(distance, { maximumFractionDigits: 1 }) }));
  }

  notify(message: string, tone: NotificationTone = "info", duration = 3_400): void {
    if (this.destroyed || !message.trim()) return;
    const id = ++this.notificationSequence;
    const notification = createElement("div", "game-notification");
    notification.dataset.tone = tone;
    notification.dataset.notificationId = id.toString();

    const signal = createElement("span", "notification-signal");
    signal.setAttribute("aria-hidden", "true");
    const copy = createElement("span", "notification-copy", message.trim());
    notification.append(signal, copy);
    this.notificationRegion.prepend(notification);

    const timeoutId = window.setTimeout(() => this.dismissNotification(id), Math.max(1_200, duration));
    this.notifications.set(id, { element: notification, timeoutId });

    const oldest = [...this.notifications.keys()].at(0);
    if (this.notifications.size > 4 && oldest !== undefined) this.dismissNotification(oldest);
  }

  /** The CORE no longer runs the kitchen, so its dialogue box was removed. */
  showDialogue(_text: string, _expression: MiraExpression, _duration = 5_200): void {
    void _text; void _expression; void _duration;
  }

  hideDialogue(): void {
    // Intentionally empty; kept so existing callers keep compiling.
  }

  setCharacters(
    characters: readonly CharacterDefinition[],
    selectedCharacterIds?: readonly string[],
  ): void {
    this.characters = [...characters];
    const resolve = (index: number): string | null => {
      const requested = selectedCharacterIds?.[index];
      if (requested && this.characters.some(({ id }) => id === requested)) return requested;
      const current = this.selectedCharacterIds[index];
      if (current && this.characters.some(({ id }) => id === current)) return current;
      // Each player starts on a different cook where there are enough of them.
      return this.characters[index % Math.max(1, this.characters.length)]?.id ?? null;
    };
    this.selectedCharacterIds = this.selectedCharacterIds.map((_, index) => resolve(index));
    this.renderCharacterSelector();
  }

  /** The picks of the players in this session, one per player. */
  private activePicks(): (string | null)[] {
    return this.selectedCharacterIds.slice(0, this.playerCount);
  }

  get players(): number {
    return this.playerCount;
  }

  /**
   * Sets the number of cooks on the selection street and clears everyone's "ready".
   */
  setPlayerCount(count: number): void {
    const next = clampPlayerCount(count);
    this.readySlots.fill(false);
    this.playerCount = next;
    // The name plates centre themselves on the cooks' row (selection-street.css).
    this.shell.style.setProperty("--pick-players", String(next));
    this.renderCharacterSelector();
  }

  setRecipes(recipes: readonly RecipeData[]): void {
    this.allRecipes = [...recipes];
    this.orderRecipes();
  }

  /**
   * The level's menu. The book still lists every recipe in the game (players asked to read
   * the ones from other levels too); the menu's come first, marked, and open selected.
   */
  setMenuRecipes(ids: readonly string[]): void {
    this.menuRecipeIds = new Set(ids);
    if (ids[0]) this.selectedRecipeId = ids[0];
    this.orderRecipes();
  }

  private orderRecipes(): void {
    const onMenu = (recipe: RecipeData) => (this.menuRecipeIds.has(recipe.id) ? 0 : 1);
    this.recipes = [...this.allRecipes].sort((a, b) => onMenu(a) - onMenu(b));
    this.recipeById.clear();
    this.recipes.forEach((recipe) => this.recipeById.set(recipe.id, recipe));

    if (!this.selectedRecipeId || !this.recipeById.has(this.selectedRecipeId)) {
      this.selectedRecipeId = this.recipes[0]?.id ?? null;
    }
    this.renderCookbook();
  }

  toggleCookbook(force?: boolean): boolean {
    if (this.destroyed) return false;
    const visible = force ?? !this.cookbookVisible;
    if (visible === this.cookbookVisible) return visible;

    this.cookbookVisible = visible;
    this.cookbookOverlay.hidden = !visible;
    this.callbacks.onCookbookVisibilityChange?.(visible);
    this.syncOverlayFocus();
    return visible;
  }

  setPausedVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.pauseOverlay.hidden = !visible;
    this.syncOverlayFocus();
  }

  showResults(result: Readonly<ShiftResult>): void {
    if (this.destroyed) return;
    this.lastResult = result;
    this.writeResults(result);
    this.resultsOverlay.hidden = false;
    this.syncOverlayFocus();
  }

  private writeResults(result: Readonly<ShiftResult>): void {
    const quality = result.averageDishQuality <= 1
      ? result.averageDishQuality * 100
      : result.averageDishQuality;

    this.setResultValue("completed", result.ordersCompleted.toString());
    this.setResultValue("failed", result.ordersFailed.toString());
    this.setResultValue("quality", `${Math.round(clamp(quality, 0, 100))}%`);
    this.setResultValue("stability", `${Math.round(clamp(result.miraStability, 0, 100))}%`);
    this.setResultValue("score", formatNumber(Math.round(result.cookingScore)));
    this.setResultValue("credits", `+${formatNumber(Math.max(0, Math.round(result.creditsEarned)))}`);
    this.setResultValue("combo", `X${result.maxCombo}`);
    this.setResultValue("throws", result.componentsThrown.toString());
    this.setResultValue("sync", `${Math.round(result.teamSynchronization)}%`);
    this.setResultValue("meltdowns", result.meltdowns.toString());

    const rank = this.requireElement("[data-result-rank]");
    rank.textContent = result.rank;
    rank.dataset.rank = result.rank;
    this.requireElement("[data-result-message]").textContent = this.getRankMessage(result.rank);

    // Stars are the level's own goal, met in coins; the rank beside them is the note on
    // how the shift was played. See src/data/levelGoals.ts.
    const stars = this.requireElement("[data-result-stars]");
    stars.dataset.stars = String(result.stars);
    for (const star of stars.querySelectorAll<HTMLElement>("[data-star]")) {
      star.dataset.filled = Number(star.dataset.star) <= result.stars ? "true" : "false";
    }
    const next = nextStarTarget(result.coins, result.starThresholds);
    this.requireElement("[data-result-star-note]").textContent =
      !Number.isFinite(result.starThresholds.three)
        ? ""
        : next === null
          ? t("results.starsAllEarned")
          : t("results.starsToGo", { coins: formatNumber(Math.max(0, next - result.coins)) });
  }

  hideResults(): void {
    if (this.destroyed) return;
    this.resultsOverlay.hidden = true;
    this.syncOverlayFocus();
  }

  updateDebug(snapshot: Readonly<GameUIDebugSnapshot> | null): void {
    if (this.destroyed) return;
    this.debugPanel.hidden = snapshot === null;
    if (!snapshot) return;

    const rows: Array<readonly [string, string]> = [];
    if (snapshot.fps !== undefined) rows.push(["FPS", snapshot.fps.toFixed(1)]);
    if (snapshot.playerPosition !== undefined) {
      const position = snapshot.playerPosition;
      const xyz: readonly [number, number, number] = "x" in position
        ? [position.x, position.y, position.z]
        : position;
      rows.push(["BYTE POS", xyz.map((value) => value.toFixed(1)).join("  ")]);
    }
    if (snapshot.carrying !== undefined) rows.push(["CARRYING", snapshot.carrying ?? "—"]);
    if (snapshot.character !== undefined) rows.push(["CHARACTER", snapshot.character]);
    if (snapshot.characterBounds !== undefined) rows.push(["CHAR BOUNDS", snapshot.characterBounds]);
    if (snapshot.characterAnimation !== undefined) rows.push(["CHAR ANIM", snapshot.characterAnimation]);
    if (snapshot.nearbyStation !== undefined) rows.push(["STATION", snapshot.nearbyStation ?? "—"]);
    if (snapshot.orders !== undefined) rows.push(["ORDERS", snapshot.orders ?? "—"]);
    if (snapshot.shiftTimeRemaining !== undefined) rows.push(["SHIFT", formatClock(snapshot.shiftTimeRemaining)]);
    if (snapshot.score !== undefined) rows.push(["SCORE", Math.round(snapshot.score).toString()]);
    if (snapshot.cameraDistance !== undefined) rows.push(["P1 ↔ P2", `${snapshot.cameraDistance.toFixed(1)}m`]);
    if (snapshot.splitAmount !== undefined) rows.push(["CAM SPLIT", `${Math.round(snapshot.splitAmount * 100)}%`]);
    if (snapshot.aiState) {
      rows.push([
        "AI STATE",
        `M${Math.round(snapshot.aiState.memory)} P${Math.round(snapshot.aiState.processing)} ` +
          `S${Math.round(snapshot.aiState.stability)} T${Math.round(snapshot.aiState.temperature)}`,
      ]);
    }

    this.debugRows.replaceChildren();
    for (const [label, value] of rows) {
      const row = createElement("div", "debug-row");
      row.append(createElement("span", "debug-key", label), createElement("span", "debug-value", value));
      this.debugRows.append(row);
    }
  }

  setMapLoading(loading: boolean): void {
    this.setStartLoading(loading);
    this.splash.inert = loading || Boolean(this.activeOverlay && this.activeOverlay !== this.splash);
    this.splash.setAttribute("aria-busy", String(loading));
  }

  setEditorVisible(visible: boolean): void {
    if (this.destroyed) return;
    // The editor is a sibling of this shell. Hide all game overlays together,
    // preserving the splash/pause state to restore when the editor closes.
    this.shell.style.display = visible ? "none" : "";
    this.shell.inert = visible;
    this.editorVisible = visible;
    this.updateLevelMapActivity();
  }

  setGameVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.shell.dataset.gameVisible = visible ? "true" : "false";
    this.hud.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  /** Whether the cook street is on screen, for a preview created after the UI. */
  get isPreviewActive(): boolean {
    return this.previewActive;
  }

  /** The splash is opaque and covers the whole canvas, so nothing behind it needs drawing. */
  get isSplashVisible(): boolean {
    return !this.splash.hidden;
  }

  setMusicMuted(muted: boolean): void {
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>("[data-action='mute-music']")) {
      button.setAttribute("aria-pressed", String(muted));
    }
  }

  showSplash(visible = true): void {
    if (this.destroyed) return;
    this.splash.hidden = !visible;
    // Start keeps focus as the splash hides; a hidden focused button would still swallow
    // player two's Enter during the shift.
    if (!visible && document.activeElement instanceof HTMLElement &&
      this.splash.contains(document.activeElement)) document.activeElement.blur();
    this.setGameVisible(!visible);
    this.syncOverlayFocus();
    // Back from a shift, everyone confirms their cook again before the next one.
    if (visible && this.readySlots.some(Boolean)) {
      this.readySlots.fill(false);
      this.renderCharacterSelector();
    }
    this.updateLevelMapActivity();
    if (visible) this.focusSplash();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopLanguage();
    this.listenerController.abort();
    this.menuBootObserver?.disconnect();
    this.menuVideo.pause();
    if (this.dialogueTimeoutId !== null) window.clearTimeout(this.dialogueTimeoutId);
    for (const timer of this.calloutTimers) if (timer !== undefined) window.clearTimeout(timer);
    for (const entry of this.notifications.values()) window.clearTimeout(entry.timeoutId);
    this.notifications.clear();
    this.shell.remove();
  }

  root(): HTMLElement {
    return this.host;
  }

  characterPreviewCanvas(): HTMLCanvasElement {
    return this.previewCanvas;
  }

  levelMapCanvasElement(): HTMLCanvasElement {
    return this.levelMapCanvas;
  }

  /** Connects the 3D map to the levels already known. */
  attachLevelMap(map: LevelMapPort): void {
    this.levelMap = map;
    map.setLevels(mapLevels(this.levels).map((entry) => entry.key));
    if (this.splashStep === "level") this.refreshMapLevel();
    this.updateLevelMapActivity();
  }

  /** Marks a level as the chosen one without re-announcing it (the game already knows). */
  markLevelSelected(key: string): void {
    if (!this.levels.some((entry) => entry.key === key)) return;
    this.selectedLevelKey = key;
    this.selectedMapKey = mapLevels(this.levels).some((entry) => entry.key === key) ? key : "";
    this.renderLevels();
    this.levelMap?.select(this.selectedMapKey || null);
  }

  /** Best rank per level, for the stars in the level window. */
  /**
   * @param stars best stars per level. Stars come from coins now, but a save written
   * before that has none of its own, so the rank is still the fallback.
   */
  setLevelRanks(ranks: LevelRanks, stars: Readonly<Record<string, number>> = {}): void {
    this.levelRanks = ranks;
    this.levelStars = stars;
    if (this.selectedMapKey) this.fillLevelWindow(this.selectedMapKey);
  }

  /** Follow the landmark picked on the map. */
  pickMapLevel(key: string | null): void {
    if (key) this.selectMapLevel(key);
  }

  refreshCharacterPreview(): void {
    this.updatePreview();
  }

  private updatePreview(): void {
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      const active = slot < this.playerCount;
      const hint = this.pickHints[slot]!;
      hint.hidden = !active;
      hint.dataset.ready = String(active && this.readySlots[slot] === true);
      const character = this.characters.find((entry) => entry.id === this.selectedCharacterIds[slot]) ?? null;
      const plate = hint.querySelector<HTMLElement>("[data-pick-name]")!;
      plate.textContent = character
        ? character.variant
          ? `${character.displayName} · ${character.variant}`
          : character.displayName
        : "—";
      if (slot === 0) {
        this.previewName.textContent = plate.textContent;
        this.previewRole.textContent = character?.role ?? "";
      }
    }
    this.callbacks.onCharacterPreview?.(this.activePicks());
  }


  /**
   * Renders the order queue as a list of tickets.
   *
   * Reconciles against cached nodes instead of rebuilding markup: this runs every frame, so
   * re-writing innerHTML would restart CSS transitions and churn the DOM sixty times a
   * second. Text is only touched when its value actually changed.
   */
  setOrderTickets(tickets: readonly OrderTicketInfo[]): void {
    if (this.destroyed) return;
    this.orderPanel.classList.toggle("is-empty", tickets.length === 0);

    let anyCritical = false;
    const seen = new Set<string>();
    tickets.forEach((ticket, index) => {
      seen.add(ticket.orderId);
      const node = this.ticketNodes.get(ticket.orderId) ?? this.createTicketNode(ticket.orderId);
      const fraction = ticket.totalSeconds > 0
        ? Math.max(0, Math.min(1, ticket.secondsRemaining / ticket.totalSeconds))
        : 0;

      if (node.last.title !== ticket.title) {
        node.last.title = ticket.title;
        node.name.textContent = ticket.title;
        // The name is not drawn on the card (icons only), so it lives on as its label.
        node.root.title = ticket.title;
        node.root.setAttribute("aria-label", ticket.title);
      }
      if (node.last.recipeId !== ticket.recipeId) {
        node.last.recipeId = ticket.recipeId;
        node.dish.hidden = !ticket.recipeId;
        if (ticket.recipeId) {
          node.dish.hidden = false;
          node.dish.src = publicUrl(`images/dishes/${ticket.recipeId}.png`);
          node.dish.alt = this.recipeById.get(ticket.recipeId)?.displayName ?? t("hud.requestedDish");
        }
      }

      this.syncTicketChips(node, ticket);

      const progress = Math.round(fraction * 1000) / 10;
      if (node.last.progress !== progress) {
        node.last.progress = progress;
        node.root.style.setProperty("--progress", `${progress}%`);
      }
      // The oldest order sits first and is the one the players should clear next.
      this.setFlag(node.root, "lead", index === 0);
      this.setFlag(node.root, "ready", ticket.readyToDeliver);
      const urgency = fraction <= 0 ? "expired"
        : fraction < 0.22 ? "critical"
        : fraction < 0.5 ? "warning"
        : "nominal";
      if (node.root.dataset.urgency !== urgency) node.root.dataset.urgency = urgency;
      anyCritical ||= urgency === "critical" || urgency === "expired";
      const player = ticket.assignedTo === null ? "" : `p${ticket.assignedTo + 1}`;
      if (node.root.dataset.player !== player) node.root.dataset.player = player;

    });

    // Reorder only when the sequence actually changed. Re-inserting a node restarts every
    // CSS animation on it, which made the whole queue flicker once per frame.
    this.reorderTickets(tickets);

    for (const [orderId, node] of this.ticketNodes) {
      if (seen.has(orderId) || node.leaving) continue;
      // No outcome was flagged (the shift ended, or the card scrolled past the cap), so it
      // just goes away rather than claiming it was delivered or lost.
      this.removeTicketNode(orderId, node);
    }
    this.orderPanel.classList.toggle("is-urgent", anyCritical);
  }

  /** Moves cards into `visible` order, touching the DOM only where it actually differs. */
  private reorderTickets(visible: readonly OrderTicketInfo[]): void {
    const desired: HTMLElement[] = [];
    for (const ticket of visible) {
      const node = this.ticketNodes.get(ticket.orderId);
      if (node) desired.push(node.root);
    }
    // Cards going away animate over their old slots without taking a grid cell.
    const live = Array.from(this.orderTickets.children).filter(
      (child) => !(child as HTMLElement).dataset.outcome,
    );
    const alreadyCorrect =
      live.length === desired.length && live.every((child, index) => child === desired[index]);
    if (alreadyCorrect) return;
    for (const element of desired) this.orderTickets.append(element);
  }

  /**
   * Marks how an order ended so its card can play the matching exit animation.
   *
   * Called from the scene's existing order:completed / order:failed events — the card then
   * outlives the order for the length of the animation, which is why `leaving` exists.
   */
  flagOrderOutcome(orderId: string, outcome: OrderOutcome): void {
    if (this.destroyed) return;
    const node = this.ticketNodes.get(orderId);
    if (!node || node.leaving) return;
    node.leaving = true;
    const { offsetLeft, offsetTop, offsetWidth } = node.root;
    node.root.style.left = `${offsetLeft}px`;
    node.root.style.top = `${offsetTop}px`;
    node.root.style.width = `${offsetWidth}px`;
    node.root.dataset.outcome = outcome;
    node.stamp.textContent = outcome === "delivered" ? "✓" : "✕";
    const timeoutId = window.setTimeout(() => {
      this.orderExitTimers.delete(orderId);
      this.removeTicketNode(orderId, node);
    }, ORDER_EXIT_MS);
    this.orderExitTimers.set(orderId, timeoutId);
  }

  /**
   * Makes one ticket flash, so a cook's "Hey!" can point at what they are working on.
   *
   * Purely decorative and self-clearing: the CSS animation removes its own class on the
   * way out, and a ticket that leaves mid-flash takes the class with it.
   */
  flashOrder(orderId: string): void {
    if (this.destroyed) return;
    const node = this.ticketNodes.get(orderId);
    if (!node || node.leaving) return;
    node.root.classList.remove("is-flagged");
    void node.root.offsetWidth;
    node.root.classList.add("is-flagged");
  }

  private removeTicketNode(orderId: string, node: TicketNode): void {
    const pending = this.orderExitTimers.get(orderId);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      this.orderExitTimers.delete(orderId);
    }
    node.root.remove();
    this.ticketNodes.delete(orderId);
  }

  private setFlag(element: HTMLElement, name: string, on: boolean): void {
    const value = on ? "1" : "";
    if (element.dataset[name] !== value) element.dataset[name] = value;
  }

  /**
   * One chip per recipe component: the card shows what the dish needs and how far along
   * each ingredient is.
   *
   * Gated behind a single key comparison, so a steady-state frame costs one string build
   * and one `===` rather than touching the DOM.
   */
  private syncTicketChips(node: TicketNode, ticket: OrderTicketInfo): void {
    const key = `${getLanguage()}|${ticketChipKey(ticket.components)}`;
    if (node.last.chipKey === key) return;
    node.last.chipKey = key;

    const plated = ticket.components.filter(component => component.stage === "plated").length;
    const total = ticket.components.length;
    node.plated.hidden = total === 0;
    node.plated.textContent = total > 0 ? `${plated}/${total}` : "";
    node.plated.setAttribute("aria-label", t("hud.platedCount", { plated, total }));

    const seen = new Set<string>();
    ticket.components.forEach((component, index) => {
      const id = `${index}:${component.ingredientId}:${component.state}`;
      seen.add(id);
      let chip = node.chipNodes.get(id);
      if (!chip) {
        chip = this.createChipNode(component.ingredientId, component.state);
        node.chipNodes.set(id, chip);
      }
      const ingredient = getIngredient(component.ingredientId);
      chip.root.style.setProperty("--chip-color", ingredient?.color ?? "#5CE6FF");
      chip.root.dataset.state = chipState(component.stage);
      for (const step of chip.steps) {
        const status = stepStatus(step.station, component.stage);
        if (step.icon.dataset.step !== status) step.icon.dataset.step = status;
      }
      // Read by the fallback tile (no ingredient art) as its label.
      chip.tile.dataset.short = (ingredient?.shortName ?? component.ingredientId).slice(0, 3).toUpperCase();
      // Every station, in order: a cooked RAM module reads "board → stove", not just "stove".
      const route = chip.steps.length > 0
        ? chip.steps.map((step) => step.station === "stove"
          ? t(component.state === "boiled" ? "kitchen.pot" : "kitchen.pan")
          : STATION_KIND_LABEL[step.station]).join(" → ")
        : FOOD_STATE_LABEL[component.state];
      chip.root.title = `${ingredient?.displayName ?? component.ingredientId} · ${route} · ${t(`hud.componentStage.${component.stage}`)}`;
      chip.root.setAttribute("aria-label", chip.root.title);
      node.chips.append(chip.root);
    });

    for (const [id, chip] of node.chipNodes) {
      if (seen.has(id)) continue;
      chip.root.remove();
      node.chipNodes.delete(id);
    }
  }

  private createChipNode(ingredientId: string, state: FoodState): ChipNode {
    const root = createElement("li", "order-chip");
    const tile = createElement("span", "order-chip-tile");
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    // Ingredient art is optional: without a PNG the chip falls back to the ingredient's
    // own colour and short name, which the data already carries.
    img.addEventListener("error", () => {
      root.dataset.fallback = "1";
      img.hidden = true;
    }, { once: true });
    img.src = publicUrl(ingredientIllustration(ingredientId));
    img.className = "order-chip-art";
    tile.append(img);
    root.append(tile);
    // The route never changes for a component, so the station icons are built once, stacked
    // under the ingredient the way a ticket in a busy kitchen reads: what, then where.
    const steps = preparationSteps(ingredientId, state).map((station) => {
      const icon = createElement("span", "order-chip-step");
      icon.dataset.station = station;
      const stationImg = document.createElement("img");
      stationImg.alt = "";
      stationImg.src = publicUrl(`assets/ui/hud/${station}.webp`);
      icon.append(stationImg);
      return { station, icon };
    });
    if (steps.length > 0) {
      const row = createElement("span", "order-chip-steps");
      row.append(...steps.map((step) => step.icon));
      root.append(row);
    }
    return { root, tile, steps };
  }

  private createTicketNode(orderId: string): TicketNode {
    const root = createElement("li", "order-card");
    root.innerHTML = `
      <div class="order-card-dish">
        <img class="order-card-art" data-t="dish" hidden alt="" />
        <span class="order-card-plated" data-t="plated" hidden></span>
      </div>
      <strong class="order-card-name" data-t="name"></strong>
      <span class="order-card-ready" data-i18n="hud.deliver"></span>
      <ul class="order-chips" data-t="chips"></ul>
      <span class="order-card-track"><span class="order-card-fill"></span></span>
      <span class="order-card-stamp" data-t="stamp" aria-hidden="true"></span>
    `;
    // Cards arrive after the shell was translated; later language switches re-run
    // applyTranslations over the whole shell, this label included.
    applyTranslations(root);
    const pick = <T extends HTMLElement>(name: string): T => {
      const found = root.querySelector<T>(`[data-t="${name}"]`);
      if (!found) throw new Error(`Missing ticket element: ${name}`);
      return found;
    };
    const node: TicketNode = {
      root,
      name: pick("name"),
      dish: pick<HTMLImageElement>("dish"),
      chips: pick("chips"),
      plated: pick("plated"),
      stamp: pick("stamp"),
      chipNodes: new Map(),
      last: { title: "", recipeId: null, chipKey: "", progress: -1 },
      leaving: false,
    };
    // One-shot entry animation: the class is dropped once it finishes, so moving the card
    // later (when the queue reorders) cannot replay it.
    if (!this.menuReducedMotion.matches) {
      root.classList.add("is-entering");
      const finishEntry = (): void => { root.classList.remove("is-entering"); };
      root.addEventListener("animationend", finishEntry, { once: true });
      root.addEventListener("animationcancel", finishEntry, { once: true });
    }
    this.ticketNodes.set(orderId, node);
    // A recipe with no art of its own shows no icon rather than a broken one.
    node.dish.addEventListener("error", () => { node.dish.hidden = true; }, { once: true });
    this.orderTickets.append(root);
    return node;
  }

  /**
   * Fills the level picker. Called once at boot and again whenever a map is saved, so a
   * level built in the editor shows up without a page reload.
   */
  /** The account button shows the signed-in player's picture (null: the default badge). */
  setAccountAvatar(url: string | null): void {
    const button = this.shell.querySelector<HTMLElement>("[data-action=account]");
    if (!button) return;
    if (url) button.style.setProperty("--home-icon", `url("${url.replace(/["\\]/g, "")}")`);
    else button.style.removeProperty("--home-icon");
    button.toggleAttribute("data-avatar", url !== null);
  }

  /** Pause and results offer "back to the editor" while a map from the editor is played. */
  setEditorReturn(available: boolean): void {
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>("[data-action='back-to-editor']")) {
      button.hidden = !available;
    }
  }

  /** Creating and listing maps needs an account; signed out, both buttons show a lock. */
  setMapsLocked(locked: boolean): void {
    if (this.mapsLocked === locked) return;
    this.mapsLocked = locked;
    this.myMaps.toggleAttribute("data-locked", locked);
    this.shell.querySelector("[data-action='open-editor']")?.toggleAttribute("data-locked", locked);
    this.renderLevels();
  }

  setLevels(entries: readonly LevelEntry[]): void {
    this.levels = entries;
    if (!entries.some((entry) => entry.key === this.selectedLevelKey)) {
      this.selectedLevelKey = mapLevels(entries)[0]?.key ?? entries[0]?.key ?? "";
    }
    this.renderLevels();
    this.levelMap?.setLevels(mapLevels(entries).map((entry) => entry.key));
    if (this.splashStep === "level") this.refreshMapLevel();
  }

  private renderLevels(): void {
    const kindLabel: Readonly<Record<LevelEntry["kind"], string>> = {
      scenario: t("level.kindScenario"),
      official: t("level.kindOfficial"),
      saved: t("level.kindSaved"),
    };
    this.levelList.replaceChildren();
    // The official levels live on the map; the list only holds the player's own maps.
    const saved = this.levels.filter((entry) => entry.kind === "saved");
    // Signed out, "Meus mapas" stays in sight with a lock (it asks to sign in) and lists nothing.
    this.myMaps.hidden = !this.mapsLocked && saved.length === 0;
    if (this.mapsLocked || saved.length === 0) this.myMaps.open = false;
    for (const entry of this.mapsLocked ? [] : saved) {
      const item = document.createElement("li");
      const card = document.createElement("button");
      card.type = "button";
      card.className = "level-card";
      card.dataset.levelKey = entry.key;
      card.dataset.kind = entry.kind;
      card.setAttribute("aria-pressed", String(entry.key === this.selectedLevelKey));

      const kind = document.createElement("span");
      kind.className = "level-card-kind";
      kind.textContent = kindLabel[entry.kind];

      const title = document.createElement("h3");
      title.className = "level-card-title";
      title.textContent = entry.title;

      const description = document.createElement("p");
      description.className = "level-card-description";
      description.textContent = entry.description || entry.summary || "";

      const meta = document.createElement("div");
      meta.className = "level-card-meta";
      for (const text of [entry.difficultyLabel, formatShiftDuration(entry.shiftDurationSeconds)]) {
        const chip = document.createElement("span");
        chip.textContent = text;
        meta.append(chip);
      }

      card.append(kind, title, description, meta);
      // A sibling of the card, not a child: a button cannot sit inside another button.
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "level-card-delete";
      remove.dataset.deleteLevel = entry.key;
      remove.setAttribute("aria-label", t("level.deleteAria", { title: entry.title }));
      remove.title = t("level.deleteTitle");
      remove.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h2v-8h-2zm4 0v8h2v-8h-2z"/></svg>`;
      item.append(card, remove);
      this.levelList.append(item);
    }
  }

  /** Asks first; the map is gone for good once confirmed. */
  private async deleteLevel(key: string): Promise<void> {
    const entry = this.levels.find((level) => level.key === key && level.kind === "saved");
    if (!entry || !this.callbacks.onDeleteLevel) return;
    const confirmed = await confirmDialog({
      title: t("level.confirmDeleteTitle"),
      message: t("level.confirmDeleteMessage", { title: entry.title }),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!confirmed) return;
    if (this.callbacks.onDeleteLevel(entry)) {
      this.notify(t("level.deleted", { title: entry.title }), "warning");
    } else {
      this.notify(t("level.deleteFailed"), "error");
    }
  }

  /**
   * `pair` connects the phones (and so the players), `home` is the menu, `level` picks the
   * stage, `characters` picks the cooks.
   */
  setSplashStep(step: SplashStep): void {
    const previous = this.selectionScreen.dataset.step;
    this.selectionScreen.dataset.step = step;
    this.requireElement<HTMLButtonElement>("[data-action='back-level']").hidden = step !== "characters";
    if (step === "characters") {
      // Everyone confirms their cook afresh each time the street opens.
      if (previous !== "characters") this.readySlots.fill(false);
      this.renderCharacterSelector();
      this.startButton.focus();
    } else {
      if (step === "level") this.refreshMapLevel();
      this.focusSplash();
    }
    this.updateLevelMapActivity();
  }

  get splashStep(): SplashStep {
    return (this.selectionScreen.dataset.step as SplashStep | undefined) ?? "home";
  }

  /** Where the phone pairing panel (QR code and player slots) is drawn. */
  pairPanel(): HTMLElement {
    return this.requireElement("[data-ui='pair-panel']");
  }

  /** Whether a player has confirmed their cook on the selection street. */
  isReady(slot: number): boolean {
    return this.readySlots[slot] === true;
  }

  /**
   * A player's own command on the selection street: left/right browse their cook, A
   * confirms it (and, once everyone has, player one's A starts), B takes the confirmation
   * back or, for player one with nothing to take back, returns to the levels.
   */
  selectionCommand(slot: number, command: MenuCommand): void {
    if (this.splash.hidden || this.splashStep !== "characters" || slot >= this.playerCount) return;
    if (this.startButton.dataset.loading === "true") return;
    switch (command) {
      case "left":
      case "right":
        if (this.readySlots[slot]) return;
        this.browseCharacter(slot, command === "left" ? -1 : 1);
        return;
      case "confirm":
        if (!this.readySlots[slot]) {
          if (!this.selectedCharacterIds[slot]) return;
          this.readySlots[slot] = true;
          this.renderCharacterSelector();
          return;
        }
        if (slot === 0 && this.allReady()) this.startButton.click();
        return;
      case "back":
        if (this.readySlots[slot]) {
          this.readySlots[slot] = false;
          this.renderCharacterSelector();
        } else if (slot === 0) {
          this.requireElement<HTMLButtonElement>("[data-action='back-level']").click();
        }
        return;
      default:
        return;
    }
  }

  private allReady(): boolean {
    for (let slot = 0; slot < this.playerCount; slot++) if (!this.readySlots[slot]) return false;
    return true;
  }

  private chooseLevel(key: string): void {
    const entry = this.levels.find((level) => level.key === key);
    if (!entry) return;
    this.selectedLevelKey = key;
    this.renderLevels();
    this.levelMap?.select(key);
    this.callbacks.onLevelChange?.(entry);
    this.setSplashStep("characters");
  }

  private bindMenuVideo(): void {
    const signal = this.listenerController.signal;
    document.addEventListener("visibilitychange", this.syncMenuVideo, { signal });
    this.menuPortrait.addEventListener("change", this.syncMenuVideo, { signal });
    this.menuReducedMotion.addEventListener("change", this.syncMenuVideo, { signal });
    this.menuNetwork?.addEventListener("change", this.syncMenuVideo, { signal });
    this.menuVideo.addEventListener("playing", () => { this.menuVideo.dataset.playing = "true"; }, { signal });
    const clearPlaying = () => { delete this.menuVideo.dataset.playing; };
    this.menuVideo.addEventListener("pause", clearPlaying, { signal });
    this.menuVideo.addEventListener("error", clearPlaying, { signal });
    const loader = document.getElementById("boot-loader");
    if (loader && loader.dataset.state !== "done") {
      this.menuBootObserver = new MutationObserver(() => {
        if (loader.dataset.state !== "done") return;
        this.menuBootObserver?.disconnect();
        this.syncMenuVideo();
      });
      this.menuBootObserver.observe(loader, { attributes: true, attributeFilter: ["data-state"] });
    }
    this.syncMenuVideo();
  }

  private readonly syncMenuVideo = (): void => {
    const loader = document.getElementById("boot-loader");
    const play = !this.destroyed && !document.hidden && !this.menuReducedMotion.matches
      && !this.splash.hidden && !this.editorVisible && this.selectionScreen.dataset.step === "home"
      && (!loader || loader.hidden || loader.dataset.state === "done");
    if (!play) {
      delete this.menuVideo.dataset.playing;
      this.menuVideo.pause();
      return;
    }
    const orientation = this.menuPortrait.matches ? "portrait" : "landscape";
    const constrained = this.menuNetwork?.saveData === true
      || ["slow-2g", "2g", "3g"].includes(this.menuNetwork?.effectiveType ?? "");
    const quality = constrained ? "lite" : "hq";
    if (this.menuVideo.dataset.orientation !== orientation || this.menuVideo.dataset.quality !== quality) {
      this.menuVideo.dataset.orientation = orientation;
      this.menuVideo.dataset.quality = quality;
      delete this.menuVideo.dataset.playing;
      const variants = constrained ? [""] : ["-hq-v1", ""];
      this.menuVideo.replaceChildren(...variants.flatMap((variant) => (["webm", "mp4"] as const).map((format) => {
        const source = document.createElement("source");
        source.type = format === "webm" ? 'video/webm; codecs="vp9"' : 'video/mp4; codecs="avc1.640028"';
        source.src = publicUrl(`assets/ui/cinematic/chase-${orientation}${variant}.${format}`);
        return source;
      })));
      this.menuVideo.load();
    }
    if (this.menuVideo.paused) void this.menuVideo.play().catch(() => undefined);
  };

  /**
   * Each menu canvas draws only while its step is on screen: the map on the level step, the
   * cook street on the cook step. The street used to keep drawing — soft shadows, two
   * skinned cooks, walking robots — behind the map, into a canvas set to display: none.
   */
  private updateLevelMapActivity(): void {
    this.syncMenuVideo();
    const menuShown = !this.splash.hidden && !this.editorVisible;
    this.levelMap?.setActive(menuShown && this.selectionScreen.dataset.step === "level");
    const previewActive = menuShown && this.selectionScreen.dataset.step === "characters";
    if (previewActive !== this.previewActive) {
      this.previewActive = previewActive;
      this.callbacks.onPreviewActiveChange?.(previewActive);
    }
  }

  /** Route keyboard navigation to the map when choosing a level. */
  private focusSplash(): void {
    const step = this.selectionScreen.dataset.step;
    if (step === "home") {
      const play = this.requireElement<HTMLButtonElement>("[data-action='home-play']");
      window.requestAnimationFrame(() => play.focus({ preventScroll: true }));
    } else if (step === "level") {
      window.requestAnimationFrame(() => this.levelMapCanvas.focus({ preventScroll: true }));
    } else {
      this.focusFirst(this.splash);
    }
  }

  private selectedMapKey = "";

  private selectMapLevel(key: string): boolean {
    if (!this.fillLevelWindow(key)) return false;
    this.selectedMapKey = key;
    if (!key.startsWith("future:")) this.selectedLevelKey = key;
    this.levelMap?.select(key);
    this.levelWindow.hidden = false;
    return true;
  }

  private refreshMapLevel(): void {
    if (this.selectedMapKey && this.selectMapLevel(this.selectedMapKey)) return;
    const first = mapLevels(this.levels)[0];
    if (first) this.selectMapLevel(first.key);
    else this.levelWindow.hidden = true;
  }

  private async confirmMapLevel(): Promise<void> {
    const key = this.selectedMapKey;
    if (!key || key.startsWith("future:") || !await this.levelMap?.focusSelectedLevel()) return;
    if (this.splashStep === "level" && key === this.selectedMapKey) this.chooseLevel(key);
  }

  /** Writes a level's details into the window; false when the level no longer exists. */
  private fillLevelWindow(key: string): boolean {
    const future = { "future:univille": "level.mapUniville", "future:pauli": "level.mapPauli", "future:schlachtfest": "level.mapSchlachtfest" } as const;
    const futureTitle = future[key as keyof typeof future];
    const play = this.requireElement<HTMLButtonElement>("[data-action='play-level']");
    play.hidden = Boolean(futureTitle);
    if (futureTitle) {
      this.requireElement("[data-ui='level-window-kind']").textContent = t("level.comingSoon");
      this.requireElement("[data-ui='level-window-title']").textContent = t(futureTitle);
      this.requireElement("[data-ui='level-window-description']").textContent = t("level.comingSoonDescription");
      this.requireElement("[data-ui='level-window-best']").textContent = "";
      this.requireElement("[data-ui='level-window-meta']").replaceChildren();
      this.requireElement("[data-ui='level-window-rank']").hidden = true;
      return true;
    }
    this.requireElement("[data-ui='level-window-rank']").hidden = false;
    const levels = mapLevels(this.levels);
    const index = levels.findIndex((level) => level.key === key);
    const entry = levels[index];
    if (!entry) return false;
    const rank = this.levelRanks[key] ?? null;
    // Coins are the goal now; the rank is only the fallback for a save written before
    // stars had a coin target to beat.
    const stars = Math.max(this.levelStars[key] ?? 0, starsForRank(rank));
    this.requireElement("[data-ui='level-window-kind']").textContent = t("level.number", { number: index + 1 });
    this.requireElement("[data-ui='level-window-title']").textContent = entry.title;
    this.requireElement("[data-ui='level-window-description']").textContent = entry.description || entry.summary || "";
    const rankRow = this.requireElement("[data-ui='level-window-rank']");
    rankRow.setAttribute("aria-label", rank ? t("level.stars", { stars }) : t("level.noStars"));
    rankRow.querySelectorAll<HTMLElement>(".rank-star").forEach((star, starIndex) => {
      star.dataset.filled = String(starIndex < stars);
    });
    const best = this.requireElement("[data-ui='level-window-best']");
    best.textContent = rank ? t("level.best", { rank }) : t("level.notPlayed");
    best.dataset.rank = rank ?? "";
    const meta = this.requireElement("[data-ui='level-window-meta']");
    meta.replaceChildren(
      ...[entry.difficultyLabel, formatShiftDuration(entry.shiftDurationSeconds)].map((text) => createElement("span", undefined, text)),
    );
    return true;
  }

  /** Arrow keys and WASD select landmarks; Enter confirms the playable level. */
  private handleLevelKey(event: KeyboardEvent): void {
    const key = event.key;
    const directions: Readonly<Record<string, readonly [number, number]>> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
      a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1],
    };
    const direction = directions[key.length === 1 ? key.toLowerCase() : key];
    const onControl = event.target instanceof HTMLButtonElement
      || (event.target instanceof Element && event.target.closest("summary, details[open]"));
    if (direction && !onControl) {
      event.preventDefault();
      const next = this.levelMap?.neighbour(this.selectedMapKey || null, direction[0], direction[1]);
      if (!next) return;
      this.selectMapLevel(next);
      return;
    }
    if (key === "Escape") {
      event.preventDefault();
      this.setSplashStep("home");
      return;
    }
    if ((key === "Enter" || key === " ") && !onControl && !event.repeat) {
      event.preventDefault();
      void this.confirmMapLevel();
    }
  }

  private bindActions(): void {
    const signal = this.listenerController.signal;
    this.shell.addEventListener("keydown", this.handleOverlayKey, { signal, capture: true });
    // Play → pick the level on the map (it zooms in) → pick the cooks → the match.
    this.requireElement<HTMLButtonElement>("[data-action='home-play']").addEventListener("click", () => {
      this.setSplashStep("level");
    }, { signal });
    this.requireElement<HTMLButtonElement>("[data-action='retry-level-map']").addEventListener("click", () => this.levelMap?.retry(), { signal });
    this.requireElement<HTMLButtonElement>("[data-action='credits']").addEventListener("click", () => this.callbacks.onOpenCredits?.(), { signal });
    this.requireElement<HTMLButtonElement>("[data-action='back-home']").addEventListener("click", () => this.setSplashStep("home"), { signal });
    this.startButton.addEventListener("click", async () => {
      if (this.startButton.disabled) return;
      const characterIds = this.activePicks().map((id) => id ?? this.characters[0]?.id ?? "");
      this.setStartLoading(true);
      // The pair walks together, the stage blurs, and only then does the shift load.
      this.selectionScreen.dataset.confirming = "1";
      try {
        await this.callbacks.onConfirmSelection?.();
        await this.callbacks.onStart?.(characterIds);
        this.showSplash(false);
        this.selectionScreen.dataset.confirming = "";
      } catch (error) {
        this.selectionScreen.dataset.confirming = "";
        console.error("Não foi possível carregar o personagem.", error);
        this.characterStatus.dataset.state = "error";
        this.characterStatus.textContent = t("menu.cookLoadFailed");
      } finally {
        this.setStartLoading(false);
      }
    }, { signal });

    // Both players choose at the same time, each on their own half of the keyboard.
    this.splash.addEventListener("keydown", (event) => {
      if (this.splash.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
      // On the level step the arrow keys belong to the map, not to the cook carousel.
      if (this.selectionScreen.dataset.step !== "characters") {
        if (this.selectionScreen.dataset.step === "level") this.handleLevelKey(event);
        return;
      }
      const key = event.key;
      if (key === "a" || key === "A" || key === "d" || key === "D") {
        event.preventDefault();
        this.browseCharacter(0, key === "a" || key === "A" ? -1 : 1);
      } else if ((key === "ArrowLeft" || key === "ArrowRight") && this.playerCount > 1) {
        event.preventDefault();
        this.browseCharacter(1, key === "ArrowLeft" ? -1 : 1);
      } else if (key === "Enter" && !(event.target instanceof HTMLButtonElement)
        && !(event.target instanceof Element && event.target.closest("summary"))) {
        event.preventDefault();
        if (!event.repeat) this.startButton.click();
      }
    }, { signal });
    this.requireElement<HTMLButtonElement>("[data-action='back-player']").addEventListener("click", () => {
      if (this.startButton.dataset.loading === "true") return;
      this.renderCharacterSelector();
      this.startButton.focus();
    }, { signal });

    this.requireElement<HTMLButtonElement>("[data-action='pause-shift']").addEventListener(
      "click", () => this.callbacks.onPause?.(), { signal },
    );
    this.requireElement<HTMLButtonElement>("[data-action='pause-recipes']").addEventListener(
      "click", () => this.toggleCookbook(true), { signal },
    );
    this.requireElement<HTMLButtonElement>("[data-action='resume']").addEventListener("click", () => {
      this.callbacks.onResume?.();
    }, { signal });

    this.shell.querySelectorAll<HTMLButtonElement>("[data-action='close-cookbook']").forEach((button) => {
      button.addEventListener("click", () => this.toggleCookbook(false), { signal });
    });

    this.requireElement<HTMLButtonElement>("[data-action='restart']").addEventListener("click", () => {
      this.hideResults();
      this.callbacks.onRestart?.();
    }, { signal });

    this.shell.querySelectorAll<HTMLButtonElement>("[data-action='back-to-editor']").forEach((button) => {
      button.addEventListener("click", () => this.callbacks.onBackToEditor?.(), { signal });
    });
    this.shell.querySelectorAll<HTMLButtonElement>("[data-action='quit-to-menu']").forEach((button) => {
      button.addEventListener("click", () => this.callbacks.onQuitToMenu?.(), { signal });
    });

    this.requireElement<HTMLButtonElement>("[data-action=menu-recipes]").addEventListener("click", () => this.toggleCookbook(true), { signal });
    this.requireElement<HTMLButtonElement>("[data-action=account]").addEventListener("click", () => this.callbacks.onOpenAccount?.());
    this.requireElement<HTMLButtonElement>("[data-action='play-on-computer']").addEventListener("click", () => this.callbacks.onPlayOnComputer?.(), { signal });
    this.shell.querySelectorAll<HTMLButtonElement>("[data-collection]").forEach((button) => {
      button.addEventListener("click", () => this.callbacks.onOpenCollection?.(
        button.dataset.collection === "items" ? "items" : "achievements",
      ));
    });
    this.requireElement<HTMLButtonElement>("[data-action='open-editor']").addEventListener("click", () => {
      this.callbacks.onOpenEditor?.();
    }, { signal });
    this.myMaps.querySelector("summary")?.addEventListener("click", (event) => {
      if (!this.mapsLocked) return;
      event.preventDefault();
      this.callbacks.onMapsLocked?.();
    }, { signal });

    this.shell.addEventListener("click", (event) => {
      const mute = event.target instanceof Element ? event.target.closest("[data-action='mute-music']") : null;
      if (mute) this.callbacks.onMusicMuteChange?.(mute.getAttribute("aria-pressed") !== "true");
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-language]") : null;
      const language = button?.dataset.language as Language | undefined;
      if (language && LANGUAGES.includes(language)) setLanguage(language);
      const quality = event.target instanceof Element
        ? event.target.closest<HTMLButtonElement>("[data-quality]")?.dataset.quality
        : undefined;
      if (isQualityMode(quality)) {
        qualityManager.setMode(quality);
        this.syncQualityButtons();
      }
    }, { signal });

    this.levelList.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const doomed = target.closest<HTMLButtonElement>("[data-delete-level]")?.dataset.deleteLevel;
      if (doomed) {
        void this.deleteLevel(doomed);
        return;
      }
      const key = target.closest<HTMLButtonElement>("[data-level-key]")?.dataset.levelKey;
      if (key) this.chooseLevel(key);
    }, { signal });

    this.requireElement<HTMLButtonElement>("[data-action='play-level']").addEventListener("click", () => { void this.confirmMapLevel(); }, { signal });

    this.requireElement<HTMLButtonElement>("[data-action='back-level']").addEventListener("click", () => {
      if (this.startButton.dataset.loading === "true") return;
      this.setSplashStep("level");
    }, { signal });

    this.cookbookNavigation.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>("[data-recipe-id]");
      const recipeId = button?.dataset.recipeId;
      if (!recipeId || !this.recipeById.has(recipeId)) return;
      this.selectedRecipeId = recipeId;
      this.renderCookbookSelection();
    }, { signal });
  }

  /** Re-renders everything already on screen after the language changed. */
  private retranslate(): void {
    if (this.destroyed) return;
    applyTranslations(this.shell);
    this.syncLanguageButtons();
    this.renderLevels();
    this.renderCharacterSelector();
    this.renderCookbook();
    if (this.selectedMapKey) this.fillLevelWindow(this.selectedMapKey);
    if (this.lastResult) this.writeResults(this.lastResult);
    // Ticket chips are cached on their contents; drop the cache so their titles redraw.
    for (const node of this.ticketNodes.values()) node.last.chipKey = "";
  }

  private syncLanguageButtons(): void {
    const current = getLanguage();
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>("[data-language]")) {
      button.setAttribute("aria-pressed", String(button.dataset.language === current));
    }
    this.syncQualityButtons();
  }

  private syncQualityButtons(): void {
    const current = qualityManager.mode;
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>("[data-quality]")) {
      button.setAttribute("aria-pressed", String(button.dataset.quality === current));
    }
  }

  /**
   * Picks a cook for a slot from outside the menu (a phone controller). Same effects as
   * browsing to it with the arrows; ignored while a match is being prepared.
   */
  selectCharacter(slot: number, characterId: string): void {
    if (this.startButton.dataset.loading === "true" || slot < 0 || slot >= MAX_PLAYERS) return;
    if (!this.characters.some(({ id }) => id === characterId) || this.selectedCharacterIds[slot] === characterId) return;
    this.selectedCharacterIds[slot] = characterId;
    this.renderCharacterSelector();
    this.emitPicks();
  }

  private browseCharacter(slot: number, direction: number): void {
    if (!this.characters.length || this.startButton.dataset.loading === "true") return;
    const current = this.characters.findIndex(({ id }) => id === this.selectedCharacterIds[slot]);
    const next = (Math.max(0, current) + direction + this.characters.length) % this.characters.length;
    const nextCharacter = this.characters[next];
    if (!nextCharacter || nextCharacter.id === this.selectedCharacterIds[slot]) return;
    this.selectedCharacterIds[slot] = nextCharacter.id;
    this.renderCharacterSelector();
    this.emitPicks();
  }

  private emitPicks(): void {
    const picks = this.activePicks();
    if (picks.every((id): id is string => Boolean(id))) this.callbacks.onCharacterChange?.(picks as string[]);
  }


  private renderCharacterSelector(): void {
    const both = this.activePicks().every((id) => Boolean(id));
    this.requireElement("[data-ui='selection-step']").textContent = t("menu.players");
    this.requireElement("[data-ui='character-count']").textContent = this.characters.length
      ? t("menu.cookCount", { count: this.characters.length })
      : "";
    this.requireElement<HTMLButtonElement>("[data-action='back-player']").hidden = true;
    this.characterStatus.dataset.state = "ready";
    this.characterStatus.textContent = !this.characters.length
      ? t("menu.noCooks")
      : this.allReady() ? t("menu.allReady") : t("menu.pickHelp");
    this.startButton.disabled = this.characters.length > 0 && !both;
    this.setStartLoading(false);
    this.updatePreview();
  }


  private setStartLoading(loading: boolean): void {
    this.startButton.disabled = loading ||
      (this.characters.length > 0 && this.activePicks().some((id) => !id));
    this.startButton.dataset.loading = loading ? "true" : "false";
    const label = this.startButton.querySelector("span");
    if (label) label.textContent = loading ? t("menu.preparing") : t("menu.startCooking");
    if (loading) {
      this.characterStatus.dataset.state = "loading";
      this.characterStatus.textContent = t("menu.preparingCooks");
    }
  }

  private renderCookbook(): void {
    this.cookbookNavigation.replaceChildren();
    if (this.recipes.length === 0) {
      const empty = createElement("div", "cookbook-empty");
      empty.append(
        createElement("span", "cookbook-empty-icon", "⌁"),
        createElement("strong", undefined, t("cookbook.emptyTitle")),
        createElement("p", undefined, t("cookbook.emptyText")),
      );
      this.cookbookNavigation.append(empty);
      this.cookbookDetail.replaceChildren();
      return;
    }

    this.recipes.forEach((recipe, index) => {
      const button = createElement("button", "recipe-tab");
      button.type = "button";
      button.dataset.recipeId = recipe.id;
      button.style.setProperty("--recipe-color", recipe.color);
      button.setAttribute("aria-pressed", (recipe.id === this.selectedRecipeId).toString());

      const indexLabel = createElement("span", "recipe-index", (index + 1).toString().padStart(2, "0"));
      const copy = createElement("span", "recipe-tab-copy");
      copy.append(
        createElement("strong", undefined, recipe.displayName),
        createElement("small", undefined, t("cookbook.tabMeta", { components: recipe.components.length, steps: recipe.steps.length })),
      );
      if (this.menuRecipeIds.has(recipe.id)) {
        button.classList.add("is-on-menu");
        copy.append(createElement("em", "recipe-on-menu", t("cookbook.onMenu")));
      }
      const illustration = document.createElement("img");
      illustration.className = "recipe-illustration";
      illustration.alt = "";
      illustration.width = illustration.height = 48;
      illustration.loading = "lazy";
      illustration.src = publicUrl(`images/dishes/${recipe.id}.png`);
      illustration.addEventListener("error", () => {
        illustration.src = publicUrl("assets/ui/bistro-recipes.webp");
      }, { once: true });
      button.append(illustration, indexLabel, copy, createElement("span", "recipe-tab-arrow", "›"));
      this.cookbookNavigation.append(button);
    });

    this.renderCookbookSelection();
  }

  private renderCookbookSelection(): void {
    const recipe = this.selectedRecipeId ? this.recipeById.get(this.selectedRecipeId) : undefined;
    this.cookbookNavigation.querySelectorAll<HTMLElement>("[data-recipe-id]").forEach((button) => {
      const selected = button.dataset.recipeId === recipe?.id;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", selected.toString());
    });
    this.cookbookDetail.replaceChildren();
    if (!recipe) return;

    this.cookbookDetail.style.setProperty("--recipe-color", recipe.color);
    const header = createElement("header", "recipe-detail-header");
    const number = Math.max(0, this.recipes.findIndex((entry) => entry.id === recipe.id)) + 1;
    const titleWrap = createElement("div");
    titleWrap.append(
      createElement("span", "ui-kicker", t("cookbook.fileKicker", { number: number.toString().padStart(2, "0") })),
      createElement("h3", undefined, recipe.displayName),
      createElement("p", undefined, recipe.description),
    );
    const reward = createElement("div", "recipe-reward");
    reward.append(
      createElement("small", undefined, t("cookbook.baseReward")),
      createElement("strong", undefined, t("cookbook.credits", { value: formatNumber(recipe.reward) })),
    );
    header.append(titleWrap, reward);

    const body = createElement("div", "recipe-detail-grid");
    const ingredients = createElement("section", "recipe-section");
    ingredients.append(createElement("h4", undefined, t("cookbook.components")));
    const ingredientList = createElement("ul", "ingredient-list");
    // Each ingredient with the process it goes through: "Módulo de RAM · assado".
    const counted = new Map<string, { ingredientId: string; state: FoodState; count: number }>();
    for (const component of recipe.components) {
      const key = `${component.ingredientId}:${component.state}`;
      const entry = counted.get(key);
      if (entry) entry.count += 1;
      else counted.set(key, { ingredientId: component.ingredientId, state: component.state, count: 1 });
    }
    counted.forEach(({ ingredientId, state, count }) => {
      const item = createElement("li");
      item.append(
        createElement("span", "ingredient-quantity", `${count}×`),
        createElement("span", undefined, `${getIngredient(ingredientId)?.displayName ?? ingredientId} · ${FOOD_STATE_LABEL[state]}`),
      );
      ingredientList.append(item);
    });
    ingredients.append(ingredientList);

    const effects = createElement("section", "recipe-section");
    effects.append(createElement("h4", undefined, t("cookbook.effects")));
    const effectList = createElement("div", "effect-list");
    const effectEntries = Object.entries(recipe.effects) as Array<[keyof AIState, number]>;
    effectEntries.forEach(([key, value]) => {
      const effect = createElement("div", "effect-chip");
      effect.dataset.effect = value >= 0 ? "positive" : "cooling";
      effect.append(
        createElement("span", undefined, effectLabel(key)),
        createElement("strong", undefined, `${value >= 0 ? "+" : ""}${value}`),
      );
      effectList.append(effect);
    });
    effects.append(effectList);
    body.append(ingredients, effects);

    const pipeline = createElement("section", "recipe-pipeline");
    pipeline.append(createElement("h4", undefined, t("cookbook.steps")));
    const stepList = createElement("ol", "recipe-steps");
    recipe.steps.forEach((step, index) => {
      const item = createElement("li");
      const marker = createElement("span", "step-marker", (index + 1).toString().padStart(2, "0"));
      const stepCopy = createElement("div");
      stepCopy.append(
        createElement("strong", undefined, stationLabel(step.stationId)),
        createElement("p", undefined, step.description),
      );
      item.append(marker, stepCopy);
      stepList.append(item);
    });
    pipeline.append(stepList);
    this.cookbookDetail.append(header, body, pipeline);
  }

  private dismissNotification(id: number): void {
    const entry = this.notifications.get(id);
    if (!entry) return;
    window.clearTimeout(entry.timeoutId);
    entry.element.classList.add("is-leaving");
    window.setTimeout(() => entry.element.remove(), 220);
    this.notifications.delete(id);
  }

  private setResultValue(key: string, value: string): void {
    this.requireElement(`[data-result='${key}']`).textContent = value;
  }

  private getRankMessage(rank: ShiftResult["rank"]): string {
    switch (rank) {
      case "S": return t("results.rankS");
      case "A": return t("results.rankA");
      case "B": return t("results.rankB");
      case "C": return t("results.rankC");
      case "D": return t("results.rankD");
    }
  }

  private captureFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.shell.contains(active)) this.lastFocusedElement = active;
  }

  private restoreFocus(): void {
    const previous = this.lastFocusedElement;
    this.lastFocusedElement = null;
    // Returning to the canvas keeps player two's Enter available for gameplay.
    const usable = previous?.isConnected && previous.getClientRects().length &&
      (this.activeOverlay === this.splash ? this.splash.contains(previous) : !previous.closest("button, summary"));
    if (usable) {
      previous.focus({ preventScroll: true });
      return;
    }
    if (!this.activeOverlay && this.gameplaySurface) {
      this.gameplaySurface.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.shell.contains(active)) active.blur();
  }

  private syncOverlayFocus(): void {
    const overlays = [this.resultsOverlay, this.cookbookOverlay, this.pauseOverlay, this.splash];
    const next = overlays.find((overlay) => !overlay.hidden) ?? null;
    const previous = this.activeOverlay;
    if (next === previous) return;
    if (next && next !== this.splash && (!previous || previous === this.splash)) this.captureFocus();
    this.activeOverlay = next;
    this.shell.dataset.modalOpen = String(Boolean(next));
    this.hud.inert = next !== null;
    for (const overlay of overlays) {
      const covered = Boolean(next && overlay !== next);
      overlay.inert = covered || overlay.getAttribute("aria-busy") === "true";
      overlay.toggleAttribute("data-focus-covered", covered);
    }
    if (next && next !== this.splash) this.focusOverlay(next);
    else if (previous && previous !== this.splash) this.restoreFocus();
  }

  private readonly handleOverlayKey = (event: KeyboardEvent): void => {
    const overlay = this.activeOverlay;
    if (!overlay || overlay.inert) return;
    if (event.key === "Escape" && overlay === this.cookbookOverlay) {
      event.preventDefault();
      event.stopPropagation();
      this.toggleCookbook(false);
    }
    if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
    // During play Tab opens the cookbook. Inside a dialog it navigates its controls.
    event.stopPropagation();
    event.preventDefault();
    const controls = [...overlay.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [tabindex]',
    )].filter(control => control.tabIndex >= 0 && !control.matches(":disabled") &&
      !control.closest("[hidden], [inert]") && control.getClientRects().length > 0);
    if (controls.length === 0) { overlay.focus({ preventScroll: true }); return; }
    const current = controls.findIndex(control => control === document.activeElement);
    const step = event.shiftKey ? -1 : 1;
    const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0) :
      (current + step + controls.length) % controls.length;
    controls[next]?.focus();
  };

  /**
   * Focuses an in-game overlay itself rather than its first button. Players are still on
   * the keyboard when the pause, recipe or results screen opens; with a button focused, the
   * Enter that player two was pressing to deliver would click "Jogar de novo" and skip the
   * results. Tab still walks to the buttons.
   */
  private focusOverlay(container: HTMLElement): void {
    if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
    container.style.outline = "none";
    window.requestAnimationFrame(() => {
      if (this.activeOverlay === container && !container.inert) container.focus({ preventScroll: true });
    });
  }

  private focusFirst(container: HTMLElement): void {
    window.requestAnimationFrame(() => {
      container.querySelector<HTMLElement>("button, [href], [tabindex]:not([tabindex='-1'])")?.focus({ preventScroll: true });
    });
  }

  private requireElement<TElement extends HTMLElement = HTMLElement>(selector: string): TElement {
    const element = this.shell.querySelector<TElement>(selector);
    if (!element) throw new Error(`GameUI element not found: ${selector}`);
    return element;
  }

  /** The PT | EN toggle; shown in the menu header and on the pause card. */
  private static languageSwitch(): string {
    const buttons = LANGUAGES.map((language) =>
      `<button type="button" data-language="${language}" data-i18n-attr="title:language.${language}">${language.toUpperCase()}</button>`,
    ).join("");
    return `<div class="language-switch" role="group" data-i18n-attr="aria-label:language.label">${buttons}</div>`;
  }

  /** Auto | Low | Medium | High, beside the language toggle; see QualityManager. */
  /** Transient emote and delivery feedback, anchored by player color. */
  private static playerStatusCards(): string {
    return Array.from({ length: MAX_PLAYERS }, (_, index) => `
      <div class="crew-callout" data-player-status="${index}" style="--player-color: ${PLAYER_COLORS[index]}">
        <p class="player-callout" data-player-callout hidden aria-live="polite"></p>
      </div>`).join("");
  }

  /** One name plate per possible player on the selection street. */
  private static pickHintCards(): string {
    return Array.from({ length: MAX_PLAYERS }, (_, index) => `
              <div class="pick-hint pick-hint-p${index + 1}" data-player="p${index + 1}" data-pick-slot="${index}" data-ready="false"${index >= 2 ? " hidden" : ""} style="--player-color: ${PLAYER_COLORS[index]}">
                <span class="pick-badge">${playerLabel(index)}</span>
                <strong data-pick-name>—</strong>
                <span class="pick-ready" aria-hidden="true">&#10003;</span>
              </div>`).join("");
  }

  private static qualitySwitch(): string {
    const buttons = QUALITY_MODES.map((mode) =>
      `<button type="button" data-quality="${mode}" data-i18n="graphics.${mode}" data-i18n-attr="title:graphics.${mode}Hint"></button>`,
    ).join("");
    return `<div class="language-switch quality-switch" role="group" data-i18n-attr="aria-label:graphics.label">${buttons}</div>`;
  }

  private static musicToggle(): string {
    return `<button class="secondary-action music-toggle" type="button" data-action="mute-music" data-i18n="audio.muteMusic" aria-pressed="false"></button>`;
  }

  private createMarkup(): string {
    return `
      <div class="hud-layer" data-ui="hud" aria-hidden="false">
        <div class="bistro-hud-top">
        <button class="round-clock" type="button" data-action="pause-shift" data-i18n-attr="aria-label:hud.pauseAction;title:hud.pauseAction">
          <span data-ui="shift-timer">00:00</span>
        </button>
        <section class="order-panel is-empty" data-ui="order" data-i18n-attr="aria-label:hud.ordersAria">
          <ul class="order-tickets" data-ui="order-tickets" aria-live="polite"></ul>
        </section>

        </div>

        <div class="crew-callouts">
          ${GameUI.playerStatusCards()}
        </div>
        <div class="split-screen-divider" data-ui="split-divider" hidden aria-hidden="true"></div>

        <div class="disaster-layer" data-ui="disaster" aria-live="assertive"></div>
        <div class="notification-region" data-ui="notifications" aria-live="polite" aria-relevant="additions"></div>

        <aside class="debug-panel" data-ui="debug" hidden>
          <header><span data-i18n="hud.telemetry"></span><i data-i18n="hud.live"></i></header>
          <div data-ui="debug-rows"></div>
        </aside>
      </div>

      <section class="full-overlay splash-overlay" data-ui="splash" role="dialog" aria-modal="true" aria-labelledby="splash-title" tabindex="-1">
        <div class="selection-screen">
          <video class="bistro-home-video" muted loop playsinline preload="none" aria-hidden="true"></video>
          <div class="bistro-home-scrim" aria-hidden="true"></div>
          <header class="selection-header">
            <h1 id="splash-title">BYTE <span>BISTRO</span></h1>
            <div class="selection-header-actions bistro-home-actions">
              <button class="secondary-action bistro-home-icon bistro-home-credits" type="button" data-action="credits" data-i18n-attr="aria-label:credits.title;title:credits.title"></button>
              <button class="secondary-action bistro-home-icon menu-map-action" type="button" data-action="open-editor" data-locked data-i18n-attr="aria-label:menu.createMap;title:menu.createMap"></button>
              <button class="secondary-action bistro-home-icon" type="button" data-action="menu-recipes" data-i18n-attr="aria-label:menu.homeRecipes;title:menu.homeRecipes"></button>
              <button class="primary-action bistro-home-play" type="button" data-action="home-play" data-i18n="menu.homePlay"></button>
              <button class="secondary-action bistro-home-icon" type="button" data-collection="items" data-i18n-attr="aria-label:collection.items;title:collection.items"></button>
              <button class="secondary-action bistro-home-icon" type="button" data-collection="achievements" data-i18n-attr="aria-label:collection.achievements;title:collection.achievements"></button>
              <details class="bistro-home-settings">
                <summary class="secondary-action bistro-home-icon" data-i18n-attr="aria-label:menu.settings;title:menu.settings"></summary>
                <div class="home-settings-panel">
                  ${GameUI.qualitySwitch()}
                  ${GameUI.musicToggle()}
                </div>
              </details>
              <button class="secondary-action bistro-home-icon bistro-account-action" type="button" data-action="account" data-i18n-attr="aria-label:account.title;title:account.title"></button>
              ${GameUI.languageSwitch()}
            </div>
            <details class="my-maps" data-ui="my-maps" data-locked hidden>
              <summary data-i18n="menu.myMaps"></summary>
              <ul class="level-list" data-ui="level-list"></ul>
            </details>
          </header>
          <section class="pair-select" data-ui="pair-select" aria-labelledby="pair-title">
            <h2 id="pair-title" data-i18n="pair.title"></h2>
            <button class="secondary-action pair-computer" type="button" data-action="play-on-computer" data-i18n="pair.playOnComputer"></button>
            <div class="pair-panel" data-ui="pair-panel"></div>
          </section>
          <section class="level-select" data-ui="level-select">
            <button class="secondary-action" type="button" data-action="back-home" data-i18n="common.back"></button>
            <h2 data-i18n="menu.chooseLevel"></h2>
            <div class="level-map-stage" data-ui="level-map-stage" data-map-state="loading">
              <div class="level-map-loading" role="status" aria-live="polite">
                <span class="level-map-loading-label" data-i18n="boot.openingMap"></span>
                <div class="level-map-error"><span data-i18n="level.mapLoadFailed"></span><button type="button" class="secondary-action" data-action="retry-level-map" data-i18n="common.retry"></button></div>
              </div>
              <canvas class="level-map-canvas" data-ui="level-map-canvas" tabindex="0" data-i18n-attr="aria-label:menu.mapAria"></canvas>
              <p class="level-map-hint" aria-hidden="true">
                <span><kbd>&#8592;</kbd><kbd>&#8594;</kbd><kbd>&#8593;</kbd><kbd>&#8595;</kbd> <span data-i18n="menu.changeLevel"></span></span>
                <span><kbd>Enter</kbd> <span data-i18n="menu.play"></span></span>
              </p>
              <aside class="level-window" data-ui="level-window" aria-labelledby="level-window-title" hidden>
                <span class="level-window-kind" data-ui="level-window-kind"></span>
                <h3 id="level-window-title" class="level-window-title" data-ui="level-window-title" aria-live="polite"></h3>
                <div class="level-window-rank" data-ui="level-window-rank" role="img">
                  <svg class="rank-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4l2.95 6.1 6.65.85-4.9 4.6 1.3 6.65L12 17.3l-5.95 3.3 1.3-6.65-4.9-4.6 6.65-.85z"/></svg><svg class="rank-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4l2.95 6.1 6.65.85-4.9 4.6 1.3 6.65L12 17.3l-5.95 3.3 1.3-6.65-4.9-4.6 6.65-.85z"/></svg><svg class="rank-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4l2.95 6.1 6.65.85-4.9 4.6 1.3 6.65L12 17.3l-5.95 3.3 1.3-6.65-4.9-4.6 6.65-.85z"/></svg>
                </div>
                <p class="level-window-best" data-ui="level-window-best"></p>
                <p class="level-window-description" data-ui="level-window-description"></p>
                <div class="level-window-meta" data-ui="level-window-meta"></div>
                <button class="primary-action level-window-play" type="button" data-action="play-level"><span data-i18n="menu.play"></span><i aria-hidden="true">&#8594;</i></button>
              </aside>
            </div>
          </section>
          <section class="selection-arena">
            <div class="character-preview-stage" data-ui="preview-stage">
              <canvas class="character-preview-canvas" data-ui="preview-canvas" width="900" height="650" data-i18n-attr="aria-label:menu.cooksAria"></canvas>
              <span class="character-preview-player" data-ui="preview-player" data-player="p1" hidden>P1</span>
              <!-- Each player's plate sits beside their cook; a tick shows they confirmed it. -->
              ${GameUI.pickHintCards()}
            </div>
            <span class="character-count" data-ui="character-count" hidden></span>
            <span data-ui="selection-step" hidden></span>
            <span data-ui="preview-name" hidden></span>
            <span data-ui="preview-role" hidden></span>
          </section>
          <footer class="selection-footer">
            <p class="character-status" aria-live="polite" data-ui="character-status" hidden></p>
            <div class="selection-actions">
              <button class="secondary-action" type="button" data-action="back-player" hidden data-i18n="common.back"></button>
              <button class="secondary-action" type="button" data-action="back-level" hidden data-i18n="menu.backToLevels"></button>
              <button class="primary-action start-action" type="button" data-action="start"><span data-i18n="menu.startCooking"></span></button>
            </div>
          </footer>
        </div>
      </section>

      <section class="full-overlay cookbook-overlay" data-ui="cookbook" role="dialog" aria-modal="true" aria-labelledby="cookbook-title" hidden>
        <div class="modal-window cookbook-window">
          <header class="modal-header">
            <div class="cookbook-brand"><div class="mini-glyph" aria-hidden="true">B</div><div><span class="panel-kicker" data-i18n="cookbook.kicker"></span><h2 id="cookbook-title" data-i18n="cookbook.title"></h2></div></div>
            <div class="modal-header-actions"><button class="icon-button" type="button" data-action="close-cookbook" data-i18n-attr="aria-label:cookbook.closeAria">× <span>ESC</span></button></div>
          </header>
          <div class="cookbook-layout">
            <nav class="cookbook-nav" data-ui="cookbook-nav" data-i18n-attr="aria-label:cookbook.listAria"></nav>
            <article class="cookbook-detail" data-ui="cookbook-detail" aria-live="polite"></article>
          </div>
          <footer class="modal-footer"><span data-i18n="cookbook.chooseHint"></span><button type="button" class="secondary-action" data-action="close-cookbook"><span data-i18n="cookbook.backToKitchen"></span> <kbd>ESC</kbd></button></footer>
        </div>
      </section>

      <section class="full-overlay pause-overlay" data-ui="pause" role="dialog" aria-modal="true" aria-labelledby="pause-title" hidden>
        <div class="pause-card modal-window">
          <div class="pause-emblem" aria-hidden="true"><span>Ⅱ</span></div>
          <h2 id="pause-title" data-i18n="pause.title"></h2>
          <p data-i18n="pause.text"></p>
          <button class="primary-action" type="button" data-action="resume"><span data-i18n="pause.resume"></span><i aria-hidden="true">→</i></button>
          <button class="secondary-action overlay-menu-action" type="button" data-action="pause-recipes"><span data-i18n="pause.hintRecipes"></span></button>
          <button class="secondary-action overlay-menu-action" type="button" data-action="back-to-editor" hidden><span data-i18n="pause.toEditor"></span></button>
          <button class="secondary-action overlay-menu-action" type="button" data-action="quit-to-menu"><span data-i18n="pause.toMenu"></span></button>
          ${GameUI.languageSwitch()}
          ${GameUI.qualitySwitch()}
          ${GameUI.musicToggle()}
          <div class="pause-hint"><kbd>ESC</kbd><span data-i18n="pause.hintResume"></span></div>
        </div>
      </section>

      <section class="full-overlay results-overlay" data-ui="results" role="dialog" aria-modal="true" aria-labelledby="results-title" hidden>
        <div class="results-window modal-window">
          <header class="results-heading"><span class="panel-kicker" data-i18n="results.kicker"></span><h2 id="results-title" data-i18n="results.title"></h2><p data-i18n="results.subtitle"></p></header>
          <div class="results-body">
            <div class="rank-module">
              <span data-i18n="results.rank"></span><strong data-result-rank data-rank="B">B</strong>
              <div class="result-stars" data-result-stars aria-live="polite">
                <span data-star="1"></span><span data-star="2"></span><span data-star="3"></span>
              </div>
              <small data-result-star-note></small>
            </div>
            <div class="results-summary">
              <p data-result-message data-i18n="results.archived"></p>
              <div class="result-grid">
                <div><span data-i18n="results.completed"></span><strong data-result="completed">0</strong></div>
                <div><span data-i18n="results.failed"></span><strong data-result="failed">0</strong></div>
                <div><span data-i18n="results.quality"></span><strong data-result="quality">0%</strong></div>
                <div><span data-i18n="results.stability"></span><strong data-result="stability">0%</strong></div>
                <div><span data-i18n="results.combo"></span><strong data-result="combo">X0</strong></div>
                <div><span data-i18n="results.throws"></span><strong data-result="throws">0</strong></div>
                <div><span data-i18n="results.sync"></span><strong data-result="sync">0%</strong></div>
                <div><span data-i18n="results.meltdowns"></span><strong data-result="meltdowns">0</strong></div>
                <div class="result-score"><span data-i18n="results.score"></span><strong data-result="score">0</strong></div>
                <div class="result-credits"><span data-i18n="results.credits"></span><strong data-result="credits">+0</strong></div>
              </div>
            </div>
          </div>
          <footer class="results-footer"><span data-i18n="results.saved"></span><div class="results-actions"><button class="secondary-action overlay-menu-action" type="button" data-action="back-to-editor" hidden><span data-i18n="pause.toEditor"></span></button><button class="secondary-action overlay-menu-action" type="button" data-action="quit-to-menu"><span data-i18n="results.menu"></span></button><button class="primary-action" type="button" data-action="restart"><span data-i18n="results.again"></span><i aria-hidden="true">↻</i></button></div></footer>
        </div>
      </section>
    `;
  }
}
