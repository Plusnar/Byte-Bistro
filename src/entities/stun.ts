/**
 * Stun maths, kept out of `Player` so it can be unit tested without a Babylon scene.
 *
 * Overcooked chefs never leave the floor when hit: they fall over in place and slide a
 * little. Everything here is deliberately horizontal — there is no vertical component to
 * compute, which is what makes the old "launched nine metres into the air" bug impossible
 * to reintroduce by tuning.
 */

/** Seconds a hit chef stays on the floor before standing back up on their own. */
export const STUN_SECONDS = 2.5;
/** Slide speed for the weakest possible hit, in m/s. */
export const STUN_SLIDE_MIN_SPEED = 1.1;
/** Slide speed for a full-strength hit, in m/s. */
export const STUN_SLIDE_MAX_SPEED = 3;
/** How fast the slide bleeds off, in m/s². */
export const STUN_SLIDE_DECELERATION = 12;
/** Momentum (kg·m/s) that counts as a full-strength hit. */
export const STUN_REFERENCE_MOMENTUM = 7;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Initial slide speed for a hit of `strength` (0..1). */
export const stunSlideSpeed = (
  strength: number,
  minimum: number = STUN_SLIDE_MIN_SPEED,
  maximum: number = STUN_SLIDE_MAX_SPEED,
): number => minimum + (maximum - minimum) * clamp01(strength);

/**
 * How hard a thrown item hits, as 0..1. A heavier or faster item slides the victim further,
 * but the result is clamped — no combination can produce an extreme impulse.
 */
export const impactStunStrength = (
  itemMass: number,
  projectileSpeed: number,
  reference: number = STUN_REFERENCE_MOMENTUM,
): number => {
  if (reference <= 0) return 1;
  return clamp01((Math.max(0, itemMass) * Math.max(0, projectileSpeed)) / reference);
};

/** Distance a slide of `speed` covers before friction stops it. */
export const stunSlideDistance = (
  speed: number,
  deceleration: number = STUN_SLIDE_DECELERATION,
): number => (deceleration <= 0 ? Number.POSITIVE_INFINITY : (speed * speed) / (2 * deceleration));
