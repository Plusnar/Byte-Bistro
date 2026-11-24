import {
  AbstractMesh,
  Color3,
  DynamicTexture,
  Mesh,
  Matrix,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector2,
  Vector3,
} from "@babylonjs/core";
import type { InputManager } from "../core/InputManager";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { kitchenAssetId } from "../data/kitchen";
import { getCharacter } from "../data/characters";
import { CARRY_HOLD, type ArmPose } from "./armPose";
import { CharacterController } from "./CharacterController";
import { GAME_CONFIG } from "../config";
import type { IngredientVisual } from "./IngredientVisual";
import {
  GROUNDED_SWEEP_DROP,
  GROUND_Y,
  clampDisplacementToBounds,
  easeStepOffset,
  groundedSweepY,
  integrateFall,
  isGroundedOn,
  settleOnFloor,
} from "./groundedMove";
import { STEP_HEIGHT, markCharacterBody, probeGroundHeight } from "../physics/groundProbe";
import { STEP_OVER_HEIGHT } from "../physics/collisionPolicy";
import { STUN_SECONDS, STUN_SLIDE_DECELERATION, stunSlideSpeed } from "./stun";
import {
  advanceDash,
  beginDash,
  cancelDash,
  canDash,
  dashReadiness,
  dashSpeed,
  isDashing,
  IDLE_DASH,
  type DashState,
} from "./dash";

export type ByteExpression = "^_^" | "-_-" | "O_O" | ">_<" | "X_X";

export interface MovementBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface PlayerOptions {
  spawnPosition?: Vector3;
  walkSpeed?: number;
  runSpeed?: number;
  acceleration?: number;
  deceleration?: number;
  movementRotation?: number;
  assetManager?: AssetManager;
  /** A tag floating over the cook ("P1" in their colour), so two cooks in the same outfit
   *  are told apart. None when omitted. */
  tag?: { readonly label: string; readonly color: string };
}

const ROTATION_RESPONSE = 13;
const WALK_CYCLE_SPEED = 11;
const STAND_UP_DURATION = 0.55;
/** How far the primitive avatar tips over while downed. */
const LYING_PITCH = -Math.PI / 2;
const LYING_VISUAL_Y = 0.34;
const STUN_BADGE_HEIGHT = 2.1;
/** The player tag floats here, over the head; the stun stars take its place while down. */
const PLAYER_TAG_HEIGHT = 2.05;
/**
 * How far the body steps in towards the board or the sink while working at it. The collider keeps a
 * wider berth than the cooks' bodies need, which would leave their hands short of it.
 */
const CHOP_STEP_IN = 0.2;
/** The board's knife at the size of the cooks' hands: about 25 cm long. */
const HAND_KNIFE_SCALE = 0.22;
/** Seconds the beam takes to lift a cook into the saucer. */
const ABDUCT_RISE_SECONDS = 1.3;
/** How high above the floor a cook dropped by the saucer starts falling. */
const SKY_DROP_HEIGHT = 9;
const SKY_FALL_ACCELERATION = 22;

let playerSequence = 0;

/** Primitive-based BYTE avatar with movement/collision logic independent of art assets. */
export class Player {
  readonly root: Mesh;
  readonly velocity = new Vector3();
  readonly carryAnchor: TransformNode;

  private readonly visualRoot: TransformNode;
  private readonly leftArm: Mesh;
  private readonly rightArm: Mesh;
  private readonly leftFoot: Mesh;
  private readonly rightFoot: Mesh;
  private readonly faceTexture: DynamicTexture;
  private readonly ownedMaterials: StandardMaterial[] = [];
  private readonly inputVector = new Vector2();
  private readonly displacement = new Vector3();
  private readonly characterController: CharacterController | null;
  private walkClock = 0;
  private expressionValue: ByteExpression = "^_^";
  private downed = false;
  private downedTimer = 0;
  private standUpTimer = 0;
  /** Length of the current stand-up, which the clip decides when it has one. */
  private standUpDuration = STAND_UP_DURATION;
  /** True while a stand-up clip is playing and must not be interrupted. */
  private standUpAnimated = false;
  private standUpYaw = 0;
  private downedYaw = 0;
  private stunClock = 0;
  private dash: DashState = IDLE_DASH;
  private readonly slideVelocity = new Vector3();
  private readonly stunBadge: Mesh;
  private readonly tag: Mesh | null = null;
  private tagTexture: DynamicTexture | null = null;
  private readonly stunTexture: DynamicTexture;
  private carriedVisual: IngredientVisual | null = null;
  private readonly assets: AssetManager | null;
  private knife: { readonly holder: TransformNode; model: ModelInstance | null } | null = null;
  /**
   * Taken by the saucer: rising up its beam, gone inside it, or falling back from
   * the sky. Null when the cook is in the kitchen.
   */
  private abduction: {
    phase: "rising" | "gone" | "falling";
    clock: number;
    readonly ship: TransformNode | null;
    readonly from: Vector3;
  } | null = null;
  private readonly walkSpeed: number;
  private readonly runSpeed: number;
  private readonly acceleration: number;
  private readonly deceleration: number;
  private readonly movementRotation: number;
  /** Parent of every visible part; offset while the body catches up with a step. */
  private readonly stepNode: TransformNode;
  /** How far the visible body trails the collider after a step, in metres. */
  private stepOffset = 0;
  /** Whether the last move ended standing on a surface; saves probing twice a frame. */
  private onFloor = true;

