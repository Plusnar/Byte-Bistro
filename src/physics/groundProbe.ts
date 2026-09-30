import { Ray, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
import { STEP_HEIGHT } from "./collisionPolicy";

export { STEP_HEIGHT };

/** How far below the feet the probe still looks for a surface to stand on. */
const PROBE_DROP = 0.6;

const CHARACTER_BODY = "characterBody";

/**
 * Marks a collider as belonging to a cook or a robot.
 *
 * Characters are solid to each other, but they are not scenery: without this
 * the ground probe could find a robot standing on a cook's spawn point and
 * plant the cook on the robot's head.
 */
export const markCharacterBody = (mesh: AbstractMesh): void => {
  mesh.metadata = { ...(mesh.metadata ?? {}), [CHARACTER_BODY]: true };
};

export const isCharacterBody = (mesh: AbstractMesh): boolean =>
  Boolean((mesh.metadata as Record<string, unknown> | null)?.[CHARACTER_BODY]);

const DOWN = new Vector3(0, -1, 0);

/**
 * Height of the walkable surface under a character, or `null` when there is
 * nothing within stepping range and they should keep falling.
 *
 * Only solid geometry counts, which is why the predicate tests `checkCollisions`
 * rather than `isPickable`: every scenery mesh in the kitchen is deliberately
 * unpickable so the interaction ray ignores it, and Babylon lets a custom
 * predicate override that default.
 */
export const probeGroundHeight = (
  scene: Scene,
  x: number,
  feetY: number,
  z: number,
  self: AbstractMesh,
): number | null => {
  const origin = new Vector3(x, feetY + STEP_HEIGHT, z);
  const ray = new Ray(origin, DOWN, STEP_HEIGHT + PROBE_DROP);
  const hit = scene.pickWithRay(
    ray,
    (mesh) => mesh !== self
      && mesh.checkCollisions
      && mesh.isEnabled()
      && !isCharacterBody(mesh),
  );
  if (!hit?.hit || !hit.pickedPoint) return null;
  return hit.pickedPoint.y;
};
