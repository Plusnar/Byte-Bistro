import { publicUrl } from "../utils/assetUrl";

export const RIG_MEDIUM_JOINTS = [
  "root",
  "hips",
  "spine",
  "chest",
  "upperarm.l",
  "lowerarm.l",
  "wrist.l",
  "hand.l",
  "handslot.l",
  "head",
  "upperarm.r",
  "lowerarm.r",
  "wrist.r",
  "hand.r",
  "handslot.r",
  "upperleg.l",
  "lowerleg.l",
  "foot.l",
  "toes.l",
  "upperleg.r",
  "lowerleg.r",
  "foot.r",
  "toes.r",
] as const;

interface CharacterBase {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly variant?: string;
  readonly modelAssetId: string;
  readonly modelUrl: string;
  readonly previewUrl: string;
  /** Desired total height in kitchen world units, including hats and hoods. */
  readonly targetHeight: number;
}

/** A KayKit cook: animated by retargeting the shared Rig_Medium packs. */
export interface RigMediumCharacter extends CharacterBase {
  readonly rig: "Rig_Medium";
}

/**
 * One clip baked into a character's own file, and how the game plays it.
 *
 * Times are seconds into the clip as authored. Slicing matters because these
 * clips come from a motion library, not from this game: a knock-down spends
 * half its length lying still, and a pitch winds up for over a second.
 */
export interface EmbeddedClip {
  /** Animation name inside the model file. */
  readonly name: string;
  readonly from?: number;
  readonly to?: number;
  readonly speed?: number;
  /**
   * For locomotion: how fast the feet travel over the ground while planted,
   * in the model's own units per second. Playback is scaled so that speed
   * matches the character's real movement, which is what stops foot sliding.
   */
  readonly footSpeed?: number;
  /** Highest playback rate the clip still reads as the same motion at. */
  readonly maxSpeed?: number;
  /** Drop horizontal root motion so the body stays on its collider. */
  readonly inPlace?: boolean;
  /** Keep every joint above the floor; lying clips otherwise sink into it. */
  readonly grounded?: boolean;
  /** With `grounded`: how far the body may leave the floor, in model units. */
  readonly maxHop?: number;
}

export interface EmbeddedClipSet {
  /** The skeleton's top joint, which carries any root motion. */
  readonly rootJoint: string;
  /** First joint of the upper body: the gesture drives it and everything below it. */
  readonly upperBodyJoint: string;
  readonly idle: EmbeddedClip;
  readonly walk: EmbeddedClip;
  readonly run: EmbeddedClip;
  /** Throwing or setting an item down. Upper body only, so the legs keep walking. */
  readonly gesture: EmbeddedClip;
  /** Hit by a thrown item. */
  readonly knockDown: EmbeddedClip;
  /** Looped on the floor until the stun wears off. */
  readonly downed: EmbeddedClip;
  readonly standUp: EmbeddedClip;
  /** Character selection screen only. */
  readonly showcase: EmbeddedClip;
}

/** A character that ships its own animations and is not retargeted. */
export interface EmbeddedCharacter extends CharacterBase {
  readonly rig: "Embedded";
  readonly clips: EmbeddedClipSet;
}

export type CharacterDefinition = RigMediumCharacter | EmbeddedCharacter;

/**
 * William's clips, sliced from measurements of the file rather than by eye.
 *
 * - Walking and Running are authored in place; their planted feet travel at
 *   0.82 and 2.71 model units per second.
 * - Knock_Down starts with the hips a metre behind the stance and drifts back
 *   further, then lies still from 1.03 s. The slide is the gameplay's job, so the
 *   drift is stripped and the idle half is cut.
 * - Lying clips put the lowest joint about 0.25 below the floor, so they are
 *   grounded rather than played as authored.
 * - Stand_Up9 lies still for its first 1.25 s; the rise runs 1.25 to 2.25 s.
 * - baseball_pitching accelerates from 1.15 s and releases at 1.68 s; the slice
 *   starts just before the release so the arm snaps through quickly.
 */
