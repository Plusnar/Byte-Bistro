import { sameColors, type MapPlacedObject } from "./MapData";

/**
 * Whether a live editor visual can absorb a change instead of being rebuilt.
 *
 * `EditorScene.refresh()` compares `data !== visual.data` by identity, and `MapData` is
 * immutable, so *every* edit produces a new object. Without this check, nudging a gizmo or
 * ticking a robot's checkbox disposes the GLB and re-instantiates it — an async reload and a
 * visible pop on every single interaction.
 *
 * Fields listed here are the ones the visual already re-reads: the root transform, and the
 * metadata nobody draws. `assetId` and `color` are not, because they decide which model and
 * which material were built in the first place.
 */
const REBUILD_KEYS = ["id", "assetId", "role", "category", "color"] as const;

const sameVector = (
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

export const isVisualPreservingChange = (
  previous: MapPlacedObject,
  next: MapPlacedObject,
): boolean => {
  for (const key of REBUILD_KEYS) {
    if (previous[key] !== next[key]) return false;
  }
  // A parade draws its route on the floor: a new distance redraws it.
  // The same for a crew's gap or circle.
  const kind = next.mechanism?.kind;
  if ((kind === "march" || kind === "bottle_fight" || kind === "panic_run") && paradeDistance(previous) !== paradeDistance(next)) return false;
  return true;
};

const paradeDistance = (object: MapPlacedObject): number => {
  const first = object.mechanism?.waypoints[0];
  return first ? Math.hypot(first.x, first.z) : 0;
};

/**
 * True when the design-tool colours changed. They are re-applied in place (a material swap),
 * so they are deliberately not a rebuild key.
 */
export const hasColorChange = (previous: MapPlacedObject, next: MapPlacedObject): boolean =>
  !sameColors(previous.colors, next.colors);

/** True when the root transform itself changed and has to be re-applied to the node. */
export const hasTransformChange = (
  previous: MapPlacedObject,
  next: MapPlacedObject,
): boolean =>
  !sameVector(previous.position, next.position) ||
  !sameVector(previous.rotation, next.rotation) ||
  !sameVector(previous.scale, next.scale);
