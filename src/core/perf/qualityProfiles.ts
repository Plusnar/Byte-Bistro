/**
 * Graphics profiles. `high` is the game exactly as it was drawn before profiles existed
 * (apart from capping 3x phone screens at 2x, which is not visible at that density), so
 * choosing it never changes the look; `medium` and `low` only trade cost that does not
 * carry gameplay information: resolution, glow blur, particle density, the menu's soft
 * shadows and its background walkers.
 *
 * Nothing here may switch off a mechanic or something a player reads to play: fire stays
 * visible on a burning stove at every level (particles are thinned, never removed).
 */
export type QualityLevel = "low" | "medium" | "high";
export type QualityMode = QualityLevel | "auto";

export const QUALITY_LEVELS: readonly QualityLevel[] = ["low", "medium", "high"];
export const QUALITY_MODES: readonly QualityMode[] = ["auto", "low", "medium", "high"];

export interface QualitySettings {
  readonly level: QualityLevel;
  /**
   * Fraction of the screen's resolution drawn, on top of the device-pixel-ratio cap. 1 draws
   * every (capped) device pixel; the automatic mode moves it between its bounds.
   */
  readonly renderScale: number;
  /** HiDPI screens are drawn at most at this many pixels per CSS pixel. */
  readonly maxDevicePixelRatio: number;
  /** The kitchen's emissive glow. Purely decorative. */
  readonly glow: { readonly enabled: boolean; readonly blurKernelSize: number };
  /** Multiplies every particle system's emit rate (fire, water, foam, sprays). */
  readonly particleScale: number;
  /** The menu street's soft sun shadows: always blurred, cheaper map and kernel lower down. */
  readonly menuShadows: { readonly mapSize: number; readonly blurKernel: number };
  /** The robots walking and waving behind the cook selection. */
  readonly menuWalkers: boolean;
}

export const QUALITY_PROFILES: Readonly<Record<QualityLevel, QualitySettings>> = {
  high: {
    level: "high",
    renderScale: 1,
    maxDevicePixelRatio: 2,
    glow: { enabled: true, blurKernelSize: 24 },
    particleScale: 1,
    menuShadows: { mapSize: 1024, blurKernel: 16 },
    menuWalkers: true,
  },
  medium: {
    level: "medium",
    renderScale: 1,
    maxDevicePixelRatio: 1.5,
    glow: { enabled: true, blurKernelSize: 16 },
    particleScale: 0.75,
    menuShadows: { mapSize: 1024, blurKernel: 8 },
    menuWalkers: true,
  },
  low: {
    level: "low",
    renderScale: 0.85,
    maxDevicePixelRatio: 1,
    glow: { enabled: false, blurKernelSize: 16 },
    particleScale: 0.5,
    menuShadows: { mapSize: 512, blurKernel: 4 },
    menuWalkers: false,
  },
};

/** The automatic mode never draws below this fraction of the capped resolution. */
export const MIN_RENDER_SCALE = 0.6;
export const MAX_RENDER_SCALE = 1;

export const isQualityMode = (value: unknown): value is QualityMode =>
  typeof value === "string" && (QUALITY_MODES as readonly string[]).includes(value);

/**
 * Hardware hints for the level the automatic mode starts at. Only a starting point: the
 * controller moves from there on measured frame times.
 */
export interface DeviceHints {
  readonly gpuRenderer?: string;
  readonly hardwareConcurrency?: number;
  readonly deviceMemoryGb?: number;
  readonly mobile?: boolean;
}

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|software|basic render|microsoft basic/i;

export const initialLevelFor = (hints: DeviceHints): QualityLevel => {
  if (hints.gpuRenderer && SOFTWARE_RENDERER.test(hints.gpuRenderer)) return "low";
  if ((hints.deviceMemoryGb ?? 8) <= 2 || (hints.hardwareConcurrency ?? 8) <= 2) return "low";
  if (hints.mobile) return "medium";
  return "high";
};

/** Frame-time target for a starting level: weak devices aim for 30 fps, the rest for 60. */
export const targetFrameMsFor = (level: QualityLevel): number => (level === "low" ? 1000 / 30 : 1000 / 60);
