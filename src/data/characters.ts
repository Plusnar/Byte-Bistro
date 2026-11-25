import { translate } from "../i18n";
import { bundledModelUrl, publicModelUrl } from "../core/assets/assetRegistry";

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

/**
 * How a cook's hair swings; see src/entities/hairPhysics.ts. Lengths are in
 * units of each hair segment, so the numbers hold at any model scale.
 */
export interface HairSpring {
  /** Pull back to the posed shape, per second. Higher is a stiffer, faster lock. */
  readonly stiffness: number;
  /** Share of its motion a lock loses each step (0 to 1). Higher settles sooner. */
  readonly drag: number;
  /** Sag per second. */
  readonly gravity: number;
  /** Furthest a segment swings from its posed direction, in degrees. */
  readonly maxAngle: number;
  /**
   * Share of the stiffness left at the end of a lock, fading linearly from the
   * root (1, the default, is even). Below 1 the root holds and the end runs free,
   * as real hair does.
   */
  readonly taper?: number;
  /**
   * Radius, in model units, of spheres round the upper spine and neck that long
   * hair may not swing into. Without it a free ponytail passes through the back.
   */
  readonly body?: number;
  /**
   * The modelled shape already hangs under gravity, so gravity only acts as the
   * head turns away from upright: tip the head and the lock keeps hanging down.
   * Off, `gravity` is a plain sag added to the modelled shape.
   */
  readonly hang?: boolean;
  /**
   * How hard the air the cook walks into blows the hair back, per metre per
   * second of travel. A lock leans back by about asin(wind × speed ÷ (stiffness
   * + gravity)) at a steady pace.
   */
  readonly wind?: number;
  /** Stiffness multipliers for single locks, by name: a short lock by the face held firmer than a long tail. */
  readonly lockStiffness?: Readonly<Record<string, number>>;
}

