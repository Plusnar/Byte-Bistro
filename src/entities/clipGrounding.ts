/**
 * Forward kinematics for fixing motion-library clips before they play.
 *
 * Clips downloaded for one character are rarely right for another as-is: a
 * lying pose can sit a quarter of a metre under the floor, and a knock-down can
 * carry the hips a metre away from where the body stands. Both are fixed by
 * editing the root joint's track, and both need to know where every joint is
 * at a given moment — which is all this module computes.
 *
 * Pure maths on plain arrays, so it is tested without a Babylon scene.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface KeyTrack<T> {
  /** Seconds, ascending. */
  readonly times: readonly number[];
  readonly values: readonly T[];
}

export interface Joint {
  readonly name: string;
  /** Index of the parent in the same list, or -1 for the skeleton's top joint. */
  readonly parent: number;
  readonly restTranslation: Vec3;
  readonly restRotation: Quat;
  readonly restScale: Vec3;
  readonly translation?: KeyTrack<Vec3>;
  readonly rotation?: KeyTrack<Quat>;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Brackets `time` in a track: the two keys either side and how far between. */
const bracket = <T>(track: KeyTrack<T>, time: number): { a: T; b: T; t: number } => {
  const { times, values } = track;
  const last = times.length - 1;
  if (time <= times[0]!) return { a: values[0]!, b: values[0]!, t: 0 };
  if (time >= times[last]!) return { a: values[last]!, b: values[last]!, t: 0 };
  let high = 1;
  while (times[high]! < time) high += 1;
  const low = high - 1;
  const span = times[high]! - times[low]!;
  return { a: values[low]!, b: values[high]!, t: span > 0 ? (time - times[low]!) / span : 0 };
};

export const sampleVec3 = (track: KeyTrack<Vec3>, time: number): Vec3 => {
  const { a, b, t } = bracket(track, time);
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
};

/** Normalised lerp, taking the short way round. Plenty for densely keyed clips. */
export const sampleQuat = (track: KeyTrack<Quat>, time: number): Quat => {
  const { a, b, t } = bracket(track, time);
  const sign = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3] < 0 ? -1 : 1;
  const q: [number, number, number, number] = [
    lerp(a[0], b[0] * sign, t),
    lerp(a[1], b[1] * sign, t),
    lerp(a[2], b[2] * sign, t),
    lerp(a[3], b[3] * sign, t),
  ];
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
};

const multiply = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** Rotates `v` by unit quaternion `q`. */
const rotate = (q: Quat, v: Vec3): Vec3 => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};

/**
 * World position of every joint at `time`, in the frame the top joint's parent
 * defines. Joints must be listed parents first.
 */
export const jointPositions = (joints: readonly Joint[], time: number): Vec3[] => {
  const position: Vec3[] = [];
  const orientation: Quat[] = [];
  const scale: Vec3[] = [];
  joints.forEach((joint, index) => {
    const localT = joint.translation ? sampleVec3(joint.translation, time) : joint.restTranslation;
    const localR = joint.rotation ? sampleQuat(joint.rotation, time) : joint.restRotation;
    if (joint.parent < 0) {
      position[index] = localT;
      orientation[index] = localR;
      scale[index] = joint.restScale;
      return;
    }
    const parentScale = scale[joint.parent]!;
    const offset = rotate(orientation[joint.parent]!, [
      localT[0] * parentScale[0],
      localT[1] * parentScale[1],
      localT[2] * parentScale[2],
    ]);
    const origin = position[joint.parent]!;
    position[index] = [origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]];
    orientation[index] = multiply(orientation[joint.parent]!, localR);
    scale[index] = [
      parentScale[0] * joint.restScale[0],
      parentScale[1] * joint.restScale[1],
      parentScale[2] * joint.restScale[2],
    ];
  });
  return position;
};

export const lowestJointHeight = (joints: readonly Joint[], time: number): number =>
  Math.min(...jointPositions(joints, time).map((p) => p[1]));

export interface GroundingOptions {
  /** Height the lowest joint must stay at or above. */
  readonly floor: number;
  /** When set, the lowest joint may rise at most this far above `floor`. */
  readonly maxHop?: number;
}

/**
 * Vertical correction for the root at each time.
 *
 * Positive lifts a pose out of the floor; negative, only with `maxHop`, pulls
 * a pose back down when the clip would throw the body into the air.
 */
export const groundingOffsets = (
  joints: readonly Joint[],
  times: readonly number[],
  options: GroundingOptions,
): number[] =>
  times.map((time) => {
    const lowest = lowestJointHeight(joints, time);
    if (lowest < options.floor) return options.floor - lowest;
    if (options.maxHop !== undefined && lowest > options.floor + options.maxHop) {
      return options.floor + options.maxHop - lowest;
    }
    return 0;
  });
