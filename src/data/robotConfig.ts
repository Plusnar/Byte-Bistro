import { t } from "../i18n";
/**
 * Robots placed from the editor ("Robos" in the catalogue).
 *
 * A robot is one placed object plus this config: whether it takes orders, whether it walks,
 * and which clip it loops while standing still. Keeping the config a typed sub-object rather
 * than a generic property bag is deliberate — `sanitizeMapData` is a whitelist by design, and
 * a bag cannot be whitelisted without abandoning the validation that keeps corrupt maps out.
 */

/** The Mannequin model every robot uses; `WeddingGuests` registers it under this id. */
export const ROBOT_ASSET_ID = "wedding-mannequin";

/** Which animation pack a clip comes from. */
export type RobotClipPack = "general" | "movement" | "simulation";

export interface RobotClip {
  readonly id: string;
  readonly label: string;
  readonly pack: RobotClipPack;
}

/**
 * A curated subset of the KayKit clips, not every clip in every pack.
 *
 * `general` and `movement` are already loaded for the cooks, so those cost nothing. Anything
 * from `simulation` pulls in an extra GLB, which is why the list stays short and the pack is
 * only fetched when a placed robot actually asks for one of its clips.
 */
export const ROBOT_CLIPS: readonly RobotClip[] = [
  { id: "Idle_A", get label() { return t("editor.clipIdle"); }, pack: "general" },
  { id: "Idle_B", get label() { return t("editor.clipIdleImpatient"); }, pack: "general" },
  { id: "Interact", get label() { return t("editor.clipInteract"); }, pack: "general" },
  { id: "Use_Item", get label() { return t("editor.clipUseItem"); }, pack: "general" },
  { id: "Walking_A", get label() { return t("editor.clipWalking"); }, pack: "movement" },
  { id: "Waving", get label() { return t("editor.clipWaving"); }, pack: "simulation" },
  { id: "Cheering", get label() { return t("editor.clipCheering"); }, pack: "simulation" },
  { id: "Sit_Chair_Idle", get label() { return t("editor.clipSitChair"); }, pack: "simulation" },
  { id: "Sit_Floor_Idle", get label() { return t("editor.clipSitFloor"); }, pack: "simulation" },
  { id: "Lie_Idle", get label() { return t("editor.clipLie"); }, pack: "simulation" },
  { id: "Push_Ups", get label() { return t("editor.clipPushUps"); }, pack: "simulation" },
];

export const DEFAULT_ROBOT_CLIP = "Idle_A";

export const getRobotClip = (id: string): RobotClip | undefined =>
  ROBOT_CLIPS.find((clip) => clip.id === id);

export interface RobotConfig {
  /** Takes orders from the queue. A non-customer robot is animated scenery. */
  readonly customer: boolean;
  /** Wanders around its placed position. A static robot stays where it was dropped. */
  readonly canMove: boolean;
  /** Clip looped while standing still. */
  readonly idleClip: string;
  /** Radius of the wander disc around the placed position, in metres. */
  readonly wanderRadius: number;
  /** Walking speed, in m/s. */
  readonly moveSpeed: number;
  /** Shown on the robot's order bubble; blank falls back to a generated name. */
  readonly displayName: string;
}

export const DEFAULT_ROBOT_CONFIG: RobotConfig = {
  customer: true,
  canMove: true,
  idleClip: DEFAULT_ROBOT_CLIP,
  wanderRadius: 2.4,
  moveSpeed: 1.15,
  displayName: "",
};

export const WANDER_RADIUS_RANGE = { min: 0, max: 12 } as const;
export const MOVE_SPEED_RANGE = { min: 0.2, max: 4 } as const;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Returns a fully defaulted, clamped config for any input.
 *
 * Total rather than partial on purpose: the runtime reads these fields every frame, so a
 * hand-edited level file must not be able to produce a robot sprinting at 400 m/s or looping
 * a clip that no pack contains.
 */
export const sanitizeRobotConfig = (value: unknown): RobotConfig => {
  const record = isRecord(value) ? value : {};
  const idleClip = record.idleClip;
  const radius = record.wanderRadius;
  const speed = record.moveSpeed;
  return {
    customer: typeof record.customer === "boolean"
      ? record.customer
      : DEFAULT_ROBOT_CONFIG.customer,
    canMove: typeof record.canMove === "boolean"
      ? record.canMove
      : DEFAULT_ROBOT_CONFIG.canMove,
    idleClip: typeof idleClip === "string" && getRobotClip(idleClip)
      ? idleClip
      : DEFAULT_ROBOT_CLIP,
    wanderRadius: typeof radius === "number" && Number.isFinite(radius)
      ? clamp(radius, WANDER_RADIUS_RANGE.min, WANDER_RADIUS_RANGE.max)
      : DEFAULT_ROBOT_CONFIG.wanderRadius,
    moveSpeed: typeof speed === "number" && Number.isFinite(speed)
      ? clamp(speed, MOVE_SPEED_RANGE.min, MOVE_SPEED_RANGE.max)
      : DEFAULT_ROBOT_CONFIG.moveSpeed,
    displayName: typeof record.displayName === "string"
      ? record.displayName.slice(0, 40)
      : "",
  };
};

export interface RobotPreset {
  readonly label: string;
  readonly config: RobotConfig;
}

/** Catalogue entries, so the common robots are one click rather than five fields. */
export const ROBOT_PRESETS: readonly RobotPreset[] = [
  {
    get label() { return t("editor.presetGuest"); },
    config: { ...DEFAULT_ROBOT_CONFIG },
  },
  {
    get label() { return t("editor.presetStanding"); },
    config: { ...DEFAULT_ROBOT_CONFIG, customer: true, canMove: false, idleClip: "Waving" },
  },
  {
    get label() { return t("editor.presetDecor"); },
    config: { ...DEFAULT_ROBOT_CONFIG, customer: false, canMove: false, idleClip: "Cheering" },
  },
  {
    get label() { return t("editor.presetSitting"); },
    config: { ...DEFAULT_ROBOT_CONFIG, customer: true, canMove: false, idleClip: "Sit_Chair_Idle" },
  },
];

/** One robot the scene has to build, derived from a placed object. */
export interface RobotSpawn {
  readonly id: string;
  readonly name: string;
  /** Where it was dropped in the editor; also the centre of its wander disc. */
  readonly position: { x: number; y: number; z: number };
  readonly rotationY: number;
  readonly config: RobotConfig;
}
