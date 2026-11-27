import { Matrix, Vector3, Viewport, type Camera, type Observer, type Scene, type TransformNode } from "@babylonjs/core";

const LIGHT_RADIUS = 1.45;
const LIGHT_HEIGHT = 0.68;
const MAX_MASK_EDGE = 960;

/** Masks the rendered world under the HUD, including unlit and emissive scenery. */
export class CampusBlackout {
  private readonly viewport = new Viewport(0, 0, 1, 1);
  private readonly transform = Matrix.Identity();
  private readonly world = Vector3.Zero();
  private readonly center = Vector3.Zero();
  private readonly edge = Vector3.Zero();
  private observer: Observer<Scene> | null = null;
  private players: readonly TransformNode[] = [];

  static create(scene: Scene): CampusBlackout | null {
    const surface = scene.getEngine().getRenderingCanvas();
    if (!surface) return null;
    const document = surface.ownerDocument;
    const canvas = document.createElement("canvas");
    const light = document.createElement("canvas");
    const context = canvas.getContext("2d");
    const stamp = light.getContext("2d");
    if (!context || !stamp) return null;
    light.width = light.height = 128;
    const gradient = stamp.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, "#fff");
    gradient.addColorStop(0.68, "#fff");
    gradient.addColorStop(1, "#fff0");
    stamp.fillStyle = gradient;
    stamp.fillRect(0, 0, 128, 128);

    canvas.className = "campus-blackout";
    canvas.setAttribute("aria-hidden", "true");
    canvas.hidden = true;
    surface.after(canvas);
    return new CampusBlackout(scene, surface, canvas, context, light);
  }

  private constructor(
    private readonly scene: Scene,
    private readonly surface: HTMLCanvasElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D,
    private readonly light: HTMLCanvasElement,
  ) {}

  setPlayers(players: readonly TransformNode[]): void {
    this.players = players;
  }

  setEnabled(enabled: boolean): void {
    if (enabled && !this.observer) {
      this.observer = this.scene.onAfterRenderObservable.add(this.draw);
    } else if (!enabled && this.observer) {
      this.scene.onAfterRenderObservable.remove(this.observer);
      this.observer = null;
      this.canvas.hidden = true;
    }
  }

  dispose(): void {
    this.setEnabled(false);
    this.canvas.remove();
  }

  private readonly draw = (): void => {
    const { clientWidth, clientHeight } = this.surface;
    if (clientWidth === 0 || clientHeight === 0) return;
    const scale = Math.min(1, MAX_MASK_EDGE / Math.max(clientWidth, clientHeight));
    const width = Math.max(1, Math.round(clientWidth * scale));
    const height = Math.max(1, Math.round(clientHeight * scale));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const context = this.context;
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "#000";
    context.fillRect(0, 0, width, height);
    context.globalCompositeOperation = "destination-out";
    const cameras = this.scene.activeCameras;
    if (cameras?.length) {
      for (const camera of cameras) this.drawLights(camera, width, height);
    } else if (this.scene.activeCamera) {
      this.drawLights(this.scene.activeCamera, width, height);
    }
    this.canvas.hidden = false;
  };

  private drawLights(camera: Camera, width: number, height: number): void {
    const context = this.context;
    const viewport = this.viewport;
    camera.viewport.toGlobalToRef(width, height, viewport);
    viewport.y = height - viewport.y - viewport.height;
    const view = camera.getViewMatrix();
    view.multiplyToRef(camera.getProjectionMatrix(), this.transform);
    const right = view.m;
    context.save();
    context.beginPath();
    context.rect(viewport.x, viewport.y, viewport.width, viewport.height);
    context.clip();
    for (const player of this.players) {
      this.world.copyFrom(player.getAbsolutePosition());
      this.world.y += LIGHT_HEIGHT;
      Vector3.ProjectToRef(this.world, Matrix.IdentityReadOnly, this.transform, viewport, this.center);
      if (this.center.z < 0 || this.center.z > 1) continue;
      this.world.addInPlaceFromFloats(right[0]! * LIGHT_RADIUS, right[4]! * LIGHT_RADIUS, right[8]! * LIGHT_RADIUS);
      Vector3.ProjectToRef(this.world, Matrix.IdentityReadOnly, this.transform, viewport, this.edge);
      const radius = Math.abs(this.edge.x - this.center.x);
      if (Number.isFinite(radius) && radius > 0) {
        context.drawImage(this.light, this.center.x - radius, this.center.y - radius, 2 * radius, 2 * radius);
      }
    }
    context.restore();
  }
}
