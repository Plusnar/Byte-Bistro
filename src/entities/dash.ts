/**
 * Dash maths, kept out of `Player` so it can be unit tested without a Babylon scene.
 *
 * The dash is a short burst in one direction, chosen the moment it starts and held for its
 * whole length: steering mid-dash would make it a second walk speed instead of a committed
 * move, which is what gives an Overcooked kitchen its read-the-room feel. It is deliberately
 * an impulse on the normal velocity, never a teleport, so the collision sweep still runs and
 * a dash cannot push a cook through a counter.
 *
 * Running still exists and is slower than a dash: `run` is for covering ground, the dash is
 * for the one tile you need right now.
 */

/** Top speed of a dash, in m/s. Well above the run so the burst reads as a burst. */
export const DASH_SPEED = 9.5;
/** How long the burst lasts, in seconds. */
export const DASH_DURATION = 0.2;
/** Seconds after the burst ends before another dash is allowed. */
export const DASH_RECOVERY = 0.55;
/**
 * How much of the top speed is left at the very end of the burst. The dash eases out
 * instead of stopping dead, so the cook settles into a walk rather than hitting a wall of
 * deceleration.
 */
const DASH_END_SPEED_SHARE = 0.45;

export interface DashState {
  /** Seconds of burst left; 0 when not dashing. */
  readonly active: number;
  /** Seconds until another dash may start; counts the burst itself as well. */
  readonly cooldown: number;
  /** Unit direction committed to at the start of the burst. */
  readonly directionX: number;
  readonly directionZ: number;
}

export const IDLE_DASH: DashState = { active: 0, cooldown: 0, directionX: 0, directionZ: 1 };

export const isDashing = (state: DashState): boolean => state.active > 0;

/** A dash may start only once the previous one has fully recovered. */
export const canDash = (state: DashState): boolean => state.cooldown <= 0;

/**
 * Starts a burst towards `(x, z)`. A zero-length direction is refused rather than
 * normalised to something arbitrary — the caller passes the facing when there is no input.
 */
export const beginDash = (state: DashState, x: number, z: number): DashState => {
  if (!canDash(state)) return state;
  const length = Math.hypot(x, z);
  if (length <= 1e-3) return state;
  return {
    active: DASH_DURATION,
    cooldown: DASH_DURATION + DASH_RECOVERY,
    directionX: x / length,
    directionZ: z / length,
  };
};

/** Runs both clocks down by `deltaSeconds`, keeping the committed direction. */
export const advanceDash = (state: DashState, deltaSeconds: number): DashState => {
  if (state.active <= 0 && state.cooldown <= 0) return state;
  const delta = Math.max(0, deltaSeconds);
  return {
    ...state,
    active: Math.max(0, state.active - delta),
    cooldown: Math.max(0, state.cooldown - delta),
  };
};

/** Cancels a burst outright, for a cook who is knocked over or taken out of play. */
export const cancelDash = (state: DashState): DashState => ({ ...state, active: 0 });

/** Speed of the burst right now, easing from full down to `DASH_END_SPEED_SHARE`. */
export const dashSpeed = (state: DashState): number => {
  if (state.active <= 0) return 0;
  const progress = Math.min(1, Math.max(0, 1 - state.active / DASH_DURATION));
  return DASH_SPEED * (1 - (1 - DASH_END_SPEED_SHARE) * progress * progress);
};

/** How ready the dash is, 0 right after one and 1 when it can be used again. */
export const dashReadiness = (state: DashState): number => {
  const total = DASH_DURATION + DASH_RECOVERY;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - state.cooldown / total));
};
