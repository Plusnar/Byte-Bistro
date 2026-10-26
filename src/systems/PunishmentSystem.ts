import { t, type MessageKey } from "../i18n";
import type { DisasterCard } from "../ui/DisasterOverlay";
import { DISASTER_MODEL_IDS } from "./disasters/assets";
import { AlienAbduction } from "./disasters/AlienAbduction";
import { InvertedControls } from "./disasters/InvertedControls";
import { LightningStorm } from "./disasters/LightningStorm";
import { RatHeist } from "./disasters/RatHeist";
import { SinkFlood } from "./disasters/SinkFlood";
import { TeslaCrash } from "./disasters/TeslaCrash";
import { TomatoBarrage } from "./disasters/TomatoBarrage";
import {
  DISASTER_KINDS,
  type Disaster,
  type DisasterHost,
  type DisasterKind,
} from "./disasters/types";

/** Seconds the imminent-disaster card counts down before the disaster starts. */
export const WARNING_SECONDS = 3.5;
/** Most punishments waiting their turn; failures beyond that are forgiven. */
export const MAX_QUEUED = 2;
/** A breather between one disaster ending and the next one's warning. */
export const REST_SECONDS = 2;

const CARDS: Readonly<Record<DisasterKind, { readonly icon: string; readonly title: MessageKey; readonly detail: MessageKey }>> = {
  inverted: { icon: "🔀", title: "disaster.invertedTitle", detail: "disaster.invertedDetail" },
  ufo: { icon: "👽", title: "disaster.ufoTitle", detail: "disaster.ufoDetail" },
  lightning: { icon: "⚡", title: "disaster.lightningTitle", detail: "disaster.lightningDetail" },
  tomatoes: { icon: "🍅", title: "disaster.tomatoTitle", detail: "disaster.tomatoDetail" },
  tesla: { icon: "🚙", title: "disaster.teslaTitle", detail: "disaster.teslaDetail" },
  flood: { icon: "💧", title: "disaster.floodTitle", detail: "disaster.floodDetail" },
  rats: { icon: "🐀", title: "disaster.ratsTitle", detail: "disaster.ratsDetail" },
};

/** The card a disaster shows, in the current language. */
export const disasterCard = (kind: DisasterKind): DisasterCard => {
  const card = CARDS[kind];
  return {
    icon: card.icon,
    title: t(card.title),
    detail: t(card.detail),
  };
};

/** Models a disaster needs, fetched while its warning counts down. */
const MODELS: Readonly<Partial<Record<DisasterKind, readonly string[]>>> = {
  ufo: [DISASTER_MODEL_IDS.ufo],
  tomatoes: [DISASTER_MODEL_IDS.tomato],
  tesla: [DISASTER_MODEL_IDS.tesla],
  rats: [DISASTER_MODEL_IDS.rat],
};

/**
 * A fresh shuffle of every disaster: the order the next ones are drawn in, last first.
 *
 * Disasters are drawn like cards from a shuffled deck, so each comes up once before
 * any comes up again; random, but never the same one twice while others are left. A
 * new deck never starts with `previous` (the one drawn last from the old deck), so the
 * seam between two decks does not repeat either.
 */
export const shuffleDisasters = (
  previous: DisasterKind | null,
  random: () => number = Math.random,
): DisasterKind[] => {
  const deck = [...DISASTER_KINDS];
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  // Drawn from the end: keep `previous` off the top of the new deck.
  if (deck.length > 1 && deck[deck.length - 1] === previous) {
    [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1]!, deck[0]!];
  }
  return deck;
};

export type DisasterFactory = (kind: DisasterKind, host: DisasterHost) => Disaster;

export const createDisaster: DisasterFactory = (kind, host) => {
  switch (kind) {
    case "inverted": return new InvertedControls(host);
    case "ufo": return new AlienAbduction(host);
    case "lightning": return new LightningStorm(host);
    case "tomatoes": return new TomatoBarrage(host, Math.random, host.juiceTexture ?? null);
    case "tesla": return new TeslaCrash(host);
    case "flood": return new SinkFlood(host);
    case "rats": return new RatHeist(host);
  }
};

type State =
  | { readonly name: "idle"; rest: number }
  | { readonly name: "warning"; readonly kind: DisasterKind; left: number }
  | { readonly name: "active"; readonly disaster: Disaster; elapsed: number };

/**
 * The punishment mode: every order that goes unserved sets off a disaster. Only one
 * plays at a time. Each first shows the imminent-disaster card counting down, then
 * runs with a chip on the HUD naming it; further failures wait in a short queue.
 */
export class PunishmentSystem {
  private state: State = { name: "idle", rest: 0 };
  private readonly queue: DisasterKind[] = [];
  /** What is left of the shuffled deck; drawn from the end. */
  private deck: DisasterKind[] = [];
  /** The last disaster drawn for a missed order. */
  private drawn: DisasterKind | null = null;

  constructor(
    private readonly host: DisasterHost,
    private readonly random: () => number = Math.random,
    private readonly factory: DisasterFactory = createDisaster,
  ) {}

  /** The disaster on screen, warned or playing, if any. */
  get current(): DisasterKind | null {
    if (this.state.name === "warning") return this.state.kind;
    if (this.state.name === "active") return this.state.disaster.kind;
    return null;
  }

  get pending(): readonly DisasterKind[] {
    return this.queue;
  }

  /** Queues a disaster for a missed order: `kind`, or one picked at random. */
  punish(kind?: DisasterKind): void {
    if (!kind && this.queue.length >= MAX_QUEUED) return;
    const next = kind ?? this.draw();
    this.queue.push(next);
    for (const id of MODELS[next] ?? []) void this.host.assets.preload(id).catch(() => false);
  }

  private draw(): DisasterKind {
    if (this.deck.length === 0) this.deck = shuffleDisasters(this.drawn, this.random);
    this.drawn = this.deck.pop()!;
    return this.drawn;
  }

  update(dt: number): void {
    const state = this.state;
    switch (state.name) {
      case "idle": {
        state.rest = Math.max(0, state.rest - dt);
        const next = this.queue[0];
        if (next && state.rest <= 0) {
          this.queue.shift();
          this.state = { name: "warning", kind: next, left: WARNING_SECONDS };
          this.host.overlay.showWarning(disasterCard(next), WARNING_SECONDS);
          this.host.sfx.play("warning");
        }
        break;
      }
      case "warning": {
        const before = Math.ceil(state.left);
        state.left -= dt;
        this.host.overlay.updateWarning(state.left);
        if (Math.ceil(state.left) < before && state.left > 0) this.host.sfx.play("warning", 0.5);
        if (state.left <= 0) {
          this.host.overlay.hideWarning();
          const disaster = this.factory(state.kind, this.host);
          disaster.start();
          this.state = { name: "active", disaster, elapsed: 0 };
        }
        break;
      }
      case "active": {
        state.elapsed += dt;
        const running = state.disaster.update(dt);
        this.host.overlay.setStatus(
          disasterCard(state.disaster.kind),
          Math.max(0, state.disaster.duration - state.elapsed),
        );
        if (!running) {
          state.disaster.stop();
          this.host.overlay.setStatus(null);
          this.state = { name: "idle", rest: REST_SECONDS };
        }
        break;
      }
    }
  }

  /** Ends everything at once and forgets the queue, as a new shift starts. */
  reset(): void {
    if (this.state.name === "active") this.state.disaster.stop();
    this.state = { name: "idle", rest: 0 };
    this.queue.length = 0;
    this.deck = [];
    this.drawn = null;
    this.host.overlay.hideWarning();
    this.host.overlay.setStatus(null);
  }
}
