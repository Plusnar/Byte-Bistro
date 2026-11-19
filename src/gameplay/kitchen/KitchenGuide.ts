import type { PlayerIndex } from "../../types/events";
import { t } from "../../i18n";
import { MIX_RECIPES, getFoodDefinition, plateableState } from "../../data/kitchen";
import { getIngredient } from "../../data/ingredients";
import type { FoodState, KitchenStationKind, RecipeComponent, RecipeData } from "../../types/game";
import { isCookware, type FoodItem, type KitchenItem } from "./KitchenItems";

/** Where a top-level item currently is; held items carry the player index. */
export interface ItemLocation {
  readonly item: KitchenItem;
  readonly holder: PlayerIndex | null;
}

export interface GuideTask {
  readonly key: string;
  readonly title: string;
  readonly detail: string;
  readonly stationKind: KitchenStationKind;
  readonly ingredientId?: string;
  /** Which order this step belongs to; absent on kitchen-wide tasks like clearing burnt food. */
  readonly orderId?: string;
}

/** Where a single recipe component currently stands in the kitchen. */
export interface ComponentStatus {
  readonly ingredientId: string;
  /** The state the recipe wants it in. */
  readonly state: FoodState;
  readonly stage: Stage;
}

export interface GuideResult {
  readonly tasks: readonly GuideTask[];
  readonly completed: number;
  readonly total: number;
  /** One entry per recipe component, in recipe order; duplicates repeat. */
  readonly componentStages: readonly ComponentStatus[];
}

/** One outstanding order to plan for, in `computeQueueGuide`. */
export interface OrderGuideRequest {
  readonly orderId: string;
  readonly recipe: RecipeData;
  readonly secondsRemaining: number;
}

export interface QueueGuideResult {
  /** Every order's steps, most urgent order first, with keys namespaced by order id. */
  readonly tasks: readonly GuideTask[];
  readonly byOrder: ReadonlyMap<string, GuideResult>;
}

type Stage = "fetch" | "mix" | "chop" | "cook" | "cooking" | "plate" | "plated";

interface TrackedFood {
  readonly food: FoodItem;
  readonly holder: PlayerIndex | null;
  readonly inCookware: boolean;
  readonly onPlate: boolean;
}

const STAGE_RANK: Readonly<Record<Stage, number>> = {
  plated: 6,
  plate: 5,
  cooking: 4,
  cook: 3,
  chop: 2,
  /** A prepared ingredient has to be made before it can be anything else. */
  mix: 1,
  fetch: 0,
};

/** Whether this ingredient comes out of the mixer rather than out of a crate. */
const mixRecipeFor = (ingredientId: string) =>
  MIX_RECIPES.find((recipe) => recipe.output === ingredientId) ?? null;

const nameOf = (ingredientId: string): string =>
  getIngredient(ingredientId)?.displayName ?? ingredientId;

const stageOf = (tracked: TrackedFood, component: RecipeComponent): Stage | null => {
  const definition = getFoodDefinition(component.ingredientId);
  if (!definition || tracked.food.ingredientId !== component.ingredientId) return null;
  const state = tracked.food.state;
  if (state === "burnt") return null;
  if (state === component.state) return tracked.onPlate ? "plated" : "plate";
  if (tracked.inCookware) return "cooking";
  if (definition.cook && state === (definition.chop ? "chopped" : "raw")) return "cook";
  if (definition.chop && state === "raw") return "chop";
  return null;
};

const collectFood = (locations: readonly ItemLocation[]): TrackedFood[] => {
  const result: TrackedFood[] = [];
  for (const { item, holder } of locations) {
    if (item.kind === "food") {
      result.push({ food: item, holder, inCookware: false, onPlate: false });
    } else if (item.kind === "plate" && !item.dirty) {
      for (const food of item.contents) result.push({ food, holder, inCookware: false, onPlate: true });
    } else if (isCookware(item)) {
      for (const food of item.contents) result.push({ food, holder, inCookware: true, onPlate: false });
    }
  }
  return result;
};

const burntTask = (): GuideTask => ({
  key: "burnt",
  title: t("kitchen.guideBurntTitle"),
  detail: t("kitchen.guideBurntDetail"),
  stationKind: "trash",
});

/**
 * Plans one recipe against `foods`, claiming the items it intends to use in `used`.
 *
 * The claim set is a parameter rather than a local so several orders can be planned against
 * the same kitchen without two of them both counting on the same chopped onion.
 */
