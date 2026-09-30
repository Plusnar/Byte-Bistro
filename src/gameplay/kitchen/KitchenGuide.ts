import { getFoodDefinition, plateableState } from "../../data/kitchen";
import { getIngredient } from "../../data/ingredients";
import type { FoodState, KitchenStationKind, RecipeComponent, RecipeData } from "../../types/game";
import { isCookware, type FoodItem, type KitchenItem } from "./KitchenItems";

/** Where a top-level item currently is; held items carry the player index. */
export interface ItemLocation {
  readonly item: KitchenItem;
  readonly holder: 0 | 1 | null;
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

type Stage = "fetch" | "chop" | "cook" | "cooking" | "plate" | "plated";

interface TrackedFood {
  readonly food: FoodItem;
  readonly holder: 0 | 1 | null;
  readonly inCookware: boolean;
  readonly onPlate: boolean;
}

const STAGE_RANK: Readonly<Record<Stage, number>> = {
  plated: 5,
  plate: 4,
  cooking: 3,
  cook: 2,
  chop: 1,
  fetch: 0,
};

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
  title: "Descarte a comida queimada",
  detail: "Leve a frigideira ou panela queimada até o lixo.",
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
      title: `Entregue ${recipe.displayName}`,
      detail: "Leve o prato montado até o balcão de entrega.",
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
  const cookware = definition?.cook === "pot" ? "panela" : "frigideira";
  const key = `${stage}:${component.ingredientId}:${index}`;
  switch (stage) {
    case "fetch":
      return {
        key,
        title: `Pegue ${name}`,
        detail: "Vá até a caixa do ingrediente e pegue um.",
        stationKind: "crate",
        ingredientId: component.ingredientId,
      };
    case "chop":
      return {
        key,
        title: `Corte ${name}`,
        detail: "Coloque na tábua e segure a ação para cortar.",
        stationKind: "cutting_board",
      };
    case "cook":
      return {
        key,
        title: `Cozinhe ${name}`,
        detail: `Coloque na ${cookware} que está no fogão.`,
        stationKind: "stove",
      };
    case "cooking":
      return {
        key,
        title: `${name} no fogo`,
        detail: "Tire do fogo quando ficar pronto, antes de queimar!",
        stationKind: "stove",
      };
    case "plate":
    case "plated":
      return {
        key,
        title: `Monte ${name} no prato`,
        detail: definition && plateableState(definition) === "cooked"
          ? "Leve um prato limpo até o fogão ou despeje a comida no prato."
          : "Pegue um prato limpo e junte os ingredientes nele.",
        stationKind: "plate_rack",
      };
  }
};
