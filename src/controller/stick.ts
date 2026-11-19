/**
 * Virtual analog stick maths: a 360° vector from a thumb offset, with a radial dead zone
 * rescaled so the cook starts moving just past it (no jump from 0 to 0.15).
 */
export const STICK_DEADZONE = 0.12;

export const stickVector = (
  dx: number,
  dy: number,
  radius: number,
  deadzone = STICK_DEADZONE,
): { x: number; y: number; magnitude: number } => {
  if (!(radius > 0)) return { x: 0, y: 0, magnitude: 0 };
  const distance = Math.hypot(dx, dy);
  const raw = Math.min(1, distance / radius);
  if (raw <= deadzone || distance === 0) return { x: 0, y: 0, magnitude: 0 };
  const magnitude = (raw - deadzone) / (1 - deadzone);
  return { x: (dx / distance) * magnitude, y: (dy / distance) * magnitude, magnitude };
};

export type DpadDirection = "up" | "down" | "left" | "right";
/** Inside this share of the D-pad's radius the thumb rests: no direction. */
export const DPAD_DEADZONE = 0.22;

/**
 * D-pad direction under a thumb, by 90° sectors (45° either side of each arrow), so a
 * thumb sliding around the pad steps through the arrows like a real cross.
 */
export const dpadDirection = (dx: number, dy: number, radius: number, deadzone = DPAD_DEADZONE): DpadDirection | null => {
  if (!(radius > 0) || Math.hypot(dx, dy) < radius * deadzone) return null;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
};