  constructor(private readonly scene: Scene, options: PlayerOptions = {}) {
    const sequence = playerSequence++;
    this.walkSpeed = options.walkSpeed ?? 3.4;
    this.runSpeed = options.runSpeed ?? 5.25;
    this.acceleration = options.acceleration ?? 22;
    this.deceleration = options.deceleration ?? 30;
    this.movementRotation = options.movementRotation ?? 0;
    this.assets = options.assetManager ?? null;

    this.root = MeshBuilder.CreateBox(
      `byte-collider-${sequence}`,
      { width: 0.68, height: 1.75, depth: 0.68 },
      scene,
    );
    // CreateBox is origin-centred, so the collider would span -0.875..0.875 while the root's
    // origin means "feet". Baking the offset into the vertices lifts it to 0..1.75 without
    // moving the parented visuals — and removes the coincidence where one chef's top face
    // sat 5 mm from the other chef's collision-ellipsoid centre, which froze both of them.
    this.root.bakeTransformIntoVertices(Matrix.Translation(0, 0.875, 0));
    this.root.visibility = 0;
    this.root.isPickable = false;
    this.root.checkCollisions = true;
    this.root.ellipsoid.set(0.33, 0.86, 0.33);
    // The base sits STEP_OVER_HEIGHT above the feet, level with the tallest
    // thing that has no collider, so trim and cabling never catch it. Taller
    // steps are climbed by tryStepUp; lifting the capsule a whole step instead
    // would leave its rounded base barely grazing a knee-high crate.
    this.root.ellipsoidOffset.set(0, 0.86 + STEP_OVER_HEIGHT, 0);
    markCharacterBody(this.root);
    this.root.position.copyFrom(options.spawnPosition ?? Vector3.Zero());

    // Everything visible hangs from here rather than from the collider, so a
    // step can move the collider at once while the body follows smoothly.
    this.stepNode = new TransformNode(`byte-step-${sequence}`, scene);
    this.stepNode.parent = this.root;
    this.visualRoot = new TransformNode(`byte-visual-${sequence}`, scene);
    this.visualRoot.parent = this.stepNode;

    const navy = this.createMaterial(`byte-navy-${sequence}`, "#19324D", "#020910");
    const white = this.createMaterial(`byte-white-${sequence}`, "#EAF7FF", "#0B1117");
    const dark = this.createMaterial(`byte-dark-${sequence}`, "#07151F", "#000000");
    const cyan = this.createMaterial(`byte-cyan-${sequence}`, "#21C7E8", "#0A9FC6");
    const apron = this.createMaterial(`byte-apron-${sequence}`, "#FCFCFF", "#111827");

    const body = this.box(`byte-body-${sequence}`, 0.7, 0.62, 0.46, navy);
    body.position.y = 0.92;

    const chestLight = this.box(`byte-chest-light-${sequence}`, 0.22, 0.08, 0.025, cyan);
    chestLight.position.set(0, 1.02, 0.245);

    const apronPanel = this.box(`byte-apron-${sequence}`, 0.5, 0.38, 0.035, apron);
    apronPanel.position.set(0, 0.79, 0.255);

    const head = this.box(`byte-head-${sequence}`, 0.68, 0.48, 0.5, white);
    head.position.y = 1.44;

    const screen = MeshBuilder.CreatePlane(
      `byte-face-${sequence}`,
      { width: 0.52, height: 0.3, sideOrientation: Mesh.DOUBLESIDE },
      scene,
    );
    screen.parent = this.visualRoot;
    screen.position.set(0, 1.44, 0.256);
    screen.rotation.y = Math.PI;
    this.faceTexture = new DynamicTexture(
      `byte-face-texture-${sequence}`,
      { width: 512, height: 256 },
      scene,
      false,
    );
    const screenMaterial = new StandardMaterial(`byte-screen-${sequence}`, scene);
    screenMaterial.diffuseColor = Color3.Black();
    screenMaterial.emissiveColor = Color3.FromHexString("#27E7FF").scale(0.75);
    screenMaterial.emissiveTexture = this.faceTexture;
    screenMaterial.diffuseTexture = this.faceTexture;
    screenMaterial.disableLighting = true;
    this.ownedMaterials.push(screenMaterial);
    screen.material = screenMaterial;
    screen.isPickable = false;

    this.leftArm = this.box(`byte-arm-left-${sequence}`, 0.17, 0.5, 0.18, navy);
    this.leftArm.position.set(-0.44, 0.94, 0);
    this.rightArm = this.box(`byte-arm-right-${sequence}`, 0.17, 0.5, 0.18, navy);
    this.rightArm.position.set(0.44, 0.94, 0);

    const leftGlove = this.sphere(`byte-glove-left-${sequence}`, 0.22, white);
    leftGlove.position.set(-0.44, 0.65, 0);
    const rightGlove = this.sphere(`byte-glove-right-${sequence}`, 0.22, white);
    rightGlove.position.set(0.44, 0.65, 0);

    const leftLeg = this.box(`byte-leg-left-${sequence}`, 0.2, 0.34, 0.2, dark);
    leftLeg.position.set(-0.2, 0.42, 0);
    const rightLeg = this.box(`byte-leg-right-${sequence}`, 0.2, 0.34, 0.2, dark);
    rightLeg.position.set(0.2, 0.42, 0);

    this.leftFoot = this.box(`byte-foot-left-${sequence}`, 0.27, 0.16, 0.38, white);
    this.leftFoot.position.set(-0.2, 0.17, 0.06);
    this.rightFoot = this.box(`byte-foot-right-${sequence}`, 0.27, 0.16, 0.38, white);
    this.rightFoot.position.set(0.2, 0.17, 0.06);

    const hatBand = MeshBuilder.CreateCylinder(
      `byte-hat-band-${sequence}`,
      { height: 0.16, diameter: 0.6, tessellation: 12 },
      scene,
    );
    hatBand.parent = this.visualRoot;
    hatBand.position.y = 1.75;
    hatBand.material = white;
    hatBand.isPickable = false;

    const hatTop = MeshBuilder.CreateSphere(
      `byte-hat-top-${sequence}`,
      { diameter: 0.58, segments: 8 },
      scene,
    );
    hatTop.parent = this.visualRoot;
    hatTop.position.y = 1.92;
    hatTop.scaling.y = 0.65;
    hatTop.material = white;
    hatTop.isPickable = false;

    this.carryAnchor = new TransformNode(`byte-carry-anchor-${sequence}`, scene);
    this.carryAnchor.parent = this.stepNode;
    this.carryAnchor.position.set(0, 1.12, 0.62);

    this.stunTexture = this.createStunTexture(sequence);
    this.stunBadge = MeshBuilder.CreatePlane(`byte-stun-${sequence}`, { size: 0.6 }, scene);
    this.stunBadge.parent = this.stepNode;
    this.stunBadge.position.y = STUN_BADGE_HEIGHT;
    this.stunBadge.billboardMode = Mesh.BILLBOARDMODE_ALL;
    this.stunBadge.isPickable = false;
    this.stunBadge.renderingGroupId = 1;
    const stunMaterial = new StandardMaterial(`byte-stun-mat-${sequence}`, scene);
    stunMaterial.diffuseTexture = this.stunTexture;
    // Masking the emissive by the texture keeps the GlowLayer on the stars, not the quad.
    stunMaterial.emissiveTexture = this.stunTexture;
    stunMaterial.useAlphaFromDiffuseTexture = true;
    stunMaterial.disableLighting = true;
    stunMaterial.backFaceCulling = false;
    this.ownedMaterials.push(stunMaterial);
    this.stunBadge.material = stunMaterial;
    this.stunBadge.setEnabled(false);

    if (options.tag) {
      this.tagTexture = this.createTagTexture(sequence, options.tag.label, options.tag.color);
      const tag = MeshBuilder.CreatePlane(`byte-tag-${sequence}`, { width: 0.74, height: 0.37 }, scene);
      tag.parent = this.stepNode;
      tag.position.y = PLAYER_TAG_HEIGHT;
      tag.billboardMode = Mesh.BILLBOARDMODE_ALL;
      tag.isPickable = false;
      // Drawn over the scene like the stun stars, so a counter or another cook never hides it.
      tag.renderingGroupId = 1;
      const tagMaterial = new StandardMaterial(`byte-tag-mat-${sequence}`, scene);
      tagMaterial.diffuseTexture = this.tagTexture;
      tagMaterial.emissiveTexture = this.tagTexture;
      tagMaterial.useAlphaFromDiffuseTexture = true;
      tagMaterial.disableLighting = true;
      tagMaterial.backFaceCulling = false;
      this.ownedMaterials.push(tagMaterial);
      tag.material = tagMaterial;
      this.tag = tag;
    }

    this.characterController = options.assetManager
      ? new CharacterController(scene, options.assetManager, this.stepNode, GAME_CONFIG.characterLift)
      : null;
    this.setExpression(this.expressionValue);
  }

