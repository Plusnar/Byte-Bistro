import type { PlayerIndex } from "../../types/events";
import { t } from "../../i18n";
import { cookableState, getFoodDefinition, vesselForState, STATE_OF_VESSEL, type CookwareKind } from "../../data/kitchen";
import { getIngredient } from "../../data/ingredients";
import type { FoodState, KitchenStationKind, RecipeComponent, RecipeData } from "../../types/game";
import { componentsFitRecipe, isCookware, isCookwareCooked, type FoodItem, type KitchenItem, type PlateItem } from "./KitchenItems";

/** Where a top-level item currently is; held items carry the player index. */
export interface ItemLocation {
  readonly item: KitchenItem;
  readonly holder: PlayerIndex | null;
  readonly processing?: boolean;
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
  readonly stage: ComponentStage;
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

export type ComponentStage = "fetch" | "chop" | "cutting" | "cook" | "cooking" | "plate" | "plated";

interface TrackedFood {
  readonly food: FoodItem;
  readonly vessel?: CookwareKind;
  readonly vesselReady?: boolean;
  readonly processing?: boolean;
  readonly plate?: PlateItem;
}

const STAGE_RANK: Readonly<Record<ComponentStage, number>> = {
  plated: 6,
  plate: 5,
  cooking: 4,
  cook: 3,
  cutting: 2,
  chop: 1,
  fetch: 0,
};

const nameOf = (ingredientId: string): string =>
  getIngredient(ingredientId)?.displayName ?? ingredientId;

const stageOf = (tracked: TrackedFood, component: RecipeComponent): ComponentStage | null => {
  const definition = getFoodDefinition(component.ingredientId);
  if (!definition || tracked.food.ingredientId !== component.ingredientId) return null;
  const state = tracked.food.state;
  if (state === "burnt") return null;
  if (state === component.state && (!tracked.vessel || tracked.vesselReady)) {
    return tracked.plate ? "plated" : "plate";
  }
  const vessel = vesselForState(component.state);
  const prepared = state === cookableState(definition);
  if (tracked.vessel) {
    return tracked.vessel === vessel && (prepared || state === STATE_OF_VESSEL[tracked.vessel])
      ? tracked.processing ? "cooking" : "cook"
      : null;
  }
  if (tracked.plate) return null;
  if (vessel && prepared) return "cook";
  if (definition.chop && state === "raw") return tracked.food.chopProgress > 0 ? "cutting" : "chop";
  return null;
};

const collectFood = (locations: readonly ItemLocation[]): TrackedFood[] => {
  const result: TrackedFood[] = [];
  for (const { item, processing } of locations) {
    if (item.kind === "food") {
      result.push({ food: item });
    } else if (item.kind === "plate" && !item.dirty) {
      for (const food of item.contents) result.push({ food, plate: item });
    } else if (isCookware(item)) {
      const vesselReady = isCookwareCooked(item);
      for (const food of item.contents) result.push({ food, vessel: item.kind, vesselReady, processing });
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
  plate?: PlateItem,
): GuideResult => {
  const tasks: GuideTask[] = [];
  const componentStages: ComponentStatus[] = [];
  let completed = 0;

  recipe.components.forEach((component, index) => {
    let best: { tracked: TrackedFood; stage: ComponentStage } | null = null;
    for (const tracked of foods) {
      if (tracked.plate && tracked.plate !== plate) continue;
      if (used.has(tracked.food)) continue;
      const stage = stageOf(tracked, component);
      if (!stage) continue;
      if (!best || STAGE_RANK[stage] > STAGE_RANK[best.stage]) best = { tracked, stage };
    }
    if (best) used.add(best.tracked.food);
    // Nothing of this ingredient exists yet: fetch one from its crate.
    const stage = best?.stage ?? "fetch";
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
  const plate = availablePlates(locations).find(item => componentsFitRecipe(item.contents, recipe.components));
  const result = computeGuideWithClaims(recipe, foods, new Set(), plate);
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
  const plates = availablePlates(locations);
  const assigned = new Map<string, PlateItem>();
  // Reserve complete dishes first. A different recipe with overlapping ingredients
  // cannot claim pieces from a finished plate, and each plate can serve only one ticket.
  for (const request of ordered) {
    const plate = plates.findIndex(item => item.contents.length === request.recipe.components.length &&
      componentsFitRecipe(item.contents, request.recipe.components));
    if (plate >= 0) assigned.set(request.orderId, plates.splice(plate, 1)[0]!);
  }
  for (const request of ordered) {
    let plate = assigned.get(request.orderId);
    if (!plate) {
      const partial = plates.findIndex(item => componentsFitRecipe(item.contents, request.recipe.components));
      if (partial >= 0) plate = plates.splice(partial, 1)[0];
    }
    const result = computeGuideWithClaims(request.recipe, foods, used, plate);
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

const availablePlates = (locations: readonly ItemLocation[]): PlateItem[] => locations
  .map(({ item }) => item)
  .filter((item): item is PlateItem => item.kind === "plate" && !item.dirty && item.contents.length > 0)
  .sort((a, b) => b.contents.length - a.contents.length);

const taskFor = (stage: ComponentStage, component: RecipeComponent, index: number): GuideTask => {
  const name = nameOf(component.ingredientId);
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
    case "cutting":
      return {
        key,
        title: t("kitchen.guideChopTitle", { name }),
        detail: t("kitchen.guideChopDetail"),
        stationKind: "cutting_board",
      };
    case "cook": {
      const vessel = vesselForState(component.state);
      if (vessel === "bowl") {
        return {
          key,
          title: t("kitchen.guideMixTitle", { name }),
          detail: t("kitchen.guideMixDetail"),
          stationKind: "mixer",
        };
      }
      return {
        key,
        title: t(vessel === "tray" ? "kitchen.guideBakeTitle" : vessel === "pot" ? "kitchen.guideBoilTitle" : "kitchen.guideCookTitle", { name }),
        detail: vessel === "tray"
          ? t("kitchen.guideBakeDetail")
          : vessel === "pot"
            ? t("kitchen.guideCookInPot")
            : t("kitchen.guideCookInPan"),
        stationKind: vessel === "tray" ? "oven" : "stove",
      };
    }
    case "cooking": {
      const vessel = vesselForState(component.state);
      if (vessel === "bowl") {
        return {
          key,
          title: t("kitchen.guideMixingTitle", { name }),
          detail: t("kitchen.guideMixingDetail"),
          stationKind: "mixer",
        };
      }
      return {
        key,
        title: t("kitchen.guideCookingTitle", { name }),
        detail: t("kitchen.guideCookingDetail"),
        stationKind: vessel === "tray" ? "oven" : "stove",
      };
    }
    case "plate":
    case "plated":
      return {
        key,
        title: t("kitchen.guidePlateTitle", { name }),
        detail: vesselForState(component.state)
          ? t("kitchen.guidePlateCooked")
          : t("kitchen.guidePlateRaw"),
        stationKind: "plate_rack",
      };
  }
};
