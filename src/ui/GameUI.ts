import type {
  AIState,
  FoodState,
  MiraExpression,
  RecipeData,
  RuntimeGameState,
  ShiftResult,
  StationId,
} from "../types/game";
import type { CharacterDefinition } from "../data/characters";
import { formatShiftDuration, type LevelEntry } from "../data/levelCatalog";
import { mapLevels } from "../data/levelMap";
import { starsForRank, type LevelRanks } from "../data/levelRanks";
import { confirmDialog } from "./confirmDialog";
import { FOOD_STATE_LABEL, STATION_KIND_LABEL } from "../data/kitchen";
import { getIngredient } from "../data/ingredients";
import { publicUrl } from "../utils/assetUrl";
import "../styles/game.css";
import "../styles/tech-theme.css";
// Imported last: the order queue deliberately overrides the older HUD-card styling.
import "../styles/orders.css";
import "../styles/selection-kitchen.css";
import "../styles/levels.css";
// Last: extends the order card's look to the overlays, the prompts and the editor.
import "../styles/cartoon.css";
// Presentation only: the reference-inspired skin leaves game state and callbacks intact.
import "../styles/cosmic.css";
import "../styles/level-map.css";

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
  stage: "fetch" | "chop" | "cook" | "cooking" | "plate" | "plated";
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
  assignedTo: 0 | 1 | null;
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

export interface GameUICallbacks {
  onStart?: (characterIds: readonly [string, string]) => void | Promise<void>;
  onCharacterChange?: (characterIds: readonly [string, string]) => void;
  onRestart?: () => void;
  onResume?: () => void;
  /** Leaves the running shift for the level and cook picker. */
  onQuitToMenu?: () => void;
  onCookbookVisibilityChange?: (visible: boolean) => void;
  onOpenEditor?: () => void;
  /** Fires when a level card is chosen, before the cooks are picked. */
  onLevelChange?: (entry: LevelEntry) => void;
  /** Deletes one of the player's saved maps, after they confirmed; false if it failed. */
  onDeleteLevel?: (entry: LevelEntry) => boolean;
  /** Fires with the character that should be shown live in the menu preview. */
  onCharacterPreview?: (playerOneId: string | null, playerTwoId: string | null) => void;
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
}

export interface GameUIOptions extends GameUICallbacks {
  characters?: readonly CharacterDefinition[];
  selectedCharacterIds?: readonly [string, string];
  /** @deprecated Use selectedCharacterIds. */
  selectedCharacterId?: string;
  recipes?: readonly RecipeData[];
  startVisible?: boolean;
}

interface NotificationEntry {
  element: HTMLElement;
  timeoutId: number;
}

const STATION_LABELS: Readonly<Record<StationId, string>> = {
  ingredient_dispenser: "Ingredient Dispenser",
  bit_crusher: "Bit Crusher",
  data_mixer: "Data Mixer",
  compiler_oven: "Compiler Oven",
  cache_freezer: "Cache Freezer",
  plating_station: "Plating Station",
  serving_terminal: "CORE Serving Terminal",
  ...STATION_KIND_LABEL,
};

const EFFECT_LABELS: Readonly<Record<keyof AIState, string>> = {
  memory: "Memory",
  processing: "Processing",
  creativity: "Creativity",
  stability: "Stability",
  temperature: "Temperature",
  energy: "Energy",
  mood: "Mood",
};

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const formatClock = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
};