  get expression(): ByteExpression {
    return this.expressionValue;
  }

  get position(): Vector3 {
    return this.root.position;
  }

  /** Yaw of the direction the player faces; +z at 0, +x at PI/2. */
  get facingYaw(): number {
    return this.root.rotationQuaternion
      ? this.root.rotationQuaternion.toEulerAngles().y
      : this.root.rotation.y;
  }

  get carriedItem(): IngredientVisual | null {
    return this.carriedVisual;
  }

  get selectedCharacterId(): string | null {
    return this.characterController?.characterId ?? null;
  }

  get characterDebugSummary(): string {
    return this.characterController?.debugSummary ?? "disabled";
  }

  get characterDebugBounds(): string {
    return this.characterController?.debugBounds ?? "—";
  }

  get characterAnimation(): string {
    return this.characterController?.locomotionState ?? "none";
  }

  isDowned(): boolean {
    return this.downed || this.standUpTimer > 0 || this.abduction !== null;
  }

  /**
   * Moves the cook by `(dx, dz)` without them walking: a platform carrying them along, or
   * a conveyor pushing them.
   *
   * Swept with collision rather than written into the position, so a belt that presses a
   * cook into a counter stops at the counter instead of posting them through it. Called
   * before `update`, so their own movement is still resolved against where they ended up.
   */
  applyCarry(dx: number, dz: number): void {
    if (this.isDowned() || (dx === 0 && dz === 0)) return;
    // A exactly-zero Y makes Babylon's collision sweep degenerate; see `update`.
    this.displacement.set(dx, -1e-4, dz);
    this.root.moveWithCollisions(this.displacement);
  }

  /** Whether the cook is mid-burst, for the shove it gives and the sound it makes. */
  get isDashing(): boolean {
    return isDashing(this.dash);
  }

  /** Where the current burst is heading. Meaningless unless `isDashing`. */
  get dashDirection(): Readonly<{ x: number; z: number }> {
    return { x: this.dash.directionX, z: this.dash.directionZ };
  }

  /** How ready the dash is, 0 right after one and 1 when it can be used again. */
  get dashReadiness(): number {
    return dashReadiness(this.dash);
  }

  /** Whether the saucer has the cook: rising, inside it, or falling back. */
  get isAbducted(): boolean {
    return this.abduction !== null;
  }

  /** Whether the cook is out of the kitchen altogether, inside the saucer. */
  get isGone(): boolean {
    return this.abduction?.phase === "gone";
  }

  /** Lifts the cook up the beam into `ship`, spinning, then hides them inside it. */
  abduct(ship: TransformNode): void {
    if (this.abduction) return;
    this.downed = false;
    this.standUpTimer = 0;
    this.stunBadge.setEnabled(false);
    this.applyLyingPose(0);
    this.velocity.setAll(0);
    this.slideVelocity.setAll(0);
    this.abduction = { phase: "rising", clock: 0, ship, from: this.root.position.clone() };
    this.setExpression("O_O");
  }

