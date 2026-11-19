/**
 * QuotaDO: one global instance ("global") holding the day's estimated usage in SQLite.
 * Rooms call it rarely: once to reserve a new room, then batched usage reports (every
 * ~1,000 relayed messages, and when they close). Each call writes one row.
 */
import { DurableObject } from "cloudflare:workers";
import { COST, readConfig, type MpConfig, type MpEnv } from "./config";
import {
  allowances,
  applyDelta,
  emptyDay,
  emptyMonth,
  turnAllowed,
  utcDay,
  utcMonth,
  type DayUsage,
  type MonthUsage,
  type UsageDelta,
} from "./quotaLedger";

export interface QuotaReply {
  readonly ok: boolean;
  readonly relay: boolean;
  readonly https: boolean;
  readonly pressure: number;
}

export class QuotaDO extends DurableObject<MpEnv> {
  private readonly config: MpConfig;

  constructor(ctx: DurableObjectState, env: MpEnv) {
    super(ctx, env);
    this.config = readConfig(env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS day_usage (
      day TEXT PRIMARY KEY, worker REAL, durable REAL, gbs REAL, rooms INTEGER, turn INTEGER)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS month_usage (
      month TEXT PRIMARY KEY, turn INTEGER, planned_mb REAL)`);
  }

  private readDay(now: number): DayUsage {
    const day = utcDay(now);
    const row = this.ctx.storage.sql.exec<{ worker: number; durable: number; gbs: number; rooms: number; turn: number }>(
      "SELECT worker, durable, gbs, rooms, turn FROM day_usage WHERE day = ?", day,
    ).toArray()[0];
    return row
      ? { day, workerRequests: row.worker, doRequests: row.durable, doGbSeconds: row.gbs, rooms: row.rooms, turnSessions: row.turn }
      : emptyDay(day);
  }

  private writeDay(usage: DayUsage): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO day_usage (day, worker, durable, gbs, rooms, turn) VALUES (?, ?, ?, ?, ?, ?)",
      usage.day, usage.workerRequests, usage.doRequests, usage.doGbSeconds, usage.rooms, usage.turnSessions,
    );
    // Keep a week of history for the diagnostics page; older rows are deleted.
    this.ctx.storage.sql.exec("DELETE FROM day_usage WHERE day < ?", utcDay(Date.now() - 7 * 864e5));
  }

  private readMonth(now: number): MonthUsage {
    const month = utcMonth(now);
    const row = this.ctx.storage.sql.exec<{ turn: number; planned_mb: number }>(
      "SELECT turn, planned_mb FROM month_usage WHERE month = ?", month,
    ).toArray()[0];
    return row ? { month, turnSessions: row.turn, turnPlannedMb: row.planned_mb } : emptyMonth(month);
  }

  private reply(usage: DayUsage, ok: boolean): QuotaReply {
    const allowed = allowances(usage, this.config);
    return { ok, relay: allowed.relay, https: allowed.https, pressure: Math.round(allowed.pressure * 1_000) / 1_000 };
  }

  /** A new room: refused when the day's budget is getting tight. */
  reserveRoom(delta: UsageDelta): QuotaReply {
    const now = Date.now();
    let usage = applyDelta(this.readDay(now), {
      ...delta,
      doRequests: (delta.doRequests ?? 0) + COST.quotaCall.durableObject,
    }, COST.doMemoryGb);
    const ok = allowances(usage, this.config).rooms;
    if (ok) usage = { ...usage, rooms: usage.rooms + 1 };
    this.writeDay(usage);
    return this.reply(usage, ok);
  }

  /** Usage a room accumulated since its last report. */
  report(delta: UsageDelta): QuotaReply {
    const usage = applyDelta(this.readDay(Date.now()), {
      ...delta,
      doRequests: (delta.doRequests ?? 0) + COST.quotaCall.durableObject,
    }, COST.doMemoryGb);
    this.writeDay(usage);
    return this.reply(usage, true);
  }

  /** Books one TURN credential against the day and month limits. */
  reserveTurn(): QuotaReply {
    const now = Date.now();
    const day = applyDelta(this.readDay(now), { doRequests: COST.quotaCall.durableObject }, COST.doMemoryGb);
    const month = this.readMonth(now);
    const ok = turnAllowed(day, month, this.config);
    const nextDay = ok ? { ...day, turnSessions: day.turnSessions + 1 } : day;
    this.writeDay(nextDay);
    if (ok) {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO month_usage (month, turn, planned_mb) VALUES (?, ?, ?)",
        month.month, month.turnSessions + 1, month.turnPlannedMb + this.config.turn.plannedMbPerSession,
      );
    }
    return this.reply(nextDay, ok);
  }

  /** Public, aggregate numbers for the diagnostics panel. */
  status(): Record<string, unknown> {
    const now = Date.now();
    const day = this.readDay(now);
    const month = this.readMonth(now);
    const allowed = allowances(day, this.config);
    const pct = (used: number, budget: number): number => (budget > 0 ? Math.round((used / budget) * 1_000) / 10 : 100);
    return {
      mode: this.config.mode,
      day: day.day,
      safetyRatio: this.config.budget.safety,
      workerRequestsPct: pct(day.workerRequests, this.config.budget.workerRequests),
      doRequestsPct: pct(day.doRequests, this.config.budget.doRequests),
      doGbSecondsPct: pct(day.doGbSeconds, this.config.budget.doGbSeconds),
      rooms: day.rooms,
      roomsPerDay: this.config.budget.roomsPerDay,
      allow: { rooms: allowed.rooms, relay: allowed.relay, https: allowed.https },
      turn: {
        enabled: this.config.turn.enabled,
        sessionsToday: day.turnSessions,
        plannedGbThisMonth: Math.round(month.turnPlannedMb / 102.4) / 10,
        monthlyGbBudget: this.config.turn.monthlyGbBudget,
      },
    };
  }
}
