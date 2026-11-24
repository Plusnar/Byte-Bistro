import {
  Matrix, Quaternion, Ray, TransformNode, Vector3,
  type AbstractMesh, type AnimationGroup, type Scene,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { bundledModelUrl } from "../core/assets/assetRegistry";
import { CHARACTER_ANIMATION_ASSETS } from "../data/characters";
import { planetRoadPoint } from "../data/mapRoute";
import { bindModelClip } from "../entities/modelAnimation";
import { fitHolderToSize } from "../entities/modelFit";

const ANIMATION = CHARACTER_ANIMATION_ASSETS.movement;
const ROBOT_ID = "level-map-walker";
const WALK_CLIP = "Walking_A";
const WALKER_SIZE = .62;
const WALK_SPEED = .39;
const TAU = 2 * Math.PI;

const ROUTES = [
  { lane: "center", count: 3, samples: 36, phase: .16, direction: 1, offset: -.19 },
  { lane: "center", count: 3, samples: 36, phase: .32, direction: -1, offset: .19 },
  { lane: "road", count: 4, samples: 72, phase: .09, direction: 1, offset: 0 },
  { lane: "rim", count: 5, samples: 96, phase: .04, direction: -1, offset: 0 },
] as const;

type RouteSpec = typeof ROUTES[number];

export const MAP_WALKER_ASSETS = [
  { id: ROBOT_ID, url: bundledModelUrl("Anim/Mannequin Character/characters/Mannequin_Medium.glb"), priority: "background" },
  { ...ANIMATION, priority: "background" },
] as const;

interface Walker {
  readonly root: TransformNode;
  readonly model: ModelInstance;
  readonly walk: AnimationGroup;
  readonly path: WalkingPath;
  sample: number;
}

interface WalkingPath {
  readonly lane: RouteSpec["lane"];
  readonly points: readonly Vector3[];
  readonly segmentLengths: readonly number[];
  readonly direction: number;
}

/** Animated mannequins follow closed paths in the planet's local space. */
export class LevelMapWalkers {
  private readonly robots: Walker[] = [];
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly side = new Vector3();
  private readonly next = new Vector3();
  private readonly orientation = Matrix.Identity();
  private disposed = false;
  private moving = false;

  constructor(
    private readonly scene: Scene, private readonly assets: AssetManager, private readonly planet: TransformNode,
  ) {}

  async load(terrain: AbstractMesh): Promise<void> {
    const [modelReady, clipsReady] = await Promise.all([this.assets.preload(ROBOT_ID), this.assets.preload(ANIMATION.id)]);
    if (this.disposed || !modelReady || !clipsReady) return;
    const source = this.assets.instantiateLoaded(ANIMATION.id, { namePrefix: "" });
    if (!source) return;
    try {
      const clip = source.animationGroups.find((group) => group.name === WALK_CLIP);
      if (!clip) return;
      for (const route of ROUTES) {
        const path = this.samplePath(terrain, route);
        for (let i = 0; i < route.count; i++) {
          this.spawn(clip, path, (route.phase + i / route.count) % 1);
        }
      }
    } finally {
      source.dispose();
      this.assets.releaseUnused((id) => id === ANIMATION.id);
    }
  }

  private samplePath(terrain: AbstractMesh, route: RouteSpec): WalkingPath {
    const ray = new Ray(new Vector3(), new Vector3(), 2);
    const world = this.planet.computeWorldMatrix(true);
    const points = Array.from({ length: route.samples }, (_, index) => {
      const angle = index * TAU / route.samples;
      const point = new Vector3();
      this.routeDirection(route, angle, point);

      // Probe the static terrain once, then interpolate the sampled ground while walking.
      Vector3.TransformNormalToRef(point, world, ray.direction);
      ray.origin.copyFrom(ray.direction).scaleInPlace(7.2);
      ray.direction.negateInPlace();
      const ground = this.scene.pickWithRay(ray, (mesh) => mesh === terrain)?.pickedPoint;
      return point.scaleInPlace((ground?.length() ?? 6.25) + .008);
    });
    const segmentLengths = points.map((point, index) => Vector3.Distance(point, points[(index + 1) % points.length]!));
    return { lane: route.lane, points, segmentLengths, direction: route.direction };
  }

  private routeDirection(route: RouteSpec, angle: number, point: Vector3): void {
    if (route.lane === "road") {
      planetRoadPoint(angle, point);
      planetRoadPoint(angle + .006, this.next);
      point.normalizeToRef(this.up);
      this.next.subtractToRef(point, this.forward);
      Vector3.CrossToRef(this.up, this.forward, this.side);
      point.addInPlace(this.side.normalize().scaleInPlace(-.39)).normalize();
      return;
    }
    // The rim bends inward at the four landmarks, leaving room for their buildings.
    const rim = .94 - .22 * ((1 + Math.cos(4 * angle)) * .5) ** 2;
    const x = route.lane === "center" ? route.offset + .125 * Math.sin(angle) : rim * Math.sin(angle);
    const y = (route.lane === "center" ? .225 : rim) * Math.cos(angle);
    point.set(x, y, Math.sqrt(1 - x * x - y * y));
  }

  private spawn(clip: AnimationGroup, path: WalkingPath, phase: number): void {
    const index = this.robots.length;
    const model = this.assets.instantiateLoaded(ROBOT_ID, { namePrefix: "" });
    if (!model) return;
    const walk = bindModelClip(this.scene, model, clip, `planet-robot-${index}-${WALK_CLIP}`);
    if (!walk) {
      model.dispose();
      return;
    }
    const root = new TransformNode(`planet-robot-${index}`, this.scene);
    const body = new TransformNode(`planet-robot-body-${index}`, this.scene);
    for (const node of model.rootNodes) node.parent = body;
    fitHolderToSize(body, model.rootNodes, WALKER_SIZE);
    body.parent = root;
    root.parent = this.planet;
    root.rotationQuaternion = Quaternion.Identity();
    for (const mesh of root.getChildMeshes()) mesh.isPickable = false;
    const robot = { root, model, walk, path, sample: phase * path.points.length };
    this.pose(robot);
    walk.start(true, 1);
    walk.goToFrame(walk.from + (walk.to - walk.from) * phase);
    if (!this.moving) walk.pause();
    this.robots.push(robot);
  }

  update(delta: number, animate: boolean): void {
    if (this.moving !== animate) {
      this.moving = animate;
      for (const { walk } of this.robots) {
        if (animate) walk.restart();
        else walk.pause();
      }
    }
    if (!animate) return;
    for (const robot of this.robots) {
      const length = robot.path.points.length;
      const segment = Math.floor(robot.sample);
      const step = delta * WALK_SPEED * robot.path.direction / robot.path.segmentLengths[segment]!;
      robot.sample = (robot.sample + step + length) % length;
      this.pose(robot);
    }
  }

  private pose(robot: Walker): void {
    const index = Math.floor(robot.sample);
    const points = robot.path.points;
    const from = points[index]!;
    const to = points[(index + 1) % points.length]!;
    Vector3.LerpToRef(from, to, robot.sample - index, robot.root.position);
    robot.root.position.normalizeToRef(this.up);
    to.subtractToRef(from, this.forward);
    this.forward.scaleInPlace(robot.path.direction);
    Vector3.CrossToRef(this.up, this.forward, this.side);
    this.side.normalize();
    Vector3.CrossToRef(this.side, this.up, this.forward);
    Matrix.FromXYZAxesToRef(this.side, this.up, this.forward, this.orientation);
    Quaternion.FromRotationMatrixToRef(this.orientation, robot.root.rotationQuaternion!);
  }

  dispose(): void {
    this.disposed = true;
    for (const { root, model, walk } of this.robots) {
      walk.dispose();
      model.dispose();
      root.dispose();
    }
    this.robots.length = 0;
  }
}