  /** Out of the saucer: reappears high above (x, z) and falls back into the kitchen. */
  dropFromSky(x: number, z: number): void {
    if (!this.abduction) return;
    this.root.setEnabled(true);
    this.stepNode.scaling.setAll(1);
    this.root.position.set(x, SKY_DROP_HEIGHT, z);
    this.velocity.setAll(0);
    this.abduction = { phase: "falling", clock: 0, ship: null, from: this.root.position.clone() };
    this.characterController?.resetHair();
  }

  async prepareCharacterAnimations(): Promise<void> {
    await this.characterController?.prepare();
  }

  async selectCharacter(characterId: string): Promise<void> {
    if (!this.characterController) {
      throw new Error("Character assets are not configured for this player.");
    }
    const character = getCharacter(characterId);
    if (!character) {
      throw new Error(`Unknown character: ${characterId}`);
    }
    await this.characterController.selectCharacter(character);
    this.visualRoot.setEnabled(false);
    // The cooks hold what they carry in both hands, in front of the chest; the
    // default spot floats it at the height of the primitive avatar's arms.
    if (character.rig === "Embedded") this.carryAnchor.position.set(...CARRY_HOLD);
  }

  /** `deltaSeconds` is clamped to keep collision response stable after tab switches. */
  update(
    deltaSeconds: number,
    input: InputManager,
    bounds?: Readonly<MovementBounds>,
  ): void {
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.05);
    // The tag steps aside while the stun stars spin where it floats.
    if (this.tag && this.tag.isEnabled() === this.stunBadge.isEnabled()) this.tag.setEnabled(!this.stunBadge.isEnabled());
    this.dash = advanceDash(this.dash, delta);
    this.stepOffset = easeStepOffset(this.stepOffset, delta);
    this.stepNode.position.y = this.stepOffset;
    this.stepNode.position.z = CHOP_STEP_IN * (this.characterController?.reachBlend ?? 0);
    if (this.abduction) {
      this.updateAbduction(delta);
      return;
    }
    if (this.standUpTimer > 0) {
      this.updateStandUp(delta, bounds);
      return;
    }
    if (this.downed) {
      this.updateDowned(delta, bounds);
      return;
    }
    const movement = input.getMovement(this.inputVector);
    const targetSpeed = input.isDown("run") ? this.runSpeed : this.walkSpeed;
    const rawX = movement.x;
    const rawZ = -movement.y;
    const rotationCosine = Math.cos(this.movementRotation);
    const rotationSine = Math.sin(this.movementRotation);
    const worldX = rawX * rotationCosine + rawZ * rotationSine;
    const worldZ = -rawX * rotationSine + rawZ * rotationCosine;
    const targetX = worldX * targetSpeed;
    const targetZ = worldZ * targetSpeed;
    const moving = movement.lengthSquared() > 0;
    const response = (moving ? this.acceleration : this.deceleration) * delta;

    // A dash is committed the moment it starts: it aims where the cook is steering, or
    // where they face when they are standing still, and holds that line to the end.
    if (input.consumePressed("dash") && canDash(this.dash)) {
      const yaw = this.facingYaw;
      this.dash = moving
        ? beginDash(this.dash, worldX, worldZ)
        : beginDash(this.dash, Math.sin(yaw), Math.cos(yaw));
    }

    if (isDashing(this.dash)) {
      // Written straight onto the velocity, not into the acceleration: the sweep below
      // still runs, so a dash can never push a cook through a counter.
      const speed = dashSpeed(this.dash);
      this.velocity.x = this.dash.directionX * speed;
      this.velocity.z = this.dash.directionZ * speed;
    } else {
      this.velocity.x = this.moveTowards(this.velocity.x, targetX, response);
      this.velocity.z = this.moveTowards(this.velocity.z, targetZ, response);
    }

    // Chefs never jump, but the fall is still integrated: a displacement with an exactly
    // zero Y makes Babylon's collision sweep degenerate and freezes the player in place.
    // See src/entities/groundedMove.ts.
    const startX = this.root.position.x;
    const startY = this.root.position.y;
    const startZ = this.root.position.z;
    const grounded = this.onFloor;
    this.velocity.y = integrateFall(this.velocity.y, delta, grounded);
    this.displacement.copyFrom(this.velocity).scaleInPlace(delta);
    // Standing on something, the sweep only has to be off horizontal. Letting it
    // drop at full probe speed ate the clearance a riser passes under.
    if (grounded) this.displacement.y = groundedSweepY(this.displacement.y);

    // Trimming the displacement keeps us inside the bounds without an uncollided teleport,
    // which could otherwise plant the ellipsoid inside a collider it cannot escape.
    if (bounds) {
      const trimmed = clampDisplacementToBounds(this.root.position, this.displacement, bounds);
      this.displacement.x = trimmed.x;
      this.displacement.z = trimmed.z;
    }
    this.root.moveWithCollisions(this.displacement);
    if (grounded) this.resolveGroundedMove(startX, startY, startZ);

