import {
  Matrix,
  Quaternion,
  TransformNode,
  Vector3,
  type Node,
  type Observer,
  type Scene,
} from "@babylonjs/core";

/**
 * What a cook's arms are doing over the clip their legs are playing.
 *
 * `carry` holds the item in front of the chest with both hands; `chop` holds a
 * knife in the right hand and brings it down on the board while the left hand
 * steadies the food; `wash` scrubs a plate down in the sink with both hands;
 * `spray` holds the extinguisher like `carry`, shaking with the jet.
 */
export type ArmPose = "none" | "carry" | "chop" | "wash" | "spray";

type PosedKind = Exclude<ArmPose, "none">;
const POSED_KINDS: readonly PosedKind[] = ["carry", "chop", "wash", "spray"];

/**
 * Arm poses for the Mixamo-rigged cooks, solved on top of the animation.
 *
 * Every frame, after the clips have posed the body, each arm is turned so the
 * wrist lands on a target given in the cook's own frame (+x right, +y up, +z
 * forward, metres from the feet): a two-bone solve for the upper arm and the
 * forearm, with the elbow bent towards a pole, then the hand aimed along a
 * direction. The solved pose is blended over the animated one by a weight that
 * eases in and out, so the legs keep walking and the arms slide into the pose.
 *
 * Only directions are ever matched, never rotations taken from world space:
 * the glTF root mirrors the model, and a rotation aimed between two vectors
 * survives that where an angle about an axis would flip.
 */

/** How fast a pose fades in or out, per second. */
const BLEND_RATE = 12;
/** One chop, down and back up, in seconds. */
export const CHOP_PERIOD = 0.34;
/** Share of a chop spent bringing the knife down; the rest lifts it. */
const CHOP_STRIKE = 0.3;
/** How far forward the torso leans over the board, in radians. */
const CHOP_LEAN = 0.3;
/** How far forward the torso leans over the sink, in radians. */
const WASH_LEAN = 0.24;
/** One scrubbing circle, in seconds. */
export const WASH_PERIOD = 0.55;
/** Radius of the scrubbing circles, in metres. */
const WASH_RADIUS = 0.045;
/** The farthest a wrist reaches, as a share of the arm's length; a locked elbow reads as stiff. */
const MAX_REACH = 0.97;

interface HandGoal {
  /** Where the wrist goes. */
  readonly wrist: Vector3;
  /** Which way the fingers point. */
  readonly fingers: Vector3;
  /** Which way the elbow bends. */
  readonly pole: Vector3;
}

interface PoseGoal {
  readonly left: HandGoal;
  readonly right: HandGoal;
  readonly lean: number;
}

const goal = (wrist: readonly number[], fingers: readonly number[], pole: readonly number[]): HandGoal => ({
  wrist: Vector3.FromArray(wrist),
  fingers: Vector3.FromArray(fingers).normalize(),
  pole: Vector3.FromArray(pole).normalize(),
});

/*
 * The targets fit the cooks' build: shoulders about 0.93 m up, an arm about
 * 0.36 m from shoulder to wrist, and a counter top at shoulder height.
 */

/** Both hands under the sides of the item at `CARRY_HOLD`, fingers forward and in. */
const CARRY: PoseGoal = {
  left: goal([-0.14, 0.75, 0.25], [0.5, 0.1, 0.85], [-0.7, -1, -0.4]),
  right: goal([0.14, 0.75, 0.25], [-0.5, 0.1, 0.85], [0.7, -1, -0.4]),
  lean: 0,
};

/** Where a carried item sits, in the cook's frame, for these hands to hold it. */
export const CARRY_HOLD: readonly [number, number, number] = [0, 0.7, 0.32];

/** Knife hand at the top of the stroke; `blendGoals` lowers it. */
const CHOP_RIGHT = goal([0.1, 1.06, 0.38], [-0.3, -0.15, 0.95], [1, -0.6, -0.3]);
/** The left hand rests on the food, fingers curled down over it. */
const CHOP_LEFT = goal([-0.12, 0.97, 0.4], [0.3, -0.5, 0.8], [-0.8, -1, -0.2]);
/** How far the knife hand drops from the top of the stroke to the board. */
const CHOP_DROP = 0.09;

/** Both hands down in the basin, around the plate, palms down. */
const WASH_LEFT = goal([-0.11, 0.86, 0.4], [0.35, -0.6, 0.7], [-0.8, -1, -0.3]);
const WASH_RIGHT = goal([0.11, 0.86, 0.4], [-0.35, -0.6, 0.7], [0.8, -1, -0.3]);

