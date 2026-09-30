import {
  AbstractMesh,
  Color3,
  InstancedMesh,
  PBRMaterial,
  StandardMaterial,
  type Material,
  type Node,
} from "@babylonjs/core";

/**
 * Per-object colours without re-modelling: the "design tool".
 *
 * A model's parts are its materials (the project's own packs use one flat-coloured material
 * per part, e.g. "Pra_Grama", "Pra_MetalPreto"). A placed object stores the colours it
 * overrides by material name; everything else keeps the shared material, so an object that
 * was never recoloured costs nothing. Overridden materials are cloned once per
 * (material, colour) pair and shared by every object painted the same.
 *
 * Colours are stored as sRGB hex, as a colour picker shows them. PBR materials from glTF hold
 * linear values, so they are converted on the way in and out.
 */

export type ColorOverrides = Readonly<Record<string, string>>;

export interface MaterialSlot {
  /** Material name: the key stored in the map. */
  readonly name: string;
  /** What the editor shows. */
  readonly label: string;
  /** The model's own colour, sRGB hex. */
  readonly defaultColor: string;
  /** Textured parts are tinted (multiplied), not replaced. */
  readonly textured: boolean;
}

/** The material each mesh was loaded with, so "restore" can put it back. */
const originals = new WeakMap<AbstractMesh, Material>();

const isHex = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

const baseColor = (material: Material): Color3 | null => {
  if (material instanceof PBRMaterial) return material.albedoColor.toGammaSpace();
  if (material instanceof StandardMaterial) return material.diffuseColor.clone();
  return null;
};

const hasTexture = (material: Material): boolean =>
  (material instanceof PBRMaterial && Boolean(material.albedoTexture)) ||
  (material instanceof StandardMaterial && Boolean(material.diffuseTexture));

/** "Pra_MetalPreto" → "Metal preto"; generic Blender names become "Cor". */
export const materialLabel = (name: string): string => {
  const trimmed = name.replace(/^[A-Za-z]{2,4}_(?=[A-Z])/, "").replace(/\.\d+$/, "");
  if (!trimmed || /^material$/i.test(trimmed)) return "Cor";
  const words = trimmed
    .replace(/([a-zà-ÿ])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const meshesUnder = (roots: readonly Node[]): AbstractMesh[] => {
  const meshes: AbstractMesh[] = [];
  for (const root of roots) {
    for (const node of [root, ...root.getDescendants()]) {
      // An instance draws with its source's material; it cannot hold its own.
      if (node instanceof AbstractMesh && !(node instanceof InstancedMesh) && node.material) meshes.push(node);
    }
  }
  return meshes;
};

/** The paintable parts of a model, in first-seen order, one per material name. */
export const listMaterialSlots = (roots: readonly Node[]): MaterialSlot[] => {
  const slots = new Map<string, MaterialSlot>();
  for (const mesh of meshesUnder(roots)) {
    const material = originals.get(mesh) ?? mesh.material!;
    if (slots.has(material.name)) continue;
    const color = baseColor(material);
    if (!color) continue;
    slots.set(material.name, {
      name: material.name,
      label: materialLabel(material.name),
      defaultColor: color.toHexString(),
      textured: hasTexture(material),
    });
  }
  const list = [...slots.values()];
  // A single textured material (KayKit/Kenney atlases) is the whole object's tone.
  if (list.length === 1 && list[0]!.textured) return [{ ...list[0]!, label: "Tom" }];
  return list;
};

/** Shared clones of recoloured materials for one scene; dispose with the scene's content. */
export class MaterialOverrideCache {
  private readonly clones = new Map<string, Material>();

  get(original: Material, hex: string): Material {
    const key = `${original.uniqueId}|${hex.toLowerCase()}`;
    let clone = this.clones.get(key);
    if (!clone) {
      clone = original.clone(`${original.name}#${hex}`) ?? original;
      const color = Color3.FromHexString(hex);
      if (clone instanceof PBRMaterial) {
        clone.albedoColor = color.toLinearSpace();
      } else if (clone instanceof StandardMaterial) {
        clone.diffuseColor = color;
      }
      this.clones.set(key, clone);
    }
    return clone;
  }

  get size(): number {
    return this.clones.size;
  }

  dispose(): void {
    for (const clone of this.clones.values()) clone.dispose();
    this.clones.clear();
  }
}

/**
 * Paints `roots` with `colors` (material name → hex). Parts with no entry get their original
 * material back, so calling it again with fewer colours restores the rest.
 */
export const applyColorOverrides = (
  roots: readonly Node[],
  colors: ColorOverrides | undefined,
  cache: MaterialOverrideCache,
): void => {
  for (const mesh of meshesUnder(roots)) {
    let original = originals.get(mesh);
    if (!original) {
      original = mesh.material!;
      originals.set(mesh, original);
    }
    const hex = colors?.[original.name];
    mesh.material = hex && isHex(hex) ? cache.get(original, hex) : original;
  }
};
