import { BALANCE } from "../../data/balance";
import { STANDARD_DIFFICULTY, type DifficultyTuning } from "../../data/difficulty";
import { OrderSystem } from "../../systems/OrderSystem";
import { maxConcurrentOrders, sortByUrgency, spawnIntervalSeconds } from "../../systems/OrderQueue";
import { OrderScheduler } from "../../systems/OrderScheduler";
import type { Order, RecipeData } from "../../types/game";

/**
 * The order queue's clock and scheduler, with no scene attached.
 *
 * `KitchenScene` needs a Babylon engine and cannot be unit tested, so everything that
 * decides *when* a ticket appears, warns or expires lives here instead: the per-order
 * countdown, the spawn cadence and the deadline clamping. The scene keeps only the parts
 * that need the world — sound, notifications, score and the guests.
 *
 * The director never reaches into game state. Every call takes the current queue and
 * returns the next one plus a list of events for the caller to act on, so the same tick
 * can be replayed in a test with a fixed clock.
 */

/** Something the caller has to react to: play a sound, score it, tell the guests. */
export type OrderDirectorEvent =
  | { readonly kind: "created"; readonly order: Order }
  | { readonly kind: "expiring"; readonly order: Order; readonly secondsRemaining: number }
  | { readonly kind: "failed"; readonly order: Order }
  | { readonly kind: "removed"; readonly orderId: string };

export interface OrderDirectorResult {
  readonly orders: readonly Order[];
  readonly events: readonly OrderDirectorEvent[];
  /** Whether `orders` is a different queue from the one passed in. */
  readonly changed: boolean;
}

export interface OrderTickInput {
  readonly deltaSeconds: number;
  readonly orders: readonly Order[];
  readonly shiftTimeRemaining: number;
  readonly shiftDuration: number;
  /** Wall clock, injected so tests do not depend on `Date.now()`. */
  readonly now: number;
}

export interface OrderDirectorOptions {
  readonly recipes: readonly RecipeData[];
  readonly orders?: OrderSystem;
  readonly scheduler?: OrderScheduler;
  readonly tuning?: DifficultyTuning;
  readonly random?: () => number;
}

/** What a reader may see of a countdown: seconds left, and what it started from. */
export interface OrderClockView {
  readonly remaining: number;
  readonly duration: number;
}

interface OrderClock extends OrderClockView {
  remaining: number;
  duration: number;
  /** Latches the one-shot expiry warning. */
  warned: boolean;
}

/**
 * Only re-stamp an order when its deadline has drifted by more than this. Rewriting every
 * frame would re-allocate the whole queue sixty times a second over sub-millisecond gaps.
 */
export const CLOCK_RESTAMP_TOLERANCE_MS = 250;

const NO_EVENTS: readonly OrderDirectorEvent[] = [];

export class OrderDirector {
  private readonly clocks = new Map<string, OrderClock>();
  private readonly orderSystem: OrderSystem;
  private readonly scheduler: OrderScheduler;
  private readonly random: () => number;
  private tuning: DifficultyTuning;
  private spawnTimer = 0;

  constructor(options: OrderDirectorOptions) {
    this.tuning = options.tuning ?? STANDARD_DIFFICULTY;
    this.random = options.random ?? Math.random;
    this.orderSystem = options.orders ?? new OrderSystem(options.recipes, this.random);
    this.scheduler = options.scheduler ?? new OrderScheduler(options.recipes, this.random);
    this.spawnTimer = spawnIntervalSeconds(0, this.tuning);
  }

  /**
   * The recipes queued up next, for the HUD's preview strip. These are the exact tickets
   * that will arrive — the draw is made once and kept, not re-rolled on each frame.
   */
  upcoming(orders: readonly Order[], count?: number): readonly string[] {
    return this.scheduler.peek(orders, count);
  }

  /** Seconds until the next ticket is due, for the preview strip's countdown. */
  get secondsToNextOrder(): number {
    return Math.max(0, this.spawnTimer);
  }

  setTuning(tuning: DifficultyTuning): void {
    this.tuning = tuning;
  }

  /**
   * Forgets every clock and restarts the spawn cadence; for the start and end of a shift.
   *
   * The timer restarts at a full opening interval rather than at zero, so the first frame
   * of a shift does not spawn on top of the opening ticket the scene hands out itself.
   */
  reset(): void {
    this.clocks.clear();
    this.scheduler.reset();
    this.spawnTimer = spawnIntervalSeconds(0, this.tuning);
  }

  /** Seconds left on each ticket, for guests deciding whether to complain. */
  urgencySeconds(): ReadonlyMap<string, number> {
    const urgency = new Map<string, number>();
    for (const [id, clock] of this.clocks) urgency.set(id, clock.remaining);
    return urgency;
  }

  /** One ticket's countdown, for the HUD. Undefined once the director has forgotten it. */
  clockFor(orderId: string): OrderClockView | undefined {
    return this.clocks.get(orderId);
  }

  /**
   * How much of a ticket's own deadline is still on the clock, 1 when fresh and 0 at
   * expiry. Null when there is no clock, so "unknown" never reads as "about to expire".
   */
  fractionRemaining(orderId: string): number | null {
    const clock = this.clocks.get(orderId);
    if (!clock || clock.duration <= 0) return null;
    return clock.remaining / clock.duration;
  }

  /** How many tickets may be outstanding at this point of the shift. */
  maxConcurrent(shiftProgress: number): number {
    return maxConcurrentOrders(shiftProgress, this.tuning);
  }

  /**
   * Re-stamps deadlines against the wall clock without advancing anything. This is the
   * paused path: the countdowns stand still, so a pause cannot burn order time, but the
   * stamps the scoring reads stay honest.
   */
  syncClocks(orders: readonly Order[], now: number): readonly Order[] {
    return this.restamp(orders, now);
  }

