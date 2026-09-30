import {
  AbstractMesh,
  Color3,
  Material,
  PBRMaterial,
  StandardMaterial,
  type Node,
  type TransformNode,
} from "@babylonjs/core";

/**
 * Normalises an instantiated model to a target physical size.
 *
 * Hand-authored art does not agree on scale or on where the origin sits — across the six
 * ingredient models the authored height ranges from 0.31 to 1.66 units, and some carry
 * stray geometry far off-origin. Measuring the real bounds and fitting to a target is
 * robust to all of that, where six hardcoded multipliers would silently rot the next time
 * the art is re-exported. `CharacterController.fitToWorld` does the same thing for rigs.
 */

export interface ModelBounds {
  readonly minimumY: number;
  readonly maximumY: number;
  /** Largest extent across all three axes. */
  readonly size: number;
}

/** World-space bounds of every renderable mesh under `roots`. */
export const measureBounds = (roots: readonly Node[]): ModelBounds | null => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const root of roots) {
    for (const node of [root, ...root.getDescendants()]) {
      if (!(node instanceof AbstractMesh) || node.getTotalVertices() === 0) continue;
      node.computeWorldMatrix(true);
      const box = node.getBoundingInfo().boundingBox;
      minX = Math.min(minX, box.minimumWorld.x);
      minY = Math.min(minY, box.minimumWorld.y);
      minZ = Math.min(minZ, box.minimumWorld.z);
      maxX = Math.max(maxX, box.maximumWorld.x);
      maxY = Math.max(maxY, box.maximumWorld.y);
      maxZ = Math.max(maxZ, box.maximumWorld.z);
    }
  }

  const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  if (!Number.isFinite(size) || size <= 0.0001) return null;
  return { minimumY: minY, maximumY: maxY, size };
};

/** The uniform scale that makes `bounds` measure `targetSize` across its largest axis. */
export const fitScale = (bounds: ModelBounds, targetSize: number): number =>
  targetSize / bounds.size;

/**
 * Scales `holder` so its contents measure `targetSize`, and lifts it so the model's lowest
 * point rests at `holder`'s own origin rather than wherever the artist left it.
 */
export const fitHolderToSize = (
  holder: TransformNode,
  roots: readonly Node[],
  targetSize: number,
): boolean => {
  holder.scaling.setAll(1);
  holder.computeWorldMatrix(true);
  const bounds = measureBounds(roots);
  if (!bounds) return false;

  const scale = fitScale(bounds, targetSize);
  holder.scaling.setAll(scale);
  // `minimumY` was measured with the holder at scale 1, so the correction scales with it.
  const anchorY = holder.position.y;
  holder.position.y = anchorY - (bounds.minimumY - anchorY) * scale;
  holder.computeWorldMatrix(true);
  return true;
};

/**
 * Multiplies `hex` into the diffuse/albedo of every material under `roots`.
 *
 * Only safe on an instance created with `cloneMaterials`, otherwise it tints every other
 * instance sharing the same material too.
 */
export const tintInstance = (roots: readonly Node[], hex: string): void => {
  const tint = Color3.FromHexString(hex);
  const seen = new Set<Material>();
  for (const root of roots) {
    for (const node of [root, ...root.getDescendants()]) {
      if (!(node instanceof AbstractMesh) || !node.material) continue;
      const material = node.material;
      if (seen.has(material)) continue;
      seen.add(material);
      if (material instanceof StandardMaterial) {
        material.diffuseColor = material.diffuseColor.multiply(tint);
        material.emissiveColor = material.emissiveColor.multiply(tint);
      } else if (material instanceof PBRMaterial) {
        material.albedoColor = material.albedoColor.multiply(tint);
      }
    }
  }
};
