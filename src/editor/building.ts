import { Color3, MeshBuilder, StandardMaterial, type Scene, type TransformNode, type Mesh } from "@babylonjs/core";

export const isBuildingAsset = (id: string): boolean =>
  id === "build-floor" || id === "build-wall" || id === "build-block" || /^build-player-spawn-[1-4]$/.test(id);

/** Shared geometry: the editor and the playable map use identical dimensions. */
export function createBuildingMesh(assetId: string, scene: Scene, parent: TransformNode, color?: string): Mesh | null {
  if (!isBuildingAsset(assetId)) return null;
  const spawn = assetId.startsWith("build-player-spawn-");
  const floor = assetId === "build-floor";
  const wall = assetId === "build-wall";
  const mesh = spawn
    ? MeshBuilder.CreateCylinder(`${parent.name}-building`, { diameter: 1.1, height: 0.08, tessellation: 32 }, scene)
    : MeshBuilder.CreateBox(`${parent.name}-building`, {
    width: floor || wall ? 2 : 1,
    height: floor ? 0.12 : wall ? 3 : 1,
    depth: floor ? 2 : wall ? 0.2 : 1,
  }, scene);
  mesh.parent = parent;
  mesh.position.y = spawn ? 0.04 : floor ? -0.06 : wall ? 1.5 : 0.5;
  const material = new StandardMaterial(`${mesh.name}-material`, scene);
  material.diffuseColor = Color3.FromHexString(color ?? (floor ? "#64758a" : wall ? "#a9bccc" : "#d5a26c"));
  if (spawn) {
    material.emissiveColor = Color3.FromHexString(color ?? "#55F3EC");
    material.alpha = 0.72;
  }
  material.specularColor = new Color3(0.08, 0.08, 0.08);
  mesh.material = material;
  mesh.onDisposeObservable.addOnce(() => material.dispose());
  return mesh;
}
