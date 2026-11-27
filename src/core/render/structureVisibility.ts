import { InstancedMesh, Material, PBRMaterial, StandardMaterial, type AbstractMesh } from "@babylonjs/core";
import { isFloorAsset, isFootingAsset, isWallAsset } from "../../physics/collisionPolicy";

const OVERHEAD_STRUCTURE = /\/[^/]*(?:roof|ceiling|telhado|forro|gable|truss|pilaster|pilastra)[^/]*\.(?:glb|gltf)$/i;
export const STRUCTURE_OPACITY = 0.22;

export function isSeeThroughStructure(assetId: string, height: number, category?: string): boolean {
  if (isFloorAsset(assetId)) return height > 0.08;
  return isWallAsset(assetId, category) ||
    (assetId !== "build-block" && isFootingAsset(assetId)) ||
    OVERHEAD_STRUCTURE.test(assetId);
}

/** One transparent copy per material and opacity, shared by every matching piece in the scene. */
export class StructureMaterials {
  private readonly copies = new Map<Material, Map<number, Material>>();
  private readonly originals = new WeakMap<AbstractMesh, Material>();

  has(mesh: AbstractMesh): boolean {
    return this.originals.has(mesh);
  }

  restore(mesh: AbstractMesh): void {
    const original = this.originals.get(mesh);
    if (!original) return;
    mesh.material = original;
    this.originals.delete(mesh);
  }

  fade(mesh: AbstractMesh, opacity = STRUCTURE_OPACITY): void {
    if (mesh instanceof InstancedMesh) return;
    const source = this.originals.get(mesh) ?? mesh.material;
    if (!(source instanceof PBRMaterial || source instanceof StandardMaterial)) return;
    let variants = this.copies.get(source);
    if (!variants) this.copies.set(source, variants = new Map());
    let material = variants.get(opacity);
    if (!material) {
      const copy = source.clone(source.name);
      if (!copy) return;
      copy.alpha *= opacity;
      copy.transparencyMode = Material.MATERIAL_ALPHABLEND;
      copy.useSpecularOverAlpha = false;
      if (copy instanceof PBRMaterial) copy.useRadianceOverAlpha = false;
      variants.set(opacity, material = copy);
    }
    this.originals.set(mesh, source);
    if (mesh.material !== material) mesh.material = material;
  }

  dispose(): void {
    for (const variants of this.copies.values()) {
      for (const material of variants.values()) material.dispose();
    }
    this.copies.clear();
  }
}
