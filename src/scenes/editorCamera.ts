import type { ArcRotateCamera, Vector3 } from "@babylonjs/core";

/**
 * Moves an orbit camera's focus to `target`, carrying the camera along with it.
 *
 * `setTarget(target)` alone keeps the camera where it stands and rebuilds its angles to
 * look at the new point, so moving the focus turns the view instead of moving it: W and S
 * spun the editor camera rather than walking it forward and back. Keeping alpha, beta and
 * radius is what makes it a move.
 */
export const moveCameraTarget = (camera: ArcRotateCamera, target: Vector3): void => {
  camera.setTarget(target, false, false, true);
};
