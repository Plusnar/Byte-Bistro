import {
  AbstractMesh,
  Color3,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Node,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { INGREDIENT_SCENARIO_VISUALS } from "../data/scenarioAssets";
import type { IngredientData, IngredientInstance } from "../types/game";

export interface IngredientVisualDefinition {
  id: string;
  displayName: string;
  shape: IngredientData["shape"];
  color: string;
  emissiveColor: string;
  scale?: number;
}

interface IngredientMaterials {
  readonly body: StandardMaterial;
  readonly accent: StandardMaterial;
}

let visualSequence = 0;

/** A lightweight world/hand representation that carries no recipe logic. */
export class IngredientVisual {
  readonly root: TransformNode;
  readonly meshes: AbstractMesh[];
  readonly definition: IngredientVisualDefinition;
  readonly instance: IngredientInstance | null;
  private scenarioInstance: ModelInstance | null = null;
  private scenarioRoot: TransformNode | null = null;
  private disposed = false;

  constructor(
    scene: Scene,
    definition: IngredientVisualDefinition,
    materials: IngredientMaterials,
    instance: IngredientInstance | null = null,
  ) {
    const sequence = visualSequence++;
    this.definition = definition;
    this.instance = instance;
    this.root = new TransformNode(`ingredient-${definition.id}-${sequence}`, scene);

    const body = this.createBody(scene, definition.shape, sequence);
    body.material = materials.body;
    body.parent = this.root;
    body.isPickable = false;

    const accent = MeshBuilder.CreateTorus(
      `ingredient-accent-${sequence}`,
      { diameter: 0.43, thickness: 0.035, tessellation: 12 },
      scene,
    );
    accent.parent = this.root;
    accent.position.y = definition.shape === "sphere" ? 0 : 0.08;
    accent.rotation.x = Math.PI * 0.5;
    accent.material = materials.accent;
    accent.isPickable = false;

    const scale = definition.scale ?? 1;
    this.root.scaling.setAll(scale);
    this.meshes = [body, accent];
  }

  async loadScenarioModel(
    assets: AssetManager,
    assetId: string,
    scale: number,
    yOffset = -0.16,
  ): Promise<void> {
    const scenarioRoot = new TransformNode(`${this.root.name}-scenario`, this.root.getScene());
    scenarioRoot.parent = this.root;
    scenarioRoot.position.y = yOffset;
    scenarioRoot.scaling.setAll(scale);
    const instance = await assets.instantiateModel(assetId, {
      namePrefix: `${this.root.name}-food-`,
      parent: scenarioRoot,
      cloneMaterials: false,
    });
    if (!instance || this.disposed) {
      instance?.dispose();
      scenarioRoot.dispose(false, false);
      return;
    }

    this.scenarioRoot = scenarioRoot;
    this.scenarioInstance = instance;
    for (const mesh of this.meshes) mesh.setEnabled(false);
    for (const rootNode of instance.rootNodes) {
      for (const node of [rootNode, ...rootNode.getDescendants()]) {
        if (!(node instanceof AbstractMesh)) continue;
        node.isPickable = false;
        // Ingredients are carried through the kitchen; a collider here would
        // trap the cook holding one.
        node.checkCollisions = false;
        this.meshes.push(node);
      }
    }
  }

  attachTo(parent: Node, localPosition: Vector3 = Vector3.Zero()): void {
    this.root.parent = parent;
    this.root.position.copyFrom(localPosition);
    this.root.rotation.set(0, 0, 0);
  }

  detachAt(worldPosition: Vector3): void {
    this.root.parent = null;
    this.root.position.copyFrom(worldPosition);
  }

  setHighlighted(highlighted: boolean): void {
    for (const mesh of this.meshes) {
      mesh.renderOutline = highlighted;
      mesh.outlineColor = Color3.FromHexString(this.definition.emissiveColor);
      mesh.outlineWidth = 0.04;
    }
  }

  setVisible(visible: boolean): void {
    this.root.setEnabled(visible);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scenarioInstance?.dispose();
    this.scenarioInstance = null;
    this.scenarioRoot?.dispose(false, false);
    this.scenarioRoot = null;
    this.root.dispose(false, false);
  }

  private createBody(
    scene: Scene,
    shape: IngredientData["shape"],
    sequence: number,
  ): Mesh {
    switch (shape) {
      case "sphere":
        return MeshBuilder.CreateSphere(
          `ingredient-body-${sequence}`,
          { diameter: 0.42, segments: 8 },
          scene,
        );
      case "cylinder":
        return MeshBuilder.CreateCylinder(
          `ingredient-body-${sequence}`,
          { height: 0.45, diameter: 0.34, tessellation: 10 },
          scene,
        );
      case "disc":
        return MeshBuilder.CreateCylinder(
          `ingredient-body-${sequence}`,
          { height: 0.12, diameter: 0.5, tessellation: 12 },
          scene,
        );
      case "box":
        return MeshBuilder.CreateBox(
          `ingredient-body-${sequence}`,
          { width: 0.52, height: 0.2, depth: 0.36 },
          scene,
        );
    }
  }
}

/** Caches the small material palette shared by all ingredient instances. */
export class IngredientVisualFactory {
  private readonly materialCache = new Map<string, IngredientMaterials>();

  constructor(
    private readonly scene: Scene,
    private readonly assets?: AssetManager,
  ) {}

  createFromData(
    data: IngredientData,
    instance: IngredientInstance | null = null,
  ): IngredientVisual {
    return this.create(
      {
        id: data.id,
        displayName: data.displayName,
        shape: data.shape,
        color: data.color,
        emissiveColor: data.emissiveColor,
      },
      instance,
    );
  }

  create(
    definition: IngredientVisualDefinition,
    instance: IngredientInstance | null = null,
  ): IngredientVisual {
    const key = `${definition.color}|${definition.emissiveColor}`;
    let materials = this.materialCache.get(key);
    if (!materials) {
      materials = this.createMaterials(definition, this.materialCache.size);
      this.materialCache.set(key, materials);
    }
    const visual = new IngredientVisual(this.scene, definition, materials, instance);
    const scenarioVisual = INGREDIENT_SCENARIO_VISUALS[definition.id];
    if (this.assets && scenarioVisual) {
      void visual.loadScenarioModel(
        this.assets,
        scenarioVisual.assetId,
        scenarioVisual.scale,
        scenarioVisual.yOffset,
      ).catch((error: unknown) => {
        console.warn(`Food model could not be loaded for ${definition.id}.`, error);
      });
    }
    return visual;
  }

  dispose(): void {
    for (const materials of this.materialCache.values()) {
      materials.body.dispose();
      materials.accent.dispose();
    }
    this.materialCache.clear();
  }

  private createMaterials(
    definition: IngredientVisualDefinition,
    index: number,
  ): IngredientMaterials {
    const body = new StandardMaterial(`ingredient-body-material-${index}`, this.scene);
    body.diffuseColor = Color3.FromHexString(definition.color);
    body.specularColor.set(0.2, 0.25, 0.35);

    const accent = new StandardMaterial(`ingredient-accent-material-${index}`, this.scene);
    const emissive = Color3.FromHexString(definition.emissiveColor);
    accent.diffuseColor = emissive.scale(0.4);
    accent.emissiveColor = emissive.scale(0.85);
    accent.disableLighting = false;
    return { body, accent };
  }
}
