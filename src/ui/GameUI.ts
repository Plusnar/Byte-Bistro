import { ingredientIllustration } from "./illustrations";
import type {
  AIState,
  FoodState,
  MiraExpression,
  RecipeData,
  RuntimeGameState,
  ShiftResult,
  StarThresholds,
  StationId,
} from "../types/game";
import type { PlayerIndex } from "../types/events";
import { MAX_PLAYERS, PLAYER_COLORS, clampPlayerCount, playerLabel } from "../data/players";
import type { MenuCommand } from "./menuInput";
import type { CharacterDefinition } from "../data/characters";
import { formatShiftDuration, type LevelEntry } from "../data/levelCatalog";
import { mapLevels } from "../data/levelMap";
import { starsForRank, type LevelRanks } from "../data/levelRanks";
import { nextStarTarget, starsForCoins } from "../data/levelGoals";
import { confirmDialog } from "./confirmDialog";
import { FOOD_STATE_LABEL } from "../data/kitchen";
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
export type StationProgressTone = "active" | "ideal" | "warning" | "danger";

export interface StationProgressInfo {
  label: string;
  progress: number;
  status?: string;
  detail?: string;
  tone?: StationProgressTone;
}

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
  aiState?: Readonly<AIState>;
  shiftTimeRemaining?: number;
  score?: number;
  cameraDistance?: number;
  splitAmount?: number;
}

export interface PlayerStatusInfo {
  prompt: string | null;
  key: string;
  carrying: string | null;
  /** What the held item still needs: "Cortar", "Cozinhar", "Montar no prato"… */
  nextStep?: string | null;
}

/** One recipe component on a ticket, with how far along it is. */
export interface OrderTicketComponent {
  ingredientId: string;
  /** The state the recipe wants it in. */
  state: FoodState;
  stage: "fetch" | "mix" | "chop" | "cook" | "cooking" | "plate" | "plated";
}

/** One row of the order queue. All values are pre-derived; GameUI stays Babylon-free. */
export interface OrderTicketInfo {
  orderId: string;
  recipeId: string | null;
  title: string;
  guestName: string | null;
  secondsRemaining: number;
  totalSeconds: number;
  reward: number;
  stepsCompleted: number;
  stepsTotal: number;
  /** Every component is plated — the dish just needs carrying to the pass. */
  readyToDeliver: boolean;
  components: readonly OrderTicketComponent[];
  assignedTo: PlayerIndex | null;
}

/** Cached DOM for one ticket row, plus the last values written, to skip no-op writes. */
/** How a card leaves the queue, which drives its exit animation. */
export type OrderOutcome = "delivered" | "expired";

interface ChipNode {
  root: HTMLElement;
  img: HTMLImageElement;
}