/**
 * Height of the knife through one chop, 1 at the top and 0 on the board: a quick
 * strike, then a slower lift.
 */
export const chopLift = (phase: number): number => {
  const t = phase - Math.floor(phase);
  if (t < CHOP_STRIKE) {
    const down = t / CHOP_STRIKE;
    return 1 - down * down;
  }
  const up = (t - CHOP_STRIKE) / (1 - CHOP_STRIKE);
  return 1 - (1 - up) * (1 - up);
};

/**
 * Where the elbow goes so a two-bone arm from `shoulder` reaches `target`.
 *
 * The wrist is pulled in to the arm's reach when the target is farther, and the
 * elbow bends towards `pole`. Writes the elbow into `elbow` and the point the
 * wrist actually reaches into `wrist`.
 */
export const solveTwoBone = (
  shoulder: Vector3,
  upperLength: number,
  foreLength: number,
  target: Vector3,
  pole: Vector3,
  elbow: Vector3,
  wrist: Vector3,
): void => {
  const toTarget = target.subtract(shoulder);
  const distance = toTarget.length();
  const reach = (upperLength + foreLength) * MAX_REACH;
  const nearest = Math.abs(upperLength - foreLength) + 1e-4;
  const along = distance > 1e-6 ? toTarget.scale(1 / distance) : new Vector3(0, -1, 0);
  const span = Math.min(reach, Math.max(nearest, distance));

  // The bend direction: the pole with its component along the arm removed.
  const bend = pole.subtract(along.scale(Vector3.Dot(pole, along)));
  if (bend.lengthSquared() < 1e-8) bend.copyFrom(Math.abs(along.y) < 0.9 ? Vector3.Down() : Vector3.Forward());
  bend.normalize();

  // Law of cosines for the angle at the shoulder.
  const cosine = (upperLength * upperLength + span * span - foreLength * foreLength)
    / (2 * upperLength * span);
  const clamped = Math.min(1, Math.max(-1, cosine));
  const sine = Math.sqrt(1 - clamped * clamped);
  shoulder.addToRef(along.scale(upperLength * clamped).addInPlace(bend.scale(upperLength * sine)), elbow);
  shoulder.addToRef(along.scale(span), wrist);
};

type PoseWeights = Readonly<Record<PosedKind, number>>;

const offset = (hand: HandGoal, by: Vector3, fingers?: Vector3): HandGoal => ({
  wrist: hand.wrist.add(by),
  fingers: fingers ? hand.fingers.add(fingers).normalize() : hand.fingers,
  pole: hand.pole,
});

/** Each pose's goal `clock` seconds after it started. */
const poseGoal = (kind: PosedKind, clock: number): PoseGoal => {
  switch (kind) {
    case "carry":
      return CARRY;
    case "spray": {
      // The jet kicks the canister: a fast, small shake on both hands together.
      const shake = new Vector3(Math.sin(clock * 71) * 0.006, Math.sin(clock * 53) * 0.01, 0);
      return { left: offset(CARRY.left, shake), right: offset(CARRY.right, shake), lean: 0.05 };
    }
    case "chop": {
      const lift = chopLift(clock / CHOP_PERIOD);
      return {
        left: CHOP_LEFT,
        right: offset(
          CHOP_RIGHT,
          new Vector3(0, -CHOP_DROP * (1 - lift), 0),
          // Fingers tip down as the knife meets the board.
          new Vector3(0, -0.25 * (1 - lift), 0),
        ),
        // The torso dips into each strike, which reads from above where the hands may not.
        lean: CHOP_LEAN * (0.8 + 0.2 * (1 - lift)),
      };
    }
    case "wash": {
      // Two circles half a turn apart, as hands scrubbing a plate between them.
      const angle = (clock / WASH_PERIOD) * Math.PI * 2;
      const circle = (phase: number) => new Vector3(
        Math.cos(angle + phase) * WASH_RADIUS,
        Math.sin(angle * 2 + phase) * 0.012,
        Math.sin(angle + phase) * WASH_RADIUS,
      );
      return {
        left: offset(WASH_LEFT, circle(0)),
        right: offset(WASH_RIGHT, circle(Math.PI)),
        lean: WASH_LEAN * (0.92 + 0.08 * Math.sin(angle)),
      };
    }
  }
};

