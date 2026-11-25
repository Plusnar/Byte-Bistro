import { bundledModelUrl } from "../core/assets/assetRegistry";
import { t } from "../i18n";
import type { RigMediumCharacter } from "./characters";

/**
 * The robots' costumes: the KayKit Mannequin dressed up, built by
 * `scripts/robots/build_robot_variants.py` (Blender). Each is the same Rig_Medium skeleton
 * with body and costume merged into one mesh and one material, so a dressed robot is one
 * draw call (the plain Mannequin is six), and every stock clip still plays on it.
 *
 * A placed robot's variant is its model: the editor's catalogue places `robot-<variant>`,
 * and the game reads the variant back from that asset id (`robotVariantOf`).
 */

export type RobotVariant =
  | "plain"
  | "german-man"
  | "german-woman"
  | "groom"
  | "bride"
  | "guitar"
  | "singer"
  | "keyboard";

export type DressedVariant = Exclude<RobotVariant, "plain">;

export const DRESSED_VARIANTS: readonly DressedVariant[] = [
  "german-man", "german-woman", "groom", "bride", "guitar", "singer", "keyboard",
];

/** The plain Mannequin's height in model units, which the game scales to 1.8 m. */
const MANNEQUIN_HEIGHT = 2.204;
const ROBOT_HEIGHT = 1.8;

/**
 * Each variant's height in model units, measured from the built file. The game fits a
 * character's whole height (hat included) to its `targetHeight`, so a top hat would shrink
 * the robot under it; scaling the target by the same ratio keeps every body the size of
 * the plain robot. `robotVariants.test.ts` checks these against the files.
 */
export const VARIANT_MODEL_HEIGHT: Readonly<Record<DressedVariant, number>> = {
  "german-man": 2.547,
  "german-woman": 2.463,
  groom: 2.6,
  bride: 2.24,
  guitar: 2.26,
  singer: 2.204,
  keyboard: 2.26,
};

export const robotAssetId = (variant: DressedVariant): string => `robot-${variant}`;

export const robotModelPath = (variant: DressedVariant): string => `src/assets/robots/robot-${variant}.glb`;

export const VARIANT_LABEL_KEY = {
  "german-man": "robots.germanMan",
  "german-woman": "robots.germanWoman",
  groom: "robots.groom",
  bride: "robots.bride",
  guitar: "robots.guitar",
  singer: "robots.singer",
  keyboard: "robots.keyboard",
} as const satisfies Readonly<Record<DressedVariant, string>>;

/** The dressed robots as characters, for `CharacterController.selectCharacter`. */
export const ROBOT_VARIANT_CHARACTERS: Readonly<Record<DressedVariant, RigMediumCharacter>> =
  Object.fromEntries(DRESSED_VARIANTS.map((variant) => [variant, {
    id: robotAssetId(variant),
    get displayName() { return t(VARIANT_LABEL_KEY[variant]); },
    get role() { return t("wedding.guestRole"); },
    modelAssetId: robotAssetId(variant),
    modelUrl: bundledModelUrl(robotModelPath(variant)),
    previewUrl: "",
    targetHeight: ROBOT_HEIGHT * VARIANT_MODEL_HEIGHT[variant] / MANNEQUIN_HEIGHT,
    rig: "Rig_Medium",
  } satisfies RigMediumCharacter])) as Record<DressedVariant, RigMediumCharacter>;

/**
 * Asset definitions for scenes that may show dressed robots. Lazy: a map downloads only
 * the costumes it actually places.
 */
export const ROBOT_VARIANT_ASSETS = DRESSED_VARIANTS.map((variant) => ({
  id: robotAssetId(variant),
  url: ROBOT_VARIANT_CHARACTERS[variant].modelUrl,
  required: false,
  lazy: true,
}));

const BY_ASSET_ID = new Map(DRESSED_VARIANTS.map((variant) => [robotAssetId(variant), variant]));

/** The variant a placed robot's model is, "plain" for the Mannequin or anything unknown. */
export const robotVariantOf = (assetId: string): RobotVariant => BY_ASSET_ID.get(assetId) ?? "plain";

export const isRobotVariantAsset = (assetId: string): boolean => BY_ASSET_ID.has(assetId);
