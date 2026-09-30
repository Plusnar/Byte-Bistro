import {
  Color3,
  DynamicTexture,
  Mesh,
  MeshBuilder,
  Observer,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3,
  type Node,
} from "@babylonjs/core";
import type { StationId } from "../types/game";

export type StationVisualState =
  | "idle"
  | "available"
  | "processing"
  | "ready"
  | "warning"
  | "error"
  | "disabled";

export interface StationVisualOptions {
  id: StationId;
  label: string;
  color: string;
  position?: Vector3;
  rotationY?: number;
  parent?: Node | null;
  width?: number;
  depth?: number;
  height?: number;
  interactionOffset?: Vector3;
  /** Hides the generic cabinet when a Scenario model provides the station body. */
  showBody?: boolean;
}

let stationVisualSequence = 0;

/** Shared low-poly workstation with readable world label and state feedback. */
export class StationVisual {
  readonly root: TransformNode;
  readonly interactionPoint: TransformNode;
  readonly id: StationId;

  private readonly body: Mesh;
  private readonly indicator: Mesh;
  private readonly feedbackRing: Mesh;
  private readonly rotor: Mesh;
  private readonly progressFill: Mesh;
  private readonly labelTexture: DynamicTexture;
  private readonly bodyMaterial: StandardMaterial;
  private readonly trimMaterial: StandardMaterial;
  private readonly displayMaterial: StandardMaterial;
  private readonly progressMaterial: StandardMaterial;
  private readonly feedbackMaterial: StandardMaterial;
  private readonly highlightRing: Mesh;
  private readonly highlightMaterial: StandardMaterial;
  private highlightOwners = 0;
  private readonly animationObserver: Observer<Scene>;
  private readonly baseColor: Color3;
  private stateValue: StationVisualState = "idle";
  private progressValue = 0;
  private lastRenderedPercent = -1;
  private pulseRemaining = 0;
  private pulseDuration = 0.65;
  private animationClock = 0;

