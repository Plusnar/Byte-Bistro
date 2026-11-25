import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Scene } from "@babylonjs/core/scene";
import type { AssetManager } from "../core/AssetManager";
import type { MechanismConfig } from "../data/mechanismConfig";
import { ROBOT_VARIANT_CHARACTERS, type DressedVariant } from "../data/robotVariants";
import { CharacterController } from "../entities/CharacterController";
import { marchDirection, marchMembers } from "../gameplay/mechanisms/MechanismSystem";

/** The parade's dance: a short hop, then a beat on the ground (scripts/robots). */
const DANCE_CLIP = "Fest_Hop";
/** The marchers alternate, man and woman, in festival dress. */
const DRESS: readonly DressedVariant[] = ["german-man", "german-woman"];
/** Travel speed the dance is timed for at a playback rate of 1; faster parades hop faster. */
const CLIP_STRIDE_SPEED = 1.1;

/**
 * The German parade's robots: the Babylon side of a `march` mechanism.
 *
 * Seven dressed robots in a column, hopping to the same clip, every other one half a beat
 * behind so the hops run down the line as a wave. Where the column is and which way it faces come from
 * `MechanismSystem` (a function of the kitchen clock, through `KitchenMechanisms`); this
 * only puts the robots there. Each one turns in place at the ends, so the column walks
 * back over the same ground rather than swinging round its middle.
 *
 * Owned by `KitchenEnvironment`, which disposes it. Its robots sit under their own node,
 * not the mechanism's: skinned, animated meshes must stay out of the static batch.
 */
export class MarchLine {
  readonly ready: Promise<void>;
  private readonly root: TransformNode;
  private readonly members: { readonly node: TransformNode; readonly controller: CharacterController }[] = [];
  private readonly routeYaw: number;
  private heading = Number.NaN;
  private moving = true;
  private disposed = false;

  constructor(scene: Scene, assets: AssetManager, parent: TransformNode, config: MechanismConfig) {
    this.root = new TransformNode("march-line", scene);
    this.root.parent = parent;
    const direction = marchDirection(config);
    this.routeYaw = Math.atan2(direction.x, direction.z);
    marchMembers(config, { x: 0, z: 0 }).forEach((offset, index) => {
      const node = new TransformNode(`march-robot-${index}`, scene);
      node.parent = this.root;
      node.position.set(offset.x, 0, offset.z);
      node.rotation.y = this.routeYaw;
      this.members.push({ node, controller: new CharacterController(scene, assets, node) });
    });
    const rate = Math.min(2, Math.max(0.4, config.speed / CLIP_STRIDE_SPEED));
    this.ready = Promise.all(this.members.map(async ({ controller }, index) => {
      await controller.selectCharacter(ROBOT_VARIANT_CHARACTERS[DRESS[index % DRESS.length]!]);
      await controller.playAmbientClip(DANCE_CLIP, "fest");
    })).then(() => {
      if (this.disposed) return;
      // Loaded one by one, they started one by one: restarted together, every other one
      // half a beat later, so each lands as its neighbour takes off.
      for (const [index, { controller }] of this.members.entries()) {
        controller.setAnimationSpeed(rate);
        controller.restartAnimation(index % 2 === 0 ? 0 : 0.5);
        if (!this.moving) controller.setAnimationPaused(true);
      }
    });
  }

  /**
   * Puts the column at `position`, facing `heading` (radians added to the route's own
   * direction: 0 out, π back), stepping or standing still.
   */
  update(position: Vector3, heading: number, moving: boolean): void {
    this.root.position.copyFrom(position);
    if (heading !== this.heading) {
      this.heading = heading;
      for (const { node } of this.members) node.rotation.y = this.routeYaw + heading;
    }
    if (moving !== this.moving) {
      this.moving = moving;
      for (const { controller } of this.members) controller.setAnimationPaused(!moving);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { controller } of this.members) controller.dispose();
    this.members.length = 0;
    this.root.dispose(false, false);
  }
}