/** The pose at a moment: every active pose, blended by its weight. */
const blendGoals = (weights: PoseWeights, clocks: PoseWeights): PoseGoal | null => {
  let total = 0;
  for (const kind of POSED_KINDS) total += weights[kind];
  if (total < 1e-3) return null;
  const wrist = { left: Vector3.Zero(), right: Vector3.Zero() };
  const fingers = { left: Vector3.Zero(), right: Vector3.Zero() };
  const pole = { left: Vector3.Zero(), right: Vector3.Zero() };
  let lean = 0;
  for (const kind of POSED_KINDS) {
    const weight = weights[kind];
    if (weight <= 0) continue;
    const share = weight / total;
    const now = poseGoal(kind, clocks[kind]);
    for (const side of ["left", "right"] as const) {
      wrist[side].addInPlace(now[side].wrist.scale(share));
      fingers[side].addInPlace(now[side].fingers.scale(share));
      pole[side].addInPlace(now[side].pole.scale(share));
    }
    // Not normalised: the lean fades in with its pose rather than snapping.
    lean += now.lean * weight;
  }
  const hand = (side: "left" | "right"): HandGoal => ({
    wrist: wrist[side],
    fingers: fingers[side].normalize(),
    pole: pole[side].normalize(),
  });
  return { left: hand("left"), right: hand("right"), lean };
};

interface Arm {
  readonly upper: TransformNode;
  readonly fore: TransformNode;
  readonly hand: TransformNode;
  /** The fingertip joint, which gives the direction the hand points. */
  readonly tip: TransformNode;
}

/**
 * A joint this pose turns, with the rotation the animation gave it this frame
 * and the one written over it.
 */
class PosedJoint {
  readonly animated = Quaternion.Identity();
  readonly written = Quaternion.Identity();
  private owned = false;

  constructor(readonly node: TransformNode) {}

  /**
   * Takes this frame's animated rotation. A joint still holding what was written
   * last frame was not animated since, and goes back to its animated rotation:
   * posing on top of our own result would add up frame after frame.
   */
  begin(): void {
    const rotation = this.node.rotationQuaternion ?? Quaternion.FromEulerVector(this.node.rotation);
    this.node.rotationQuaternion = rotation;
    if (this.owned && rotation.equalsWithEpsilon(this.written, 1e-6)) rotation.copyFrom(this.animated);
    else this.animated.copyFrom(rotation);
    this.owned = false;
  }

  /** Blends what was solved over the animated rotation and remembers the result. */
  commit(weight: number): void {
    const rotation = this.node.rotationQuaternion!;
    if (weight < 1) Quaternion.SlerpToRef(this.animated, rotation, weight, rotation);
    this.written.copyFrom(rotation);
    this.owned = true;
  }
}

const scratch = {
  inverse: Matrix.Identity(),
  from: Vector3.Zero(),
  to: Vector3.Zero(),
  swing: Quaternion.Identity(),
  shoulder: Vector3.Zero(),
  elbow: Vector3.Zero(),
  wrist: Vector3.Zero(),
  target: Vector3.Zero(),
  reached: Vector3.Zero(),
  pole: Vector3.Zero(),
  point: Vector3.Zero(),
  frameRotation: Quaternion.Identity(),
};

/**
 * Turns `joint` so the point `current`, which it carries, moves onto the line
 * from the joint towards `desired`. Both are world positions.
 */
const aim = (joint: TransformNode, current: Vector3, desired: Vector3): void => {
  const parent = joint.parent as TransformNode | null;
  const origin = joint.getAbsolutePosition();
  const { inverse, from, to, swing } = scratch;
  if (parent) parent.getWorldMatrix().invertToRef(inverse);
  else inverse.copyFrom(Matrix.IdentityReadOnly);
  Vector3.TransformNormalToRef(current.subtract(origin), inverse, from);
  Vector3.TransformNormalToRef(desired.subtract(origin), inverse, to);
  if (from.lengthSquared() < 1e-12 || to.lengthSquared() < 1e-12) return;
  Quaternion.FromUnitVectorsToRef(from.normalize(), to.normalize(), swing);
  const rotation = joint.rotationQuaternion ?? Quaternion.FromEulerVector(joint.rotation);
  swing.multiplyToRef(rotation, rotation);
  joint.rotationQuaternion = rotation;
};

const refresh = (nodes: readonly TransformNode[]): void => {
  for (const node of nodes) node.computeWorldMatrix(true);
};

export class ArmPoser {
  private readonly observer: Observer<Scene>;
  private pose: ArmPose = "none";
  private readonly weights: Record<PosedKind, number> = { carry: 0, chop: 0, wash: 0, spray: 0 };
  /** Seconds each pose has been held, from 0 each time it starts. */
  private readonly clocks: Record<PosedKind, number> = { carry: 0, chop: 0, wash: 0, spray: 0 };
  private knife: TransformNode | null = null;
  private readonly posed: ReadonlyMap<TransformNode, PosedJoint>;

