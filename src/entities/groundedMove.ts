/**
 * Ground movement maths for characters that never jump.
 *
 * Kept pure and Babylon-free so it can be unit tested, and kept out of `stun.ts` because
 * that module has a test asserting none of its exports mention gravity.
 *
 * ## Why gravity still exists in a game with no jumping
 *
 * Babylon's collision sweep (`Collisions/collider.js` `_testTriangle`) computes
 * `normalDotVelocity = dot(trianglePlane.normal, velocity)`. When that is *exactly* zero it
 * takes a degenerate branch — `embeddedInPlane = true; t0 = 0` — which makes
 * `_nearestDistance` zero, so `_getResponse` scales the whole velocity to nothing and the
 * mesh never moves. A purely horizontal displacement hits that branch against every
 * horizontal face in the level, and the state is a fixed point: the character freezes on
 * the spot for as long as the input is held.
 *
 * Keeping a small downward component in the displacement makes the branch unreachable, and
 * the downward sweep also pushes the collision ellipsoid back out of anything it ends up
 * inside. That self-healing is the real reason to integrate a fall.
 */

/** Downward acceleration while airborne, in m/s². */
export const FALL_ACCELERATION = 18;
/** Fastest a character may fall, so a drop off a custom map recovers predictably. */
export const TERMINAL_FALL_SPEED = 12;
/**
 * Downward speed kept while standing on the floor. Small enough to be invisible, large
 * enough that the collision sweep is never exactly horizontal.
 */
export const GROUND_PROBE_SPEED = 2;
/** Floor height. Characters are authored with their origin at the feet. */
export const GROUND_Y = 0;

export interface Bounds2D {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface Displacement2D {
  readonly x: number;
  readonly z: number;
}

/**
 * The next vertical velocity.
 *
 * Never returns 0 — that is the whole point, see the module comment.
 */
export const integrateFall = (
  velocityY: number,
  deltaSeconds: number,
  grounded: boolean,
): number => {
  if (grounded) return -GROUND_PROBE_SPEED;
  const next = velocityY - FALL_ACCELERATION * Math.max(0, deltaSeconds);
  return Math.max(-TERMINAL_FALL_SPEED, Math.min(-GROUND_PROBE_SPEED, next));
};

/**
 * Trims a horizontal displacement so `position + result` lands inside `bounds`.
 *
 * Clamping the displacement *before* moving is safer than clamping the position after:
 * a post-move clamp is an uncollided teleport that can plant the collision ellipsoid
 * inside a collider it then cannot escape.
 */
export const clampDisplacementToBounds = (
  position: { readonly x: number; readonly z: number },
  displacement: Displacement2D,
  bounds: Bounds2D,
  inset = 0,
): Displacement2D => {
  const minX = bounds.minX + inset;
  const maxX = bounds.maxX - inset;
  const minZ = bounds.minZ + inset;
  const maxZ = bounds.maxZ - inset;
  const targetX = Math.min(maxX, Math.max(minX, position.x + displacement.x));
  const targetZ = Math.min(maxZ, Math.max(minZ, position.z + displacement.z));
  return { x: targetX - position.x, z: targetZ - position.z };
};

/** Whether a character is resting on the floor rather than falling. */
export const isGrounded = (y: number, epsilon = 0.02): boolean => y <= GROUND_Y + epsilon;

// --- Standing on things other than the floor ---------------------------------
//
// Stairs and platforms put the feet above y = 0, so "on the ground" has to mean
// "on the surface measured under the feet". Comparing against GROUND_Y instead
// made a cook on a stair tread count as falling: the fall speed built up to
// terminal, and at 30 fps each frame swept the capsule 0.4 m down — past its
// step clearance, onto the tread, where the next riser caught it. That was the
// "stuck on some steps", and why it came and went with the frame rate.

/**
 * Most a grounded sweep may drop in one frame. It only has to keep the sweep
 * off exactly horizontal (see the module comment); anything more eats into the
 * clearance that lets a riser pass under the capsule.
 */
export const GROUNDED_SWEEP_DROP = 0.02;

/** Top speed at which the visible body catches up with a step, in m/s. */
export const STEP_SMOOTH_SPEED = 6;

export const isGroundedOn = (y: number, floor: number, epsilon = 0.02): boolean =>
  y <= floor + epsilon;

/** Caps a grounded sweep's drop without ever making it exactly zero. */
export const groundedSweepY = (displacementY: number): number =>
  Math.max(displacementY, -GROUNDED_SWEEP_DROP);

export interface Settled {
  /** Feet height after settling. */
  readonly y: number;
  /** True when the feet were placed on the floor rather than left to fall. */
  readonly onFloor: boolean;
}

/**
 * Where the feet end up after a move, given the floor measured beneath them.
 *
 * Below the floor means a step up: stand on it. Just above it, having been on
 * the ground, means walking off a step: stay on it rather than drop a riser as
 * a fall. Further above than a step is a real drop, and gravity takes over.
 */
export const settleOnFloor = (
  y: number,
  floor: number,
  wasGrounded: boolean,
  stepHeight: number,
): Settled => {
  if (y <= floor) return { y: floor, onFloor: true };
  if (wasGrounded && y - floor <= stepHeight) return { y: floor, onFloor: true };
  return { y, onFloor: false };
};

/**
 * Eases the visible body's offset from its collider back to zero.
 *
 * The collider takes a step in one frame, which keeps collision exact; the body
 * follows at a capped speed instead of popping. Linear rather than exponential
 * so a long staircase never builds up lag: each step is caught before the next.
 */
export const easeStepOffset = (
  offset: number,
  deltaSeconds: number,
  speed: number = STEP_SMOOTH_SPEED,
): number => {
  const remaining = Math.abs(offset) - speed * Math.max(0, deltaSeconds);
  return remaining <= 0 ? 0 : Math.sign(offset) * remaining;
};
