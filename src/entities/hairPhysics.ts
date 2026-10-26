import {
  Matrix,
  Quaternion,
  TransformNode,
  Vector3,
  type Node,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import type { HairSpring } from "../data/characters";

/**
 * Spring hair for cooks rigged by scripts/rig-hair.py.
 *
 * Each lock of hair is a chain of joints under the head, `hair.<lock>.0`,
 * `hair.<lock>.1`… and a `hair.<lock>.tip` node past the last one. Every frame,
 * after the animations have posed the body, the tip of each joint is moved like
 * a weight on a spring: it is carried along with the head, keeps some of the
 * swing it had relative to the head, is pulled back towards where the pose puts
 * it, and sags under gravity. The joint is then turned to point at it.
 * `hair.collider`, a sphere at the skull centre, keeps the tips out of the head.
 *
 * Long hair can also be kept out of the body (spheres round the upper spine and
 * neck) and made to stiffen towards its root (`taper`), so a ponytail hangs from
 * its band and swings freely at the end.
 *
 * The drag only slows the swing relative to the head, never the cook's own
 * travel. Damping the absolute motion instead acts like a gale, holding every
 * lock blown back against its limit.
 *
 * The cook's travel across the floor carries the hair along with it outright:
 * the game starts and stops a cook within a few frames, and hair that felt those
 * jolts would whip about. What travel does to hair is the air it walks into, a
 * separate gentle push (`wind`) against how fast the body moves, smoothed over a
 * few tenths of a second. The hair streams back as the cook walks off and falls
 * again as they stop, without picking up the bob of each step. Turning, and the
 * body's own motion in its clips, still swing the hair freely.
 *
 * Each frame is simulated in equal steps of at most 1/60 s, and always at least
 * one: a fixed step left some frames with no step and the next with two, so the
 * hair stood still one frame and jumped the next, and on a real, uneven frame
 * rate it shook. The drag is scaled to the step, so the hair swings the same at
 * any frame rate.
 */

const STEP = 1 / 60;
/** Most steps one frame is split into; a longer frame is shortened to fit. */
const MAX_STEPS = 4;
/** A frame longer than this is a stall, not motion. */
const STALL_SECONDS = 0.25;
/** A joint moving further than this many of its own lengths in a frame was teleported. */
const TELEPORT_LENGTHS = 6;
/**
 * Past this share of `maxAngle` a lock is pulled back ever harder, this many times
 * its own stiffness at the limit. It slows to a stop rather than hitting the
 * limit, which would halt it within a step and read as a jolt.
 */
const SOFT_LIMIT = 0.5;
const LIMIT_PULL = 3;
/** How long the body's travel is smoothed over before it blows the hair back, in seconds. */
const WIND_SECONDS = 0.15;
/** A body moving faster than this, in metres per second, was teleported. */
const TELEPORT_SPEED = 30;

interface Segment {
  readonly joint: TransformNode;
  readonly parent: TransformNode;
  /** The joint's rotation relative to its parent in the bind pose. */
  readonly restRotation: Quaternion;
  /** Where the child sits in the joint's own space. */
  readonly childOffset: Vector3;
  /** The same direction, in the parent's space at rest. */
  readonly restDirection: Vector3;
  readonly tail: Vector3;
  readonly previousTail: Vector3;
  /** Where the pose put the tail last step, and how far the head moved it then. */
  readonly previousTarget: Vector3;
  readonly carried: Vector3;
  /** This segment's own stiffness, after the taper along its lock. */
  readonly stiffness: number;
  /** Straight down, in the parent's space while the cook stands upright. */
  readonly restDown: Vector3;
}

interface Collider {
  readonly node: TransformNode;
  readonly centre: Vector3;
  /** Radius in the node's own units; scaled to the world each step. */
  readonly size: number;
  radius: number;
}

/** The joints long hair is kept off, with each sphere's share of `body`. */
const BODY_JOINTS: readonly [string, number][] = [
  ["mixamorig:Spine1", 1],
  ["mixamorig:Spine2", 1.05],
  ["mixamorig:Neck", 0.6],
];

const HAIR_JOINT = /^hair\.(.+)\.(\d+)$/;

const scratch = {
  parentWorld: Matrix.Identity(),
  inverseParent: Matrix.Identity(),
  origin: Vector3.Zero(),
  target: Vector3.Zero(),
  next: Vector3.Zero(),
  velocity: Vector3.Zero(),
  moved: Vector3.Zero(),
  down: Vector3.Zero(),
  direction: Vector3.Zero(),
  local: Vector3.Zero(),
  offset: Vector3.Zero(),
  normal: Vector3.Zero(),
  slide: Vector3.Zero(),
  swing: Quaternion.Identity(),
};

const worldPosition = (node: TransformNode, result: Vector3): Vector3 =>
  result.copyFrom(node.getAbsolutePosition());

export class HairPhysics {
  private readonly observer: Observer<Scene>;
  private settled = false;
  private readonly maxAngle: number;
  /** Where the body was last frame, and its speed smoothed once and twice over. */
  private readonly lastBody = Vector3.Zero();
  private readonly speed = Vector3.Zero();
  private readonly flow = Vector3.Zero();
  private readonly frameVelocity = Vector3.Zero();

  private constructor(
    private readonly scene: Scene,
    private readonly segments: readonly Segment[],
    private readonly colliders: readonly Collider[],
    private readonly spring: HairSpring,
    private readonly body: TransformNode | null,
  ) {
    this.maxAngle = (spring.maxAngle * Math.PI) / 180;
    this.observer = scene.onAfterAnimationsObservable.add(() => {
      this.update(scene.getEngine().getDeltaTime() / 1000);
    });
  }

  /**
   * Starts simulating the hair of a character instance.
   *
   * @returns null for a model without hair joints, which is left as it is.
   */
  static attach(rootNodes: readonly Node[], scene: Scene, spring: HairSpring): HairPhysics | null {
    const nodes = rootNodes.flatMap((root) => [root, ...root.getDescendants()]);
    const byName = new Map<string, TransformNode>();
    for (const node of nodes) {
      if (node instanceof TransformNode && node.name.startsWith("hair.")) byName.set(node.name, node);
    }

    const segments: Segment[] = [];
    // Parents come before children, so each joint is solved after the one above it.
    const joints = [...byName.values()]
      .map((node) => ({ node, match: HAIR_JOINT.exec(node.name) }))
      .filter((entry): entry is { node: TransformNode; match: RegExpExecArray } => entry.match !== null)
      .sort((a, b) => Number(a.match[2]) - Number(b.match[2]));
    const levels = new Map<string, number>();
    for (const { match } of joints) levels.set(match[1]!, Math.max(levels.get(match[1]!) ?? 0, Number(match[2])));
    const taper = spring.taper ?? 1;
    for (const { node, match } of joints) {
      const lock = match[1]!;
      const level = Number(match[2]);
      const last = levels.get(lock) ?? 0;
      const along = last > 0 ? level / last : 0;
      const child = byName.get(`hair.${lock}.${level + 1}`) ?? byName.get(`hair.${lock}.tip`);
      const parent = node.parent;
      if (!child || !(parent instanceof TransformNode)) continue;
      const restRotation = (node.rotationQuaternion ?? Quaternion.FromEulerVector(node.rotation)).clone();
      node.rotationQuaternion = restRotation.clone();
      const childOffset = child.position.clone();
      parent.computeWorldMatrix(true);
      const restDown = Vector3.TransformNormal(Vector3.Down(), parent.getWorldMatrix().clone().invert()).normalize();
      segments.push({
        joint: node,
        parent,
        restRotation,
        childOffset,
        restDirection: childOffset.applyRotationQuaternion(restRotation).normalize(),
        tail: Vector3.Zero(),
        previousTail: Vector3.Zero(),
        previousTarget: Vector3.Zero(),
        carried: Vector3.Zero(),
        stiffness: spring.stiffness * (spring.lockStiffness?.[lock] ?? 1) * (1 - (1 - taper) * along),
        restDown,
      });
    }
    if (segments.length === 0) return null;

    const colliders: Collider[] = [];
    const head = byName.get("hair.collider");
    // The skull: a plain node whose uniform scale is the sphere's radius.
    if (head) colliders.push({ node: head, centre: Vector3.Zero(), size: 1, radius: 0 });
    if (spring.body) {
      for (const node of nodes) {
        const share = BODY_JOINTS.find(([name]) => name === node.name)?.[1];
        if (share && node instanceof TransformNode) {
          colliders.push({ node, centre: Vector3.Zero(), size: spring.body * share, radius: 0 });
        }
      }
    }
    const body = rootNodes.find((node): node is TransformNode => node instanceof TransformNode) ?? null;
    return new HairPhysics(scene, segments, colliders, spring, body);
  }

  /** Drops all motion: the hair snaps to where the pose puts it. */
  reset(): void {
    this.settled = false;
  }

  dispose(): void {
    this.scene.onAfterAnimationsObservable.remove(this.observer);
    for (const segment of this.segments) {
      if (!segment.joint.isDisposed()) segment.joint.rotationQuaternion?.copyFrom(segment.restRotation);
    }
  }

  /** Advances the simulation by `seconds` of real time. */
  update(seconds: number): void {
    if (this.segments[0]?.joint.isDisposed()) return;
    // After a long stall (a background tab, a hitch) the body has jumped; swinging
    // from where the hair was would whip it. Treat the gap as a cut.
    if (!this.settled || seconds > STALL_SECONDS) {
      this.settle();
      return;
    }
    const time = Math.min(Math.max(0, seconds), STEP * MAX_STEPS);
    if (time <= 0) {
      // No time passed, but the body may still have moved: re-aim at the tails
      // already solved so the hair stays attached.
      this.solve(0);
      return;
    }
    if (this.body) {
      this.body.computeWorldMatrix(true);
      const position = this.body.getAbsolutePosition();
      const travel = position.subtract(this.lastBody);
      if (travel.length() > TELEPORT_SPEED * seconds) {
        this.settle();
        return;
      }
      this.lastBody.copyFrom(position);
      // Carry the hair with the body's travel, so only the air below acts on it.
      for (const segment of this.segments) {
        segment.tail.addInPlace(travel);
        segment.previousTail.addInPlace(travel);
        segment.previousTarget.addInPlace(travel);
      }
      // The frame's speed, from the real frame time even when it was cut short.
      this.frameVelocity.copyFrom(travel).scaleInPlace(1 / seconds);
      this.frameVelocity.y = 0;
    }
    const steps = Math.max(1, Math.ceil(time / STEP - 1e-6));
    for (let i = 0; i < steps; i += 1) {
      const dt = time / steps;
      const blend = 1 - Math.exp(-dt / WIND_SECONDS);
      this.frameVelocity.subtractToRef(this.speed, scratch.offset);
      this.speed.addInPlace(scratch.offset.scaleInPlace(blend));
      this.speed.subtractToRef(this.flow, scratch.offset);
      this.flow.addInPlace(scratch.offset.scaleInPlace(blend));
      this.solve(dt);
    }
  }

  /** Puts every tail where the current pose holds it, at rest. */
  private settle(): void {
    for (const segment of this.segments) {
      segment.joint.rotationQuaternion!.copyFrom(segment.restRotation);
      segment.joint.computeWorldMatrix(true);
      Vector3.TransformCoordinatesToRef(segment.childOffset, segment.joint.getWorldMatrix(), segment.tail);
      segment.previousTail.copyFrom(segment.tail);
      segment.previousTarget.copyFrom(segment.tail);
      segment.carried.setAll(0);
    }
    if (this.body) {
      this.body.computeWorldMatrix(true);
      this.lastBody.copyFrom(this.body.getAbsolutePosition());
    }
    this.speed.setAll(0);
    this.flow.setAll(0);
    this.settled = true;
  }

  private solve(dt: number): void {
    const { spring } = this;
    const { parentWorld, inverseParent, origin, target, next, velocity, moved, down, direction, local, offset, swing } = scratch;
    for (const collider of this.colliders) {
      collider.node.computeWorldMatrix(true);
      worldPosition(collider.node, collider.centre);
      Vector3.TransformNormalToRef(Vector3.RightReadOnly, collider.node.getWorldMatrix(), offset);
      collider.radius = offset.length() * collider.size;
    }

    for (const segment of this.segments) {
      segment.parent.computeWorldMatrix(true);
      parentWorld.copyFrom(segment.parent.getWorldMatrix());
      segment.joint.rotationQuaternion!.copyFrom(segment.restRotation);
      segment.joint.computeWorldMatrix(true);
      worldPosition(segment.joint, origin);
      // Where the pose alone would put the tail, and how long the segment is in the world.
      Vector3.TransformCoordinatesToRef(segment.childOffset, segment.joint.getWorldMatrix(), target);
      const length = target.subtract(origin).length();
      if (length < 1e-6) continue;

      if (dt > 0) {
        if (Vector3.Distance(segment.tail, target) > length * TELEPORT_LENGTHS) {
          segment.tail.copyFrom(target);
          segment.previousTail.copyFrom(target);
          segment.previousTarget.copyFrom(target);
          segment.carried.setAll(0);
        }
        // How far the head carried the spot this tail hangs from since the last step.
        target.subtractToRef(segment.previousTarget, moved);
        // The tail keeps its own momentum; the drag only pulls that towards the
        // head's own motion. So a turn, or a toss of the head, leaves the hair
        // behind to swing. `drag` is the share lost per 1/60 s, compounded for
        // the step actually taken.
        segment.tail.subtractToRef(segment.previousTail, velocity);
        next.copyFrom(segment.tail).addInPlace(velocity);
        velocity.subtractInPlace(moved).scaleInPlace(1 - Math.pow(1 - spring.drag, dt / STEP));
        next.subtractInPlace(velocity);
        segment.previousTarget.copyFrom(target);
        segment.carried.copyFrom(moved);
        // Spring back towards the posed direction, and sag. Both are accelerations,
        // tuned at 1/60 s steps: a step of another length gets the same pull.
        const push = (dt * dt) / STEP;
        target.subtractToRef(origin, direction).normalize();
        // Swung far out, the lock meets a steeper pull back (see SOFT_LIMIT).
        next.subtractToRef(origin, local).normalize();
        const out = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(direction, local))));
        const soft = this.maxAngle * SOFT_LIMIT;
        const over = Math.max(0, (out - soft) / (this.maxAngle - soft));
        if (over > 0) {
          direction.subtractToRef(local, offset);
          if (offset.lengthSquared() > 1e-12) {
            // Never more than half the way back to the soft limit in one step: a
            // stiff lock pulled further would overshoot and flick to and fro.
            const pull = Math.min(LIMIT_PULL * segment.stiffness * over * over * push, 0.5 * (out - soft));
            next.addInPlace(offset.normalize().scaleInPlace(pull * length));
          }
        }
        next.addInPlace(direction.scaleInPlace(segment.stiffness * length * push));
        next.y -= spring.gravity * length * push;
        if (spring.wind) {
          // The air pushes against the body's smoothed travel, in proportion to it.
          next.x -= spring.wind * this.flow.x * length * push;
          next.z -= spring.wind * this.flow.z * length * push;
        }
        if (spring.hang) {
          // The pose already hangs: take away the pull it was modelled under, as
          // the head now holds it. Upright that cancels; tipped, the rest pulls down.
          Vector3.TransformNormalToRef(segment.restDown, parentWorld, down).normalize();
          next.addInPlace(down.scaleInPlace(-spring.gravity * length * push));
        }
        const bumped = this.keepOut(next, target);
        // The segment does not stretch.
        next.subtractToRef(origin, direction).normalize();
        segment.previousTail.copyFrom(segment.tail);
        origin.addToRef(direction.scaleInPlace(length), segment.tail);
        // Against the body or the skull the lock slides along it: its swing across
        // the surface is kept and its swing through it, in or out, is dropped. So
        // it neither bounces off each step, which would make it shake, nor sticks
        // there, which would make it jerk.
        if (bumped) {
          const slide = scratch.slide;
          segment.tail.subtractToRef(segment.previousTail, slide).subtractInPlace(segment.carried);
          slide.subtractInPlace(scratch.normal.scale(Vector3.Dot(slide, scratch.normal)));
          segment.tail.subtractToRef(segment.carried, segment.previousTail).subtractInPlace(slide);
        }
      }

      // Aim the joint at its tail, in the parent's space, within the swing limit.
      parentWorld.invertToRef(inverseParent);
      segment.tail.subtractToRef(origin, direction);
      Vector3.TransformNormalToRef(direction, inverseParent, local);
      if (local.lengthSquared() < 1e-12) continue;
      local.normalize();
      const rest = segment.restDirection;
      Quaternion.FromUnitVectorsToRef(rest, local, swing);
      const angle = Math.acos(Math.min(1, Math.max(-1, Vector3.Dot(rest, local))));
      const limited = angle > this.maxAngle;
      if (limited) Quaternion.SlerpToRef(Quaternion.Identity(), swing, this.maxAngle / angle, swing);
      swing.multiplyToRef(segment.restRotation, segment.joint.rotationQuaternion!);
      segment.joint.computeWorldMatrix(true);
      if (limited) {
        // Hold the tail at the limit and stop its swing there. Keeping the speed it
        // had would throw it back at the limit next step, and the lock would shake.
        Vector3.TransformCoordinatesToRef(segment.childOffset, segment.joint.getWorldMatrix(), segment.tail);
        segment.tail.subtractToRef(segment.carried, segment.previousTail);
      }
    }
  }

  /**
   * Pushes `point` out of the skull and the body, but never further out of a
   * sphere than where the pose itself puts it (`posed`). Short locks rest right on
   * the scalp, inside the head sphere; pushing them past their own pose would
   * fight the spring every step and make the hair buzz.
   */
  private keepOut(point: Vector3, posed: Vector3): boolean {
    let bumped = false;
    for (const collider of this.colliders) {
      if (collider.radius <= 0) continue;
      const radius = Math.min(collider.radius, Vector3.Distance(posed, collider.centre) * 0.98);
      point.subtractToRef(collider.centre, scratch.offset);
      const distance = scratch.offset.length();
      if (distance >= radius || distance < 1e-6) continue;
      scratch.normal.copyFrom(scratch.offset).scaleInPlace(1 / distance);
      point.copyFrom(collider.centre).addInPlace(scratch.offset.scaleInPlace(radius / distance));
      bumped = true;
    }
    return bumped;
  }
}