  private constructor(
    private readonly scene: Scene,
    private readonly frame: TransformNode,
    private readonly arms: { readonly left: Arm; readonly right: Arm },
    /** Every joint from the top of the model down to both shoulders, parents first. */
    private readonly torso: readonly TransformNode[],
    private readonly spine: { readonly joint: TransformNode; readonly child: TransformNode } | null,
    private readonly suppressed: () => boolean,
  ) {
    const joints = [arms.left, arms.right].flatMap((arm) => [arm.upper, arm.fore, arm.hand]);
    if (spine) joints.unshift(spine.joint);
    this.posed = new Map(joints.map((node) => [node, new PosedJoint(node)]));
    this.observer = scene.onAfterAnimationsObservable.add(() => {
      this.update(scene.getEngine().getDeltaTime() / 1000);
    });
  }

  /**
   * @param frame The node the cook's own frame hangs from: it turns with the cook and
   *   sits at their feet, unscaled.
   * @param suppressed True while something else owns the arms, such as a throw or a
   *   fall; the pose fades out until it is false again.
   * @returns null for a model without Mixamo arms, which is left as it is.
   */
  static attach(
    rootNodes: readonly Node[],
    scene: Scene,
    frame: TransformNode,
    suppressed: () => boolean = () => false,
  ): ArmPoser | null {
    const byName = new Map<string, TransformNode>();
    for (const root of rootNodes) {
      for (const node of [root, ...root.getDescendants()]) {
        if (node instanceof TransformNode && !byName.has(node.name)) byName.set(node.name, node);
      }
    }
    const arm = (side: "Left" | "Right"): Arm | null => {
      const upper = byName.get(`mixamorig:${side}Arm`);
      const fore = byName.get(`mixamorig:${side}ForeArm`);
      const hand = byName.get(`mixamorig:${side}Hand`);
      const tip = byName.get(`mixamorig:${side}HandMiddle4`);
      if (!upper || !fore || !hand || !tip) return null;
      return { upper, fore, hand, tip };
    };
    const left = arm("Left");
    const right = arm("Right");
    if (!left || !right) return null;

    const torso: TransformNode[] = [];
    const seen = new Set<TransformNode>();
    for (const shoulder of [left.upper.parent, right.upper.parent]) {
      const chain: TransformNode[] = [];
      for (let node = shoulder; node instanceof TransformNode; node = node.parent) chain.unshift(node);
      for (const node of chain) {
        if (seen.has(node)) continue;
        seen.add(node);
        torso.push(node);
      }
    }
    const spineJoint = byName.get("mixamorig:Spine1");
    const spineChild = byName.get("mixamorig:Spine2");
    const spine = spineJoint && spineChild ? { joint: spineJoint, child: spineChild } : null;
    return new ArmPoser(scene, frame, { left, right }, torso, spine, suppressed);
  }

  setPose(pose: ArmPose): void {
    this.pose = pose;
  }

  /**
   * A prop to keep in the right hand while chopping, hidden otherwise. It must
   * have no parent: it is placed in world space every frame.
   */
  setKnife(knife: TransformNode | null): void {
    this.knife?.setEnabled(false);
    this.knife = knife;
    knife?.setEnabled(false);
  }

  /** How far into the chopping pose the arms are, 0..1. */
  get chopBlend(): number {
    return this.weights.chop;
  }

  /** How far into a pose that leans over a counter (chopping, washing) the arms are, 0..1. */
  get reachBlend(): number {
    return Math.min(1, this.weights.chop + this.weights.wash);
  }

  /** Whether the knife is in the cook's hand rather than on the board. */
  get holdsKnife(): boolean {
    return this.knife !== null && this.weights.chop > 0.5;
  }

  dispose(): void {
    this.scene.onAfterAnimationsObservable.remove(this.observer);
    this.knife?.setEnabled(false);
  }

