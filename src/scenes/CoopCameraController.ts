import {
  FreeCamera,
  Scene,
  Vector3,
  Viewport,
} from "@babylonjs/core";

const SHARED_DISTANCE = 8;
const SPLIT_DISTANCE = 14;
const MERGE_DISTANCE = 10;
const BASE_FOV = 0.72;
const WIDE_FOV = 1.02;

export interface CoopCameraSnapshot {
  readonly distance: number;
  readonly splitAmount: number;
  readonly isSplit: boolean;
}

/** Shared co-op camera with FOV expansion and a hysteretic animated split. */
export class CoopCameraController {
  readonly primary: FreeCamera;
  readonly secondary: FreeCamera;

  private readonly midpoint = new Vector3();
  private readonly sharedTarget = new Vector3();
  private readonly primaryTarget = new Vector3();
  private readonly secondaryTarget = new Vector3();
  private readonly desiredPosition = new Vector3();
  private splitRequested = false;
  private splitAmountValue = 0;

  constructor(
    private readonly scene: Scene,
    initialPosition: Vector3,
    private readonly offset: Readonly<Vector3>,
    private readonly smoothing: number,
  ) {
    this.primary = this.createCamera("coop-camera-p1", initialPosition);
    this.secondary = this.createCamera("coop-camera-p2", initialPosition);
    this.scene.activeCamera = this.primary;
  }

  update(
    deltaSeconds: number,
    playerOne: Readonly<Vector3>,
    playerTwo: Readonly<Vector3>,
    focusTarget?: Readonly<Vector3> | null,
    focusWeight = 0,
  ): CoopCameraSnapshot {
    const dx = playerTwo.x - playerOne.x;
    const dz = playerTwo.z - playerOne.z;
    const distance = Math.sqrt(dx * dx + dz * dz);

    if (!this.splitRequested && distance > SPLIT_DISTANCE) this.splitRequested = true;
    if (this.splitRequested && distance < MERGE_DISTANCE) this.splitRequested = false;

    const splitTarget = this.splitRequested ? 1 : 0;
    const transition = 1 - Math.exp(-4.5 * Math.max(0, deltaSeconds));
    this.splitAmountValue += (splitTarget - this.splitAmountValue) * transition;
    if (Math.abs(splitTarget - this.splitAmountValue) < 0.001) {
      this.splitAmountValue = splitTarget;
    }

    this.midpoint.copyFrom(playerOne).addInPlace(playerTwo).scaleInPlace(0.5);
    this.midpoint.y += 0.82;
    this.sharedTarget.copyFrom(this.midpoint);
    if (focusTarget && focusWeight > 0) {
      Vector3.LerpToRef(
        this.sharedTarget,
        focusTarget,
        Math.min(0.45, Math.max(0, focusWeight)),
        this.sharedTarget,
      );
    }

    Vector3.LerpToRef(this.sharedTarget, playerOne, this.splitAmountValue, this.primaryTarget);
    Vector3.LerpToRef(this.sharedTarget, playerTwo, this.splitAmountValue, this.secondaryTarget);
    this.primaryTarget.y += 0.82 * this.splitAmountValue;
    this.secondaryTarget.y += 0.82 * this.splitAmountValue;

    const zoom = Math.min(1, Math.max(0, (distance - SHARED_DISTANCE) /
      (SPLIT_DISTANCE - SHARED_DISTANCE)));
    const offsetScale = 1 + zoom * 0.12 * (1 - this.splitAmountValue);
    const sharedFov = BASE_FOV + (WIDE_FOV - BASE_FOV) * zoom;
    this.updateCamera(
      this.primary,
      this.primaryTarget,
      offsetScale,
      BASE_FOV + (sharedFov - BASE_FOV) * (1 - this.splitAmountValue),
      deltaSeconds,
    );
    this.updateCamera(
      this.secondary,
      this.secondaryTarget,
      offsetScale,
      BASE_FOV + (sharedFov - BASE_FOV) * (1 - this.splitAmountValue),
      deltaSeconds,
    );

    const boundary = 1 - this.splitAmountValue * 0.5;
    this.primary.viewport = new Viewport(0, 0, boundary, 1);
    this.secondary.viewport = new Viewport(boundary, 0, 1 - boundary, 1);
    if (this.splitAmountValue > 0.002) {
      this.scene.activeCameras = [this.primary, this.secondary];
    } else {
      this.scene.activeCameras = null;
      this.scene.activeCamera = this.primary;
    }

    return {
      distance,
      splitAmount: this.splitAmountValue,
      isSplit: this.splitRequested,
    };
  }

  dispose(): void {
    this.scene.activeCameras = null;
    this.primary.dispose();
    this.secondary.dispose();
  }

  /**
   * Metres the view trembles by, for fires, crashes and lightning; 0 holds it still.
   * The tremble is taken back off before the next smoothing step, so it never drifts.
   */
  shake = 0;
  private readonly shakeOffsets = new Map<FreeCamera, Vector3>();

  private createCamera(name: string, position: Vector3): FreeCamera {
    const camera = new FreeCamera(name, position.clone(), this.scene);
    camera.fov = BASE_FOV;
    // Far enough for the town around the level (see OutdoorBackdrop); the near plane moves
    // out a little to keep depth precision over the longer range.
    camera.minZ = 0.3;
    camera.maxZ = 200;
    return camera;
  }

  private updateCamera(
    camera: FreeCamera,
    target: Vector3,
    offsetScale: number,
    fov: number,
    deltaSeconds: number,
  ): void {
    this.desiredPosition.copyFrom(target).addInPlaceFromFloats(
      this.offset.x * offsetScale,
      this.offset.y * offsetScale,
      this.offset.z * offsetScale,
    );
    let shaken = this.shakeOffsets.get(camera);
    if (!shaken) {
      shaken = Vector3.Zero();
      this.shakeOffsets.set(camera, shaken);
    }
    camera.position.subtractInPlace(shaken);
    const smoothing = 1 - Math.exp(-this.smoothing * Math.max(0, deltaSeconds));
    Vector3.LerpToRef(camera.position, this.desiredPosition, smoothing, camera.position);
    camera.fov += (fov - camera.fov) * smoothing;
    camera.setTarget(target);
    if (this.shake > 0) {
      shaken.set(
        (Math.random() - 0.5) * 2 * this.shake,
        (Math.random() - 0.5) * 2 * this.shake,
        (Math.random() - 0.5) * 2 * this.shake,
      );
    } else {
      shaken.setAll(0);
    }
    camera.position.addInPlace(shaken);
  }
}
