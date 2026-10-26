import { BALANCE } from "../data/balance";

/**
 * Where a thrown ingredient will land, kept out of the scene so the aiming marker and the
 * flight itself can never be drawn from different numbers.
 *
 * `KitchenScene.updateFloorItems` integrates the same `BALANCE.throw` values frame by
 * frame; everything here is the closed form of that integration, which is why the marker
 * lands on the spot the item actually reaches (see the cross-check in the tests).
 *
 * Holding the throw button charges it. The shortest possible press throws exactly as far
 * as the game always did, so charging only ever adds range.
 */

/** Seconds of holding that reach a full-power throw. */
export const CHARGE_SECONDS = 0.55;
/** How much faster a fully charged throw leaves the hand. */
export const CHARGE_SPEED_BONUS = 0.55;
/** And how much higher it is lobbed, so a long throw clears a counter. */
export const CHARGE_KICK_BONUS = 0.35;

export interface ThrowLaunch {
  readonly speed: number;
  readonly verticalKick: number;
}

export interface LandingPoint {
  readonly x: number;
  readonly z: number;
  /** Seconds in the air before it first touches the floor. */
  readonly seconds: number;
}

/** How far into a charge a hold of `heldSeconds` is, as 0..1. */
export const chargeFraction = (heldSeconds: number): number =>
  Math.min(1, Math.max(0, heldSeconds / CHARGE_SECONDS));

/** Launch speed and lob for a charge of 0..1. */
export const throwLaunch = (charge: number): ThrowLaunch => {
  const amount = Math.min(1, Math.max(0, charge));
  return {
    speed: BALANCE.throw.launchSpeed * (1 + CHARGE_SPEED_BONUS * amount),
    verticalKick: BALANCE.throw.verticalKick * (1 + CHARGE_KICK_BONUS * amount),
  };
};

/**
 * Where a throw from `origin` heading `(directionX, directionZ)` first meets `floorY`.
 *
 * Solves the same parabola the per-frame integration walks: the positive root of
 * `originY + kick·t − ½g·t² = floorY`. Bounces are not predicted — the marker shows the
 * first touch, which is what the thrower is aiming at.
 */
export const landingPoint = (
  origin: Readonly<{ x: number; y: number; z: number }>,
  directionX: number,
  directionZ: number,
  launch: ThrowLaunch,
  floorY = 0,
): LandingPoint => {
  const gravity = BALANCE.throw.gravity;
  const drop = Math.max(0, origin.y - floorY);
  const kick = launch.verticalKick;
  // Always real and positive: the discriminant cannot go below kick² for a non-negative drop.
  const seconds = (kick + Math.sqrt(kick * kick + 2 * gravity * drop)) / gravity;
  return {
    x: origin.x + directionX * launch.speed * seconds,
    z: origin.z + directionZ * launch.speed * seconds,
    seconds,
  };
};

/** Height of the throw `seconds` after it leaves the hand. */
export const heightAt = (originY: number, launch: ThrowLaunch, seconds: number): number =>
  originY + launch.verticalKick * seconds - 0.5 * BALANCE.throw.gravity * seconds * seconds;
