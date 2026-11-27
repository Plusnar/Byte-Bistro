import { DynamicTexture, ParticleSystem, Vector3, type Light, type Scene } from "@babylonjs/core";
import { trackParticleSystem } from "../core/perf/effectBudget";
import type { MovementBounds } from "../entities/Player";
import type { SkyPalette } from "./OutdoorBackdrop";
import { clamp } from "../utils/math";

export const STORM_SKY: SkyPalette = {
  zenith: "#38495B",
  horizon: "#8797A9",
  belowHorizon: "#788782",
};

const FIRST_OUTAGE = 16;
const OUTAGE_PERIOD = 27;
const RAIN_SPEED = 0.01;

/** Simulated seconds in the current power dip. The initial grace period has no dip. */
export const outagePhase = (elapsed: number): number =>
  elapsed < FIRST_OUTAGE ? Infinity : (elapsed - FIRST_OUTAGE) % OUTAGE_PERIOD;

export const campusPower = (phase: number, reducedMotion: boolean): number => {
  const fadeIn = clamp((phase - 1) / 0.9, 0, 1);
  const fadeOut = clamp((5.6 - phase) / 1.2, 0, 1);
  const warning = reducedMotion ? 0 : Math.max(0, 1 - Math.abs(phase - 0.45) / 0.45) * 0.10;
  return 1 - 0.25 * Math.min(fadeIn, fadeOut) - warning;
};

/** Non-overlapping outdoor strips. Rain falls vertically so it cannot drift under cover. */
export const rainZones = (shelter: Readonly<MovementBounds>): readonly MovementBounds[] => {
  const minX = shelter.minX - 10;
  const maxX = shelter.maxX + 10;
  const minZ = shelter.minZ - 24;
  const maxZ = shelter.maxZ + 10;
  return [
    { minX, maxX: shelter.minX, minZ, maxZ },
    { minX: shelter.maxX, maxX, minZ, maxZ },
    { minX: shelter.minX, maxX: shelter.maxX, minZ, maxZ: shelter.minZ },
    { minX: shelter.minX, maxX: shelter.maxX, minZ: shelter.maxZ, maxZ },
  ];
};

/** Owned by KitchenEnvironment. Only the level lights dim, keeping HUD and station alerts legible. */
export class CampusStorm {
  private readonly rain: ParticleSystem | null;
  private readonly baseIntensity: readonly number[];
  private power = 1;
  private inOutage = false;

  constructor(scene: Scene, shelter: Readonly<MovementBounds>, private readonly lights: readonly Light[]) {
    this.baseIntensity = lights.map(light => light.intensity);
    this.rain = typeof document === "undefined" ? null : this.createRain(scene, shelter);
  }

  reset(): void {
    this.stop();
    this.setPaused(false);
    this.rain?.start();
  }

  stop(): void {
    this.inOutage = false;
    this.setPower(1);
    this.rain?.stop();
    this.rain?.reset();
  }

  setPaused(paused: boolean): void {
    if (this.rain) this.rain.updateSpeed = paused ? 0 : RAIN_SPEED;
  }

  update(elapsed: number, reducedMotion: boolean): boolean {
    const phase = outagePhase(elapsed);
    this.setPower(campusPower(phase, reducedMotion));
    const outage = phase >= 1 && phase < 5.6;
    const began = outage && !this.inOutage;
    this.inOutage = outage;
    return began;
  }

  dispose(): void {
    this.rain?.dispose();
  }

  private setPower(factor: number): void {
    if (factor === this.power) return;
    this.power = factor;
    for (let index = 0; index < this.lights.length; index += 1) {
      this.lights[index]!.intensity = this.baseIntensity[index]! * factor;
    }
  }

  private createRain(scene: Scene, shelter: Readonly<MovementBounds>): ParticleSystem {
    const texture = new DynamicTexture("univille-raindrop", { width: 16, height: 64 }, scene, false);
    texture.hasAlpha = true;
    const canvas = texture.getContext();
    const gradient = canvas.createLinearGradient(0, 0, 0, 64);
    gradient.addColorStop(0, "rgba(235,246,255,0)");
    gradient.addColorStop(0.72, "rgba(226,244,255,0.84)");
    gradient.addColorStop(1, "rgba(235,246,255,0)");
    canvas.strokeStyle = gradient;
    canvas.lineWidth = 2.8;
    canvas.beginPath();
    canvas.moveTo(5, 0);
    canvas.lineTo(10, 64);
    canvas.stroke();
    texture.update();

    let area = 0;
    const zones = rainZones(shelter).map(zone => ({
      ...zone, through: area += (zone.maxX - zone.minX) * (zone.maxZ - zone.minZ),
    }));
    const rain = new ParticleSystem("univille-outdoor-rain", 920, scene);
    rain.particleTexture = texture;
    rain.emitter = Vector3.Zero();
    rain.startPositionFunction = (_world, position) => {
      const roll = Math.random() * area;
      const zone = zones.find(candidate => roll < candidate.through) ?? zones[0]!;
      position.set(
        zone.minX + Math.random() * (zone.maxX - zone.minX),
        8 + Math.random() * 2,
        zone.minZ + Math.random() * (zone.maxZ - zone.minZ),
      );
    };
    rain.direction1.set(0, -14, 0);
    rain.direction2.copyFrom(rain.direction1);
    rain.minEmitPower = 1;
    rain.maxEmitPower = 1;
    rain.minLifeTime = 0.53;
    rain.maxLifeTime = 0.7;
    rain.minSize = 0.82;
    rain.maxSize = 1.25;
    rain.minScaleX = 0.42;
    rain.maxScaleX = 0.55;
    rain.color1.set(0.68, 0.8, 1, 0.7);
    rain.color2.set(0.84, 0.94, 1, 0.86);
    rain.colorDead.set(0.62, 0.73, 0.92, 0);
    rain.emitRate = 1100;
    rain.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    return trackParticleSystem(rain);
  }
}