interface TicketNode {
  root: HTMLElement;
  name: HTMLElement;
  timer: HTMLElement;
  dish: HTMLImageElement;
  guest: HTMLElement;
  reward: HTMLElement;
  chips: HTMLElement;
  stamp: HTMLElement;
  /** Keyed by `index:ingredientId` so duplicate components keep separate nodes. */
  chipNodes: Map<string, ChipNode>;
  last: {
    seconds: number; title: string; guest: string;
    recipeId: string | null; reward: number; chipKey: string;
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

/** How many cards fit the queue before the rest collapse into a "+N" pill. */
export const MAX_VISIBLE_ORDERS = 4;
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
    // Mixing is preparing, not fetching: the ingredients for it are already in hand.
    case "mix":
    case "chop":
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
  /** Leaves the running shift for the level and cook picker. */
  onQuitToMenu?: () => void;
  onCookbookVisibilityChange?: (visible: boolean) => void;
  onOpenEditor?: () => void;
  onOpenAccount?: () => void;
  /** Back to the phone pairing screen, to add or remove players. */
  onOpenPhones?: () => void;
  /** Development only: leave the pairing screen without phones, as two keyboard players. */
  onPairSkip?: () => void;
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
  /** The star an arrow key leads to from `key`, or null when none lies that way. */
  neighbour(key: string | null, dx: number, dy: number): string | null;
  setActive(active: boolean): void;
  isMoving(): boolean;
  retry(): void;
}

export interface GameUIOptions extends GameUICallbacks {
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
  private selectedRecipeId: string | null = null;
  private cookbookVisible = false;
  private dialogueTimeoutId: number | null = null;
  private notificationSequence = 0;
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
  /** The level whose window is open, or "" when it is closed. */
  private levelWindowKey = "";
  private levelWindowTimer = 0;
  private editorVisible = false;
  /** Last value sent through onPreviewActiveChange; the preview starts out drawing. */
  private previewActive = true;
  private readonly levelMapCanvas: HTMLCanvasElement;
  private readonly levelWindow: HTMLElement;
  private readonly myMaps: HTMLDetailsElement;
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
  private readonly stationProgress: HTMLElement;
  private readonly stationProgressLabel: HTMLElement;
  private readonly stationProgressStatus: HTMLElement;
  private readonly stationProgressDetail: HTMLElement;
  private readonly stationProgressBar: HTMLElement;
  private readonly stationProgressValue: HTMLElement;
  private readonly orderPanel: HTMLElement;
  private readonly orderTickets: HTMLElement;
  private readonly orderUpcoming: HTMLElement;
  private readonly starMeter: HTMLElement;
  private readonly starMeterFill: HTMLElement;
  private readonly starMeterNote: HTMLElement;
  /** Recipe ids currently drawn in the preview strip, to skip redundant rebuilds. */
  private upcomingKey = "";
  private readonly weddingGuest: HTMLElement;
  /** Live ticket rows, keyed by order id, so the list reconciles instead of rebuilding. */
  private readonly ticketNodes = new Map<string, TicketNode>();
  /** Pending exit animations, so a card is not removed while it is still playing one. */
  private readonly orderExitTimers = new Map<string, number>();
  private readonly shiftTimer: HTMLElement;
  private readonly scoreValue: HTMLElement;
  private readonly comboValue: HTMLElement;
  private readonly comboChip: HTMLElement;
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
    this.host = root;
    this.callbacks = options;
    this.shell = createElement("div", "game-ui");
    this.shell.dataset.gameVisible = "true";
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
    this.stationProgress = this.requireElement("[data-ui='station-progress']");
    this.stationProgressLabel = this.requireElement("[data-ui='station-progress-label']");
    this.stationProgressStatus = this.requireElement("[data-ui='station-progress-status']");
    this.stationProgressDetail = this.requireElement("[data-ui='station-progress-detail']");
    this.stationProgressBar = this.requireElement("[data-ui='station-progress-bar']");
    this.stationProgressValue = this.requireElement("[data-ui='station-progress-value']");
    this.orderPanel = this.requireElement("[data-ui='order']");
    this.orderTickets = this.requireElement("[data-ui='order-tickets']");
    this.orderUpcoming = this.requireElement("[data-ui='order-upcoming']");
    this.starMeter = this.requireElement("[data-ui='star-meter']");
    this.starMeterFill = this.requireElement("[data-ui='star-meter-fill']");
    this.starMeterNote = this.requireElement("[data-ui='star-meter-note']");
    this.weddingGuest = this.requireElement("[data-ui='wedding-guest']");
    this.shiftTimer = this.requireElement("[data-ui='shift-timer']");
    this.scoreValue = this.requireElement("[data-ui='score']");
    this.comboValue = this.requireElement("[data-ui='combo']");
    this.comboChip = this.requireElement(".combo-chip");
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

    this.shiftTimer.textContent = formatClock(state.shiftTimeRemaining);
    this.shiftTimer.closest(".shift-chip")?.classList.toggle("is-urgent", state.shiftTimeRemaining <= 30);
    this.scoreValue.textContent = formatNumber(Math.max(0, Math.round(state.score)));
    this.comboValue.textContent = state.combo > 1 ? `X${state.combo}` : "—";
    this.comboValue.closest(".shift-chip")?.classList.toggle("is-active", state.combo > 1);
    this.updateMiraState(state.aiState);
    // The order queue is pushed imperatively from KitchenScene, which owns the countdowns.
    this.shell.dataset.shiftEnded = state.shiftEnded ? "true" : "false";
  }

  setPlayerStatus(index: PlayerIndex, info: Readonly<PlayerStatusInfo>): void {
    if (this.destroyed) return;
    const panel = this.playerStatusPanels[index];
    if (!panel) return;
    const prompt = panel.querySelector<HTMLElement>("[data-player-prompt]");
    const key = panel.querySelector<HTMLElement>("[data-player-key]");
    const carrying = panel.querySelector<HTMLElement>("[data-player-carrying]");
    if (!prompt || !key || !carrying) return;
    panel.classList.toggle("has-prompt", Boolean(info.prompt));
    panel.classList.toggle("is-carrying", Boolean(info.carrying));
    prompt.textContent = info.prompt ?? t("hud.goToStation");
    key.textContent = info.key;
    key.hidden = !info.prompt;
    carrying.textContent = info.carrying ? info.carrying : "";
    const step = panel.querySelector<HTMLElement>("[data-player-step]");
    if (step) {
      const next = info.nextStep ?? "";
      step.hidden = next === "";
      if (step.textContent !== next) step.textContent = next;
    }
  }