const WILLIAM_CLIPS: EmbeddedClipSet = {
  rootJoint: "mixamorig:Hips",
  upperBodyJoint: "mixamorig:Spine",
  idle: { name: "Look_Around_Dumbfounded" },
  walk: { name: "Walking", footSpeed: 0.82, maxSpeed: 2.6 },
  run: { name: "Running", footSpeed: 2.71, maxSpeed: 2 },
  gesture: { name: "baseball_pitching", from: 1.3, to: 2.15, speed: 1.5 },
  knockDown: {
    name: "Knock_Down", from: 0, to: 1.3, inPlace: true, grounded: true, maxHop: 0.12,
  },
  downed: { name: "SideLying_Reach_Help", inPlace: true, grounded: true },
  standUp: { name: "Stand_Up9", from: 1, to: 2.5, speed: 1.3, inPlace: true, grounded: true },
  showcase: { name: "Gangnam_Groove" },
};

/**
 * Sandy shares William's rig and most of his clip library, so she starts from
 * his set. What differs was measured from her file:
 *
 * - Her stride is longer: planted feet travel at 1.03 (walk) and 3.09 (run)
 *   model units per second, against his 0.82 and 2.71. His values would make
 *   her feet skate.
 * - Her get-up is Stand_Up1, an 8.33 s clip: still until 1.74 s, a slow shuffle
 *   to about 4.2 s, the rise from about 4.3 to 5.9 s, then standing. The slice
 *   keeps the end of the shuffle and the rise.
 * - Her selection dance is You_Groove.
 *
 * The knock-down, lying and pitching clips time the same as his (landing at
 * 1.03 s, release at 1.68 s), so those slices carry over.
 */
const SANDY_CLIPS: EmbeddedClipSet = {
  ...WILLIAM_CLIPS,
  walk: { ...WILLIAM_CLIPS.walk, footSpeed: 1.03 },
  run: { ...WILLIAM_CLIPS.run, footSpeed: 3.09 },
  standUp: { name: "Stand_Up1", from: 4, to: 6.1, speed: 1.7, inPlace: true, grounded: true },
  showcase: { name: "You_Groove" },
};

// Only the two cooks made for this game: William and Sandy.
export const CHARACTERS = [
  {
    id: "william",
    displayName: "William",
    role: "Head Chef",
    modelAssetId: "character-william",
    // The file name ends in a space before the extension, so it is encoded
    // rather than typed into the path.
    modelUrl: publicUrl(`asset-library/Char/Characters/${encodeURIComponent("William .glb")}`),
    previewUrl: "",
    // KayKit-cook proportions: the counters and props were sized for 1.78 to 1.90 m.
    targetHeight: 1.84,
    rig: "Embedded",
    clips: WILLIAM_CLIPS,
  },
  {
    id: "sandy",
    displayName: "Sandy",
    role: "Sous Chef",
    modelAssetId: "character-sandy",
    modelUrl: publicUrl("asset-library/Char/Characters/Sandy.glb"),
    previewUrl: "",
    // Same authored height as William, so the same fit keeps them level.
    targetHeight: 1.84,
    rig: "Embedded",
    clips: SANDY_CLIPS,
  },
] as const satisfies readonly CharacterDefinition[];

export type CharacterId = (typeof CHARACTERS)[number]["id"];

export const DEFAULT_CHARACTER_ID: CharacterId = "william";

export const CHARACTER_ANIMATION_ASSETS = {
  general: {
    id: "rig-medium-general",
    url: new URL(
      "../../Anim/Animations/gltf/Rig_Medium/Rig_Medium_General.glb",
      import.meta.url,
    ).href,
  },
  movement: {
    id: "rig-medium-movement-basic",
    url: new URL(
      "../../Anim/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb",
      import.meta.url,
    ).href,
  },
  /**
   * Ambient clips for placed robots (waving, sitting, cheering).
   *
   * Never `required`: only a level with a robot asking for one of these clips pays for the
   * download, and it is fetched the first time such a robot appears.
   */
  simulation: {
    id: "rig-medium-simulation",
    url: new URL(
      "../../Anim/Animations/gltf/Rig_Medium/Rig_Medium_Simulation.glb",
      import.meta.url,
    ).href,
  },
} as const;

export type AnimationPackKey = keyof typeof CHARACTER_ANIMATION_ASSETS;

export const getCharacter = (id: string): CharacterDefinition | undefined =>
  CHARACTERS.find((character) => character.id === id);
