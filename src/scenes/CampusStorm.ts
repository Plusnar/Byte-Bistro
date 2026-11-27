import { DynamicTexture, ParticleSystem, Vector3, type Scene } from "@babylonjs/core";
import { trackParticleSystem } from "../core/perf/effectBudget";
import type { MovementBounds } from "../entities/Player";
import type { SkyPalette } from "./OutdoorBackdrop";
import { CampusBlackout } from "./CampusBlackout";

export const STORM_SKY: SkyPalette = {
  zenith: "#38495B",
  horizon: "#8797A9",
  belowHorizon: "#788782",
};

const FIRST_OUTAGE = 17;
const OUTAGE_PERIOD = 27;
const OUTAGE_DURATION = 10;
const DARKEN_DURATION = 3;
const RAIN_SPEED = 0.01;

export const campusDarkness = (elapsed: number): number => {
  const sinceFirstFade = elapsed - (FIRST_OUTAGE - DARKEN_DURATION);
  if (sinceFirstFade < 0) return 0;
  const phase = sinceFirstFade % OUTAGE_PERIOD;
  if (phase >= DARKEN_DURATION + OUTAGE_DURATION) return 0;
  if (phase >= DARKEN_DURATION) return 1;
  const progress = phase / DARKEN_DURATION;
  return progress * progress * (3 - 2 * progress);
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

/** Owned by KitchenEnvironment. Keeps the outage independent of HUD and station alerts. */
export class CampusStorm {
  private readonly rain: ParticleSystem | null;
  readonly blackout: CampusBlackout | null;
  private inOutage = false;

  constructor(scene: Scene, shelter: Readonly<MovementBounds>) {
    this.blackout = CampusBlackout.create(scene);
    this.rain = typeof document === "undefined" ? null : this.createRain(scene, shelter);
  }

  reset(): void {
    this.stop();
    this.setPaused(false);
    this.rain?.start();
  }

  stop(): void {
    this.inOutage = false;
    this.blackout?.setDarkness(0);
    this.rain?.stop();
    this.rain?.reset();
  }

  setPaused(paused: boolean): void {
    if (this.rain) this.rain.updateSpeed = paused ? 0 : RAIN_SPEED;
  }

  update(elapsed: number): boolean {
    const darkness = campusDarkness(elapsed);
    this.blackout?.setDarkness(darkness);
    const outage = darkness === 1;
    const began = outage && !this.inOutage;
    this.inOutage = outage;
    return began;
  }

  dispose(): void {
    this.blackout?.dispose();
    this.rain?.dispose();
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
