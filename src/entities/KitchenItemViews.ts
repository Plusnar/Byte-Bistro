import {
  AbstractMesh,
  Color3,
  MeshBuilder,
  StandardMaterial,
  TransformNode,
  type Mesh,
  type Node,
  type Scene,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { foodVisualFor, getFoodDefinition, kitchenAssetId, type ModelVisual } from "../data/kitchen";
import { fitHolderToSize, tintInstance } from "./modelFit";
import { INGREDIENT_SCENARIO_VISUALS } from "../data/scenarioAssets";
import {
  findMatchingRecipe,
  isCookwareBurnt,
  type FoodItem,
  type KitchenItem,
} from "../gameplay/kitchen/KitchenItems";
import type { RecipeData } from "../types/game";

interface ItemView {
  readonly root: TransformNode;
  signature: string;
  readonly models: ModelInstance[];
  readonly meshes: Mesh[];
}

const PLATE_SCALE = 0.6;
const COOKWARE_SCALE = 0.55;
/** Food shrinks when sitting on a plate or inside cookware. */
const CONTAINED_FOOD_SCALE = 0.75;

const signatureOf = (item: KitchenItem, recipes: readonly RecipeData[]): string => {
  const foods = (list: readonly FoodItem[]): string =>
    list.map((food) => `${food.ingredientId}.${food.state}`).join(",");
  switch (item.kind) {
    case "food":
      return `food|${item.ingredientId}|${item.state}`;
    case "plate": {
      const recipe = item.dirty ? null : findMatchingRecipe(item.contents, recipes);
      return `plate|${item.dirty ? "dirty" : "clean"}|${recipe?.id ?? foods(item.contents)}`;
    }
    case "pan":
    case "pot":
    case "tray":
    case "bowl":
      return `${item.kind}|${isCookwareBurnt(item) ? "burnt" : ""}|${foods(item.contents)}`;
    case "extinguisher":
      return "extinguisher";
  }
};

/**
 * Owns one Babylon node per kitchen item, rebuilt only when the item's visible
 * state changes (chopped, cooked, plated...). Models come from preloaded
 * containers so rebuilds are synchronous.
 */
export class KitchenItemViews {
  private readonly views = new Map<string, ItemView>();
  private readonly extinguisherBody: StandardMaterial;
  private readonly extinguisherTrim: StandardMaterial;
  private readonly burntTint: StandardMaterial;
  private readonly seen = new Set<string>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetManager,
    private readonly recipes: readonly RecipeData[],
  ) {
    this.extinguisherBody = this.material("kitchen-extinguisher-body", "#D7263D", "#4A0A12");
    this.extinguisherTrim = this.material("kitchen-extinguisher-trim", "#1B1F24", "#000000");
    this.burntTint = this.material("kitchen-burnt-smoke", "#1A1A1A", "#000000");
    this.burntTint.alpha = 0.55;
  }

  /** Marks the start of a sync pass; views not touched before `endFrame` are disposed. */
  beginFrame(): void {
    this.seen.clear();
  }

  /** Ensures the item's view exists, is current, and is parented as requested. */
  place(item: KitchenItem, parent: Node | null): TransformNode {
    this.seen.add(item.uid);
    let view = this.views.get(item.uid);
    const signature = signatureOf(item, this.recipes);
    if (!view) {
      view = {
        root: new TransformNode(`kitchen-item-${item.uid}`, this.scene),
        signature: "",
        models: [],
        meshes: [],
      };
      this.views.set(item.uid, view);
    }
    if (view.signature !== signature) this.rebuild(view, item, signature);
    if (view.root.parent !== parent) {
      view.root.parent = parent;
      if (parent) {
        view.root.position.setAll(0);
        view.root.rotation.setAll(0);
      }
    }
    return view.root;
  }

  getRoot(item: KitchenItem): TransformNode | null {
    return this.views.get(item.uid)?.root ?? null;
  }

  endFrame(): void {
    for (const [uid, view] of this.views) {
      if (this.seen.has(uid)) continue;
      this.disposeView(view);
      this.views.delete(uid);
    }
  }

  dispose(): void {
    for (const view of this.views.values()) this.disposeView(view);
    this.views.clear();
    this.extinguisherBody.dispose();
    this.extinguisherTrim.dispose();
    this.burntTint.dispose();
  }

  private rebuild(view: ItemView, item: KitchenItem, signature: string): void {
    this.clearParts(view);
    let complete = true;
    switch (item.kind) {
      case "food":
        complete = this.addFood(view, item, 1, 0, 0, 0);
        break;
      case "plate":
        complete = this.addPlate(view, item.dirty, item.contents);
        break;
      case "pan":
      case "pot":
        complete = this.addCookware(view, item.kind, item.contents, isCookwareBurnt(item));
        break;
      case "extinguisher":
        this.addExtinguisher(view);
        break;
    }
    // Retry next frame when a model was still loading.
    view.signature = complete ? signature : "";
  }

  private addPlate(view: ItemView, dirty: boolean, contents: readonly FoodItem[]): boolean {
    let complete = this.addModel(view, kitchenAssetId(dirty ? "plate_dirty" : "plate"), PLATE_SCALE, 0, 0, 0);
    if (dirty || contents.length === 0) return complete;
    const recipe = findMatchingRecipe(contents, this.recipes);
    const dish = recipe ? INGREDIENT_SCENARIO_VISUALS[recipe.finalItemId] : undefined;
    if (dish) {
      return this.addModel(view, dish.assetId, dish.scale * 0.85, 0.06, 0, 0) && complete;
    }
    const radius = contents.length > 1 ? 0.12 : 0;
    contents.forEach((food, index) => {
      const angle = (index / contents.length) * Math.PI * 2;
      complete = this.addFood(
        view,
        food,
        CONTAINED_FOOD_SCALE,
        0.06 + index * 0.02,
        Math.cos(angle) * radius,
        Math.sin(angle) * radius,
      ) && complete;
    });
    return complete;
  }

  private addCookware(
    view: ItemView,
    kind: "pan" | "pot",
    contents: readonly FoodItem[],
    burnt: boolean,
  ): boolean {
    if (kind === "pot") {
      const model = contents.length > 0 ? "pot_A_stew" : "pot_A";
      const complete = this.addModel(view, kitchenAssetId(model), COOKWARE_SCALE * 0.85, 0, 0, 0);
      if (burnt) this.addSmoke(view, 0.3);
      return complete;
    }
    let complete = this.addModel(view, kitchenAssetId("pan_A"), COOKWARE_SCALE, 0, 0, 0);
    const food = contents[0];
    if (food) complete = this.addFood(view, food, CONTAINED_FOOD_SCALE, 0.07, 0, 0) && complete;
    if (burnt) this.addSmoke(view, 0.2);
    return complete;
  }

  private addFood(view: ItemView, food: FoodItem, scale: number, y: number, x: number, z: number): boolean {
    const definition = getFoodDefinition(food.ingredientId);
    if (!definition) return true;
    const visual = foodVisualFor(definition, food.state);
    if (!visual) return true;
    return this.addModel(
      view,
      visual.assetId,
      visual.scale * scale,
      y + (visual.y ?? 0),
      x,
      z,
      visual,
    );
  }

  private addModel(
    view: ItemView,
    assetId: string,
    scale: number,
    y: number,
    x: number,
    z: number,
    visual?: ModelVisual,
  ): boolean {
    const holder = new TransformNode(`${view.root.name}-part`, this.scene);
    holder.parent = view.root;
    holder.position.set(x, y, z);
    holder.scaling.setAll(scale);
    const instance = this.assets.instantiateLoaded(assetId, {
      namePrefix: `${view.root.name}-`,
      parent: holder,
      // A tint mutates materials, so it must not share them with every other instance.
      cloneMaterials: Boolean(visual?.tint),
    });
    if (!instance) {
      holder.dispose(false, false);
      return false;
    }
    if (visual?.fitToSize !== undefined) {
      // Authored scale is unreliable across the hand-made art; measure and normalise.
      fitHolderToSize(holder, instance.rootNodes, visual.fitToSize * scale);
    }
    for (const rootNode of instance.rootNodes) {
      for (const node of [rootNode, ...rootNode.getDescendants()]) {
        if (!(node instanceof AbstractMesh)) continue;
        node.isPickable = false;
        // Items are picked up and carried, so they must never be solid.
        node.checkCollisions = false;
      }
    }
    if (visual?.tint) tintInstance(instance.rootNodes, visual.tint);
    view.models.push({
      ...instance,
      dispose: () => {
        instance.dispose();
        holder.dispose(false, false);
      },
    });
    return true;
  }

  private addExtinguisher(view: ItemView): void {
    const body = MeshBuilder.CreateCylinder(
      `${view.root.name}-body`,
      { height: 0.5, diameter: 0.2, tessellation: 12 },
      this.scene,
    );
    body.position.y = 0.25;
    body.material = this.extinguisherBody;
    const cap = MeshBuilder.CreateCylinder(
      `${view.root.name}-cap`,
      { height: 0.08, diameter: 0.12, tessellation: 10 },
      this.scene,
    );
    cap.position.y = 0.54;
    cap.material = this.extinguisherTrim;
    const nozzle = MeshBuilder.CreateBox(
      `${view.root.name}-nozzle`,
      { width: 0.05, height: 0.05, depth: 0.2 },
      this.scene,
    );
    nozzle.position.set(0, 0.56, 0.1);
    nozzle.material = this.extinguisherTrim;
    for (const mesh of [body, cap, nozzle]) {
      mesh.parent = view.root;
      mesh.isPickable = false;
      view.meshes.push(mesh);
    }
  }

  private addSmoke(view: ItemView, y: number): void {
    const puff = MeshBuilder.CreateSphere(`${view.root.name}-smoke`, { diameter: 0.32, segments: 6 }, this.scene);
    puff.parent = view.root;
    puff.position.y = y;
    puff.scaling.y = 0.6;
    puff.material = this.burntTint;
    puff.isPickable = false;
    view.meshes.push(puff);
  }

  private clearParts(view: ItemView): void {
    for (const model of view.models) model.dispose();
    view.models.length = 0;
    for (const mesh of view.meshes) mesh.dispose(false, false);
    view.meshes.length = 0;
  }

  private disposeView(view: ItemView): void {
    this.clearParts(view);
    view.root.dispose(false, false);
  }

  private material(name: string, diffuse: string, emissive: string): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(diffuse);
    material.emissiveColor = Color3.FromHexString(emissive);
    material.specularColor.set(0.2, 0.2, 0.2);
    return material;
  }
}