  constructor(private readonly scene: Scene, private readonly options: StationVisualOptions) {
    const sequence = stationVisualSequence++;
    const width = options.width ?? 1.85;
    const depth = options.depth ?? 1.25;
    const height = options.height ?? 1.05;
    this.id = options.id;
    this.baseColor = Color3.FromHexString(options.color);

    this.root = new TransformNode(`station-${options.id}-${sequence}`, scene);
    this.root.parent = options.parent ?? null;
    this.root.position.copyFrom(options.position ?? Vector3.Zero());
    this.root.rotation.y = options.rotationY ?? 0;

    this.bodyMaterial = this.material(
      `station-body-material-${sequence}`,
      Color3.FromHexString("#172738"),
      Color3.FromHexString("#02070C"),
    );
    this.trimMaterial = this.material(
      `station-trim-material-${sequence}`,
      this.baseColor.scale(0.35),
      this.baseColor.scale(0.45),
    );
    this.progressMaterial = this.material(
      `station-progress-material-${sequence}`,
      this.baseColor.scale(0.5),
      this.baseColor.scale(0.8),
    );
    this.feedbackMaterial = this.material(
      `station-feedback-material-${sequence}`,
      this.baseColor.scale(0.3),
      this.baseColor.scale(0.7),
    );
    this.feedbackMaterial.alpha = 0;

    this.body = MeshBuilder.CreateBox(
      `station-body-${sequence}`,
      { width, height, depth },
      scene,
    );
    this.body.parent = this.root;
    this.body.position.y = height * 0.5;
    this.body.material = this.bodyMaterial;
    this.body.checkCollisions = true;
    this.body.isPickable = false;
    this.body.visibility = options.showBody === false ? 0 : 1;

    const top = MeshBuilder.CreateBox(
      `station-top-${sequence}`,
      { width: width * 0.94, height: 0.14, depth: depth * 0.96 },
      scene,
    );
    top.parent = this.root;
    top.position.y = height + 0.06;
    top.material = this.trimMaterial;
    top.isPickable = false;
    top.visibility = options.showBody === false ? 0 : 1;

    this.rotor = MeshBuilder.CreateTorus(
      `station-activity-${sequence}`,
      { diameter: Math.min(width, depth) * 0.46, thickness: 0.075, tessellation: 16 },
      scene,
    );
    this.rotor.parent = this.root;
    this.rotor.position.set(0, height + 0.16, 0);
    this.rotor.material = this.trimMaterial;
    this.rotor.isPickable = false;
    this.rotor.visibility = options.showBody === false ? 0 : 1;

    const panel = MeshBuilder.CreatePlane(
      `station-label-${sequence}`,
      {
        width: width * 0.84,
        height: 0.55,
        sideOrientation: Mesh.DOUBLESIDE,
      },
      scene,
    );
    panel.parent = this.root;
    panel.position.set(0, height * 0.72, -depth * 0.505);
    this.labelTexture = new DynamicTexture(
      `station-label-texture-${sequence}`,
      { width: 512, height: 256 },
      scene,
      false,
    );
    this.displayMaterial = this.material(
      `station-display-material-${sequence}`,
      Color3.Black(),
      this.baseColor.scale(0.4),
    );
    this.displayMaterial.diffuseTexture = this.labelTexture;
    this.displayMaterial.emissiveTexture = this.labelTexture;
    this.displayMaterial.disableLighting = true;
    panel.material = this.displayMaterial;
    panel.isPickable = false;

    const progressTrack = MeshBuilder.CreateBox(
      `station-progress-track-${sequence}`,
      { width: width * 0.74, height: 0.07, depth: 0.035 },
      scene,
    );
    progressTrack.parent = this.root;
    progressTrack.position.set(0, height * 0.4, -depth * 0.525);
    progressTrack.material = this.bodyMaterial;
    progressTrack.isPickable = false;

    this.progressFill = MeshBuilder.CreateBox(
      `station-progress-fill-${sequence}`,
      { width: width * 0.7, height: 0.045, depth: 0.046 },
      scene,
    );
    this.progressFill.parent = this.root;
    this.progressFill.position.set(-width * 0.35, height * 0.4, -depth * 0.55);
    this.progressFill.scaling.x = 0.001;
    this.progressFill.material = this.progressMaterial;
    this.progressFill.isPickable = false;

    this.indicator = MeshBuilder.CreateSphere(
      `station-indicator-${sequence}`,
      { diameter: 0.17, segments: 8 },
      scene,
    );
    this.indicator.parent = this.root;
    this.indicator.position.set(width * 0.37, height + 0.2, -depth * 0.2);
    this.indicator.material = this.feedbackMaterial;
    this.indicator.isPickable = false;

    this.feedbackRing = MeshBuilder.CreateTorus(
      `station-feedback-ring-${sequence}`,
      { diameter: Math.max(width, depth) * 1.08, thickness: 0.045, tessellation: 20 },
      scene,
    );
    this.feedbackRing.parent = this.root;
    this.feedbackRing.position.y = 0.04;
    this.feedbackRing.material = this.feedbackMaterial;
    this.feedbackRing.visibility = 0;
    this.feedbackRing.isPickable = false;

    this.highlightMaterial = this.material(
      `station-highlight-material-${sequence}`,
      Color3.Black(),
      this.baseColor.clone(),
    );
    this.highlightMaterial.disableLighting = true;
    this.highlightMaterial.alpha = 0.9;
    this.highlightRing = MeshBuilder.CreateTorus(
      `station-highlight-ring-${sequence}`,
      { diameter: Math.max(width, depth) * 1.16, thickness: 0.06, tessellation: 24 },
      scene,
    );
    this.highlightRing.parent = this.root;
    this.highlightRing.position.y = 0.05;
    this.highlightRing.material = this.highlightMaterial;
    this.highlightRing.isPickable = false;
    this.highlightRing.setEnabled(false);

    this.interactionPoint = new TransformNode(`station-interaction-${sequence}`, scene);
    this.interactionPoint.parent = this.root;
    this.interactionPoint.position.copyFrom(
      options.interactionOffset ?? new Vector3(0, 0.6, -depth * 0.5 - 0.75),
    );

    this.animationObserver = scene.onBeforeRenderObservable.add(() => this.animate());
    this.setState("idle");
    this.drawLabel(true);
  }

  get state(): StationVisualState {
    return this.stateValue;
  }

  get progress(): number {
    return this.progressValue;
  }

  setState(state: StationVisualState): void {
    this.stateValue = state;
    const color = this.getStateColor(state);
    this.trimMaterial.emissiveColor.copyFrom(color.scale(0.6));
    this.progressMaterial.diffuseColor.copyFrom(color.scale(0.55));
    this.progressMaterial.emissiveColor.copyFrom(color.scale(0.9));
    this.feedbackMaterial.diffuseColor.copyFrom(color.scale(0.45));
    this.feedbackMaterial.emissiveColor.copyFrom(color);
    this.feedbackMaterial.alpha = state === "disabled" ? 0.15 : 0.8;
    this.indicator.visibility = state === "disabled" ? 0.25 : 1;
    this.drawLabel(true);

    if (state === "ready" || state === "error") {
      this.pulse(color);
    }
  }

