/**
 * The free-tier ledger: pure arithmetic, so it can be unit tested without a Durable Object.
 *
 * These are ESTIMATES built from the operations the rooms report, not Cloudflare's own
 * metering. They exist so the app stops itself (new rooms refused, relay switched off)
 * well before a quota runs out. The hard guarantee of zero cost is the Workers Free plan
 * itself, which errors instead of billing; on a paid plan these budgets are the only guard.
 */
import type { MpConfig } from "./config";

export interface DayUsage {
  day: string;
  workerRequests: number;
  doRequests: number;
  doGbSeconds: number;
  rooms: number;
  turnSessions: number;
}

export interface MonthUsage {
  month: string;
  turnSessions: number;
  turnPlannedMb: number;
}

export interface UsageDelta {
  readonly workerRequests?: number;
  readonly doRequests?: number;
  readonly awakeMs?: number;
}

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
export const utcMonth = (now: number): string => new Date(now).toISOString().slice(0, 7);

export const emptyDay = (day: string): DayUsage => ({ day, workerRequests: 0, doRequests: 0, doGbSeconds: 0, rooms: 0, turnSessions: 0 });
export const emptyMonth = (month: string): MonthUsage => ({ month, turnSessions: 0, turnPlannedMb: 0 });

/** Fractions of this app's own budget at which features switch off, most optional first. */
export const THRESHOLDS = {
  /** HTTPS polling is the most expensive transport per input. */
  https: 0.7,
  /** No new rooms past this: players already in a match keep going. */
  rooms: 0.8,
  /** WebSocket relay of input. Signalling and lobby keep working above it. */
  relay: 0.9,
} as const;

const clamp = (value: number | undefined, max: number): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;

export const applyDelta = (usage: DayUsage, delta: UsageDelta, memoryGb: number): DayUsage => ({
  ...usage,
  workerRequests: usage.workerRequests + clamp(delta.workerRequests, 1e6),
  doRequests: usage.doRequests + clamp(delta.doRequests, 1e6),
  doGbSeconds: usage.doGbSeconds + (clamp(delta.awakeMs, 864e5 * 8) / 1_000) * memoryGb,
});

/** The worst of the three daily quotas, as a fraction of this app's budget for it. */
export const pressure = (usage: DayUsage, config: MpConfig): number => {
  const ratio = (used: number, budget: number): number => (budget <= 0 ? Infinity : used / budget);
  return Math.max(
    ratio(usage.workerRequests, config.budget.workerRequests),
    ratio(usage.doRequests, config.budget.doRequests),
    ratio(usage.doGbSeconds, config.budget.doGbSeconds),
  );
};

export interface Allowances {
  readonly rooms: boolean;
  readonly relay: boolean;
  readonly https: boolean;
  readonly pressure: number;
}

export const allowances = (usage: DayUsage, config: MpConfig): Allowances => {
  const level = pressure(usage, config);
  return {
    rooms: level < THRESHOLDS.rooms && usage.rooms < config.budget.roomsPerDay,
    relay: config.relayEnabled && level < THRESHOLDS.relay,
    https: config.httpsEnabled && level < THRESHOLDS.https,
    pressure: level,
  };
};

/**
 * Whether one more TURN credential may be issued. Planned traffic is booked up front at
 * `plannedMbPerSession`, a deliberately pessimistic figure: once issued, a credential can
 * relay data until it expires and nothing here can meter it.
 */
export const turnAllowed = (day: DayUsage, month: MonthUsage, config: MpConfig): boolean =>
  config.turn.enabled &&
  day.turnSessions < config.turn.maxSessionsPerDay &&
  (month.turnPlannedMb + config.turn.plannedMbPerSession) / 1_024 <= config.turn.monthlyGbBudget;
