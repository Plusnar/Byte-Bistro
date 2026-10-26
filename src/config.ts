export const GAME_CONFIG = {
  title: "BYTE BISTRO",
  organization: "NEURADYNE SYSTEMS",
  player: {
    walkSpeed: 3.6,
    // Running covers ground; the dash (see src/entities/dash.ts) is the burst. The two
    // would compete if a held run were nearly as fast, so the run sits closer to the walk.
    runMultiplier: 1.3,
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
    developmentDuration: 195,
    standardDuration: 195,
  },
  interactionCooldownMs: 160,
  /**
   * How much of their own colour the cooks show regardless of the room's light (see
   * CharacterController.setLift): their models read dark under the kitchen's warm light.
   * Only the cooks; the room and the guests are lit as before.
   */
  characterLift: 0.3,
} as const;

export const DEV_MODE = import.meta.env.DEV;

export const isDevelopmentMode = (): boolean =>
  DEV_MODE || new URLSearchParams(window.location.search).has("dev");

export const getShiftDuration = (): number =>
  isDevelopmentMode()
    ? GAME_CONFIG.shift.developmentDuration
    : GAME_CONFIG.shift.standardDuration;
