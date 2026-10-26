import { nextSpawnRecipeId } from "./OrderQueue";
import type { Order, RecipeData } from "../types/game";

/**
 * Which recipe each upcoming ticket will ask for.
 *
 * The HUD shows the next couple of orders before they arrive, and a preview is only worth
 * showing if it is the truth. So the draw is made from a seeded generator and remembered:
 * `peek` reports what `take` will hand out, and nothing re-rolls behind the player's back.
 *
 * The anti-repetition bias still comes from `OrderQueue.nextSpawnRecipeId` — the planned
 * tickets count as already queued, so the preview does not line up three of the same dish.
 */

/** A deterministic 32-bit generator. Small, seedable and good enough to pick from a list. */
export const createRandom = (seed: number): (() => number) => {
  let state = Math.floor(seed) >>> 0 || 0x9e3779b9;
  return () => {
    // xorshift32
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
};

export class OrderScheduler {
  private readonly planned: string[] = [];

  constructor(
    private readonly recipes: readonly RecipeData[],
    private readonly random: () => number = Math.random,
    /** How far ahead the preview can see. */
    private readonly lookahead = 2,
  ) {}

  /** Forgets the plan; for the start of a shift. */
  reset(): void {
    this.planned.length = 0;
  }

  /**
   * The recipes queued up next, soonest first. Never longer than the lookahead, and
   * shorter only when there are no recipes at all to draw from.
   */
  peek(orders: readonly Order[], count = this.lookahead): readonly string[] {
    this.fill(orders);
    return this.planned.slice(0, Math.max(0, count));
  }

  /** Hands out the next recipe and plans a replacement for it. */
  take(orders: readonly Order[]): string {
    this.fill(orders);
    const next = this.planned.shift();
    if (next === undefined) throw new Error("Cannot schedule an order without recipes");
    this.fill(orders);
    return next;
  }

  /**
   * Tops the plan back up to the lookahead.
   *
   * Already-planned tickets are passed to the draw as if they were queued, so the plan
   * varies the same way the live queue does.
   */
  private fill(orders: readonly Order[]): void {
    if (this.recipes.length === 0) return;
    while (this.planned.length < this.lookahead) {
      this.planned.push(nextSpawnRecipeId(
        [...orders, ...this.planned.map(asPlannedOrder)],
        this.recipes,
        this.random,
      ));
    }
  }
}

/**
 * Dresses a planned recipe as an order, purely so `nextSpawnRecipeId` can count it as
 * taken. Nothing but its recipe id and status is ever read.
 */
const asPlannedOrder = (recipeId: string, index: number): Order => ({
  id: `planned-${index}`,
  type: "recipe",
  requestedRecipeId: recipeId,
  createdAt: 0,
  expiresAt: 0,
  reward: 0,
  status: "active",
});