  /** Advances the blend and the chop by `seconds`, then poses the arms. */
  update(seconds: number): void {
    if (this.arms.right.hand.isDisposed()) return;
    const dt = Math.min(Math.max(seconds, 0), 0.1);
    const ease = Math.min(1, dt * BLEND_RATE);
    const free = !this.suppressed();
    let total = 0;
    for (const kind of POSED_KINDS) {
      const target = free && this.pose === kind ? 1 : 0;
      let weight = this.weights[kind] + (target - this.weights[kind]) * ease;
      if (weight < 1e-3) weight = 0;
      this.weights[kind] = weight;
      // Each pose starts from its beginning, so the first chop is a full stroke.
      this.clocks[kind] = target || weight > 0 ? this.clocks[kind] + dt : 0;
      total += weight;
    }

    for (const joint of this.posed.values()) joint.begin();
    const pose = blendGoals(this.weights, this.clocks);
    if (pose) this.apply(pose, Math.min(1, total));
    this.placeKnife(chopLift(this.clocks.chop / CHOP_PERIOD));
  }

  private apply(pose: PoseGoal, weight: number): void {
    this.frame.computeWorldMatrix(true);
    refresh(this.torso);
    if (this.spine && pose.lean > 0) this.lean(this.spine.joint, this.spine.child, pose.lean);
    this.solveArm(this.arms.left, pose.left, weight);
    this.solveArm(this.arms.right, pose.right, weight);
  }

  /** Tips the torso forward by `angle`, from `joint` up. */
  private lean(joint: TransformNode, child: TransformNode, angle: number): void {
    const origin = joint.getAbsolutePosition();
    const up = child.getAbsolutePosition().subtract(origin);
    const length = up.length();
    if (length < 1e-6) return;
    const forward = Vector3.TransformNormal(Vector3.Forward(), this.frame.getWorldMatrix()).normalize();
    const tipped = up.scale(Math.cos(angle)).addInPlace(forward.scale(length * Math.sin(angle)));
    aim(joint, child.getAbsolutePosition(), origin.add(tipped));
    this.posed.get(joint)?.commit(1);
    const below = this.torso.indexOf(joint);
    refresh(below >= 0 ? this.torso.slice(below) : this.torso);
  }

  private solveArm(arm: Arm, hand: HandGoal, weight: number): void {
    const { shoulder, elbow, wrist, target, reached, pole, point } = scratch;
    refresh([arm.upper, arm.fore, arm.hand, arm.tip]);

    const world = this.frame.getWorldMatrix();
    Vector3.TransformCoordinatesToRef(hand.wrist, world, target);
    Vector3.TransformNormalToRef(hand.pole, world, pole);
    shoulder.copyFrom(arm.upper.getAbsolutePosition());
    elbow.copyFrom(arm.fore.getAbsolutePosition());
    wrist.copyFrom(arm.hand.getAbsolutePosition());
    const upperLength = Vector3.Distance(shoulder, elbow);
    const foreLength = Vector3.Distance(elbow, wrist);
    const handLength = Vector3.Distance(wrist, arm.tip.getAbsolutePosition());
    solveTwoBone(shoulder, upperLength, foreLength, target, pole, point, reached);

    aim(arm.upper, elbow, point);
    refresh([arm.upper, arm.fore, arm.hand, arm.tip]);
    aim(arm.fore, arm.hand.getAbsolutePosition(), reached);
    refresh([arm.fore, arm.hand, arm.tip]);
    Vector3.TransformNormalToRef(hand.fingers, world, point);
    aim(arm.hand, arm.tip.getAbsolutePosition(), reached.add(point.scale(handLength)));

    for (const joint of [arm.upper, arm.fore, arm.hand]) this.posed.get(joint)?.commit(weight);
    refresh([arm.upper, arm.fore, arm.hand, arm.tip]);
  }

  /** Puts the knife in the right palm, blade forward and in, edge down. */
  private placeKnife(lift: number): void {
    const knife = this.knife;
    if (!knife) return;
    const visible = this.weights.chop > 0.5;
    if (knife.isEnabled() !== visible) knife.setEnabled(visible);
    if (!visible) return;
    const { hand, tip } = this.arms.right;
    const palm = Vector3.Lerp(hand.getAbsolutePosition(), tip.getAbsolutePosition(), 0.42);
    knife.position.copyFrom(palm);
    // In the cook's frame: the blade points forward across the board, tipping down
    // as it strikes, and its spine faces up.
    const blade = new Vector3(-0.45, -0.08 - 0.12 * (1 - lift), 0.88).normalize();
    const spine = Vector3.Up().subtractInPlace(blade.scale(blade.y)).normalize();
    const side = Vector3.Cross(spine.negate(), blade);
    const local = Quaternion.RotationQuaternionFromAxis(spine.negate(), blade, side);
    this.frame.getWorldMatrix().decompose(undefined, scratch.frameRotation);
    knife.rotationQuaternion = scratch.frameRotation.multiply(local);
  }
}