/** A character that ships its own animations and is not retargeted. */
export interface EmbeddedCharacter extends CharacterBase {
  readonly rig: "Embedded";
  readonly clips: EmbeddedClipSet;
  /** Spring settings for hair joints added by scripts/rig-hair.py. */
  readonly hair?: HairSpring;
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

/**
 * Milena ships her own Mixamo library, merged from Meshy's per-animation exports by
 * scripts/merge-clips.py: the same knock-down, lying, get-up (Stand_Up1) and
 * pitching clips as Sandy's, timed the same, so their slices carry over. Her
 * planted feet travel at 1.26 walking and 3.6 running (scripts/measure-stride.py),
 * and her selection dance is her own Shake_It_Off_Dance.
 */
const MILENA_CLIPS: EmbeddedClipSet = {
  ...SANDY_CLIPS,
  walk: { ...SANDY_CLIPS.walk, footSpeed: 1.26 },
  run: { ...SANDY_CLIPS.run, footSpeed: 3.6 },
  showcase: { name: "Shake_It_Off_Dance" },
};

/**
 * Jean ships the same Mixamo library as Sandy (Stand_Up1 for getting up, the same
 * knock-down and pitching timings) with his own stride, 1.42 walking and 3.8
 * running, and Hip_Hop_Dance_3 as his selection dance.
 */
const JEAN_CLIPS: EmbeddedClipSet = {
  ...SANDY_CLIPS,
  walk: { ...SANDY_CLIPS.walk, footSpeed: 1.42 },
  run: { ...SANDY_CLIPS.run, footSpeed: 3.8 },
  showcase: { name: "Hip_Hop_Dance_3" },
};

// The cooks made for this game: William, Sandy, Milena and Jean.
export const CHARACTERS = [
  {
    id: "william",
    displayName: "William",
    get role() { return translate("characters.headChef"); },
    modelAssetId: "character-william",
    // The file name ends in a space before the extension; the registry encodes it.
    modelUrl: publicModelUrl("asset-library/Char/Characters/William .glb"),
    previewUrl: "",
    // KayKit-cook proportions: the counters and props were sized for 1.78 to 1.90 m.
    targetHeight: 1.84,
    rig: "Embedded",
    clips: WILLIAM_CLIPS,
    // Short, swept hair: quick to settle, it flicks as he turns and stops.
    hair: { stiffness: 14, drag: 0.45, gravity: 0.3, maxAngle: 18 },
  },
  {
    id: "sandy",
    displayName: "Sandy",
    get role() { return translate("characters.sousChef"); },
    modelAssetId: "character-sandy",
    modelUrl: publicModelUrl("asset-library/Char/Characters/Sandy.glb"),
    previewUrl: "",
    // Same authored height as William, so the same fit keeps them level.
    targetHeight: 1.84,
    rig: "Embedded",
    clips: SANDY_CLIPS,
    // Big curls: softer, so the puff lags and wobbles a little longer.
    hair: { stiffness: 14, drag: 0.45, gravity: 0.4, maxAngle: 22 },
  },
  {
    id: "milena",
    displayName: "Milena",
    get role() { return translate("characters.pastryChef"); },
    modelAssetId: "character-milena",
    modelUrl: publicModelUrl("asset-library/Char/Characters/Milena.glb"),
    previewUrl: "",
    targetHeight: 1.84,
    rig: "Embedded",
    clips: MILENA_CLIPS,
    // A high ponytail whose two strands hang from the one band on her crown, and
    // a lock by her left cheek. The modelled shape is how they hang, so gravity
    // only acts as she tips her head: the tail keeps falling straight down. Soft
    // and well damped, so it sways slowly (about once a second) rather than
    // bouncing to her quick in-game stride; it streams back about 18° walking and
    // 25° running, and drifts down again when she stops. Firmer at the band than
    // at the ends, kept off her back; the cheek lock is held firmer still.
    hair: {
      stiffness: 1,
      drag: 0.6,
      gravity: 0.5,
      maxAngle: 30,
      taper: 0.5,
      body: 0.18,
      hang: true,
      wind: 0.025,
      lockStiffness: { lock_l: 3 },
    },
  },
  {
    id: "jean",
    displayName: "Jean",
    get role() { return translate("characters.grillChef"); },
    modelAssetId: "character-jean",
    modelUrl: publicModelUrl("asset-library/Char/Characters/Jean.glb"),
    previewUrl: "",
    targetHeight: 1.84,
    rig: "Embedded",
    clips: JEAN_CLIPS,
    // A buzz cut barely moves: a hint of give on the turns, held to a few degrees.
    hair: { stiffness: 14, drag: 0.5, gravity: 0.15, maxAngle: 8 },
  },
] as const satisfies readonly CharacterDefinition[];

export type CharacterId = (typeof CHARACTERS)[number]["id"];

export const DEFAULT_CHARACTER_ID: CharacterId = "william";

export const CHARACTER_ANIMATION_ASSETS = {
  general: {
    id: "rig-medium-general",
    url: bundledModelUrl("Anim/Animations/gltf/Rig_Medium/Rig_Medium_General.glb"),
  },
  movement: {
    id: "rig-medium-movement-basic",
    url: bundledModelUrl("Anim/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb"),
  },
  /**
   * Ambient clips for placed robots (waving, sitting, cheering).
   *
   * Never `required`: only a level with a robot asking for one of these clips pays for the
   * download, and it is fetched the first time such a robot appears.
   */
  simulation: {
    id: "rig-medium-simulation",
    url: bundledModelUrl("Anim/Animations/gltf/Rig_Medium/Rig_Medium_Simulation.glb"),
  },
  /**
   * The dressed robots' clips: march, sway, the band and the couple (built by
   * scripts/robots). Like `simulation`, fetched only when a robot asks for one.
   */
  fest: {
    id: "rig-medium-fest",
    url: bundledModelUrl("src/assets/robots/Rig_Medium_Fest.glb"),
  },
} as const;

export type AnimationPackKey = keyof typeof CHARACTER_ANIMATION_ASSETS;

export const getCharacter = (id: string): CharacterDefinition | undefined =>
  CHARACTERS.find((character) => character.id === id);
