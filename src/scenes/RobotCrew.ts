import { Color3 } from "@babylonjs/core/Maths/math.color";
import type { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { AssetManager } from "../core/AssetManager";
import type { MechanismConfig } from "../data/mechanismConfig";
import { CharacterController } from "../entities/CharacterController";
import { crewMembers, type CrewKind } from "../gameplay/mechanisms/MechanismSystem";
import { MANNEQUIN } from "../systems/WeddingGuests";

/** Each crew's loop, and how far behind the first robot the second one runs (0..1). */
const CREW_CLIP: Readonly<Record<CrewKind, { readonly clip: string; readonly offset: number }>> = {
  // Half a clip apart: one throws while the other winds up, then the other way round.
  bottle_fight: { clip: "Drunk_Throw", offset: 0.5 },
  // Half a clip apart: the first half of Brawl attacks, the second half takes the beating.
  brawl: { clip: "Brawl", offset: 0.5 },
  panic_run: { clip: "Panic_Run", offset: 0 },
};

/**
 * The party gone wrong: the Babylon side of a `bottle_fight`, `brawl` or `panic_run`
 * mechanism, in the plain robot (the game's default model).
 *
 * The pair stand face to face along the mechanism's own x; the runner stands on the node,
 * which `MechanismSystem` moves round its circle. A bottle thrower's clip drives the
 * bottle: `throwProgress` tells `KitchenMechanisms` where the throw is, and the pure
 * `bottleFlight` says where the bottle flies. Owned and disposed by `KitchenEnvironment`;
 * its robots sit under their own node, out of the static batch.
 */
export class RobotCrew {
  readonly ready: Promise<void>;
  private readonly root: TransformNode;
  private readonly members: { readonly node: TransformNode; readonly controller: CharacterController }[] = [];
  private readonly bottle: Mesh | null = null;
  private readonly bottleMaterial: StandardMaterial | null = null;
  private moving = true;
  private disposed = false;
  private lastProgress = 0;
  private cycles = 0;

  constructor(scene: Scene, assets: AssetManager, parent: TransformNode, private readonly config: MechanismConfig) {
    const kind = config.kind as CrewKind;
    this.root = new TransformNode(`robot-crew-${kind}`, scene);
    this.root.parent = parent;
    const offsets = crewMembers(config, { x: 0, z: 0 }, 0);
    offsets.forEach((offset, index) => {
      const node = new TransformNode(`robot-crew-${kind}-${index}`, scene);
      node.parent = this.root;
      node.position.set(offset.x, 0, offset.z);
      // Face to face: the first looks along +x at the second, the second back at it.
      if (offsets.length === 2) node.rotation.y = index === 0 ? Math.PI / 2 : -Math.PI / 2;
      this.members.push({ node, controller: new CharacterController(scene, assets, node) });
    });
    if (kind === "bottle_fight") {
      const body = MeshBuilder.CreateCylinder("crew-bottle-body", { height: 0.26, diameter: 0.11, tessellation: 10 }, scene);
      const neck = MeshBuilder.CreateCylinder("crew-bottle-neck", { height: 0.12, diameterTop: 0.04, diameterBottom: 0.08, tessellation: 10 }, scene);
      neck.position.y = 0.19;
      const bottle = Mesh.MergeMeshes([body, neck], true)!;
      bottle.name = "crew-bottle";
      const material = new StandardMaterial("crew-bottle-material", scene);
      material.diffuseColor = Color3.FromHexString("#2f9e4a");
      material.emissiveColor = Color3.FromHexString("#0d3a19");
      material.specularColor = new Color3(0.6, 0.6, 0.6);
      bottle.material = material;
      bottle.isPickable = false;
      bottle.setEnabled(false);
      this.bottle = bottle;
      this.bottleMaterial = material;
    }
    const { clip, offset } = CREW_CLIP[kind];
    // A runner's pace follows its speed; a pair keeps its clip's own tempo.
    const rate = kind === "panic_run" ? Math.min(1.8, Math.max(0.6, config.speed / 2.2)) : 1;
    this.ready = Promise.all(this.members.map(async ({ controller }) => {
      await controller.selectCharacter(MANNEQUIN);
      await controller.playAmbientClip(clip, "fest");
    })).then(() => {
      if (this.disposed) return;
      // Loaded one by one, started one by one: back in step, the second a beat behind.
      this.members.forEach(({ controller }, index) => {
        controller.setAnimationSpeed(rate);
        controller.restartAnimation(index === 0 ? 0 : offset);
        if (!this.moving) controller.setAnimationPaused(true);
      });
    });
  }

  /** Puts the crew where the mechanism node is, turned like it, playing or holding still. */
  update(position: Vector3, yaw: number, moving: boolean): void {
    this.root.position.copyFrom(position);
    this.root.rotation.y = yaw;
    if (moving !== this.moving) {
      this.moving = moving;
      for (const { controller } of this.members) controller.setAnimationPaused(!moving);
    }
  }

  /**
   * Where the first thrower's clip is (0..1) and how many loops it has played: what the
   * bottle's flight is read from. Counting loops lets each throw hit a cook only once.
   */
  throwProgress(): { progress: number; cycles: number } {
    const progress = this.members[0]?.controller.animationProgress() ?? 0;
    if (progress + 0.5 < this.lastProgress) this.cycles += 1;
    this.lastProgress = progress;
    return { progress, cycles: this.cycles };
  }

  /** Shows the bottle at a world position, tumbling, or hides it (null). */
  showBottle(at: { x: number; y: number; z: number } | null, spin: number): void {
    if (!this.bottle) return;
    if (!at) {
      if (this.bottle.isEnabled()) this.bottle.setEnabled(false);
      return;
    }
    if (!this.bottle.isEnabled()) this.bottle.setEnabled(true);
    this.bottle.position.set(at.x, at.y, at.z);
    this.bottle.rotation.set(spin * 9, spin * 4, 0);
  }

  get kind(): CrewKind {
    return this.config.kind as CrewKind;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const { controller } of this.members) controller.dispose();
    this.members.length = 0;
    this.bottle?.dispose();
    this.bottleMaterial?.dispose();
    this.root.dispose(false, false);
  }
}
