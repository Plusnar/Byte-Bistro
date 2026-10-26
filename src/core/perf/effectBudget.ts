import { PBRMaterial, type AbstractMesh, type ParticleSystem } from "@babylonjs/core";
import { qualityManager, type QualityManager } from "./QualityManager";

/**
 * How effects follow the graphics profile. Every particle system the game makes goes
 * through `trackParticleSystem` once it is configured (the perf rules check enforces it):
 * its authored emit rate becomes the `high` rate, and lower profiles thin it — never to
 * zero, because some effects (a stove on fire) carry gameplay information.
 */
export const trackParticleSystem = (
  system: ParticleSystem,
  quality: QualityManager = qualityManager,
): ParticleSystem => {
  const authoredRate = system.emitRate;
  // A one-shot burst (manualEmitCount) is scaled once; it is gone before a profile change.
  const authoredBurst = system.manualEmitCount;
  if (authoredBurst > 0) {
    system.manualEmitCount = Math.max(1, Math.round(authoredBurst * quality.settings.particleScale));
    return system;
  }
  const unsubscribe = quality.subscribe((settings) => {
    system.emitRate = Math.max(1, authoredRate * settings.particleScale);
  });
  system.onDisposeObservable.addOnce(unsubscribe);
  return system;
};

/**
 * A mesh whose material can never glow: glTF art (PBR) with no emissive texture and black
 * emissive colour. In the glow layer's exclusion mode such a mesh is only drawn black into
 * the glow texture — one more draw call per mesh per frame, for nothing but occluding
 * glow behind it. Materials the game creates in code (highlights, markers) are never
 * matched, since their emissive colour is animated.
 */
export const canNeverGlow = (mesh: AbstractMesh): boolean => {
  const material = mesh.material;
  if (!(material instanceof PBRMaterial)) return false;
  if (material.emissiveTexture) return false;
  const emissive = material.emissiveColor;
  return emissive.r + emissive.g + emissive.b < 0.01;
};