  /** Runs the countdown, the expiry warnings and the spawn cadence for one frame. */
  tick(input: OrderTickInput): OrderDirectorResult {
    const events: OrderDirectorEvent[] = [];
    // Expired ids are collected first: failing one rewrites the queue mid-loop.
    const expired: string[] = [];
    for (const order of input.orders) {
      if (order.status !== "active") continue;
      const clock = this.clocks.get(order.id);
      if (!clock) continue;
      clock.remaining = Math.max(0, clock.remaining - input.deltaSeconds);
      if (clock.remaining <= 0) {
        expired.push(order.id);
        continue;
      }
      if (!clock.warned && clock.remaining <= BALANCE.order.expiringWarningSeconds) {
        clock.warned = true;
        events.push({ kind: "expiring", order, secondsRemaining: clock.remaining });
      }
    }

    let orders = this.restamp(input.orders, input.now);
    for (const id of expired) {
      const failure = this.fail(orders, id);
      orders = failure.orders;
      events.push(...failure.events);
    }

    const spawned = this.updateSpawning(orders, input);
    orders = spawned.orders;
    events.push(...spawned.events);

    return { orders, events, changed: orders !== input.orders };
  }

  /**
   * Adds a ticket to the queue. `recipeId` is for the opening tutorial ticket; left out,
   * the recipe is drawn with the queue's own anti-repetition bias.
   */
  create(
    orders: readonly Order[],
    context: { readonly now: number; readonly shiftTimeRemaining: number },
    recipeId?: string,
  ): OrderDirectorResult {
    const chosen = recipeId ?? this.scheduler.take(orders);
    const order = this.orderSystem.createRecipeOrder(chosen, context.now);

    // Never hand out a deadline the shift cannot honour.
    const recipeSeconds = (order.expiresAt - order.createdAt) / 1_000;
    const duration = Math.max(1, Math.min(recipeSeconds, context.shiftTimeRemaining - 2));
    const clamped: Order = { ...order, expiresAt: context.now + duration * 1_000 };

    this.clocks.set(clamped.id, { remaining: duration, duration, warned: false });
    return {
      orders: sortByUrgency([...orders, clamped]),
      events: [{ kind: "created", order: clamped }],
      changed: true,
    };
  }

  /** Drops an order from the queue and forgets its clock. */
  remove(orders: readonly Order[], orderId: string): OrderDirectorResult {
    if (!orders.some((order) => order.id === orderId)) {
      return { orders, events: NO_EVENTS, changed: false };
    }
    this.clocks.delete(orderId);
    return {
      orders: orders.filter((order) => order.id !== orderId),
      events: [{ kind: "removed", orderId }],
      changed: true,
    };
  }

  /** Marks an active order as missed and drops it. */
  fail(orders: readonly Order[], orderId: string): OrderDirectorResult {
    const active = orders.find((order) => order.id === orderId);
    if (!active || active.status !== "active") {
      return { orders, events: NO_EVENTS, changed: false };
    }
    const failed = this.orderSystem.fail(active);
    const removal = this.remove(orders, orderId);
    return {
      orders: removal.orders,
      events: [{ kind: "failed", order: failed }, ...removal.events],
      changed: true,
    };
  }

  /**
   * Spawns tickets on a cadence instead of one-in-one-out, which is what lets orders pile
   * up. The timer holds at the cap rather than banking, so clearing a backlog does not
   * immediately dump a fresh batch on the players.
   */
  private updateSpawning(orders: readonly Order[], input: OrderTickInput): OrderDirectorResult {
    const progress = shiftProgress(input.shiftTimeRemaining, input.shiftDuration);
    const active = orders.filter((order) => order.status === "active");
    if (active.length >= maxConcurrentOrders(progress, this.tuning)) {
      this.spawnTimer = Math.max(this.spawnTimer, 2);
      return { orders, events: NO_EVENTS, changed: false };
    }
    this.spawnTimer -= input.deltaSeconds;
    if (this.spawnTimer > 0) return { orders, events: NO_EVENTS, changed: false };
    // A ticket spawned in the last stretch could not be finished, and an unavoidable
    // timeout would drag the shift's completion score down through no fault of the players.
    if (input.shiftTimeRemaining <= BALANCE.order.noSpawnTailSeconds) {
      return { orders, events: NO_EVENTS, changed: false };
    }
    const created = this.create(orders, input);
    this.spawnTimer = spawnIntervalSeconds(progress, this.tuning);
    return created;
  }

  /**
   * Rewrites each order's wall-clock stamps from its delta-accumulated countdown. The
   * countdown is the authority, so pausing the game does not burn order time, while
   * ScoreSystem still gets honest createdAt/expiresAt to derive its speed bonus from.
   */
  private restamp(orders: readonly Order[], now: number): readonly Order[] {
    if (orders.length === 0) return orders;
    let changed = false;
    const next = orders.map((order) => {
      const clock = this.clocks.get(order.id);
      if (!clock || order.status !== "active" || clock.duration <= 0) return order;
      const elapsedMs = Math.max(0, clock.duration - clock.remaining) * 1_000;
      const expiresAt = now + clock.remaining * 1_000;
      if (Math.abs(expiresAt - order.expiresAt) < CLOCK_RESTAMP_TOLERANCE_MS) return order;
      changed = true;
      return { ...order, createdAt: now - elapsedMs, expiresAt };
    });
    return changed ? next : orders;
  }
}

/** How far into the shift we are, 0 at the whistle and 1 at the buzzer. */
export const shiftProgress = (timeRemaining: number, duration: number): number =>
  duration > 0 ? 1 - timeRemaining / duration : 0;