    // Stand on whatever solid surface is under the feet — a stair tread, a
    // platform, or the floor. Stepping onto a higher tread, or off onto a lower
    // one, moves the collider now and lets the body follow.
    const position = this.root.position;
    const floor = this.floorBelow();
    // Half on a tread and half off it, the front foot holds the cook up. It can
    // only hold them where they were, never lift them: that takes a step up.
    const footing = position.y > floor
      ? Math.max(floor, Math.min(startY, this.floorAhead()))
      : floor;
    const settled = settleOnFloor(position.y, footing, grounded, STEP_HEIGHT);
    this.onFloor = settled.onFloor;
    if (settled.onFloor) {
      if (settled.y > position.y) position.y = settled.y;
      else if (settled.y < position.y) this.sweepDown(settled.y - position.y);
      this.velocity.y = 0;
      this.absorbStep(position.y - startY);
    }
    if (bounds) {
      this.root.position.x = Math.min(bounds.maxX, Math.max(bounds.minX, this.root.position.x));
      this.root.position.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, this.root.position.z));
    }

    const speedSquared = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    if (speedSquared > 0.01) {
      const desiredYaw = Math.atan2(this.velocity.x, this.velocity.z);
      const difference = Math.atan2(
        Math.sin(desiredYaw - this.root.rotation.y),
        Math.cos(desiredYaw - this.root.rotation.y),
      );
      this.root.rotation.y += difference * Math.min(1, ROTATION_RESPONSE * delta);
    }

    if (this.characterController?.hasCharacter) {
      const runThreshold = this.walkSpeed * 1.12;
      this.characterController.setLocomotion(
        speedSquared <= 0.04
          ? "idle"
          : speedSquared >= runThreshold * runThreshold
            ? "run"
            : "walk",
        Math.sqrt(speedSquared),
      );
    } else {
      this.animateWalk(delta, speedSquared);
    }
  }

  private updateDowned(delta: number, bounds?: Readonly<MovementBounds>): void {
    this.downedTimer += delta;
    this.stunClock += delta;

    const decel = STUN_SLIDE_DECELERATION * delta;
    this.slideVelocity.x = this.moveTowards(this.slideVelocity.x, 0, decel);
    this.slideVelocity.z = this.moveTowards(this.slideVelocity.z, 0, decel);
    // A zero-Y displacement would freeze the slide the same way it froze walking.
    const floorUnder = this.floorBelow();
    const slideGrounded = isGroundedOn(this.root.position.y, floorUnder);
    const slideY = integrateFall(this.velocity.y, delta, slideGrounded);
    this.velocity.y = slideY;
    this.displacement.set(
      this.slideVelocity.x * delta,
      slideGrounded ? groundedSweepY(slideY * delta) : slideY * delta,
      this.slideVelocity.z * delta,
    );
    if (bounds) {
      const trimmed = clampDisplacementToBounds(this.root.position, this.displacement, bounds);
      this.displacement.x = trimmed.x;
      this.displacement.z = trimmed.z;
    }
    // moveWithCollisions, unlike the old ragdoll's direct position writes, respects counters.
    this.root.moveWithCollisions(this.displacement);

    // The line that makes levitation impossible: a downed chef is always on the
    // surface under them — the floor, or the stair they were knocked down on.
    this.root.position.y = this.floorBelow();
    this.onFloor = true;
    if (bounds) {
      this.root.position.x = Math.min(bounds.maxX, Math.max(bounds.minX, this.root.position.x));
      this.root.position.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, this.root.position.z));
    }
    // Yaw only. Pitching the collider is what used to compose with the death clip and read
    // as the character floating or standing on its head.
    this.root.rotation.set(0, this.downedYaw, 0);

    if (this.characterController?.hasCharacter) {
      this.characterController.playDeath();
    } else {
      this.applyLyingPose(1);
    }
    this.updateStunBadge();

    if (this.downedTimer >= STUN_SECONDS) this.standUp();
  }

  /** Lays the primitive avatar down. `amount` 1 = fully down, 0 = upright. */
  private applyLyingPose(amount: number): void {
    this.visualRoot.rotation.x = LYING_PITCH * amount;
    this.visualRoot.position.y = LYING_VISUAL_Y * amount;
    this.leftArm.rotation.x = -0.7 * amount;
    this.rightArm.rotation.x = -0.7 * amount;
  }

  private updateStunBadge(): void {
    this.stunBadge.position.y = STUN_BADGE_HEIGHT + Math.sin(this.stunClock * 4) * 0.06;
    this.stunBadge.rotation.z = Math.sin(this.stunClock * 2.4) * 0.25;
    this.stunBadge.scaling.setAll(1 + Math.abs(Math.sin(this.stunClock * 6)) * 0.12);
  }

  private standUp(): void {
    this.downed = false;
    this.downedTimer = 0;
    const clipSeconds = this.characterController?.playStandUp() ?? 0;
    this.standUpAnimated = clipSeconds > 0;
    // Never shorter than before: the KayKit cooks still rely on the fixed blend.
    this.standUpDuration = Math.max(STAND_UP_DURATION, clipSeconds);
    this.standUpTimer = this.standUpDuration;
    this.slideVelocity.setAll(0);
    this.velocity.setAll(0);
    this.standUpYaw = this.downedYaw;
    this.root.position.y = this.floorBelow();
    this.setExpression("O_O");
  }

  private updateStandUp(delta: number, bounds?: Readonly<MovementBounds>): void {
    this.standUpTimer = Math.max(0, this.standUpTimer - delta);
    const progress = 1 - this.standUpTimer / this.standUpDuration;
    const eased = Math.sin(Math.min(1, progress) * Math.PI * 0.5);
    if (!this.characterController?.hasCharacter) {
      this.applyLyingPose(1 - eased);
    } else if (!this.standUpAnimated) {
      // setLocomotion blends Death_A back out.
      this.characterController.setLocomotion("idle");
    }
    // A stand-up clip plays out on its own; locomotion resumes once it is done.
    this.root.position.y = this.floorBelow();
    this.root.rotation.set(0, this.standUpYaw, 0);
    if (this.standUpTimer <= 0) {
      this.applyLyingPose(0);
      this.setExpression("^_^");
      this.stunBadge.setEnabled(false);
    }
    if (bounds) {
      this.root.position.x = Math.min(bounds.maxX, Math.max(bounds.minX, this.root.position.x));
      this.root.position.z = Math.min(bounds.maxZ, Math.max(bounds.minZ, this.root.position.z));
    }
  }

  /**
   * Keeps a walking cook's feet on the ground after the collision sweep.
   *
   * Babylon's ellipsoid slides up over any edge below its widest point, so a
   * knee-high crate would be ridden like a ramp. A move that rose, or that was
   * stopped short, is therefore redone: as a step up when the surface ahead is
   * low enough, and otherwise as a slide along the obstacle at the same height.
   */
  private resolveGroundedMove(startX: number, startY: number, startZ: number): void {
    const wantX = this.displacement.x;
    const wantZ = this.displacement.z;
    const wanted = wantX * wantX + wantZ * wantZ;
    if (wanted < 1e-8) return;
    const position = this.root.position;
    const movedX = position.x - startX;
    const movedZ = position.z - startZ;
    const rose = position.y > startY + 1e-3;
    // Progress along the intended direction, scaled by its length.
    const progress = rose ? 0 : movedX * wantX + movedZ * wantZ;
    if (!rose && progress >= wanted * 0.9) return;

    // Where to fall back to if climbing does not work out.
    const keptX = rose ? startX : position.x;
    const keptY = rose ? startY : position.y;
    const keptZ = rose ? startZ : position.z;
    if (this.tryStepUp(startX, startY, startZ, wantX, wantZ, progress)) return;
    this.placeCollider(keptX, keptY, keptZ);
    if (!rose) return;

    // The sweep turned the part of the move that pushed into the obstacle
    // upward; take that part out and slide along its side instead.
    let intoX = wantX - movedX;
    let intoZ = wantZ - movedZ;
    const intoLength = Math.hypot(intoX, intoZ);
    if (intoLength < 1e-6) return;
    intoX /= intoLength;
    intoZ /= intoLength;
    const pushing = wantX * intoX + wantZ * intoZ;
    this.displacement.set(wantX - pushing * intoX, -GROUNDED_SWEEP_DROP, wantZ - pushing * intoZ);
    this.root.moveWithCollisions(this.displacement);
    if (position.y > startY + 1e-3) this.placeCollider(startX, startY, startZ);
  }

  /**
   * Retries a blocked move a step higher and keeps it only if it lands on a
   * surface no more than a step above the feet: a stair or a low crate.
   * Anything taller stays a wall. Returns whether the cook stepped up.
   */
  private tryStepUp(
    startX: number,
    startY: number,
    startZ: number,
    wantX: number,
    wantZ: number,
    progress: number,
  ): boolean {
    const position = this.root.position;
    this.placeCollider(startX, startY + STEP_HEIGHT, startZ);
    this.displacement.set(wantX, -GROUNDED_SWEEP_DROP, wantZ);
    this.root.moveWithCollisions(this.displacement);
    const raisedProgress = (position.x - startX) * wantX + (position.z - startZ) * wantZ;
    if (raisedProgress <= progress + 1e-6) return false;

    // The riser is under the front of the capsule, not under its centre.
    const length = Math.hypot(wantX, wantZ);
    const reach = this.root.ellipsoid.x + 0.05;
    const surface = probeGroundHeight(
      this.scene,
      position.x + (wantX / length) * reach,
      position.y,
      position.z + (wantZ / length) * reach,
      this.root,
    );
    if (surface === null || surface <= startY + 0.01 || surface > startY + STEP_HEIGHT) return false;
    position.y = surface;
    return true;
  }

  /**
   * Moves the collider without a sweep. Babylon caches the world matrix for
   * the rest of the frame and the next sweep starts from it, so it has to be
   * refreshed or that sweep would run from where the collider used to be.
   */
  private placeCollider(x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
    this.root.computeWorldMatrix(true);
  }

  /**
   * Lowers the cook onto the surface below with a sweep rather than a jump,
   * so the rounded base comes to rest on a step's edge instead of inside it —
   * a sweep that starts embedded ignores what it is embedded in.
   */
  private sweepDown(drop: number): void {
    this.root.computeWorldMatrix(true);
    // A hair of sideways motion: an exactly vertical sweep is degenerate
    // against vertical faces, the way a flat one is against floors.
    this.displacement.set(1e-4, drop, 1.7e-4);
    this.root.moveWithCollisions(this.displacement);
  }

  /** Height of the surface under the front of the capsule, never below the floor. */
  private floorAhead(): number {
    const speedSquared = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const yaw = this.facingYaw;
    const speed = Math.sqrt(speedSquared);
    const directionX = speedSquared > 0.01 ? this.velocity.x / speed : Math.sin(yaw);
    const directionZ = speedSquared > 0.01 ? this.velocity.z / speed : Math.cos(yaw);
    const reach = this.root.ellipsoid.x;
    const surface = probeGroundHeight(
      this.scene,
      this.root.position.x + directionX * reach,
      this.root.position.y,
      this.root.position.z + directionZ * reach,
      this.root,
    );
    return Math.max(GROUND_Y, surface ?? GROUND_Y);
  }

  /** Height of the walkable surface under the feet, never below the floor. */
  private updateAbduction(delta: number): void {
    const abduction = this.abduction!;
    abduction.clock += delta;
    if (abduction.phase === "rising") {
      const t = Math.min(1, abduction.clock / ABDUCT_RISE_SECONDS);
      const eased = t * t * (3 - 2 * t);
      const ship = abduction.ship?.getAbsolutePosition() ?? abduction.from.add(new Vector3(0, 6, 0));
      // Up the beam towards the saucer's belly, drawn in under it as it moves.
      this.root.position.set(
        abduction.from.x + (ship.x - abduction.from.x) * eased,
        abduction.from.y + (ship.y - 0.6 - abduction.from.y) * eased,
        abduction.from.z + (ship.z - abduction.from.z) * eased,
      );
      this.stepNode.rotation.y += delta * (6 + 14 * t);
      this.stepNode.scaling.setAll(1 - 0.65 * eased);
      this.characterController?.setLocomotion("idle");
      if (t >= 1) {
        abduction.phase = "gone";
        abduction.clock = 0;
        this.root.setEnabled(false);
      }
      return;
    }
    if (abduction.phase === "gone") return;

    // Falling back from the sky, tumbling, until the floor catches them.
    this.velocity.y -= SKY_FALL_ACCELERATION * delta;
    this.root.position.y += this.velocity.y * delta;
    this.stepNode.rotation.y += delta * 9;
    const floor = this.floorBelow();
    if (this.root.position.y > floor) return;
    this.root.position.y = floor;
    this.velocity.setAll(0);
    this.stepNode.rotation.y = 0;
    this.abduction = null;
    this.onFloor = true;
    const angle = Math.random() * Math.PI * 2;
    this.stun(Math.sin(angle), Math.cos(angle), 0.2);
  }

  private floorBelow(): number {
    const surface = probeGroundHeight(
      this.scene,
      this.root.position.x,
      this.root.position.y,
      this.root.position.z,
      this.root,
    );
    return Math.max(GROUND_Y, surface ?? GROUND_Y);
  }

  /**
   * The collider just moved by `change` onto a new surface. Hold the body where
   * it was and let it catch up, capped at one step so a long staircase never
   * leaves it trailing.
   */
  private absorbStep(change: number): void {
    if (change === 0) return;
    this.stepOffset = Math.max(-STEP_HEIGHT, Math.min(STEP_HEIGHT, this.stepOffset - change));
    this.stepNode.position.y = this.stepOffset;
  }

  teleport(position: Vector3): void {
    if (this.abduction) {
      this.abduction = null;
      this.root.setEnabled(true);
      this.stepNode.scaling.setAll(1);
      this.stepNode.rotation.y = 0;
      this.setExpression("^_^");
    }
    this.root.position.copyFrom(position);
    this.velocity.setAll(0);
    // A teleport is a cut, not a step: nothing to smooth over.
    this.stepOffset = 0;
    this.stepNode.position.y = 0;
    this.onFloor = true;
    this.characterController?.resetHair();
    // A cook knocked down when the shift ended must not start the next one lying down,
    // still sliding and wearing the dizzy stars.
    if (this.downed || this.standUpTimer > 0) {
      this.downed = false;
      this.downedTimer = 0;
      this.standUpTimer = 0;
      this.slideVelocity.setAll(0);
      this.stunBadge.setEnabled(false);
      this.applyLyingPose(0);
      if (this.characterController?.hasCharacter) this.characterController.setLocomotion("idle");
    }
  }

  setExpression(expression: ByteExpression): void {
    this.expressionValue = expression;
    const context = this.faceTexture.getContext();
    context.fillStyle = "#031019";
    context.fillRect(0, 0, 512, 256);
    context.fillStyle = "#74F4FF";
    context.font = "bold 112px monospace";
    const expressionWidth = context.measureText(expression).width;
    context.fillText(expression, (512 - expressionWidth) * 0.5, 168);
    this.faceTexture.update();
  }

  /**
   * Overcooked-style hit: the chef falls over where they stand, slides a short distance
   * along (directionX, directionZ) while decelerating, and gets back up on their own.
   *
   * `strength` is 0..1 and scales only the slide — there is deliberately no vertical
   * component, so no amount of tuning can launch a player off the floor again.
   */
  stun(directionX: number, directionZ: number, strength: number): void {
    const length = Math.hypot(directionX, directionZ);
    const nx = length > 1e-3 ? directionX / length : 0;
    const nz = length > 1e-3 ? directionZ / length : 1;
    const speed = stunSlideSpeed(strength);

    this.downed = true;
    this.downedTimer = 0;
    this.standUpTimer = 0;
    this.stunClock = 0;
    // A cook on the floor is not still dashing; the burst would fight the slide.
    this.dash = cancelDash(this.dash);
    this.slideVelocity.set(nx * speed, 0, nz * speed);
    this.velocity.setAll(0);
    this.downedYaw = this.facingYaw;
    // Steering uses rotation.y, which Babylon ignores while a quaternion is set.
    this.root.rotationQuaternion = null;
    this.root.rotation.set(0, this.downedYaw, 0);
    this.root.position.y = this.floorBelow();
    this.applyLyingPose(1);
    this.setExpression("X_X");
    this.stunBadge.setEnabled(true);
  }

  /**
   * What the arms hold over the legs' clip: the carried item, or the knife at a
   * board. The knife is made the first time the cook chops.
   */
  setArmPose(pose: ArmPose): void {
    if (pose === "chop") this.ensureKnife();
    this.characterController?.setArmPose(pose);
  }

  /** Whether the cook holds the board's knife, which the board then hides. */
  get holdsKnife(): boolean {
    return this.characterController?.holdsKnife ?? false;
  }

  /** Arm swing for throwing or setting an item down. Ignored while on the floor. */
  playThrowGesture(): void {
    if (this.isDowned()) return;
    this.characterController?.playGesture();
  }

  setCarriedItem(item: IngredientVisual | null): void {
    if (item === this.carriedVisual) {
      return;
    }

    if (this.carriedVisual) {
      this.carriedVisual.detachAt(this.carryAnchor.getAbsolutePosition());
    }
    this.carriedVisual = item;
    item?.attachTo(this.carryAnchor);
  }

  dropCarriedItem(position?: Vector3): IngredientVisual | null {
    const item = this.carriedVisual;
    if (!item) {
      return null;
    }

    const dropPosition = position ?? this.carryAnchor.getAbsolutePosition();
    item.detachAt(dropPosition);
    this.carriedVisual = null;
    return item;
  }

  dispose(): void {
    this.dropCarriedItem();
    this.characterController?.dispose();
    this.knife?.model?.dispose();
    this.knife?.holder.dispose(false, false);
    this.knife = null;
    this.faceTexture.dispose();
    this.stunTexture.dispose();
    this.tagTexture?.dispose();
    this.tagTexture = null;
    for (const material of this.ownedMaterials) {
      material.dispose();
    }
    this.root.dispose(false, false);
  }

  private ensureKnife(): void {
    if (this.knife || !this.assets || !this.characterController) return;
    // Unparented: the arm pose places it in world space every frame.
    const holder = new TransformNode(`${this.root.name}-knife`, this.scene);
    holder.scaling.setAll(HAND_KNIFE_SCALE);
    holder.setEnabled(false);
    const knife: { readonly holder: TransformNode; model: ModelInstance | null } = { holder, model: null };
    this.knife = knife;
    const adopt = (model: ModelInstance | null): void => {
      if (!model) return;
      if (this.knife !== knife) {
        model.dispose();
        return;
      }
      knife.model = model;
      for (const root of model.rootNodes) {
        for (const node of [root, ...root.getDescendants()]) {
          if (node instanceof AbstractMesh) node.isPickable = false;
        }
      }
    };
    const id = kitchenAssetId("knife");
    const options = { namePrefix: `${this.root.name}-`, parent: holder };
    const loaded = this.assets.instantiateLoaded(id, options);
    if (loaded) adopt(loaded);
    else void this.assets.instantiateModel(id, options).then(adopt);
    this.characterController.setKnifeProp(holder);
  }

  /** A rounded pill in the player's colour with their label ("P1"), drawn once. */
  private createTagTexture(sequence: number, label: string, color: string): DynamicTexture {
    const width = 256;
    const height = 128;
    const texture = new DynamicTexture(`byte-tag-texture-${sequence}`, { width, height }, this.scene, true);
    texture.hasAlpha = true;
    const context = texture.getContext() as unknown as CanvasRenderingContext2D;
    context.clearRect(0, 0, width, height);
    const inset = 10;
    const radius = (height - inset * 2) / 2;
    context.beginPath();
    context.moveTo(inset + radius, inset);
    context.arcTo(width - inset, inset, width - inset, height - inset, radius);
    context.arcTo(width - inset, height - inset, inset, height - inset, radius);
    context.arcTo(inset, height - inset, inset, inset, radius);
    context.arcTo(inset, inset, width - inset, inset, radius);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    context.lineWidth = 10;
    context.strokeStyle = "#0d1b2a";
    context.stroke();
    context.font = "900 68px Nunito, 'Arial Black', sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#0d1b2a";
    context.fillText(label, width / 2, height / 2 + 4);
    texture.update();
    return texture;
  }

  /** Three dizzy stars, drawn once per player and shown while they are down. */
  private createStunTexture(sequence: number): DynamicTexture {
    const size = 128;
    const texture = new DynamicTexture(
      `byte-stun-texture-${sequence}`,
      { width: size, height: size },
      this.scene,
      false,
    );
    texture.hasAlpha = true;
    const context = texture.getContext();
    context.clearRect(0, 0, size, size);
    context.font = "bold 40px sans-serif";
    context.fillStyle = "#FFD166";
    const stars: readonly [number, number, number][] = [
      [14, 58, 34],
      [48, 40, 44],
      [90, 62, 34],
    ];
    for (const [x, y, glyphSize] of stars) {
      context.font = `bold ${glyphSize}px sans-serif`;
      context.fillText("✦", x, y + glyphSize * 0.4);
    }
    texture.update();
    return texture;
  }

  private animateWalk(delta: number, speedSquared: number): void {
    if (speedSquared <= 0.04) {
      this.walkClock = 0;
      const settle = Math.min(1, delta * 14);
      this.leftArm.rotation.x *= 1 - settle;
      this.rightArm.rotation.x *= 1 - settle;
      this.leftFoot.position.y += (0.17 - this.leftFoot.position.y) * settle;
      this.rightFoot.position.y += (0.17 - this.rightFoot.position.y) * settle;
      this.visualRoot.position.y *= 1 - settle;
      return;
    }

    this.walkClock += delta * WALK_CYCLE_SPEED;
    const swing = Math.sin(this.walkClock);
    this.leftArm.rotation.x = swing * 0.42;
    this.rightArm.rotation.x = -swing * 0.42;
    this.leftFoot.position.y = 0.17 + Math.max(0, swing) * 0.07;
    this.rightFoot.position.y = 0.17 + Math.max(0, -swing) * 0.07;
    this.visualRoot.position.y = Math.abs(Math.sin(this.walkClock * 2)) * 0.025;
  }

  private moveTowards(current: number, target: number, maximumDelta: number): number {
    if (Math.abs(target - current) <= maximumDelta) {
      return target;
    }
    return current + Math.sign(target - current) * maximumDelta;
  }

  private createMaterial(
    name: string,
    diffuseHex: string,
    emissiveHex: string,
  ): StandardMaterial {
    const material = new StandardMaterial(name, this.scene);
    material.diffuseColor = Color3.FromHexString(diffuseHex);
    material.emissiveColor = Color3.FromHexString(emissiveHex);
    material.specularColor.set(0.18, 0.22, 0.28);
    this.ownedMaterials.push(material);
    return material;
  }

  private box(
    name: string,
    width: number,
    height: number,
    depth: number,
    material: StandardMaterial,
  ): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, this.scene);
    mesh.parent = this.visualRoot;
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  }

  private sphere(name: string, diameter: number, material: StandardMaterial): Mesh {
    const mesh = MeshBuilder.CreateSphere(
      name,
      { diameter, segments: 8 },
      this.scene,
    );
    mesh.parent = this.visualRoot;
    mesh.material = material;
    mesh.isPickable = false;
    return mesh;
  }
}
