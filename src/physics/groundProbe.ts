import { Matrix, Ray, Vector3, type AbstractMesh, type Scene } from "@babylonjs/core";
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
const worldRay = new Ray(Vector3.Zero(), DOWN);
const localRay = Ray.Zero();
const inverseWorld = Matrix.Identity();
const flightRay = new Ray(Vector3.Zero(), Vector3.Zero());
const obstacles = new WeakSet<AbstractMesh>();

/** A solid obstacle blocks the collider, but never catches or lifts the cook's feet. */
export const excludeFromGroundProbe = (mesh: AbstractMesh): void => { obstacles.add(mesh); };
export const isGroundProbeObstacle = (mesh: AbstractMesh): boolean => obstacles.has(mesh);

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
  maxRise = STEP_HEIGHT,
): number | null => {
  const highest = feetY + maxRise;
  const lowest = feetY - PROBE_DROP;
  worldRay.origin.set(x, highest, z);
  worldRay.length = maxRise + PROBE_DROP;
  const solid = (mesh: AbstractMesh): boolean => mesh !== self && supportsGround(mesh);
  // A body handed its nearby colliders (NearbyColliders) only looks at those: the same
  // floors it can collide with, instead of every mesh in a large level.
  const nearby = self.surroundingMeshes;
  if (nearby) {
    let top: number | null = null;
    for (const mesh of nearby) {
      if (!solid(mesh)) continue;
      const world = mesh.computeWorldMatrix();
      const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
      if (x < min.x || x > max.x || z < min.z || z > max.z || highest < min.y || lowest > max.y) continue;
      // Babylon's mesh picker expects a local-space ray, even though it returns a world-space hit.
      world.invertToRef(inverseWorld);
      Ray.TransformToRef(worldRay, inverseWorld, localRay);
      const hit = mesh.intersects(localRay, false, undefined, false, world);
      if (hit.hit && hit.pickedPoint && (top === null || hit.pickedPoint.y > top)) top = hit.pickedPoint.y;
    }
    // Nothing near: the body may have just been teleported past its list (a portal, a
    // respawn), so look properly before letting it fall.
    if (top !== null) return top;
  }
  const hit = scene.pickWithRay(worldRay, solid);
  if (!hit?.hit || !hit.pickedPoint) return null;
  return hit.pickedPoint.y;
};


const supportsGround = (mesh: AbstractMesh): boolean =>
  mesh.checkCollisions && mesh.isEnabled() && !isGroundProbeObstacle(mesh) && !isCharacterBody(mesh);

/** First walkable surface crossed by a descending ingredient, as a fraction of its step. */
export function flightGroundContact(from: Vector3, to: Vector3, candidates: readonly AbstractMesh[]): number {
  const drop = from.y - to.y;
  if (drop <= 0) return Infinity;
  flightRay.origin.copyFrom(from);
  to.subtractToRef(from, flightRay.direction);
  flightRay.length = flightRay.direction.length();
  flightRay.direction.scaleInPlace(1 / flightRay.length);
  const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x);
  const minZ = Math.min(from.z, to.z), maxZ = Math.max(from.z, to.z);
  let nearest = Infinity;
  for (const mesh of candidates) {
    if (!supportsGround(mesh)) continue;
    const world = mesh.computeWorldMatrix();
    const { minimumWorld: min, maximumWorld: max } = mesh.getBoundingInfo().boundingBox;
    if (maxX < min.x || minX > max.x || maxZ < min.z || minZ > max.z || from.y < min.y || to.y > max.y) continue;
    world.invertToRef(inverseWorld);
    Ray.TransformToRef(flightRay, inverseWorld, localRay);
    const hit = mesh.intersects(localRay, false, undefined, false, world);
    if (!hit.hit || !hit.pickedPoint) continue;
    const fraction = (from.y - hit.pickedPoint.y) / drop;
    if (fraction >= 0 && fraction <= 1 && fraction < nearest &&
        Math.abs(hit.getNormal(true, false)?.y ?? 0) >= 0.5) nearest = fraction;
  }
  if (nearest !== Infinity) return nearest;
  return to.y <= 0 ? Math.max(0, from.y / drop) : Infinity;
}
