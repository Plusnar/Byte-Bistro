import { Color3, PointLight, Vector3, type Scene } from "@babylonjs/core";
import type { LoopHandle, SynthSfx } from "../core/SynthSfx";
import type { DisasterOverlay } from "../ui/DisasterOverlay";

/** How strong the chaos is with `burning` stations alight: 0 calm, 1 inferno. */
export const chaosLevel = (burning: number): number =>
  burning <= 0 ? 0 : Math.min(1, 0.45 + 0.18 * (burning - 1));

/** What the kitchen does with the chaos this frame. */
export interface ChaosEffects {
  /** Metres the camera trembles by. */
  readonly shake: number;
  /** How much to add to the glow layer's intensity. */
  readonly glow: number;
}

const CALM: ChaosEffects = { shake: 0, glow: 0 };

/**
 * The kitchen on fire: a red alarm light sweeping the room, a siren, a pulsing red
 * vignette with the alarm chip on the HUD, the glow turned up and the camera
 * trembling. It grows with the number of stations burning and dies down when the
 * last fire is out.
 */
export class ChaosMode {
  private level = 0;
  private clock = 0;
  private light: PointLight | null = null;
  private siren: LoopHandle | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly overlay: DisasterOverlay,
    private readonly sfx: SynthSfx,
    private readonly centre: Vector3,
  ) {}

  get active(): boolean {
    return this.level > 0.01;
  }

  update(dt: number, burning: number): ChaosEffects {
    const target = chaosLevel(burning);
    // Rises fast, as the alarm goes off; fades more slowly once the fire is out.
    const rate = target > this.level ? 4 : 1.2;
    this.level += (target - this.level) * Math.min(1, dt * rate);
    if (target === 0 && this.level < 0.01) this.level = 0;
    this.clock += dt;

    if (this.level <= 0) {
      if (this.light || this.siren) this.calm();
      return CALM;
    }
    if (!this.light) {
      this.light = new PointLight("chaos-alarm", this.centre.clone(), this.scene);
      this.light.diffuse = Color3.FromHexString("#FF2A2A");
      this.light.specular = Color3.FromHexString("#FF5A3A");
      this.light.range = 40;
    }
    if (!this.siren) this.siren = this.sfx.loop("siren", 0);
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 7);
    this.light.intensity = this.level * (0.5 + 1.3 * pulse);
    // The beacon sweeps round, as a rotating alarm lamp would.
    this.light.position.set(
      this.centre.x + Math.cos(this.clock * 2.4) * 4,
      this.centre.y,
      this.centre.z + Math.sin(this.clock * 2.4) * 3,
    );
    this.siren.setLevel(this.level);
    this.overlay.setChaos(this.level);
    return { shake: 0.035 * this.level, glow: 0.45 * this.level * (0.6 + 0.4 * pulse) };
  }

  /** Back to calm at once, as a new shift starts. */
  reset(): void {
    this.level = 0;
    this.calm();
  }

  dispose(): void {
    this.reset();
  }

  private calm(): void {
    this.light?.dispose();
    this.light = null;
    this.siren?.stop(0.8);
    this.siren = null;
    this.overlay.setChaos(0);
  }
}