  setProgress(progress: number): void {
    this.progressValue = Math.min(1, Math.max(0, progress));
    const width = this.options.width ?? 1.85;
    this.progressFill.scaling.x = Math.max(0.001, this.progressValue);
    this.progressFill.position.x = (this.progressValue - 1) * width * 0.35;
    this.drawLabel(false);
  }

  /**
   * Per-player floor ring. The body is invisible when a Scenario model supplies the
   * station, and Babylon skips outlines on meshes with visibility 0.
   */
  setHighlighted(highlighted: boolean, playerIndex = 0, color?: Color3): void {
    const bit = 1 << playerIndex;
    this.highlightOwners = highlighted
      ? this.highlightOwners | bit
      : this.highlightOwners & ~bit;
    if (highlighted && color) {
      this.highlightMaterial.emissiveColor.copyFrom(color);
    }
    this.highlightRing.setEnabled(this.highlightOwners !== 0);
    if (this.options.showBody !== false) {
      this.body.renderOutline = this.highlightOwners !== 0;
      this.body.outlineColor.copyFrom(this.highlightMaterial.emissiveColor);
      this.body.outlineWidth = 0.06;
    }
  }

  pulse(color: Color3 = this.getStateColor(this.stateValue), duration = 0.65): void {
    this.feedbackMaterial.emissiveColor.copyFrom(color);
    this.pulseDuration = Math.max(0.1, duration);
    this.pulseRemaining = this.pulseDuration;
    this.feedbackRing.visibility = 1;
  }

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.animationObserver);
    this.labelTexture.dispose();
    this.bodyMaterial.dispose();
    this.trimMaterial.dispose();
    this.displayMaterial.dispose();
    this.progressMaterial.dispose();
    this.feedbackMaterial.dispose();
    this.highlightMaterial.dispose();
    this.root.dispose(false, false);
  }

  private animate(): void {
    const delta = Math.min(this.scene.getEngine().getDeltaTime() / 1000, 0.05);
    this.animationClock += delta;

    if (this.stateValue === "processing") {
      this.rotor.rotation.y += delta * 4.5;
      const glow = 0.88 + Math.sin(this.animationClock * 7) * 0.12;
      this.indicator.scaling.setAll(glow);
    } else if (this.stateValue === "ready") {
      this.indicator.scaling.setAll(1 + Math.sin(this.animationClock * 5) * 0.16);
    } else {
      this.indicator.scaling.setAll(1);
    }

    if (this.pulseRemaining <= 0) {
      this.feedbackRing.visibility = 0;
      return;
    }

    this.pulseRemaining = Math.max(0, this.pulseRemaining - delta);
    const progress = 1 - this.pulseRemaining / this.pulseDuration;
    this.feedbackRing.scaling.setAll(0.7 + progress * 0.65);
    this.feedbackRing.visibility = 1 - progress;
  }

  private drawLabel(force: boolean): void {
    const percent = Math.round(this.progressValue * 100);
    if (!force && percent === this.lastRenderedPercent) {
      return;
    }
    this.lastRenderedPercent = percent;

    const context = this.labelTexture.getContext();
    context.fillStyle = "#06111B";
    context.fillRect(0, 0, 512, 256);
    context.strokeStyle = this.options.color;
    context.lineWidth = 8;
    context.strokeRect(8, 8, 496, 240);
    context.fillStyle = "#E9FBFF";
    context.font = "bold 42px monospace";
    const title = this.options.label.toUpperCase();
    const titleWidth = context.measureText(title).width;
    context.fillText(title, (512 - titleWidth) * 0.5, 100);
    context.fillStyle = this.options.color;
    context.font = "bold 34px monospace";
    const status = this.stateValue === "processing"
      ? `${this.stateValue.toUpperCase()} ${percent}%`
      : this.stateValue.toUpperCase();
    const statusWidth = context.measureText(status).width;
    context.fillText(status, (512 - statusWidth) * 0.5, 188);
    this.labelTexture.update();
  }

  private getStateColor(state: StationVisualState): Color3 {
    switch (state) {
      case "ready":
        return Color3.FromHexString("#5CFF9D");
      case "warning":
        return Color3.FromHexString("#FFD166");
      case "error":
        return Color3.FromHexString("#FF5370");
      case "processing":
        return Color3.FromHexString("#41E7FF");
      case "disabled":
        return Color3.FromHexString("#536170");
      case "available":
        return this.baseColor.scale(1.15);
      case "idle":
        return this.baseColor.scale(0.65);
    }
  }

  private material(name: string, diffuse: Color3, emissive: Color3): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = diffuse;
    material.emissiveColor = emissive;
    material.specularColor.set(0.12, 0.17, 0.24);
    return material;
  }
}