  /**
   * The tickets that have not arrived yet, dimmed ahead of the live ones.
   *
   * These are the real draws, not a guess (see `OrderScheduler`), which is the only reason
   * showing them is fair: a cook can start prepping for an order they can see coming.
   */
  setUpcomingOrders(recipeIds: readonly string[]): void {
    if (this.destroyed) return;
    const key = recipeIds.join("|");
    if (key === this.upcomingKey) return;
    this.upcomingKey = key;
    this.orderUpcoming.replaceChildren();
    for (const recipeId of recipeIds) {
      const item = createElement("li", "order-upcoming-card");
      const recipe = this.recipes.find((entry) => entry.id === recipeId);
      const art = document.createElement("img");
      art.src = publicUrl(`images/dishes/${recipeId}.png`);
      art.alt = "";
      art.loading = "lazy";
      // A recipe with no art of its own shows its name alone rather than a broken icon.
      art.addEventListener("error", () => { art.hidden = true; }, { once: true });
      item.append(art);
      const label = createElement("span");
      label.textContent = recipe?.shortName ?? recipe?.displayName ?? "";
      item.append(label);
      this.orderUpcoming.append(item);
    }
    this.orderUpcoming.hidden = recipeIds.length === 0;
  }

  /**
   * The coin meter: how far this shift is along the level's own one-, two- and three-star
   * targets. Hidden when the level sets no targets, rather than showing an empty bar.
   */
  setStarMeter(coins: number, thresholds: StarThresholds | null): void {
    if (this.destroyed) return;
    if (!thresholds || !Number.isFinite(thresholds.three)) {
      this.starMeter.hidden = true;
      return;
    }
    this.starMeter.hidden = false;
    const stars = starsForCoins(coins, thresholds);
    this.starMeter.dataset.stars = String(stars);
    this.starMeterFill.style.width = `${clamp((coins / thresholds.three) * 100, 0, 100).toFixed(1)}%`;
    for (const star of this.starMeter.querySelectorAll<HTMLElement>("[data-star]")) {
      star.dataset.filled = Number(star.dataset.star) <= stars ? "true" : "false";
    }
    const next = nextStarTarget(coins, thresholds);
    const note = next === null
      ? t("hud.starsAllEarned")
      : t("hud.starsToGo", { coins: formatNumber(Math.max(0, next - coins)) });
    if (this.starMeterNote.textContent !== note) this.starMeterNote.textContent = note;
  }

