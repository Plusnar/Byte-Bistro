import { InstancedMesh, Material, PBRMaterial, StandardMaterial, type AbstractMesh } from "@babylonjs/core";
import { isFootingAsset, isWallAsset } from "../../physics/collisionPolicy";

const OVERHEAD_STRUCTURE = /\/[^/]*(?:roof|ceiling|telhado|forro|gable|truss|pilaster|pilastra)[^/]*\.(?:glb|gltf)$/i;

export function isConstruction(assetId: string, category?: string): boolean {
  return category === "room" || isWallAsset(assetId, category) ||
    (assetId !== "build-block" && isFootingAsset(assetId)) ||
    OVERHEAD_STRUCTURE.test(assetId);
}

/** Reuse opaque copies of construction materials without modifying shared source materials. */
export class ConstructionMaterials {
  private readonly copies = new Map<Material, Material>();

  apply(mesh: AbstractMesh): void {
    if (mesh instanceof InstancedMesh) return;
    const source = mesh.material;
    if (!(source instanceof PBRMaterial || source instanceof StandardMaterial)) return;
    if (!source.needAlphaBlendingForMesh(mesh)) return;
    let material = this.copies.get(source);
    if (!material) {
      const copy = source.clone(source.name);
      if (!copy) return;
      copy.alpha = 1;
      copy.transparencyMode = source.transparencyMode === Material.MATERIAL_ALPHATESTANDBLEND
        ? Material.MATERIAL_ALPHATEST
        : Material.MATERIAL_OPAQUE;
      this.copies.set(source, material = copy);
    }
    mesh.material = material;
  }

  dispose(): void {
    for (const material of this.copies.values()) material.dispose();
    this.copies.clear();
  }
}
