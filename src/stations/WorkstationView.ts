import {
  AbstractMesh,
  Color3,
  Color4,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Scene,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { trackParticleSystem } from "../core/perf/effectBudget";
import {
  COUNTER_HEIGHT,
  CRATE_MODEL_BY_INGREDIENT,
  KITCHEN_TILE,
  getFoodDefinition,
  kitchenAssetId,
  type KitchenModelName,
} from "../data/kitchen";
import { BOARD, KNIFE_SPOT, PLATE_STEP, STACKED_PLATE_SCALE } from "./stationDressing";
import type { KitchenStationPlacement } from "../data/kitchenLayout";
import { fitHolderToSize } from "../entities/modelFit";
import type { KitchenStationKind } from "../types/game";

export type ProgressTone = "work" | "cook" | "burn";

export interface WorkstationViewState {
  readonly progress: number | null;
  readonly tone: ProgressTone;
  readonly warning: boolean;
  readonly onFire: boolean;
  readonly cleanPlates: number;
  readonly dirtyPlates: number;
  readonly chopping: boolean;
  /** A cook has picked the knife up to chop with, so the board shows none. */
  readonly knifeInHand?: boolean;
  /** A cook is scrubbing a plate in this sink. */
  readonly washing?: boolean;
}

interface BaseModel {
  readonly name: KitchenModelName;
  readonly scale: readonly [number, number, number];
  readonly y?: number;
}

const COUNTER_SCALE = [0.6, 0.9, 0.6] as const;
const MAX_STACKED_PLATES = 6;

/**
 * A sample of the ingredient floats above its crate so players can read the kitchen at a
 * glance. Sits between the crate top (0.9) and the progress bar (bottom edge 1.77), well
 * clear of the warning icon (2.25) and the keycap (2.6).
 */
const CRATE_ICON_HEIGHT = 1.45;
/** Target size of the floating sample above a crate, in metres. */
const CRATE_ICON_SIZE = 0.42;
/** Target size of the crate body, a little under the 1.2 m tile. */
const CRATE_BODY_SIZE = 1.1;

const TOP_HEIGHT: Readonly<Record<KitchenStationKind, number>> = {
  crate: 0.9,
  counter: COUNTER_HEIGHT,
  cutting_board: COUNTER_HEIGHT + 0.09,
  stove: 0.91,
  oven: 0.91,
  mixer: COUNTER_HEIGHT,
  sink: COUNTER_HEIGHT,
  plate_rack: COUNTER_HEIGHT,
  dirty_return: COUNTER_HEIGHT,
  trash: 0.95,
  delivery: COUNTER_HEIGHT,
  extinguisher_stand: COUNTER_HEIGHT,
};

/** Shared materials/textures for every workstation in a scene. */
export class WorkstationResources {
  readonly highlight: readonly [StandardMaterial, StandardMaterial];
  readonly barBackground: StandardMaterial;
  readonly barFill: Readonly<Record<ProgressTone, StandardMaterial>>;
  readonly warning: StandardMaterial;
  readonly deliveryGlow: StandardMaterial;
  readonly trashHole: StandardMaterial;
  readonly fireTexture: DynamicTexture;
  private readonly warningTexture: DynamicTexture;
  private readonly materials: StandardMaterial[] = [];
  /** One material per distinct keycap label ("E", "F", "ENTER", "RSHIFT"). */
  private readonly keyPrompts = new Map<string, StandardMaterial>();
  private readonly keyTextures: DynamicTexture[] = [];

  constructor(private readonly scene: Scene, playerColors: readonly [Color3, Color3]) {
    this.highlight = [this.flat("ws-highlight-p1", playerColors[0], 0.45), this.flat("ws-highlight-p2", playerColors[1], 0.45)];
    this.barBackground = this.flat("ws-bar-bg", Color3.FromHexString("#0B1620"), 0.85);
    this.barFill = {
      work: this.flat("ws-bar-work", Color3.FromHexString("#5CFF9D"), 1),
      cook: this.flat("ws-bar-cook", Color3.FromHexString("#FFD166"), 1),
      burn: this.flat("ws-bar-burn", Color3.FromHexString("#FF5370"), 1),
    };
    this.deliveryGlow = this.flat("ws-delivery", Color3.FromHexString("#5CFF9D"), 0.55);
    this.trashHole = this.flat("ws-trash-hole", Color3.FromHexString("#050608"), 1);

    this.warningTexture = new DynamicTexture("ws-warning-texture", { width: 128, height: 128 }, scene, false);
    this.warningTexture.hasAlpha = true;
    const context = this.warningTexture.getContext();
    context.clearRect(0, 0, 128, 128);
    context.fillStyle = "#FF6B35";
    context.beginPath();
    context.arc(64, 64, 58, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#FFFFFF";
    context.font = "bold 92px sans-serif";
    context.fillText("!", 64 - context.measureText("!").width / 2, 96);
    this.warningTexture.update();
    this.warning = this.flat("ws-warning", Color3.White(), 1);
    this.warning.diffuseTexture = this.warningTexture;
    this.warning.emissiveTexture = this.warningTexture;
    this.warning.useAlphaFromDiffuseTexture = true;

    this.fireTexture = new DynamicTexture("ws-fire-texture", { width: 64, height: 64 }, scene, false);
    this.fireTexture.hasAlpha = true;
    const fire = this.fireTexture.getContext();
    const gradient = fire.createRadialGradient(32, 32, 2, 32, 32, 30);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.4, "rgba(255,255,255,0.6)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    fire.fillStyle = gradient;
    fire.fillRect(0, 0, 64, 64);
    this.fireTexture.update();
  }

  /**
   * Material showing `label` as a keycap, built once per label and shared by every station.
   * `emissiveTexture` is set so the glow pass lights the glyph and not the whole quad.
   */
  keyPrompt(label: string): StandardMaterial {
    const cached = this.keyPrompts.get(label);
    if (cached) return cached;

    const size = 128;
    const texture = new DynamicTexture(`ws-key-${label}`, { width: size, height: size }, this.scene, false);
    texture.hasAlpha = true;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = "#07161F";
    ctx.fillRect(10, 18, size - 20, size - 46);
    ctx.strokeStyle = "#5CE6FF";
    ctx.lineWidth = 6;
    ctx.strokeRect(10, 18, size - 20, size - 46);
    ctx.fillStyle = "#EAF7FF";
    // Long labels like RSHIFT must shrink to stay inside the cap.
    const fontSize = label.length <= 1 ? 66 : label.length <= 2 ? 52 : label.length <= 4 ? 34 : 26;
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.fillText(label, (size - ctx.measureText(label).width) / 2, size / 2 + fontSize * 0.36);
    texture.update();

    const material = this.flat(`ws-key-mat-${label}`, Color3.White(), 1);
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.useAlphaFromDiffuseTexture = true;
    this.keyTextures.push(texture);
    this.keyPrompts.set(label, material);
    return material;
  }

  dispose(): void {
    for (const material of this.materials) material.dispose();
    for (const texture of this.keyTextures) texture.dispose();
    this.warningTexture.dispose();
    this.fireTexture.dispose();
  }

  private flat(name: string, color: Color3, alpha: number): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = color.clone();
    material.emissiveColor = color.clone();
    material.disableLighting = true;
    material.alpha = alpha;
    material.backFaceCulling = false;
    this.materials.push(material);
    return material;
  }
}

let workstationSequence = 0;

/**
 * Renders one kitchen tile: its KayKit model, a tile-sized collider, the item
 * anchor, per-player highlight, world-space progress bar, burn warning and fire.
 */
export class WorkstationView {
  readonly root: TransformNode;
  readonly itemAnchor: TransformNode;
  readonly topHeight: number;

  private readonly models: ModelInstance[] = [];
  private readonly highlight: Mesh;
  private readonly bar: TransformNode;
  private readonly barFill: Mesh;
  private readonly warningIcon: Mesh;
  private readonly keyPrompt: Mesh;
  private keyPromptLabel: string | null = null;
  private crateIcon: TransformNode | null = null;
  private readonly plateStacks: { clean: ModelInstance[]; dirty: ModelInstance[] } = { clean: [], dirty: [] };
  private readonly ownedMeshes: Mesh[] = [];
  private knife: TransformNode | null = null;
  private fire: ParticleSystem | null = null;
  private water: ParticleSystem | null = null;
  private foam: ParticleSystem | null = null;
  private highlightOwners = 0;
  private clock = 0;
  private shownClean = -1;
  private shownDirty = -1;
  private readonly sequence = workstationSequence++;

  constructor(
    private readonly scene: Scene,
    private readonly assets: AssetManager,
    private readonly resources: WorkstationResources,
    readonly placement: KitchenStationPlacement,
  ) {
    const kind = placement.kind;
    this.topHeight = TOP_HEIGHT[kind];
    this.root = new TransformNode(`workstation-${kind}-${this.sequence}`, scene);
    this.root.position.set(placement.x, 0, placement.z);
    this.root.rotation.y = placement.rotationY;

    const collider = MeshBuilder.CreateBox(
      `${this.root.name}-collider`,
      // Taller than the counter so the bottom face sits below the floor: a face exactly at
      // y = 0 lands inside the player's collision ellipsoid and degenerates the sweep.
      { width: KITCHEN_TILE * 0.98, height: 1.4, depth: KITCHEN_TILE * 0.98 },
      scene,
    );
    collider.parent = this.root;
    collider.position.y = 0.55;
    collider.isVisible = false;
    collider.isPickable = false;
    collider.checkCollisions = true;
    this.ownedMeshes.push(collider);

    this.itemAnchor = new TransformNode(`${this.root.name}-anchor`, scene);
    this.itemAnchor.parent = this.root;
    this.itemAnchor.position.y = this.topHeight;

    this.highlight = MeshBuilder.CreateBox(
      `${this.root.name}-highlight`,
      { width: KITCHEN_TILE * 1.0, height: 0.04, depth: KITCHEN_TILE * 1.0 },
      scene,
    );
    this.highlight.parent = this.root;
    this.highlight.position.y = this.topHeight + 0.015;
    this.highlight.isPickable = false;
    this.highlight.setEnabled(false);
    this.ownedMeshes.push(this.highlight);

    this.bar = new TransformNode(`${this.root.name}-bar`, scene);
    this.bar.parent = this.root;
    this.bar.position.y = 1.85;
    this.bar.billboardMode = TransformNode.BILLBOARDMODE_ALL;
    const background = MeshBuilder.CreatePlane(`${this.root.name}-bar-bg`, { width: 0.92, height: 0.16 }, scene);
    background.parent = this.bar;
    background.material = resources.barBackground;
    this.barFill = MeshBuilder.CreatePlane(`${this.root.name}-bar-fill`, { width: 0.86, height: 0.1 }, scene);
    this.barFill.parent = this.bar;
    this.barFill.position.z = -0.01;
    for (const mesh of [background, this.barFill]) {
      mesh.isPickable = false;
      mesh.renderingGroupId = 1;
      this.ownedMeshes.push(mesh);
    }
    this.bar.setEnabled(false);

    this.warningIcon = MeshBuilder.CreatePlane(`${this.root.name}-warning`, { size: 0.5 }, scene);
    this.warningIcon.parent = this.root;
    this.warningIcon.position.y = 2.25;
    this.warningIcon.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.warningIcon.material = resources.warning;
    this.warningIcon.isPickable = false;
    this.warningIcon.renderingGroupId = 1;
    this.warningIcon.setEnabled(false);
    this.ownedMeshes.push(this.warningIcon);

    this.keyPrompt = MeshBuilder.CreatePlane(`${this.root.name}-key`, { size: 0.55 }, scene);
    this.keyPrompt.parent = this.root;
    this.keyPrompt.position.y = 2.6;
    this.keyPrompt.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.keyPrompt.isPickable = false;
    this.keyPrompt.renderingGroupId = 1;
    this.keyPrompt.setEnabled(false);
    this.ownedMeshes.push(this.keyPrompt);

    this.buildBase();
  }

  get kind(): KitchenStationKind {
    return this.placement.kind;
  }

  setHighlighted(playerIndex: 0 | 1, highlighted: boolean): void {
    const bit = 1 << playerIndex;
    this.highlightOwners = highlighted ? this.highlightOwners | bit : this.highlightOwners & ~bit;
    if (highlighted) this.highlight.material = this.resources.highlight[playerIndex];
    this.highlight.setEnabled(this.highlightOwners !== 0);
  }

  /** Shows the keycap a player standing here would press, or hides it when `label` is null. */
  setKeyPrompt(label: string | null): void {
    if (label === this.keyPromptLabel) return;
    this.keyPromptLabel = label;
    if (label === null) {
      this.keyPrompt.setEnabled(false);
      return;
    }
    this.keyPrompt.material = this.resources.keyPrompt(label);
    this.keyPrompt.setEnabled(true);
  }

  update(deltaSeconds: number, state: WorkstationViewState): void {
    this.clock += deltaSeconds;
    // Nudge the keycap up so it never collides with the burn warning below it.
    if (this.keyPromptLabel !== null) {
      this.keyPrompt.position.y = 2.6 + Math.sin(this.clock * 3) * 0.05;
    }
    if (this.crateIcon) {
      this.crateIcon.position.y = CRATE_ICON_HEIGHT + Math.sin(this.clock * 1.6) * 0.08;
      this.crateIcon.rotation.y = this.clock * 0.9;
    }

    if (state.progress !== null && state.progress > 0 && state.progress < 1) {
      this.bar.setEnabled(true);
      const progress = Math.min(1, Math.max(0.001, state.progress));
      this.barFill.scaling.x = progress;
      this.barFill.position.x = -(1 - progress) * 0.43;
      this.barFill.material = this.resources.barFill[state.tone];
    } else if (this.bar.isEnabled()) {
      this.bar.setEnabled(false);
    }

    this.warningIcon.setEnabled(state.warning && !state.onFire);
    if (state.warning) {
      const pulse = 1 + Math.abs(Math.sin(this.clock * 9)) * 0.35;
      this.warningIcon.scaling.setAll(pulse);
    }

    this.updateFire(state.onFire);
    this.updateWash(state.washing ?? false);
    this.updatePlateStacks(state.cleanPlates, state.dirtyPlates);

    if (this.knife) {
      const inHand = state.knifeInHand ?? false;
      if (this.knife.isEnabled() === inHand) this.knife.setEnabled(!inHand);
      // A cook without hands to hold it: the knife chops by itself.
      const lift = state.chopping && !inHand ? Math.abs(Math.sin(this.clock * 16)) * 0.9 : 0;
      this.knife.rotation.x = Math.PI / 2 - lift;
    }
  }

  dispose(): void {
    this.fire?.dispose();
    this.fire = null;
    this.water?.dispose();
    this.water = null;
    this.foam?.dispose();
    this.foam = null;
    for (const model of this.models) model.dispose();
    for (const model of [...this.plateStacks.clean, ...this.plateStacks.dirty]) model.dispose();
    for (const mesh of this.ownedMeshes) mesh.dispose(false, false);
    this.root.dispose(false, false);
  }

  private buildBase(): void {
    const { kind, x, z } = this.placement;
    // Alternate the two counter variants by grid cell for visual variety.
    const variant = Math.abs(Math.round(x / KITCHEN_TILE) + Math.round(z / KITCHEN_TILE)) % 2 === 0
      ? "kitchencounter_straight_A"
      : "kitchencounter_straight_B";
    const counter: BaseModel = { name: variant, scale: COUNTER_SCALE };

    switch (kind) {
      case "crate": {
        const ingredientId = this.placement.ingredientId ?? "";
        const crate = CRATE_MODEL_BY_INGREDIENT[ingredientId];
        if (crate) {
          // Bespoke bulk art: normalised to the tile footprint rather than trusted.
          this.addModelById(crate, 1, 0, CRATE_BODY_SIZE);
        } else {
          this.addModel({ name: "crate", scale: [0.6, 0.98, 0.6] });
        }
        const raw = getFoodDefinition(ingredientId)?.visuals.raw;
        if (raw) {
          this.crateIcon = this.addModelById(raw.assetId, 1, CRATE_ICON_HEIGHT, CRATE_ICON_SIZE);
        }
        break;
      }
      case "cutting_board": {
        this.addModel(counter);
        this.addModel({ name: BOARD.model, scale: [...BOARD.scale], y: BOARD.position[1] });
        const knifeHolder = new TransformNode(`${this.root.name}-knife`, this.scene);
        knifeHolder.parent = this.root;
        knifeHolder.position.set(...KNIFE_SPOT.position);
        knifeHolder.rotation.x = KNIFE_SPOT.rotationX;
        this.addModel({ name: "knife", scale: [KNIFE_SPOT.scale, KNIFE_SPOT.scale, KNIFE_SPOT.scale] }, knifeHolder);
        this.knife = knifeHolder;
        break;
      }
      case "stove":
        this.addModel({ name: "stove_single", scale: [0.6, 0.75, 0.52] });
        break;
      case "sink":
        this.addModel({ name: "kitchencounter_sink", scale: COUNTER_SCALE });
        break;
      case "trash": {
        this.addModel({ name: "barrel", scale: [0.8, 0.95, 0.8], y: 0.475 });
        const hole = MeshBuilder.CreateDisc(`${this.root.name}-hole`, { radius: 0.3, tessellation: 20 }, this.scene);
        hole.parent = this.root;
        hole.rotation.x = Math.PI / 2;
        hole.position.y = 0.955;
        hole.material = this.resources.trashHole;
        hole.isPickable = false;
        this.ownedMeshes.push(hole);
        break;
      }
      case "delivery": {
        this.addModel({ name: "kitchencounter_straight_B", scale: COUNTER_SCALE });
        const strip = MeshBuilder.CreateBox(
          `${this.root.name}-strip`,
          { width: KITCHEN_TILE * 0.9, height: 0.02, depth: KITCHEN_TILE * 0.5 },
          this.scene,
        );
        strip.parent = this.root;
        strip.position.y = COUNTER_HEIGHT + 0.012;
        strip.material = this.resources.deliveryGlow;
        strip.isPickable = false;
        this.ownedMeshes.push(strip);
        break;
      }
      default:
        this.addModel(counter);
        break;
    }
  }

  /**
   * Instantiates a model by raw asset id, for things `KitchenModelName` does not cover —
   * a crate's floating ingredient comes from FOOD_DEFINITIONS as an already-resolved id.
   *
   * Synchronous only: every food model is preloaded as a required kitchen asset, and the
   * caller needs the holder immediately so it can animate it.
   */
  private addModelById(
    assetId: string,
    scale: number,
    y: number,
    fitToSize?: number,
  ): TransformNode | null {
    const holder = new TransformNode(`${this.root.name}-icon`, this.scene);
    holder.parent = this.root;
    holder.position.y = y;
    holder.scaling.setAll(scale);
    const instance = this.assets.instantiateLoaded(assetId, {
      namePrefix: `${this.root.name}-`,
      parent: holder,
    });
    if (!instance) {
      console.warn(`Model was not preloaded: ${assetId}`);
      holder.dispose(false, false);
      return null;
    }
    // Authored scale varies wildly across the hand-made art; measure and normalise.
    if (fitToSize !== undefined) fitHolderToSize(holder, instance.rootNodes, fitToSize);
    this.models.push(this.track(instance, holder));
    return holder;
  }

  private addModel(model: BaseModel, parent: TransformNode = this.root): void {
    const holder = new TransformNode(`${this.root.name}-${model.name}`, this.scene);
    holder.parent = parent;
    holder.position.y = model.y ?? 0;
    holder.scaling.set(model.scale[0], model.scale[1], model.scale[2]);
    const instance = this.assets.instantiateLoaded(kitchenAssetId(model.name), {
      namePrefix: `${this.root.name}-`,
      parent: holder,
    });
    if (!instance) {
      // Assets are preloaded before a shift; fall back to async if not.
      void this.assets.instantiateModel(kitchenAssetId(model.name), {
        namePrefix: `${this.root.name}-`,
        parent: holder,
      }).then((late) => {
        if (late) this.models.push(this.track(late, holder));
      });
      return;
    }
    this.models.push(this.track(instance, holder));
  }

  private track(instance: ModelInstance, holder: TransformNode): ModelInstance {
    for (const rootNode of instance.rootNodes) {
      for (const node of [rootNode, ...rootNode.getDescendants()]) {
        if (node instanceof AbstractMesh) node.isPickable = false;
      }
    }
    return {
      ...instance,
      dispose: () => {
        instance.dispose();
        holder.dispose(false, false);
      },
    };
  }

  private updatePlateStacks(clean: number, dirty: number): void {
    if (clean !== this.shownClean) {
      this.shownClean = clean;
      this.rebuildStack(this.plateStacks.clean, clean, "plate", this.kind === "sink" ? 0.36 : 0);
    }
    if (dirty !== this.shownDirty) {
      this.shownDirty = dirty;
      this.rebuildStack(this.plateStacks.dirty, dirty, "plate_dirty", this.kind === "sink" ? -0.3 : 0);
    }
  }

  private rebuildStack(stack: ModelInstance[], count: number, model: KitchenModelName, offsetX: number): void {
    for (const entry of stack) entry.dispose();
    stack.length = 0;
    const visible = Math.min(MAX_STACKED_PLATES, count);
    for (let index = 0; index < visible; index += 1) {
      const holder = new TransformNode(`${this.root.name}-stack`, this.scene);
      holder.parent = this.root;
      holder.position.set(offsetX, this.topHeight + index * PLATE_STEP, 0);
      holder.scaling.setAll(STACKED_PLATE_SCALE);
      const instance = this.assets.instantiateLoaded(kitchenAssetId(model), {
        namePrefix: `${this.root.name}-stack-`,
        parent: holder,
      });
      if (!instance) {
        holder.dispose(false, false);
        // Retry once the plate model finishes loading.
        this.shownClean = -1;
        this.shownDirty = -1;
        return;
      }
      stack.push(this.track(instance, holder));
    }
  }

  private updateFire(onFire: boolean): void {
    if (onFire && !this.fire) {
      const fire = new ParticleSystem(`${this.root.name}-fire`, 120, this.scene);
      fire.particleTexture = this.resources.fireTexture;
      fire.emitter = new Vector3(this.placement.x, this.topHeight + 0.05, this.placement.z);
      fire.minEmitBox = new Vector3(-0.35, 0, -0.35);
      fire.maxEmitBox = new Vector3(0.35, 0.05, 0.35);
      fire.color1 = new Color4(1, 0.72, 0.18, 1);
      fire.color2 = new Color4(1, 0.28, 0.05, 1);
      fire.colorDead = new Color4(0.25, 0.08, 0.02, 0);
      fire.minSize = 0.25;
      fire.maxSize = 0.6;
      fire.minLifeTime = 0.35;
      fire.maxLifeTime = 0.8;
      fire.emitRate = 90;
      fire.blendMode = ParticleSystem.BLENDMODE_ADD;
      fire.direction1 = new Vector3(-0.2, 1.6, -0.2);
      fire.direction2 = new Vector3(0.2, 2.4, 0.2);
      fire.minEmitPower = 0.6;
      fire.maxEmitPower = 1.2;
      fire.gravity = new Vector3(0, 0.6, 0);
      this.fire = trackParticleSystem(fire);
    }
    if (!this.fire) return;
    if (onFire && !this.fire.isStarted()) this.fire.start();
    if (!onFire && this.fire.isStarted()) this.fire.stop();
  }

  /** Splashing water and soap bubbles out of the basin while a plate is scrubbed. */
  private updateWash(washing: boolean): void {
    if (washing && !this.water) {
      const basin = new Vector3(this.placement.x, this.topHeight - 0.02, this.placement.z);
      const water = new ParticleSystem(`${this.root.name}-water`, 90, this.scene);
      water.particleTexture = this.resources.fireTexture;
      water.emitter = basin.clone();
      water.minEmitBox = new Vector3(-0.16, 0, -0.12);
      water.maxEmitBox = new Vector3(0.16, 0.02, 0.12);
      water.color1 = new Color4(0.55, 0.85, 1, 0.9);
      water.color2 = new Color4(0.25, 0.6, 1, 0.8);
      water.colorDead = new Color4(0.6, 0.85, 1, 0);
      water.minSize = 0.03;
      water.maxSize = 0.07;
      water.minLifeTime = 0.25;
      water.maxLifeTime = 0.5;
      water.emitRate = 70;
      water.direction1 = new Vector3(-0.6, 1.6, -0.6);
      water.direction2 = new Vector3(0.6, 2.4, 0.6);
      water.minEmitPower = 0.5;
      water.maxEmitPower = 0.9;
      water.gravity = new Vector3(0, -9, 0);
      this.water = trackParticleSystem(water);

      const foam = new ParticleSystem(`${this.root.name}-foam`, 60, this.scene);
      foam.particleTexture = this.resources.fireTexture;
      foam.emitter = basin.clone();
      foam.minEmitBox = new Vector3(-0.2, 0, -0.14);
      foam.maxEmitBox = new Vector3(0.2, 0.04, 0.14);
      foam.color1 = new Color4(1, 1, 1, 0.95);
      foam.color2 = new Color4(0.85, 0.95, 1, 0.85);
      foam.colorDead = new Color4(1, 1, 1, 0);
      foam.minSize = 0.04;
      foam.maxSize = 0.11;
      foam.minLifeTime = 0.6;
      foam.maxLifeTime = 1.3;
      foam.emitRate = 26;
      foam.direction1 = new Vector3(-0.08, 0.25, -0.08);
      foam.direction2 = new Vector3(0.08, 0.45, 0.08);
      foam.minEmitPower = 0.2;
      foam.maxEmitPower = 0.4;
      foam.gravity = new Vector3(0, 0.05, 0);
      this.foam = trackParticleSystem(foam);
    }
    for (const system of [this.water, this.foam]) {
      if (!system) continue;
      if (washing && !system.isStarted()) system.start();
      if (!washing && system.isStarted()) system.stop();
    }
  }
}