  /**
   * Drains the combo chip as the streak's window runs out, so a run that is about to lapse
   * looks like one. 0 leaves the chip idle.
   */
  setComboWindow(remaining: number): void {
    if (this.destroyed) return;
    this.comboChip.style.setProperty("--combo-window", clamp(remaining, 0, 1).toFixed(3));
    this.comboChip.classList.toggle("is-fading", remaining > 0 && remaining < 0.35);
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

  setSplitScreen(amount: number, distance: number): void {
    if (this.destroyed) return;
    const split = clamp(amount, 0, 1);
    this.splitDivider.style.setProperty("--split-opacity", split.toFixed(3));
    this.splitDivider.hidden = split < 0.01;
    this.splitDivider.setAttribute("aria-label", t("hud.splitAria", { distance: formatNumber(distance, { maximumFractionDigits: 1 }) }));
  }

  setStationProgress(info: StationProgressInfo | null): void {
    if (this.destroyed) return;
    this.stationProgress.hidden = info === null;
    if (!info) return;

    const normalizedProgress = info.progress <= 1 ? info.progress * 100 : info.progress;
    const percentage = clamp(normalizedProgress, 0, 100);
    this.stationProgress.dataset.tone = info.tone ?? "active";
    this.stationProgressLabel.textContent = info.label;
    this.stationProgressStatus.textContent = info.status ?? t("hud.working");
    this.stationProgressDetail.textContent = info.detail ?? `${Math.round(percentage)}%`;
    this.stationProgressBar.style.setProperty("--progress", `${percentage}%`);
    this.stationProgressBar.setAttribute("aria-valuenow", Math.round(percentage).toString());
    this.stationProgressValue.textContent = `${Math.round(percentage)}%`;
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
   * How many people play (one per paired phone): the selection street shows that many
   * cooks, the HUD that many cards. Clears everyone's "ready".
   */
  setPlayerCount(count: number): void {
    const next = clampPlayerCount(count);
    this.readySlots.fill(false);
    this.playerCount = next;
    this.playerStatusPanels.forEach((panel, index) => { panel.hidden = index >= next; });
    this.requireElement("[data-ui='coop-player-status']").dataset.count = String(next);
    this.renderCharacterSelector();
  }

  setRecipes(recipes: readonly RecipeData[]): void {
    this.recipes = [...recipes];
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
    this.shell.dataset.modalOpen = visible ? "true" : "false";
    this.callbacks.onCookbookVisibilityChange?.(visible);

    if (visible) {
      this.captureFocus();
      this.focusOverlay(this.cookbookOverlay);
    } else {
      this.restoreFocus();
    }
    return visible;
  }

  setPausedVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.pauseOverlay.hidden = !visible;
    this.shell.dataset.modalOpen = visible ? "true" : this.cookbookVisible ? "true" : "false";
    if (visible) {
      this.captureFocus();
      this.focusOverlay(this.pauseOverlay);
    } else if (!this.cookbookVisible) {
      this.restoreFocus();
    }
  }

  showResults(result: Readonly<ShiftResult>): void {
    if (this.destroyed) return;
    this.lastResult = result;
    this.writeResults(result);
    this.resultsOverlay.hidden = false;
    this.shell.dataset.modalOpen = "true";
    this.captureFocus();
    this.focusOverlay(this.resultsOverlay);
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
    this.shell.dataset.modalOpen = this.cookbookVisible || !this.pauseOverlay.hidden ? "true" : "false";
    this.restoreFocus();
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
    this.splash.inert = loading;
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

  showSplash(visible = true): void {
    if (this.destroyed) return;
    this.splash.hidden = !visible;
    // Start keeps focus as the splash hides; a hidden focused button would still swallow
    // player two's Enter during the shift.
    if (!visible && document.activeElement instanceof HTMLElement &&
      this.splash.contains(document.activeElement)) document.activeElement.blur();
    this.setGameVisible(!visible);
    this.shell.dataset.modalOpen = visible ? "true" : "false";
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
    window.clearTimeout(this.levelWindowTimer);
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

  /** Connects the 3D map; stars are laid out for the levels already known. */
  attachLevelMap(map: LevelMapPort): void {
    this.levelMap = map;
    map.setLevels(mapLevels(this.levels).map((entry) => entry.key));
    map.select(this.selectedLevelKey || null);
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
    if (this.levelWindowKey) this.fillLevelWindow(this.levelWindowKey);
  }

  /** A star (or empty ground, for null) was clicked on the map. */
  pickMapLevel(key: string | null): void {
    if (!key) {
      this.closeLevelWindow();
      return;
    }
    this.selectMapLevel(key);
    this.openLevelWindow(key);
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
      const portrait = this.shell.querySelector<HTMLImageElement>(`[data-player-portrait="${slot}"]`);
      if (portrait) {
        portrait.hidden = !character || !active;
        if (character) portrait.src = publicUrl(`assets/ui/avatar-${character.id}.webp`);
      }
    }
    this.callbacks.onCharacterPreview?.(this.activePicks());
  }


  private updateMiraState(_aiState: Readonly<AIState>): void {
    // The CORE panel was removed from the HUD; its metrics are no longer surfaced.
    void _aiState;
  }

  /**
   * Renders the order queue as a list of tickets.
   *
   * Reconciles against cached nodes instead of rebuilding markup: this runs every frame, so
   * re-writing innerHTML would restart CSS transitions and churn the DOM sixty times a
   * second. Text is only touched when its value actually changed.
   */
  setOrderTickets(tickets: readonly OrderTicketInfo[], guestCount: number): void {
    if (this.destroyed) return;
    const visible = tickets.slice(0, MAX_VISIBLE_ORDERS);
    const overflow = tickets.length - visible.length;

    this.orderPanel.classList.toggle("is-empty", tickets.length === 0);
    this.weddingGuest.textContent = overflow > 0 ? `+${overflow}` : "";
    this.weddingGuest.hidden = overflow <= 0;
    void guestCount;

    let anyCritical = false;
    const seen = new Set<string>();
    visible.forEach((ticket, index) => {
      seen.add(ticket.orderId);
      const node = this.ticketNodes.get(ticket.orderId) ?? this.createTicketNode(ticket.orderId);
      const seconds = Math.max(0, Math.ceil(ticket.secondsRemaining));
      const fraction = ticket.totalSeconds > 0
        ? Math.max(0, Math.min(1, ticket.secondsRemaining / ticket.totalSeconds))
        : 0;

      if (node.last.seconds !== seconds) {
        node.last.seconds = seconds;
        node.timer.textContent = `${seconds}s`;
      }
      if (node.last.title !== ticket.title) {
        node.last.title = ticket.title;
        node.name.textContent = ticket.title;
      }
      if (node.last.reward !== ticket.reward) {
        node.last.reward = ticket.reward;
        node.reward.textContent = String(ticket.reward);
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

      node.root.style.setProperty("--progress", `${fraction * 100}%`);
      // The oldest order sits first and is the one the players should clear next.
      this.setFlag(node.root, "lead", index === 0);
      this.setFlag(node.root, "ready", ticket.readyToDeliver);
      const urgency = fraction <= 0 ? "expired"
        : fraction < 0.22 ? "critical"
        : fraction < 0.5 ? "warning"
        : "nominal";
      if (node.root.dataset.urgency !== urgency) node.root.dataset.urgency = urgency;
      anyCritical ||= urgency === "critical" || urgency === "expired";
      const player = ticket.assignedTo === null ? "" : ticket.assignedTo === 0 ? "p1" : "p2";
      if (node.root.dataset.player !== player) node.root.dataset.player = player;

    });

    // Reorder only when the sequence actually changed. Re-inserting a node restarts every
    // CSS animation on it, which made the whole queue flicker once per frame.
    this.reorderTickets(visible);

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
    // Cards on their way out keep whatever slot they already had.
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
    const key = ticketChipKey(ticket.components);
    if (node.last.chipKey === key) return;
    node.last.chipKey = key;

    const seen = new Set<string>();
    ticket.components.forEach((component, index) => {
      const id = `${index}:${component.ingredientId}`;
      seen.add(id);
      let chip = node.chipNodes.get(id);
      if (!chip) {
        chip = this.createChipNode(component.ingredientId);
        node.chipNodes.set(id, chip);
      }
      const ingredient = getIngredient(component.ingredientId);
      chip.root.style.setProperty("--chip-color", ingredient?.color ?? "#5CE6FF");
      chip.root.dataset.state = chipState(component.stage);
      chip.root.dataset.short = (ingredient?.shortName ?? component.ingredientId).slice(0, 3).toUpperCase();
      chip.root.title =
        `${ingredient?.displayName ?? component.ingredientId} · ${FOOD_STATE_LABEL[component.state]}`;
      node.chips.append(chip.root);
    });

    for (const [id, chip] of node.chipNodes) {
      if (seen.has(id)) continue;
      chip.root.remove();
      node.chipNodes.delete(id);
    }
  }

  private createChipNode(ingredientId: string): ChipNode {
    const root = createElement("li", "order-chip");
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
    root.append(img);
    return { root, img };
  }

  private createTicketNode(orderId: string): TicketNode {
    const root = createElement("li", "order-card");
    root.innerHTML = `
      <div class="order-card-dish">
        <img class="order-card-art" data-t="dish" hidden alt="" />
        <span class="order-card-timer" data-t="timer">0s</span>
      </div>
      <strong class="order-card-name" data-t="name"></strong>
      <ul class="order-chips" data-t="chips"></ul>
      <span class="order-card-track"><span class="order-card-fill"></span></span>
      <span class="order-card-reward"><em data-t="reward">0</em></span>
      <span class="order-card-stamp" data-t="stamp" aria-hidden="true"></span>
      <span class="order-card-guest" data-t="guest" hidden></span>
    `;
    const pick = <T extends HTMLElement>(name: string): T => {
      const found = root.querySelector<T>(`[data-t="${name}"]`);
      if (!found) throw new Error(`Missing ticket element: ${name}`);
      return found;
    };
    const node: TicketNode = {
      root,
      name: pick("name"),
      timer: pick("timer"),
      dish: pick<HTMLImageElement>("dish"),
      guest: pick("guest"),
      reward: pick("reward"),
      chips: pick("chips"),
      stamp: pick("stamp"),
      chipNodes: new Map(),
      last: { seconds: -1, title: "", guest: "", recipeId: null, reward: -1, chipKey: "" },
      leaving: false,
    };
    // One-shot entry animation: the class is dropped once it finishes, so moving the card
    // later (when the queue reorders) cannot replay it.
    root.classList.add("is-entering");
    root.addEventListener(
      "animationend",
      () => root.classList.remove("is-entering"),
      { once: true },
    );
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
  setLevels(entries: readonly LevelEntry[]): void {
    this.levels = entries;
    if (!entries.some((entry) => entry.key === this.selectedLevelKey)) {
      this.selectedLevelKey = mapLevels(entries)[0]?.key ?? entries[0]?.key ?? "";
    }
    this.renderLevels();
    this.levelMap?.setLevels(mapLevels(entries).map((entry) => entry.key));
    this.levelMap?.select(this.selectedLevelKey || null);
    if (this.levelWindowKey && !entries.some((entry) => entry.key === this.levelWindowKey)) {
      this.closeLevelWindow();
    }
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
    this.myMaps.hidden = saved.length === 0;
    if (saved.length === 0) this.myMaps.open = false;
    for (const entry of saved) {
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
      this.closeLevelWindow(true);
      // Everyone confirms their cook afresh each time the street opens.
      if (previous !== "characters") this.readySlots.fill(false);
      this.renderCharacterSelector();
      this.startButton.focus();
    } else {
      this.focusSplash();
    }
    this.updateLevelMapActivity();
  }

  get splashStep(): SplashStep {
    return (this.selectionScreen.dataset.step as SplashStep | undefined) ?? "home";
  }

  setPairSkipVisible(visible: boolean): void {
    this.requireElement<HTMLButtonElement>("[data-action='pair-skip']").hidden = !visible;
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

  /** On the level step the map takes the keyboard, so Enter opens a star, not a button. */
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

  private selectMapLevel(key: string): void {
    this.selectedMapKey = key;
    if (!key.startsWith("future:")) this.selectedLevelKey = key;
    this.levelMap?.select(key);
  }

  private openLevelWindow(key: string): void {
    if (!this.fillLevelWindow(key)) return;
    this.levelMap?.select(key);
    window.clearTimeout(this.levelWindowTimer);
    this.levelWindowKey = key;
    this.levelWindow.hidden = false;
    // One frame hidden-to-shown first, or the transition has no starting state to run from.
    window.requestAnimationFrame(() => {
      if (this.levelWindowKey === key) this.levelWindow.dataset.open = "true";
    });
  }

  private closeLevelWindow(immediate = false): void {
    if (!this.levelWindowKey && this.levelWindow.hidden) return;
    this.levelWindowKey = "";
    this.levelWindow.dataset.open = "false";
    window.clearTimeout(this.levelWindowTimer);
    const hide = (): void => {
      if (!this.levelWindowKey) this.levelWindow.hidden = true;
    };
    if (immediate) hide();
    else this.levelWindowTimer = window.setTimeout(hide, 220);
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

  /** Arrow keys and WASD select landmarks; Enter opens the window, then plays. */
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
      const next = this.levelMap?.neighbour(this.levelWindowKey || this.selectedMapKey || this.selectedLevelKey || null, direction[0], direction[1]);
      if (!next) return;
      this.closeLevelWindow(true);
      this.selectMapLevel(next);
      return;
    }
    if (key === "Escape" && this.levelWindowKey) {
      event.preventDefault();
      this.closeLevelWindow();
      this.levelMapCanvas.focus({ preventScroll: true });
      return;
    }
    if ((key === "Enter" || key === " ") && !onControl && !event.repeat) {
      event.preventDefault();
      const mapKey = this.selectedMapKey || this.selectedLevelKey;
      if (!mapKey || this.levelMap?.isMoving()) return;
      if (this.levelWindowKey === mapKey && !mapKey.startsWith("future:")) this.chooseLevel(mapKey);
      else if (this.levelWindowKey !== mapKey) this.openLevelWindow(mapKey);
    }
  }

  private bindActions(): void {
    const signal = this.listenerController.signal;
    this.requireElement<HTMLButtonElement>("[data-action='home-play']").addEventListener("click", () => {
      const key = this.selectedLevelKey || this.levels[0]?.key;
      if (key) this.chooseLevel(key);
      else this.setSplashStep("level");
    }, { signal });
    this.requireElement<HTMLButtonElement>("[data-action='retry-level-map']").addEventListener("click", () => this.levelMap?.retry(), { signal });
    this.requireElement<HTMLButtonElement>("[data-action='home-levels']").addEventListener("click", () => this.setSplashStep("level"), { signal });
    this.requireElement<HTMLButtonElement>("[data-action='back-home']").addEventListener("click", () => {
      this.closeLevelWindow(true);
      this.setSplashStep("home");
    }, { signal });
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

    this.shell.querySelectorAll<HTMLButtonElement>("[data-action='quit-to-menu']").forEach((button) => {
      button.addEventListener("click", () => this.callbacks.onQuitToMenu?.(), { signal });
    });

    this.requireElement<HTMLButtonElement>("[data-action=menu-recipes]").addEventListener("click", () => this.toggleCookbook(true), { signal });
    this.requireElement<HTMLButtonElement>("[data-action=account]").addEventListener("click", () => this.callbacks.onOpenAccount?.());
    this.requireElement<HTMLButtonElement>("[data-action=phones]").addEventListener("click", () => this.callbacks.onOpenPhones?.(), { signal });
    this.requireElement<HTMLButtonElement>("[data-action='pair-skip']").addEventListener("click", () => this.callbacks.onPairSkip?.(), { signal });
    this.shell.querySelectorAll<HTMLButtonElement>("[data-collection]").forEach((button) => {
      button.addEventListener("click", () => this.callbacks.onOpenCollection?.(
        button.dataset.collection === "items" ? "items" : "achievements",
      ));
    });
    this.requireElement<HTMLButtonElement>("[data-action='open-editor']").addEventListener("click", () => {
      this.callbacks.onOpenEditor?.();
    }, { signal });

    this.shell.addEventListener("click", (event) => {
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

    this.requireElement<HTMLButtonElement>("[data-action='play-level']").addEventListener("click", () => {
      if (this.levelWindowKey) this.chooseLevel(this.levelWindowKey);
    }, { signal });
    this.requireElement<HTMLButtonElement>("[data-action='close-level-window']").addEventListener("click", () => {
      this.closeLevelWindow();
      this.levelMapCanvas.focus({ preventScroll: true });
    }, { signal });

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
    if (this.levelWindowKey) this.fillLevelWindow(this.levelWindowKey);
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
        createElement("small", undefined, t("cookbook.tabMeta", { components: recipe.ingredients.length, steps: recipe.steps.length })),
      );
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
    recipe.ingredients.forEach((ingredient) => {
      const item = createElement("li");
      item.append(
        createElement("span", "ingredient-quantity", `${ingredient.quantity}×`),
        createElement("span", undefined, getIngredient(ingredient.ingredientId)?.displayName ?? ingredient.ingredientId),
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
    // Back to gameplay nothing should hold focus: a focused (possibly hidden) button would
    // swallow player two's Enter, which is also the key that clicks it.
    const usable = previous?.isConnected && previous.offsetParent !== null &&
      !previous.closest("button, summary");
    if (usable) {
      previous.focus({ preventScroll: true });
      return;
    }
    const active = document.activeElement;
    if (active instanceof HTMLElement && this.shell.contains(active)) active.blur();
  }

  /**
   * Focuses an in-game overlay itself rather than its first button. Players are still on
   * the keyboard when the pause, recipe or results screen opens; with a button focused, the
   * Enter that player two was pressing to deliver would click "Jogar de novo" and skip the
   * results. Tab still walks to the buttons.
   */
  private focusOverlay(container: HTMLElement): void {
    if (!container.hasAttribute("tabindex")) container.tabIndex = -1;
    container.style.outline = "none";
    window.requestAnimationFrame(() => container.focus({ preventScroll: true }));
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
  /** One HUD card per possible player; `setPlayerCount` shows the ones in play. */
  private static playerStatusCards(): string {
    const classes = ["player-one", "player-two", "player-three", "player-four"];
    return classes.map((name, index) => `
          <section class="player-status ${name}" data-player-status="${index}"${index >= 2 ? " hidden" : ""} style="--player-color: ${PLAYER_COLORS[index]}">
            <p class="player-callout" data-player-callout hidden aria-live="polite"></p>
            <header><img data-player-portrait="${index}" class="hud-portrait" width="32" height="32" alt="" hidden /><strong>${playerLabel(index)}</strong><span data-i18n="hud.phoneKeys"></span></header>
            <div><kbd data-player-key hidden>A</kbd><span data-player-prompt data-i18n="hud.goToStation"></span></div>
            <small data-player-carrying data-i18n="hud.handsFree"></small>
            <span class="player-next-step" data-player-step hidden></span>
          </section>`).join("");
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

  private createMarkup(): string {
    return `
      <div class="hud-layer" data-ui="hud" aria-hidden="false">
        <div class="bistro-hud-top">
        <div class="shift-cluster" data-i18n-attr="aria-label:hud.shiftAria">
          <button class="shift-pause" type="button" data-action="pause-shift" data-i18n-attr="aria-label:hud.pauseAction"></button>
          <div class="shift-chip time-chip">
            <span><small data-i18n="hud.time"></small><strong data-ui="shift-timer">00:00</strong></span>
          </div>
          <div class="shift-chip score-chip">
            <span><small data-i18n="hud.score"></small><strong data-ui="score">0</strong></span>
          </div>
          <div class="shift-chip combo-chip">
            <span><small data-i18n="hud.combo"></small><strong data-ui="combo">—</strong></span>
          </div>
          <div class="star-meter" data-ui="star-meter" hidden data-i18n-attr="aria-label:hud.starMeterAria">
            <div class="star-meter-track"><span class="star-meter-fill" data-ui="star-meter-fill"></span></div>
            <div class="star-meter-stars">
              <span data-star="1"></span><span data-star="2"></span><span data-star="3"></span>
            </div>
            <small data-ui="star-meter-note"></small>
          </div>
        </div>

        <section class="order-panel is-empty" data-ui="order" data-i18n-attr="aria-label:hud.ordersAria">
          <ul class="order-tickets" data-ui="order-tickets" aria-live="polite"></ul>
          <ul class="order-upcoming" data-ui="order-upcoming" data-i18n-attr="aria-label:hud.upcomingAria"></ul>
          <p class="order-empty-hint" data-i18n="hud.waitingOrders"></p>
          <span class="order-overflow" data-ui="wedding-guest" hidden></span>
        </section>

        </div>

        <section class="station-progress" data-ui="station-progress" data-tone="active" hidden aria-live="polite">
          <header><span data-ui="station-progress-label" data-i18n="hud.station"></span><strong data-ui="station-progress-status" data-i18n="hud.working"></strong></header>
          <div class="station-progress-track" data-ui="station-progress-bar" role="progressbar" data-i18n-attr="aria-label:hud.stationProgressAria" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <span class="station-progress-fill"></span><span class="station-ideal-zone" aria-hidden="true"></span>
          </div>
          <footer><span data-ui="station-progress-detail"></span><strong data-ui="station-progress-value">0%</strong></footer>
        </section>

        <div class="coop-player-status" data-ui="coop-player-status" data-count="2" data-i18n-attr="aria-label:hud.playersAria">
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
              <button class="secondary-action bistro-home-icon bistro-home-levels" type="button" data-action="home-levels" data-i18n-attr="aria-label:menu.selectPhase;title:menu.selectPhase"></button>
              <button class="secondary-action bistro-home-icon menu-map-action" type="button" data-action="open-editor" data-i18n-attr="aria-label:menu.createMap;title:menu.createMap"></button>
              <button class="secondary-action bistro-home-icon" type="button" data-action="menu-recipes" data-i18n-attr="aria-label:menu.homeRecipes;title:menu.homeRecipes"></button>
              <button class="primary-action bistro-home-play" type="button" data-action="home-play" data-i18n="menu.homePlay"></button>
              <button class="secondary-action bistro-home-icon" type="button" data-collection="items" data-i18n-attr="aria-label:collection.items;title:collection.items"></button>
              <button class="secondary-action bistro-home-icon" type="button" data-collection="achievements" data-i18n-attr="aria-label:collection.achievements;title:collection.achievements"></button>
              <details class="bistro-home-settings">
                <summary class="secondary-action bistro-home-icon" data-i18n-attr="aria-label:menu.settings;title:menu.settings"></summary>
                ${GameUI.qualitySwitch()}
              </details>
              <button class="secondary-action bistro-home-icon bistro-account-action" type="button" data-action="account" data-i18n-attr="aria-label:account.title;title:account.title"></button>
              <button class="secondary-action bistro-home-icon bistro-phones-action" type="button" data-action="phones" data-i18n-attr="aria-label:pair.players;title:pair.players"></button>
              ${GameUI.languageSwitch()}
            </div>
            <details class="my-maps" data-ui="my-maps" hidden>
              <summary data-i18n="menu.myMaps"></summary>
              <ul class="level-list" data-ui="level-list"></ul>
            </details>
          </header>
          <section class="pair-select" data-ui="pair-select" aria-labelledby="pair-title">
            <h2 id="pair-title" data-i18n="pair.title"></h2>
            <div class="pair-panel" data-ui="pair-panel"></div>
            <button class="secondary-action pair-skip" type="button" data-action="pair-skip" hidden data-i18n="pair.skip"></button>
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
                <span><kbd>Enter</kbd> <span data-i18n="menu.open"></span></span>
              </p>
              <aside class="level-window" data-ui="level-window" data-open="false" role="dialog" aria-labelledby="level-window-title" hidden>
                <button class="level-window-close" type="button" data-action="close-level-window" data-i18n-attr="aria-label:common.close">&times;</button>
                <span class="level-window-kind" data-ui="level-window-kind"></span>
                <h3 id="level-window-title" class="level-window-title" data-ui="level-window-title"></h3>
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
          <footer class="modal-footer"><span data-i18n="cookbook.chooseHint"></span><button type="button" class="secondary-action" data-action="close-cookbook"><span data-i18n="cookbook.backToKitchen"></span> <kbd>TAB</kbd></button></footer>
        </div>
      </section>

      <section class="full-overlay pause-overlay" data-ui="pause" role="dialog" aria-modal="true" aria-labelledby="pause-title" hidden>
        <div class="pause-card modal-window">
          <div class="pause-emblem" aria-hidden="true"><span>Ⅱ</span></div>
          <h2 id="pause-title" data-i18n="pause.title"></h2>
          <p data-i18n="pause.text"></p>
          <button class="primary-action" type="button" data-action="resume"><span data-i18n="pause.resume"></span><i aria-hidden="true">→</i></button>
          <button class="secondary-action overlay-menu-action" type="button" data-action="quit-to-menu"><span data-i18n="pause.toMenu"></span></button>
          ${GameUI.languageSwitch()}
          ${GameUI.qualitySwitch()}
          <div class="pause-hint"><kbd>ESC</kbd><span data-i18n="pause.hintResume"></span><kbd>TAB</kbd><span data-i18n="pause.hintRecipes"></span></div>
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
          <footer class="results-footer"><span data-i18n="results.saved"></span><div class="results-actions"><button class="secondary-action overlay-menu-action" type="button" data-action="quit-to-menu"><span data-i18n="results.menu"></span></button><button class="primary-action" type="button" data-action="restart"><span data-i18n="results.again"></span><i aria-hidden="true">↻</i></button></div></footer>
        </div>
      </section>
    `;
  }
}