const humanizeId = (value: string): string =>
  value
    .split("_")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");

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
  private readonly notifications = new Map<number, NotificationEntry>();
  private readonly recipeById = new Map<string, RecipeData>();

  private characters: readonly CharacterDefinition[] = [];
  private selectedCharacterIds: [string | null, string | null] = [null, null];
  private recipes: readonly RecipeData[] = [];
  private selectedRecipeId: string | null = null;
  private cookbookVisible = false;
  private dialogueTimeoutId: number | null = null;
  private notificationSequence = 0;
  private lastFocusedElement: HTMLElement | null = null;
  private destroyed = false;

  private readonly splash: HTMLElement;
  private readonly characterStatus: HTMLElement;
  private readonly selectionScreen: HTMLElement;
  private readonly levelList: HTMLElement;
  private levels: readonly LevelEntry[] = [];
  private selectedLevelKey = "";
  private levelRanks: LevelRanks = {};
  private levelMap: LevelMapPort | null = null;
  /** The level whose window is open, or "" when it is closed. */
  private levelWindowKey = "";
  private levelWindowTimer = 0;
  private editorVisible = false;
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
  private readonly stationProgress: HTMLElement;
  private readonly stationProgressLabel: HTMLElement;
  private readonly stationProgressStatus: HTMLElement;
  private readonly stationProgressDetail: HTMLElement;
  private readonly stationProgressBar: HTMLElement;
  private readonly stationProgressValue: HTMLElement;
  private readonly orderPanel: HTMLElement;
  private readonly orderTickets: HTMLElement;
  private readonly weddingGuest: HTMLElement;
  /** Live ticket rows, keyed by order id, so the list reconciles instead of rebuilding. */
  private readonly ticketNodes = new Map<string, TicketNode>();
  /** Pending exit animations, so a card is not removed while it is still playing one. */
  private readonly orderExitTimers = new Map<string, number>();
  private readonly shiftTimer: HTMLElement;
  private readonly scoreValue: HTMLElement;
  private readonly comboValue: HTMLElement;
  private readonly playerStatusPanels: readonly [HTMLElement, HTMLElement];
  private readonly splitDivider: HTMLElement;
  private readonly debugPanel: HTMLElement;
  private readonly debugRows: HTMLElement;
  private readonly previewCanvas: HTMLCanvasElement;
  private readonly previewName: HTMLElement;
  private readonly previewRole: HTMLElement;
  private readonly previewName2: HTMLElement;
  private readonly previewRole2: HTMLElement;

  constructor(root: HTMLElement, options: GameUIOptions = {}) {
    this.host = root;
    this.callbacks = options;
    this.shell = createElement("div", "game-ui");
    this.shell.dataset.gameVisible = "true";
    this.shell.innerHTML = this.createMarkup();
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
    this.stationProgress = this.requireElement("[data-ui='station-progress']");
    this.stationProgressLabel = this.requireElement("[data-ui='station-progress-label']");
    this.stationProgressStatus = this.requireElement("[data-ui='station-progress-status']");
    this.stationProgressDetail = this.requireElement("[data-ui='station-progress-detail']");
    this.stationProgressBar = this.requireElement("[data-ui='station-progress-bar']");
    this.stationProgressValue = this.requireElement("[data-ui='station-progress-value']");
    this.orderPanel = this.requireElement("[data-ui='order']");
    this.orderTickets = this.requireElement("[data-ui='order-tickets']");
    this.weddingGuest = this.requireElement("[data-ui='wedding-guest']");
    this.shiftTimer = this.requireElement("[data-ui='shift-timer']");
    this.scoreValue = this.requireElement("[data-ui='score']");
    this.comboValue = this.requireElement("[data-ui='combo']");
    this.playerStatusPanels = [
      this.requireElement("[data-player-status='0']"),
      this.requireElement("[data-player-status='1']"),
    ];
    this.splitDivider = this.requireElement("[data-ui='split-divider']");
    this.debugPanel = this.requireElement("[data-ui='debug']");
    this.debugRows = this.requireElement("[data-ui='debug-rows']");
    this.previewCanvas = this.requireElement<HTMLCanvasElement>("[data-ui='preview-canvas']");
    this.previewName = this.requireElement("[data-ui='preview-name']");
    this.previewRole = this.requireElement("[data-ui='preview-role']");
    this.previewName2 = this.requireElement("[data-ui='preview-name-2']");
    this.previewRole2 = this.requireElement("[data-ui='preview-role-2']");

    this.setCharacters(
      options.characters ?? [],
      options.selectedCharacterIds ?? (options.selectedCharacterId
        ? [options.selectedCharacterId, options.selectedCharacterId]
        : undefined),
    );
    this.bindActions();
    this.setRecipes(options.recipes ?? []);
    this.showSplash(options.startVisible ?? true);
    // The stage is chosen before the cooks. Set once here rather than on every
    // showSplash, so using the splash as a loading veil cannot flash the level list.
    this.setSplashStep("level");
  }

  update(state: Readonly<RuntimeGameState>): void {
    if (this.destroyed) return;

    this.shiftTimer.textContent = formatClock(state.shiftTimeRemaining);
    this.shiftTimer.closest(".shift-chip")?.classList.toggle("is-urgent", state.shiftTimeRemaining <= 30);
    this.scoreValue.textContent = Math.max(0, Math.round(state.score)).toLocaleString("en-US");
    this.comboValue.textContent = state.combo > 1 ? `X${state.combo}` : "—";
    this.comboValue.closest(".shift-chip")?.classList.toggle("is-active", state.combo > 1);
    this.updateMiraState(state.aiState);
    // The order queue is pushed imperatively from KitchenScene, which owns the countdowns.
    this.shell.dataset.shiftEnded = state.shiftEnded ? "true" : "false";
  }

  setPlayerStatus(index: 0 | 1, info: Readonly<PlayerStatusInfo>): void {
    if (this.destroyed) return;
    const panel = this.playerStatusPanels[index];
    const prompt = panel.querySelector<HTMLElement>("[data-player-prompt]");
    const key = panel.querySelector<HTMLElement>("[data-player-key]");
    const carrying = panel.querySelector<HTMLElement>("[data-player-carrying]");
    if (!prompt || !key || !carrying) return;
    panel.classList.toggle("has-prompt", Boolean(info.prompt));
    panel.classList.toggle("is-carrying", Boolean(info.carrying));
    prompt.textContent = info.prompt ?? "MOVE TO A STATION";
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

  setSplitScreen(amount: number, distance: number): void {
    if (this.destroyed) return;
    const split = clamp(amount, 0, 1);
    this.splitDivider.style.setProperty("--split-opacity", split.toFixed(3));
    this.splitDivider.hidden = split < 0.01;
    this.splitDivider.setAttribute("aria-label", `Split screen, players ${distance.toFixed(1)} meters apart`);
  }

  setStationProgress(info: StationProgressInfo | null): void {
    if (this.destroyed) return;
    this.stationProgress.hidden = info === null;
    if (!info) return;

    const normalizedProgress = info.progress <= 1 ? info.progress * 100 : info.progress;
    const percentage = clamp(normalizedProgress, 0, 100);
    this.stationProgress.dataset.tone = info.tone ?? "active";
    this.stationProgressLabel.textContent = info.label;
    this.stationProgressStatus.textContent = info.status ?? "PROCESSING";
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
    selectedCharacterIds?: readonly [string, string],
  ): void {
    this.characters = [...characters];
    const resolve = (index: 0 | 1): string | null => {
      const requested = selectedCharacterIds?.[index];
      if (requested && this.characters.some(({ id }) => id === requested)) return requested;
      const current = this.selectedCharacterIds[index];
      if (current && this.characters.some(({ id }) => id === current)) return current;
      return this.characters[index]?.id ?? this.characters[0]?.id ?? null;
    };
    this.selectedCharacterIds = [resolve(0), resolve(1)];
    this.startButton.disabled = this.characters.length > 0 && this.selectedCharacterIds.some((id) => !id);
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
    const quality = result.averageDishQuality <= 1
      ? result.averageDishQuality * 100
      : result.averageDishQuality;

    this.setResultValue("completed", result.ordersCompleted.toString());
    this.setResultValue("failed", result.ordersFailed.toString());
    this.setResultValue("quality", `${Math.round(clamp(quality, 0, 100))}%`);
    this.setResultValue("stability", `${Math.round(clamp(result.miraStability, 0, 100))}%`);
    this.setResultValue("score", Math.round(result.cookingScore).toLocaleString("en-US"));
    this.setResultValue("credits", `+${Math.max(0, Math.round(result.creditsEarned)).toLocaleString("en-US")}`);
    this.setResultValue("combo", `X${result.maxCombo}`);
    this.setResultValue("throws", result.componentsThrown.toString());
    this.setResultValue("sync", `${Math.round(result.teamSynchronization)}%`);
    this.setResultValue("meltdowns", result.meltdowns.toString());

    const rank = this.requireElement("[data-result-rank]");
    rank.textContent = result.rank;
    rank.dataset.rank = result.rank;
    this.requireElement("[data-result-message]").textContent = this.getRankMessage(result.rank);
    this.resultsOverlay.hidden = false;
    this.shell.dataset.modalOpen = "true";
    this.captureFocus();
    this.focusOverlay(this.resultsOverlay);
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
    this.callbacks.onPreviewActiveChange?.(!visible);
    this.updateLevelMapActivity();
  }

  setGameVisible(visible: boolean): void {
    if (this.destroyed) return;
    this.shell.dataset.gameVisible = visible ? "true" : "false";
    this.hud.setAttribute("aria-hidden", visible ? "false" : "true");
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
    this.callbacks.onPreviewActiveChange?.(visible);
    this.updateLevelMapActivity();
    if (visible) this.focusSplash();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    window.clearTimeout(this.levelWindowTimer);
    this.listenerController.abort();
    if (this.dialogueTimeoutId !== null) window.clearTimeout(this.dialogueTimeoutId);
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
    this.renderLevels();
    this.levelMap?.select(mapLevels(this.levels).some((entry) => entry.key === key) ? key : null);
  }

  /** Best rank per level, for the stars in the level window. */
  setLevelRanks(ranks: LevelRanks): void {
    this.levelRanks = ranks;
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
    const plates: readonly [HTMLElement, HTMLElement] = [this.previewName, this.previewName2];
    const roles: readonly [HTMLElement, HTMLElement] = [this.previewRole, this.previewRole2];
    for (const slot of [0, 1] as const) {
      const character = this.characters.find((entry) => entry.id === this.selectedCharacterIds[slot]) ?? null;
      plates[slot].textContent = character
        ? character.variant
          ? `${character.displayName} · ${character.variant}`
          : character.displayName
        : "—";
      roles[slot].textContent = character?.role ?? "";
    }
    const [p1, p2] = this.selectedCharacterIds;
    this.callbacks.onCharacterPreview?.(p1, p2);
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
          node.dish.src = publicUrl(`images/dishes/${ticket.recipeId}.png`);
          node.dish.alt = this.recipeById.get(ticket.recipeId)?.displayName ?? "Prato solicitado";
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
    img.src = publicUrl(`images/ingredients/${ingredientId}.png`);
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
      scenario: "Cenário",
      official: "Fase oficial",
      saved: "Meu mapa",
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
      remove.setAttribute("aria-label", `Excluir o mapa ${entry.title}`);
      remove.title = "Excluir mapa";
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
      title: "Excluir mapa?",
      message: `O mapa "${entry.title}" será apagado permanentemente. Essa ação não pode ser desfeita.`,
      confirmLabel: "Excluir",
      danger: true,
    });
    if (!confirmed) return;
    if (this.callbacks.onDeleteLevel(entry)) {
      this.notify(`Mapa "${entry.title}" excluído.`, "warning");
    } else {
      this.notify("Não foi possível excluir o mapa.", "error");
    }
  }

  /** `level` picks the stage, `characters` picks the cooks. */
  private setSplashStep(step: "level" | "characters"): void {
    this.selectionScreen.dataset.step = step;
    this.requireElement<HTMLButtonElement>("[data-action='back-level']").hidden = step !== "characters";
    if (step === "characters") {
      this.closeLevelWindow(true);
      this.startButton.focus();
    } else {
      this.focusSplash();
    }
    this.updateLevelMapActivity();
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

  /** The map draws only while the level step is on screen. */
  private updateLevelMapActivity(): void {
    this.levelMap?.setActive(
      !this.splash.hidden && !this.editorVisible && this.selectionScreen.dataset.step === "level",
    );
  }

  /** On the level step the map takes the keyboard, so Enter opens a star, not a button. */
  private focusSplash(): void {
    if (this.selectionScreen.dataset.step === "level") {
      window.requestAnimationFrame(() => this.levelMapCanvas.focus({ preventScroll: true }));
    } else {
      this.focusFirst(this.splash);
    }
  }

  private selectMapLevel(key: string): void {
    this.selectedLevelKey = key;
    this.levelMap?.select(key);
  }

  private openLevelWindow(key: string): void {
    if (!this.fillLevelWindow(key)) return;
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
    const levels = mapLevels(this.levels);
    const index = levels.findIndex((level) => level.key === key);
    const entry = levels[index];
    if (!entry) return false;
    const rank = this.levelRanks[key] ?? null;
    const stars = starsForRank(rank);
    this.requireElement("[data-ui='level-window-kind']").textContent = `Fase ${index + 1}`;
    this.requireElement("[data-ui='level-window-title']").textContent = entry.title;
    this.requireElement("[data-ui='level-window-description']").textContent = entry.description || entry.summary || "";
    const rankRow = this.requireElement("[data-ui='level-window-rank']");
    rankRow.setAttribute("aria-label", rank ? `${stars} de 3 estrelas` : "Ainda sem estrelas");
    rankRow.querySelectorAll<HTMLElement>(".rank-star").forEach((star, starIndex) => {
      star.dataset.filled = String(starIndex < stars);
    });
    const best = this.requireElement("[data-ui='level-window-best']");
    best.textContent = rank ? `Melhor nota: ${rank}` : "Ainda não jogada";
    best.dataset.rank = rank ?? "";
    const meta = this.requireElement("[data-ui='level-window-meta']");
    meta.replaceChildren(
      ...[entry.difficultyLabel, formatShiftDuration(entry.shiftDurationSeconds)].map((text) => createElement("span", undefined, text)),
    );
    return true;
  }

  /** Arrow keys and WASD jump between stars; Enter opens the window, then plays. */
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
      const next = this.levelMap?.neighbour(this.selectedLevelKey || null, direction[0], direction[1]);
      if (!next) return;
      this.selectMapLevel(next);
      if (this.levelWindowKey) this.openLevelWindow(next);
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
      if (!this.selectedLevelKey) return;
      if (this.levelWindowKey === this.selectedLevelKey) this.chooseLevel(this.selectedLevelKey);
      else this.openLevelWindow(this.selectedLevelKey);
    }
  }

  private bindActions(): void {
    const signal = this.listenerController.signal;
    this.startButton.addEventListener("click", async () => {
      if (this.startButton.disabled) return;
      const characterIds: readonly [string, string] = [
        this.selectedCharacterIds[0] ?? "",
        this.selectedCharacterIds[1] ?? "",
      ];
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
        this.characterStatus.textContent = "Não foi possível carregar o cozinheiro. Tente de novo.";
      } finally {
        this.setStartLoading(false);
      }
    }, { signal });

    // Both players choose at the same time, each on their own half of the keyboard.
    this.splash.addEventListener("keydown", (event) => {
      if (this.splash.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
      // On the level step the arrow keys belong to the map, not to the cook carousel.
      if (this.selectionScreen.dataset.step !== "characters") {
        this.handleLevelKey(event);
        return;
      }
      const key = event.key;
      if (key === "a" || key === "A" || key === "d" || key === "D") {
        event.preventDefault();
        this.browseCharacter(0, key === "a" || key === "A" ? -1 : 1);
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
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

    this.requireElement<HTMLButtonElement>("[data-action='open-editor']").addEventListener("click", () => {
      this.callbacks.onOpenEditor?.();
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

  private browseCharacter(slot: 0 | 1, direction: number): void {
    if (!this.characters.length || this.startButton.dataset.loading === "true") return;
    const current = this.characters.findIndex(({ id }) => id === this.selectedCharacterIds[slot]);
    const next = (Math.max(0, current) + direction + this.characters.length) % this.characters.length;
    const nextCharacter = this.characters[next];
    if (!nextCharacter || nextCharacter.id === this.selectedCharacterIds[slot]) return;
    this.selectedCharacterIds[slot] = nextCharacter.id;
    this.renderCharacterSelector();
    const [p1, p2] = this.selectedCharacterIds;
    if (p1 && p2) this.callbacks.onCharacterChange?.([p1, p2]);
  }


  private renderCharacterSelector(): void {
    const both = this.selectedCharacterIds.every((id) => Boolean(id));
    this.requireElement("[data-ui='selection-step']").textContent = "JOGADOR 1 E 2";
    this.requireElement("[data-ui='character-count']").textContent = this.characters.length
      ? `${this.characters.length} cozinheiros`
      : "";
    this.requireElement<HTMLButtonElement>("[data-action='back-player']").hidden = true;
    this.characterStatus.dataset.state = "ready";
    this.characterStatus.textContent = !this.characters.length
      ? "Nenhum personagem disponível."
      : "P1 escolhe com A e D · P2 escolhe com ← e → · ENTER para começar";
    this.startButton.disabled = this.characters.length > 0 && !both;
    this.setStartLoading(false);
    this.updatePreview();
  }


  private setStartLoading(loading: boolean): void {
    this.startButton.disabled = loading ||
      (this.characters.length > 0 && this.selectedCharacterIds.some((id) => !id));
    this.startButton.dataset.loading = loading ? "true" : "false";
    const label = this.startButton.querySelector("span");
    if (label) label.textContent = loading ? "PREPARANDO…" : "COMEÇAR A COZINHAR";
    if (loading) {
      this.characterStatus.dataset.state = "loading";
      this.characterStatus.textContent = "Preparando os cozinheiros…";
    }
  }

  private renderCookbook(): void {
    this.cookbookNavigation.replaceChildren();
    if (this.recipes.length === 0) {
      const empty = createElement("div", "cookbook-empty");
      empty.append(
        createElement("span", "cookbook-empty-icon", "⌁"),
        createElement("strong", undefined, "RECIPE DATABASE SYNCING"),
        createElement("p", undefined, "No neural recipes are available in this shift."),
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
        createElement("small", undefined, `${recipe.ingredients.length} COMPONENTS · ${recipe.steps.length} STAGES`),
      );
      button.append(indexLabel, copy, createElement("span", "recipe-tab-arrow", "›"));
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
      createElement("span", "ui-kicker", `RECIPE FILE // ${number.toString().padStart(2, "0")}`),
      createElement("h3", undefined, recipe.displayName),
      createElement("p", undefined, recipe.description),
    );
    const reward = createElement("div", "recipe-reward");
    reward.append(createElement("small", undefined, "BASE REWARD"), createElement("strong", undefined, `${recipe.reward} CR`));
    header.append(titleWrap, reward);

    const body = createElement("div", "recipe-detail-grid");
    const ingredients = createElement("section", "recipe-section");
    ingredients.append(createElement("h4", undefined, "Required components"));
    const ingredientList = createElement("ul", "ingredient-list");
    recipe.ingredients.forEach((ingredient) => {
      const item = createElement("li");
      item.append(
        createElement("span", "ingredient-quantity", `${ingredient.quantity}×`),
        createElement("span", undefined, humanizeId(ingredient.ingredientId)),
      );
      ingredientList.append(item);
    });
    ingredients.append(ingredientList);

    const effects = createElement("section", "recipe-section");
    effects.append(createElement("h4", undefined, "CORE response"));
    const effectList = createElement("div", "effect-list");
    const effectEntries = Object.entries(recipe.effects) as Array<[keyof AIState, number]>;
    effectEntries.forEach(([key, value]) => {
      const effect = createElement("div", "effect-chip");
      effect.dataset.effect = value >= 0 ? "positive" : "cooling";
      effect.append(
        createElement("span", undefined, EFFECT_LABELS[key]),
        createElement("strong", undefined, `${value >= 0 ? "+" : ""}${value}`),
      );
      effectList.append(effect);
    });
    effects.append(effectList);
    body.append(ingredients, effects);

    const pipeline = createElement("section", "recipe-pipeline");
    pipeline.append(createElement("h4", undefined, "Compilation pipeline"));
    const stepList = createElement("ol", "recipe-steps");
    recipe.steps.forEach((step, index) => {
      const item = createElement("li");
      const marker = createElement("span", "step-marker", (index + 1).toString().padStart(2, "0"));
      const stepCopy = createElement("div");
      stepCopy.append(
        createElement("strong", undefined, STATION_LABELS[step.stationId]),
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
      case "S": return "Exceptional neural cuisine. CORE will remember this shift.";
      case "A": return "High-efficiency service with excellent system care.";
      case "B": return "A stable shift. A few processes can still be optimized.";
      case "C": return "Shift completed, but CORE detected inconsistent output.";
      case "D": return "Critical service faults logged. Recalibration recommended.";
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

  private createMarkup(): string {
    return `
      <div class="hud-layer" data-ui="hud" aria-hidden="false">
        <div class="shift-cluster" aria-label="Estado do turno">
          <div class="shift-chip">
            <span><small>TEMPO</small><strong data-ui="shift-timer">00:00</strong></span>
          </div>
          <div class="shift-chip score-chip">
            <span><small>PONTOS</small><strong data-ui="score">0</strong></span>
          </div>
          <div class="shift-chip combo-chip">
            <span><small>COMBO</small><strong data-ui="combo">—</strong></span>
          </div>
        </div>

        <section class="order-panel is-empty" data-ui="order" aria-label="Pedidos ativos">
          <ul class="order-tickets" data-ui="order-tickets" aria-live="polite"></ul>
          <p class="order-empty-hint">Aguardando pedidos…</p>
          <span class="order-overflow" data-ui="wedding-guest" hidden></span>
        </section>

        <section class="station-progress" data-ui="station-progress" data-tone="active" hidden aria-live="polite">
          <header><span data-ui="station-progress-label">ESTAÇÃO</span><strong data-ui="station-progress-status">TRABALHANDO</strong></header>
          <div class="station-progress-track" data-ui="station-progress-bar" role="progressbar" aria-label="Progresso da estação" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <span class="station-progress-fill"></span><span class="station-ideal-zone" aria-hidden="true"></span>
          </div>
          <footer><span data-ui="station-progress-detail"></span><strong data-ui="station-progress-value">0%</strong></footer>
        </section>

        <div class="coop-player-status" aria-label="Co-op player status">
          <section class="player-status player-one" data-player-status="0">
            <header><strong>P1</strong><span>WASD · E · F · SHIFT</span></header>
            <div><kbd data-player-key hidden>E</kbd><span data-player-prompt>VÁ ATÉ UMA ESTAÇÃO</span></div>
            <small data-player-carrying>MÃOS LIVRES</small>
            <span class="player-next-step" data-player-step hidden></span>
          </section>
          <section class="player-status player-two" data-player-status="1">
            <header><strong>P2</strong><span>SETAS · ENTER · RSHIFT</span></header>
            <div><kbd data-player-key hidden>ENTER</kbd><span data-player-prompt>VÁ ATÉ UMA ESTAÇÃO</span></div>
            <small data-player-carrying>MÃOS LIVRES</small>
            <span class="player-next-step" data-player-step hidden></span>
          </section>
        </div>
        <div class="split-screen-divider" data-ui="split-divider" hidden aria-hidden="true"></div>

        <div class="notification-region" data-ui="notifications" aria-live="polite" aria-relevant="additions"></div>

        <aside class="debug-panel" data-ui="debug" hidden>
          <header><span>TELEMETRIA</span><i>AO VIVO</i></header>
          <div data-ui="debug-rows"></div>
        </aside>
      </div>

      <section class="full-overlay splash-overlay" data-ui="splash" role="dialog" aria-modal="true" aria-labelledby="splash-title" tabindex="-1">
        <div class="selection-screen">
          <header class="selection-header">
            <h1 id="splash-title">BYTE <span>BISTRO</span></h1>
            <button class="secondary-action menu-map-action" type="button" data-action="open-editor">Criar mapa</button>
          </header>
          <section class="level-select" data-ui="level-select">
            <h2>ESCOLHA A FASE</h2>
            <div class="level-map-stage" data-ui="level-map-stage">
              <canvas class="level-map-canvas" data-ui="level-map-canvas" tabindex="0" aria-label="Mapa de São Bento do Sul. Use as setas para escolher uma fase e Enter para abrir."></canvas>
              <p class="level-map-hint" aria-hidden="true">
                <span>Arraste para girar</span>
                <span>Roda do mouse para zoom</span>
                <span><kbd>&#8592;</kbd><kbd>&#8594;</kbd><kbd>&#8593;</kbd><kbd>&#8595;</kbd> trocar de fase</span>
                <span><kbd>Enter</kbd> abrir</span>
              </p>
              <aside class="level-window" data-ui="level-window" data-open="false" role="dialog" aria-labelledby="level-window-title" hidden>
                <button class="level-window-close" type="button" data-action="close-level-window" aria-label="Fechar">&times;</button>
                <span class="level-window-kind" data-ui="level-window-kind">Fase 1</span>
                <h3 id="level-window-title" class="level-window-title" data-ui="level-window-title"></h3>
                <div class="level-window-rank" data-ui="level-window-rank" role="img">
                  <svg class="rank-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4l2.95 6.1 6.65.85-4.9 4.6 1.3 6.65L12 17.3l-5.95 3.3 1.3-6.65-4.9-4.6 6.65-.85z"/></svg><svg class="rank-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4l2.95 6.1 6.65.85-4.9 4.6 1.3 6.65L12 17.3l-5.95 3.3 1.3-6.65-4.9-4.6 6.65-.85z"/></svg><svg class="rank-star" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.4l2.95 6.1 6.65.85-4.9 4.6 1.3 6.65L12 17.3l-5.95 3.3 1.3-6.65-4.9-4.6 6.65-.85z"/></svg>
                </div>
                <p class="level-window-best" data-ui="level-window-best"></p>
                <p class="level-window-description" data-ui="level-window-description"></p>
                <div class="level-window-meta" data-ui="level-window-meta"></div>
                <button class="primary-action level-window-play" type="button" data-action="play-level"><span>JOGAR</span><i aria-hidden="true">&#8594;</i></button>
              </aside>
              <details class="my-maps" data-ui="my-maps" hidden>
                <summary>Meus mapas</summary>
                <ul class="level-list" data-ui="level-list"></ul>
              </details>
            </div>
          </section>
          <section class="selection-arena">
            <div class="character-preview-stage" data-ui="preview-stage">
              <canvas class="character-preview-canvas" data-ui="preview-canvas" width="900" height="650" aria-label="Cozinheiros escolhidos"></canvas>
              <span class="character-preview-player" data-ui="preview-player" data-player="p1" hidden>P1</span>
              <!-- Keys sit beside each cook, so the control is read where it applies. -->
              <div class="pick-hint pick-hint-p1" data-player="p1">
                <span class="pick-badge">P1</span>
                <span class="pick-keys"><kbd>A</kbd><kbd>D</kbd></span>
                <strong data-ui="preview-name">—</strong>
              </div>
              <div class="pick-hint pick-hint-p2" data-player="p2">
                <span class="pick-badge">P2</span>
                <span class="pick-keys"><kbd>&#8592;</kbd><kbd>&#8594;</kbd></span>
                <strong data-ui="preview-name-2">—</strong>
              </div>
            </div>
            <span class="character-count" data-ui="character-count" hidden></span>
            <span data-ui="selection-step" hidden></span>
            <span data-ui="preview-role" hidden></span>
            <span data-ui="preview-role-2" hidden></span>
          </section>
          <footer class="selection-footer">
            <p class="character-status" aria-live="polite" data-ui="character-status" hidden></p>
            <div class="selection-actions">
              <button class="secondary-action" type="button" data-action="back-player" hidden>Voltar</button>
              <button class="secondary-action" type="button" data-action="back-level" hidden>Trocar de fase</button>
              <button class="primary-action start-action" type="button" data-action="start"><span>COME&Ccedil;AR A COZINHAR</span></button>
            </div>
          </footer>
        </div>
      </section>

      <section class="full-overlay cookbook-overlay" data-ui="cookbook" role="dialog" aria-modal="true" aria-labelledby="cookbook-title" hidden>
        <div class="modal-window cookbook-window">
          <header class="modal-header">
            <div class="cookbook-brand"><div class="mini-glyph" aria-hidden="true">B</div><div><span class="panel-kicker">MENU</span><h2 id="cookbook-title">RECEITAS</h2></div></div>
            <div class="modal-header-actions"><button class="icon-button" type="button" data-action="close-cookbook" aria-label="Fechar receitas">× <span>ESC</span></button></div>
          </header>
          <div class="cookbook-layout">
            <nav class="cookbook-nav" data-ui="cookbook-nav" aria-label="Lista de receitas"></nav>
            <article class="cookbook-detail" data-ui="cookbook-detail" aria-live="polite"></article>
          </div>
          <footer class="modal-footer"><span>ESCOLHA UMA RECEITA PARA VER O PREPARO</span><button type="button" class="secondary-action" data-action="close-cookbook">VOLTAR À COZINHA <kbd>TAB</kbd></button></footer>
        </div>
      </section>

      <section class="full-overlay pause-overlay" data-ui="pause" role="dialog" aria-modal="true" aria-labelledby="pause-title" hidden>
        <div class="pause-card modal-window">
          <div class="pause-emblem" aria-hidden="true"><span>Ⅱ</span></div>
          <h2 id="pause-title">PAUSADO</h2>
          <p>Sem pressa. A cozinha espera por você.</p>
          <button class="primary-action" type="button" data-action="resume"><span>CONTINUAR</span><i aria-hidden="true">→</i></button>
          <button class="secondary-action overlay-menu-action" type="button" data-action="quit-to-menu"><span>VOLTAR AO MENU</span></button>
          <div class="pause-hint"><kbd>ESC</kbd><span>Continuar</span><kbd>TAB</kbd><span>Receitas</span></div>
        </div>
      </section>

      <section class="full-overlay results-overlay" data-ui="results" role="dialog" aria-modal="true" aria-labelledby="results-title" hidden>
        <div class="results-window modal-window">
          <header class="results-heading"><span class="panel-kicker">RELATÓRIO DO TURNO</span><h2 id="results-title">TURNO CONCLUÍDO</h2><p>COMO FOI O SEU TURNO</p></header>
          <div class="results-body">
            <div class="rank-module">
              <span>NOTA</span><strong data-result-rank data-rank="B">B</strong>
            </div>
            <div class="results-summary">
              <p data-result-message>Resultado do turno arquivado.</p>
              <div class="result-grid">
                <div><span>PEDIDOS ENTREGUES</span><strong data-result="completed">0</strong></div>
                <div><span>PEDIDOS PERDIDOS</span><strong data-result="failed">0</strong></div>
                <div><span>QUALIDADE MÉDIA</span><strong data-result="quality">0%</strong></div>
                <div><span>ESTABILIDADE</span><strong data-result="stability">0%</strong></div>
                <div><span>MELHOR COMBO</span><strong data-result="combo">X0</strong></div>
                <div><span>ITENS ARREMESSADOS</span><strong data-result="throws">0</strong></div>
                <div><span>ENTROSAMENTO</span><strong data-result="sync">0%</strong></div>
                <div><span>COLAPSOS</span><strong data-result="meltdowns">0</strong></div>
                <div class="result-score"><span>PONTUAÇÃO TOTAL</span><strong data-result="score">0</strong></div>
                <div class="result-credits"><span>CRÉDITOS</span><strong data-result="credits">+0</strong></div>
              </div>
            </div>
          </div>
          <footer class="results-footer"><span>SALVO NO SEU PERFIL</span><div class="results-actions"><button class="secondary-action overlay-menu-action" type="button" data-action="quit-to-menu"><span>MENU</span></button><button class="primary-action" type="button" data-action="restart"><span>JOGAR DE NOVO</span><i aria-hidden="true">↻</i></button></div></footer>
        </div>
      </section>
    `;
  }
}
