export const GAME_CONFIG = {
  title: "BYTE BISTRO",
  organization: "NEURADYNE SYSTEMS",
  player: {
    walkSpeed: 4.4,
    runMultiplier: 1.55,
    interactionRadius: 2.25,
    bounds: {
      minX: -12.8,
      maxX: 12.8,
      minZ: -8.2,
      maxZ: 8.2,
    },
  },
  camera: {
    // Centralizada na abertura frontal do módulo para que as paredes laterais
    // nunca ocultem os jogadores, mesmo mantendo o enquadramento próximo.
    offsetX: 0,
    offsetY: 10.5,
    offsetZ: -10.5,
    smoothing: 5.5,
  },
  shift: {
    developmentDuration: 240,
    standardDuration: 240,
  },
  interactionCooldownMs: 160,
} as const;

export const DEV_MODE = import.meta.env.DEV;

export const isDevelopmentMode = (): boolean =>
  DEV_MODE || new URLSearchParams(window.location.search).has("dev");

export const getShiftDuration = (): number =>
  isDevelopmentMode()
    ? GAME_CONFIG.shift.developmentDuration
    : GAME_CONFIG.shift.standardDuration;
