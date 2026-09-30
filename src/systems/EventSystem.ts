import type { TemporaryGameEvent } from "../types/game";

export type EventModifier = keyof TemporaryGameEvent["modifiers"];

export interface ActiveGameEvent {
  event: TemporaryGameEvent;
  startedAt: number;
  endsAt: number;
}

export class EventSystem {
  private readonly definitions = new Map<string, TemporaryGameEvent>();
  private readonly active = new Map<string, ActiveGameEvent>();

  constructor(definitions: readonly TemporaryGameEvent[] = []) {
    for (const definition of definitions) {
      this.register(definition);
    }
  }

  register(definition: TemporaryGameEvent): void {
    if (definition.duration <= 0 || !Number.isFinite(definition.duration)) {
      throw new Error(`Event ${definition.id} must have a positive duration`);
    }
    this.definitions.set(definition.id, {
      ...definition,
      modifiers: { ...definition.modifiers },
    });
  }

  unregister(eventId: string): boolean {
    this.active.delete(eventId);
    return this.definitions.delete(eventId);
  }

  start(eventId: string, now: number = Date.now()): ActiveGameEvent | undefined {
    const definition = this.definitions.get(eventId);
    if (definition === undefined) {
      return undefined;
    }
    const activeEvent = {
      event: definition,
      startedAt: now,
      endsAt: now + definition.duration,
    };
    this.active.set(eventId, activeEvent);
    return { ...activeEvent };
  }

  stop(eventId: string): boolean {
    return this.active.delete(eventId);
  }

  update(now: number = Date.now()): readonly ActiveGameEvent[] {
    const ended: ActiveGameEvent[] = [];
    for (const [eventId, activeEvent] of this.active) {
      if (now >= activeEvent.endsAt) {
        ended.push({ ...activeEvent });
        this.active.delete(eventId);
      }
    }
    return ended;
  }

  getActive(): readonly ActiveGameEvent[] {
    return [...this.active.values()].map((activeEvent) => ({ ...activeEvent }));
  }

  getModifier(modifier: EventModifier): number {
    return [...this.active.values()].reduce(
      (combined, activeEvent) => combined * (activeEvent.event.modifiers[modifier] ?? 1),
      1,
    );
  }
}
