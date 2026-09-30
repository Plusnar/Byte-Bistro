import { BALANCE } from "../data/balance";
import { RECIPES } from "../data/recipes";
import { recipeOrderDurationMs } from "../data/recipeTiming";
import type {
  AIState,
  ObjectiveConstraint,
  Order,
  RecipeData,
} from "../types/game";
import { createUid } from "../utils/math";

export interface OrderSubmission {
  recipeId?: string;
  stateBefore?: AIState;
  stateAfter?: AIState;
}

const validatesObjective = (
  objective: ObjectiveConstraint,
  before: AIState,
  after: AIState,
): boolean => {
  const previous = before[objective.attribute];
  const current = after[objective.attribute];
  switch (objective.operator) {
    case "increase":
      return current - previous >= objective.value;
    case "decrease":
      return previous - current >= objective.value;
    case "above":
      return current >= objective.value;
    case "below":
      return current <= objective.value;
  }
};

const validateDuration = (durationMs: number): void => {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Order duration must be greater than zero");
  }
};

export class OrderSystem {
  private readonly recipes: readonly RecipeData[];
  private readonly random: () => number;
  private readonly durationForRecipe: (recipe: RecipeData) => number;

  constructor(
    recipes: readonly RecipeData[] = RECIPES,
    random: () => number = Math.random,
    /** Injected so `createRandomRecipeOrder` inherits per-recipe deadlines for free. */
    durationForRecipe: (recipe: RecipeData) => number = recipeOrderDurationMs,
  ) {
    this.recipes = [...recipes];
    this.random = random;
    this.durationForRecipe = durationForRecipe;
  }

  createRecipeOrder(recipeId: string, now: number = Date.now(), durationMs?: number): Order {
    const recipe = this.recipes.find((candidate) => candidate.id === recipeId);
    if (recipe === undefined) {
      throw new Error(`Unknown recipe: ${recipeId}`);
    }
    const duration = durationMs ?? this.durationForRecipe(recipe);
    validateDuration(duration);
    return {
      id: createUid("order"),
      type: "recipe",
      requestedRecipeId: recipe.id,
      createdAt: now,
      expiresAt: now + duration,
      reward: recipe.reward,
      status: "active",
    };
  }

  createRandomRecipeOrder(now: number = Date.now(), excludedRecipeId?: string): Order {
    const available = this.recipes.filter((recipe) => recipe.id !== excludedRecipeId);
    const candidates = available.length > 0 ? available : this.recipes;
    if (candidates.length === 0) {
      throw new Error("Cannot create an order without recipes");
    }
    const randomValue = Math.min(Math.max(this.random(), 0), 1 - Number.EPSILON);
    const recipe = candidates[Math.floor(randomValue * candidates.length)];
    if (recipe === undefined) {
      throw new Error("Unable to select an order recipe");
    }
    return this.createRecipeOrder(recipe.id, now);
  }

  createObjectiveOrder(
    objectives: readonly ObjectiveConstraint[],
    now: number = Date.now(),
    reward: number = BALANCE.order.objectiveReward,
    durationMs: number = BALANCE.order.defaultDurationMs,
  ): Order {
    validateDuration(durationMs);
    if (objectives.length === 0) {
      throw new Error("An objective order requires at least one objective");
    }
    return {
      id: createUid("objective-order"),
      type: "objective",
      objectives: objectives.map((objective) => ({ ...objective })),
      createdAt: now,
      expiresAt: now + durationMs,
      reward: Math.max(0, reward),
      status: "active",
    };
  }

  matches(order: Order, submission: OrderSubmission): boolean {
    if (order.type === "recipe") {
      return (
        order.requestedRecipeId !== undefined &&
        submission.recipeId === order.requestedRecipeId
      );
    }
    if (
      order.objectives === undefined ||
      submission.stateBefore === undefined ||
      submission.stateAfter === undefined
    ) {
      return false;
    }
    return order.objectives.every((objective) =>
      validatesObjective(objective, submission.stateBefore as AIState, submission.stateAfter as AIState),
    );
  }

  isExpired(order: Order, now: number = Date.now()): boolean {
    return order.status === "active" && now >= order.expiresAt;
  }

  timeRemaining(order: Order, now: number = Date.now()): number {
    return Math.max(0, order.expiresAt - now);
  }

  complete(order: Order, now: number = Date.now()): Order {
    if (order.status !== "active") {
      return order;
    }
    return this.isExpired(order, now) ? this.fail(order) : { ...order, status: "completed" };
  }

  fail(order: Order): Order {
    return order.status === "active" ? { ...order, status: "failed" } : order;
  }

  expire(order: Order, now: number = Date.now()): Order {
    return this.isExpired(order, now) ? this.fail(order) : order;
  }

  resolve(order: Order, submission: OrderSubmission, now: number = Date.now()): Order {
    if (this.isExpired(order, now)) {
      return this.fail(order);
    }
    return order.status === "active" && this.matches(order, submission)
      ? this.complete(order, now)
      : order;
  }
}
