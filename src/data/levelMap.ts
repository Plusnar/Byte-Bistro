import type { LevelEntry } from "./levelCatalog";

/**
 * The level map: São Bento do Sul as a diorama, one star per official level.
 *
 * Pure placement and navigation rules live here so they can be tested without WebGL; the
 * Babylon side is `ui/LevelMapView.ts`.
 */

/** Referenced where it sits, so the artist's file is the one the game shows. */
export const LEVEL_MAP_URL = new URL("../../Scenario/sao_bento_do_sul.glb", import.meta.url).href;

/**
 * Landmarks that hold a star, in level order. The first level sits on the church; more
 * levels take the next landmark, then spread over the grass (see `ringSpots`).
 */
export const LEVEL_LANDMARKS: readonly string[] = ["Igreja", "Coreto", "Letreiro"];

/** Only the levels that ship with the game go on the map; a player's own maps do not. */
export const mapLevels = (entries: readonly LevelEntry[]): LevelEntry[] =>
  entries.filter((entry) => entry.kind !== "saved");

export interface GroundRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * `count` points spread evenly around the middle of the ground, for levels beyond the
 * named landmarks. Inset from the edge so a star never hangs over the side of the island.
 */
export const ringSpots = (count: number, ground: GroundRect): { x: number; z: number }[] => {
  const centerX = (ground.minX + ground.maxX) / 2;
  const centerZ = (ground.minZ + ground.maxZ) / 2;
  const radiusX = ((ground.maxX - ground.minX) / 2) * 0.62;
  const radiusZ = ((ground.maxZ - ground.minZ) / 2) * 0.62;
  const spots: { x: number; z: number }[] = [];
  for (let i = 0; i < count; i++) {
    // Offset by half a step so two extra levels do not line up with the landmarks' axis.
    const angle = ((i + 0.5) / Math.max(1, count)) * Math.PI * 2;
    spots.push({ x: centerX + Math.cos(angle) * radiusX, z: centerZ + Math.sin(angle) * radiusZ });
  }
  return spots;
};

/**
 * The star to jump to when a direction is pressed: the nearest one on screen that lies
 * within 60° of that direction. `points` are screen positions (y grows downward) and
 * `dx`/`dy` the pressed direction in the same space. Returns -1 when nothing is that way.
 */
export const neighbourInDirection = (
  points: readonly { x: number; y: number }[],
  from: number,
  dx: number,
  dy: number,
): number => {
  const origin = points[from];
  const length = Math.hypot(dx, dy);
  if (!origin || length === 0) return -1;
  const dirX = dx / length;
  const dirY = dy / length;
  let best = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < points.length; i++) {
    if (i === from) continue;
    const offsetX = points[i]!.x - origin.x;
    const offsetY = points[i]!.y - origin.y;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance < 1e-6) continue;
    const alignment = (offsetX * dirX + offsetY * dirY) / distance;
    if (alignment < 0.5) continue;
    // Straight ahead beats diagonal at the same distance.
    const score = distance * (2 - alignment);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
};
