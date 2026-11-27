import type { PlayerIndex } from "../../types/events";
import type { BaseTexture, Scene, TransformNode, Vector3 } from "@babylonjs/core";
import type { AssetManager } from "../../core/AssetManager";
import type { InputManager } from "../../core/InputManager";
import type { SynthSfx } from "../../core/SynthSfx";
import type { MovementBounds, Player } from "../../entities/Player";
import type { DisasterOverlay } from "../../ui/DisasterOverlay";
import type { WeddingGuests } from "../WeddingGuests";

export type DisasterKind = "inverted" | "ufo" | "lightning" | "tomatoes" | "tesla" | "flood" | "rats";

export const DISASTER_KINDS: readonly DisasterKind[] = [
  "inverted", "ufo", "lightning", "tomatoes", "tesla", "flood", "rats",
];

export type DisasterTone = "info" | "success" | "warning" | "error";

/** A cook as the disasters see them. */
export interface DisasterCook {
  readonly index: PlayerIndex;
  /** How messages name them: the player's label. */
  readonly label: string;
  readonly player: Player;
  readonly input: InputManager;
}

/** A station's model, which the Tesla throws about and puts back. */
export interface DisasterStationView {
  readonly root: TransformNode;
  readonly x: number;
  readonly z: number;
  readonly topHeight: number;
  /** The station kind, such as "sink" or "stove". */
  readonly kind: string;
}

/** Something the kitchen owns and a disaster may carry off: kept opaque. */
export type LooseItem = { readonly __loose: unique symbol };

/** Food a rat could carry off: lying on the floor, or on a counter nobody is working at. */
export interface Stealable {
  /** Stable while the item exists, so a rat can keep chasing the same one. */
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** Height of the surface it lies on. */
  readonly y: number;
  /** Height of the floor below the item, even if it is on a counter. */
  readonly floorY: number;
  /** Its name, for the message. */
  readonly label: string;
  /** Takes it out of the kitchen; null if it has gone since. */
  take(): LooseItem | null;
}

/**
 * What the kitchen lends a disaster: the scene to draw in, the cooks to pick on,
 * and a few actions that touch the kitchen's own state.
 */
export interface DisasterHost {
  readonly scene: Scene;
  readonly assets: AssetManager;
  readonly sfx: SynthSfx;
  readonly overlay: DisasterOverlay;
  readonly cooks: readonly DisasterCook[];
  /** The floor the cooks can stand on. */
  readonly bounds: Readonly<MovementBounds>;
  readonly robots: WeddingGuests;
  /** A soft round sprite for splashes of tomato juice. */
  readonly juiceTexture?: BaseTexture | null;
  /** Knocks a cook over, away from (fromX, fromZ), scattering what they carry. */
  hitCook(cook: DisasterCook, fromX: number, fromZ: number, strength: number): void;
  /** Drops what the cook carries where they stand. */
  dropHeld(cook: DisasterCook): void;
  notify(message: string, tone: DisasterTone): void;
  /** Trembles the view by `amount` metres, fading out over `seconds`. */
  shake(amount: number, seconds: number): void;
  /** A disaster just broke out: the whole room feels it (screen jolt, phones buzz). */
  alarm?(kind: DisasterKind): void;
  stationViews(): readonly DisasterStationView[];
  /** Flings everything lying on the floor within `radius` of (x, z) away from it. */
  scatterFloorItems(x: number, y: number, z: number, radius: number, power: number): void;
  /** A surface near the supplied floor height; preserves the reference across gaps. */
  floorHeight(x: number, referenceY: number, z: number): number;
  /** Where this cook starts the shift: always inside the kitchen, and clear of the counters. */
  spawnPoint(cook: DisasterCook): Vector3;
  /** Food a rat may steal right now. */
  stealables(): readonly Stealable[];
  /** Puts a taken item back into the kitchen, above the given floor. */
  dropLoose(item: LooseItem, x: number, y: number, z: number): void;
}

/**
 * One disaster. `start` sets it off; `update` runs it every frame and returns false
 * once it has played out; `stop` ends it at once and puts everything back, as at the
 * end of a shift.
 */
export interface Disaster {
  readonly kind: DisasterKind;
  /** How long it runs, in seconds, shown on the HUD chip. */
  readonly duration: number;
  start(): void;
  update(dt: number): boolean;
  stop(): void;
}

/** Uniform random number in [min, max). */
export const between = (min: number, max: number, random: () => number = Math.random): number =>
  min + (max - min) * random();