const computeGuideWithClaims = (
  recipe: RecipeData,
  foods: readonly TrackedFood[],
  used: Set<FoodItem>,
): GuideResult => {
  const tasks: GuideTask[] = [];
  const componentStages: ComponentStatus[] = [];
  let completed = 0;

  recipe.components.forEach((component, index) => {
    let best: { tracked: TrackedFood; stage: Stage } | null = null;
    for (const tracked of foods) {
      if (used.has(tracked.food)) continue;
      const stage = stageOf(tracked, component);
      if (!stage) continue;
      if (!best || STAGE_RANK[stage] > STAGE_RANK[best.stage]) best = { tracked, stage };
    }
    if (best) used.add(best.tracked.food);
    // Nothing of this ingredient exists yet: a prepared one has to be mixed, and anything
    // else is fetched. Without this the guide would send a cook to a crate of dough.
    const missing: Stage = mixRecipeFor(component.ingredientId) ? "mix" : "fetch";
    const stage = best?.stage ?? missing;
    componentStages.push({ ingredientId: component.ingredientId, state: component.state, stage });
    if (stage === "plated") {
      completed += 1;
      return;
    }
    tasks.push(taskFor(stage, component, index));
  });

  if (tasks.length === 0) {
    tasks.push({
      key: "deliver",
      title: t("kitchen.guideDeliverTitle", { dish: recipe.displayName }),
      detail: t("kitchen.guideDeliverDetail"),
      stationKind: "delivery",
    });
  }
  return { tasks, completed, total: recipe.components.length, componentStages };
};

/**
 * Derives the next Overcooked-style steps for a recipe from the live kitchen,
 * so the guidance never drifts from what players actually did.
 */
export const computeGuide = (
  recipe: RecipeData,
  locations: readonly ItemLocation[],
): GuideResult => {
  const foods = collectFood(locations);
  const result = computeGuideWithClaims(recipe, foods, new Set());
  if (!foods.some((tracked) => tracked.food.state === "burnt")) return result;
  return { ...result, tasks: [burntTask(), ...result.tasks] };
};

/**
 * Plans every outstanding order at once, most urgent first.
 *
 * Planning each order in isolation would let two tickets for the same recipe both claim the
 * one chopped ingredient on the counter, quietly stalling whichever is served second. A
 * single shared claim set means the ticket closest to expiry gets first call on work
 * already in progress, and the rest are told to start fresh.
 */
export const computeQueueGuide = (
  requests: readonly OrderGuideRequest[],
  locations: readonly ItemLocation[],
): QueueGuideResult => {
  const foods = collectFood(locations);
  const used = new Set<FoodItem>();
  const byOrder = new Map<string, GuideResult>();
  const tasks: GuideTask[] = [];

  const ordered = [...requests].sort((a, b) => a.secondsRemaining - b.secondsRemaining);
  for (const request of ordered) {
    const result = computeGuideWithClaims(request.recipe, foods, used);
    const namespaced = result.tasks.map((task) => ({
      ...task,
      key: `${request.orderId}#${task.key}`,
      orderId: request.orderId,
    }));
    byOrder.set(request.orderId, { ...result, tasks: namespaced });
    tasks.push(...namespaced);
  }

  // Burnt food is a kitchen-wide hazard, not any one order's step, so it is emitted once.
  if (foods.some((tracked) => tracked.food.state === "burnt")) tasks.unshift(burntTask());
  return { tasks, byOrder };
};

const taskFor = (stage: Stage, component: RecipeComponent, index: number): GuideTask => {
  const name = nameOf(component.ingredientId);
  const definition = getFoodDefinition(component.ingredientId);
  const key = `${stage}:${component.ingredientId}:${index}`;
  switch (stage) {
    case "fetch":
      return {
        key,
        title: t("kitchen.guideFetchTitle", { name }),
        detail: t("kitchen.guideFetchDetail"),
        stationKind: "crate",
        ingredientId: component.ingredientId,
      };
    case "chop":
      return {
        key,
        title: t("kitchen.guideChopTitle", { name }),
        detail: t("kitchen.guideChopDetail"),
        stationKind: "cutting_board",
      };
    case "mix": {
      const inputs = mixRecipeFor(component.ingredientId)?.inputs ?? [];
      return {
        key,
        title: t("kitchen.guideMixTitle", { name }),
        detail: t("kitchen.guideMixDetail", {
          inputs: inputs.map((input) => nameOf(input.ingredientId)).join(" + "),
        }),
        stationKind: "mixer",
      };
    }
    case "cook":
      return {
        key,
        title: t("kitchen.guideCookTitle", { name }),
        detail: definition?.cook === "tray"
          ? t("kitchen.guideBakeDetail")
          : definition?.cook === "pot"
            ? t("kitchen.guideCookInPot")
            : t("kitchen.guideCookInPan"),
        stationKind: definition?.cook === "tray" ? "oven" : "stove",
      };
    case "cooking":
      return {
        key,
        title: t("kitchen.guideCookingTitle", { name }),
        detail: t("kitchen.guideCookingDetail"),
        stationKind: definition?.cook === "tray" ? "oven" : "stove",
      };
    case "plate":
    case "plated":
      return {
        key,
        title: t("kitchen.guidePlateTitle", { name }),
        detail: definition && plateableState(definition) === "cooked"
          ? t("kitchen.guidePlateCooked")
          : t("kitchen.guidePlateRaw"),
        stationKind: "plate_rack",
      };
  }
};
