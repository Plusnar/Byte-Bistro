import {
  Camera, Color3, Color4, DirectionalLight, Engine, FreeCamera, HemisphericLight,
  Matrix, PointerEventTypes, Quaternion, Scene, ShadowGenerator, TransformNode, Vector3, type AbstractMesh,
} from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { assetStreaming } from "../core/assets/AssetStreamingManager";
import { absoluteUrl, assetCache } from "../core/assets/AssetCache";
import { bundledModelUrl } from "../core/assets/assetRegistry";
import { qualityManager } from "../core/perf/QualityManager";
import { LEVEL_MAP_URL, neighbourInDirection } from "../data/levelMap";
import { planetRoadPoint, planetStopAngle } from "../data/mapRoute";
import { fitHolderToSize } from "../entities/modelFit";
import { GALAXY_URL, LevelMapSpace, ORBIT_ASSETS, PlanetWind } from "./LevelMapEffects";
import { LevelMapWalkers, MAP_WALKER_ASSETS } from "./LevelMapWalkers";

const LANDMARKS = [
  { mesh: "landmark-church", fallback: "" },
  { mesh: "landmark-sgd", fallback: "future:schlachtfest" },
  { mesh: "landmark-pauli", fallback: "future:pauli" },
  { mesh: "landmark-univille", fallback: "future:univille" },
] as const;
const MAP_MODEL = "sao-bento-planet";
const BUS_MODEL = "rainha-bus";
const BUS_ANGULAR_SPEED = 1.62;
const SNAP_DISTANCE = 0.0001;
const PREVIEW_ZOOM = .17;

interface Place {
  readonly mesh: AbstractMesh;
  readonly center: Vector3;
  key: string;
}

export class LevelMapView {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: FreeCamera;
  private readonly planetRoot: TransformNode;
  private readonly assets: AssetManager;
  private readonly space: LevelMapSpace;
  private readonly walkers: LevelMapWalkers;
  private readonly observer: ResizeObserver;
  private readonly details: HTMLElement | null;
  private readonly unregisterQuality: () => void;
  private readonly stopMapQuality: () => void;
  private readonly shadows: ShadowGenerator;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private readonly instances: ModelInstance[] = [];
  private readonly gamepadButtons = new Set<string>();
  private readonly roadAhead = new Vector3();
  private readonly up = new Vector3();
  private readonly right = new Vector3();
  private readonly forward = new Vector3();
  private readonly orientation = Matrix.Identity();
  private readonly navigationPose = Matrix.Identity();
  private readonly cameraTarget = new Vector3(0, .14, 0);
  private readonly focusCenter = new Vector3();
  private readonly wheels: TransformNode[] = [];
  private ready: Promise<boolean> | null = null;
  private keys: readonly string[] = [];
  private places: Place[] = [];
  private active = false;
  private disposed = false;
  private bus: TransformNode | null = null;
  private gamepadElapsed = 0;
  private angle = 0;
  private stop = 0;
  private destination = 0;
  private confirmation: ((focused: boolean) => void) | null = null;
  private zoom = 0;
  private aspect = 1;
  private safeWidth = 1;
  private safeHeight = 1;
  private wind: PlanetWind | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: { onPick: (key: string | null) => void }) {
    this.engine = new Engine(canvas, true, { alpha: true, antialias: true, stencil: true }, true);
    this.unregisterQuality = qualityManager.registerEngine(this.engine, { followsDevicePixelRatio: true });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    this.camera = new FreeCamera("planet-camera", new Vector3(0, 1.65, 24), this.scene);
    this.camera.setTarget(this.cameraTarget);
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.minZ = .1;
    this.camera.maxZ = 70;

    const ambient = new HemisphericLight("planet-fill", new Vector3(0, 1, .5), this.scene);
    ambient.groundColor = Color3.FromHexString("#a9bbdb");
    ambient.intensity = 1.15;
    const sun = new DirectionalLight("planet-sun", new Vector3(.42, -.66, -.58), this.scene);
    sun.position.set(-10, 15, 13);
    sun.intensity = 1.05;
    sun.autoCalcShadowZBounds = true;
    this.shadows = new ShadowGenerator(1024, sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.bias = .0015;
    this.shadows.normalBias = .035;
    this.shadows.setDarkness(.38);
    this.stopMapQuality = qualityManager.subscribe((settings) => {
      this.scene.shadowsEnabled = settings.level !== "low";
      this.shadows.filteringQuality = settings.level === "high" ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
    });

    this.assets = assetStreaming.createSceneAssets(this.scene, [
      { id: MAP_MODEL, url: LEVEL_MAP_URL, priority: "background", required: true },
      { id: BUS_MODEL, url: bundledModelUrl("src/assets/map-vehicles/rainha-585.glb"), priority: "background", required: true },
      ...ORBIT_ASSETS,
      ...MAP_WALKER_ASSETS,
    ]);
    this.planetRoot = new TransformNode("planet-root", this.scene);
    this.space = new LevelMapSpace(this.scene, this.assets);
    this.walkers = new LevelMapWalkers(this.scene, this.assets, this.planetRoot);
    this.canvas.inert = true;
    this.scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERUP && info.type !== PointerEventTypes.POINTERMOVE) return;
      const picked = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => mesh.isPickable);
      const key = (picked?.pickedMesh?.metadata?.levelKey as string | undefined) || null;
      if (info.type === PointerEventTypes.POINTERMOVE) {
        this.canvas.style.cursor = key ? "pointer" : "";
      } else if (key) this.options.onPick(key);
    });
    this.details = canvas.parentElement?.querySelector<HTMLElement>(".level-window") ?? null;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    if (this.details) this.observer.observe(this.details);
  }

  whenReady(): Promise<boolean> {
    return this.ready ?? this.startLoading();
  }

  retry(): void {
    if (this.disposed) return;
    assetCache.retryFailed();
    this.startLoading();
  }

  private startLoading(): Promise<boolean> {
    const stage = this.canvas.parentElement;
    if (stage) stage.dataset.mapState = "loading";
    this.canvas.inert = true;
    this.ready = this.load().catch((error: unknown) => {
      console.error("Level map could not load", error);
      return false;
    }).then((loaded) => {
      if (!this.disposed) {
        if (stage) stage.dataset.mapState = loaded ? "ready" : "error";
        this.canvas.inert = !loaded;
        const focused = document.activeElement;
        const shouldRestoreFocus = focused === document.body || !(focused instanceof HTMLElement)
          || focused.matches("[data-action='home-levels'],[data-action='retry-level-map']")
          || focused.getClientRects().length === 0;
        if (this.active && shouldRestoreFocus) {
          if (loaded) this.canvas.focus({ preventScroll: true });
          else stage?.querySelector<HTMLButtonElement>("[data-action='retry-level-map']")?.focus({ preventScroll: true });
        }
      }
      return loaded;
    });
    return this.ready;
  }

  setLevels(keys: readonly string[]): void {
    this.keys = LANDMARKS.map((landmark, index) => index === 0 ? keys[0] ?? "" : landmark.fallback);
    this.places.forEach((place, index) => {
      place.key = this.keys[index] ?? "";
      place.mesh.metadata = { levelKey: place.key };
      place.mesh.isPickable = Boolean(place.key);
    });
  }

  select(key: string | null): void {
    const destination = this.places.findIndex((place) => place.key === key);
    if (destination < 0 || destination === this.destination || !this.bus) return;
    this.finishConfirmation(false);
    this.destination = destination;
    this.stop = planetStopAngle(this.angle, destination);
    if (this.reducedMotion.matches) this.arrive(Math.sign(this.stop - this.angle));
  }

  focusSelectedLevel(): Promise<boolean> {
    if (!this.active || !this.bus || this.canvas.inert || this.confirmation) return Promise.resolve(false);
    return new Promise((resolve) => { this.confirmation = resolve; });
  }

  private finishConfirmation(focused: boolean): void {
    const resolve = this.confirmation;
    this.confirmation = null;
    resolve?.(focused);
  }

  isMoving(): boolean {
    return Math.abs(this.angle - this.stop) > SNAP_DISTANCE;
  }

  private arrive(direction: number): void {
    this.angle = this.stop;
    this.poseBus(direction);
  }

  neighbour(key: string | null, dx: number, dy: number): string | null {
    const from = this.places.findIndex((place) => place.key === key);
    if (from < 0) return this.keys[0] || null;
    const viewport = this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    // Evaluate navigation at the destination pose so rapid input follows the visible layout
    // after the current turn, even before the rotation has caught up.
    Matrix.RotationZToRef(planetStopAngle(0, from), this.navigationPose);
    const points = this.places.map((place) => Vector3.Project(place.center, this.navigationPose, this.scene.getTransformMatrix(), viewport));
    // Opposite landmarks share an axis. Prefer that axis to a closer diagonal building.
    const aligned = neighbourInDirection(points, from, dx, dy, .83);
    const index = aligned >= 0 ? aligned : neighbourInDirection(points, from, dx, dy);
    return this.places[index]?.key || null;
  }

  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) {
      this.resize();
      this.space.restartFlights();
      void this.whenReady();
      this.engine.runRenderLoop(this.frame);
    } else {
      this.engine.stopRenderLoop(this.frame);
      this.space.update(0, false);
      this.walkers.update(0, false);
      this.finishConfirmation(false);
      this.zoom = 0;
    }
  }

  resize(): void {
    if (this.disposed) return;
    this.engine.resize();
    this.aspect = this.engine.getAspectRatio(this.camera) || 1;
    const width = this.canvas.clientWidth;
    this.safeWidth = width > 720 && this.details ? Math.max(.7, 1 - (this.details.offsetWidth + 28) / width) : 1;
    this.safeHeight = width > 0 && width <= 720 ? .62 : 1;
    const baseline = this.baseHalfHeight();
    const halfWidth = baseline * this.aspect;
    this.space.setCameraBounds(halfWidth, baseline, halfWidth * (1 - this.safeWidth));
    this.space.resize(this.aspect);
    this.frameCamera();
  }

  private updateZoom(delta: number, reduced: boolean): void {
    const target = this.isMoving() ? 0 : this.confirmation ? 1 : PREVIEW_ZOOM;
    if (target === this.zoom) return;
    const remaining = target - this.zoom;
    this.zoom = reduced || Math.abs(remaining) < .005 ? target : this.zoom + remaining * (1 - Math.exp(-delta * 8));
    this.frameCamera();
  }

  private baseHalfHeight(): number {
    return Math.max(9.10 / this.safeHeight, 8.70 / (this.aspect * this.safeWidth));
  }

  private frameCamera(): void {
    const halfHeight = this.baseHalfHeight() * (1 - this.zoom * .37);
    const halfWidth = halfHeight * this.aspect;
    const focus = Math.max(0, (this.zoom - PREVIEW_ZOOM) / (1 - PREVIEW_ZOOM));
    const landmark = this.places[this.destination];
    if (landmark) Vector3.TransformCoordinatesToRef(landmark.center, this.planetRoot.getWorldMatrix(), this.focusCenter);
    const x = halfWidth * (1 - this.safeWidth) + this.focusCenter.x * focus;
    const y = -halfHeight * (1 - this.safeHeight) + (this.focusCenter.y + .7) * focus;
    this.camera.position.set(x, 1.65 + y, 24);
    this.cameraTarget.set(x, .14 + y, 0);
    this.camera.setTarget(this.cameraTarget);
    this.camera.orthoTop = halfHeight;
    this.camera.orthoBottom = -halfHeight;
    this.camera.orthoLeft = -halfWidth;
    this.camera.orthoRight = halfWidth;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.finishConfirmation(false);
    this.observer.disconnect();
    this.engine.stopRenderLoop(this.frame);
    this.space.dispose();
    this.walkers.dispose();
    for (const instance of this.instances) instance.dispose();
    this.assets.dispose();
    this.stopMapQuality();
    this.shadows.dispose();
    this.scene.dispose();
    this.unregisterQuality();
    this.engine.dispose();
  }

  private readonly frame = (): void => {
    if (this.disposed) return;
    const delta = Math.min(this.engine.getDeltaTime() / 1000, .1);
    const reduced = this.reducedMotion.matches;
    this.gamepadElapsed += delta;
    if (this.gamepadElapsed >= .08) {
      this.gamepadElapsed = 0;
      this.pollGamepad();
    }
    const previousAngle = this.angle;
    const remaining = this.stop - this.angle;
    if (Math.abs(remaining) > SNAP_DISTANCE) {
      const advance = Math.min(Math.abs(remaining), delta * BUS_ANGULAR_SPEED);
      if (reduced || advance >= Math.abs(remaining) - SNAP_DISTANCE) {
        this.arrive(Math.sign(remaining));
      } else {
        this.angle += advance * Math.sign(remaining);
        this.poseBus(Math.sign(remaining));
        for (const wheel of this.wheels) wheel.rotation.x += advance * 13;
      }
    }
    const turnSpeedRatio = delta > 0 ? (this.angle - previousAngle) / (delta * BUS_ANGULAR_SPEED) : 0;
    this.wind?.update(delta, reduced, turnSpeedRatio);
    this.space.update(delta, !reduced, turnSpeedRatio);
    this.walkers.update(delta, !reduced);
    this.updateZoom(delta, reduced);
    this.scene.render();
    if (this.confirmation && this.zoom === 1 && !this.isMoving()) this.finishConfirmation(true);
  };

  private poseBus(direction: number): void {
    if (!this.bus) return;
    this.planetRoot.rotation.z = this.angle;
    planetRoadPoint(this.angle, this.bus.position);
    this.bus.position.normalizeToRef(this.up);
    if (direction === 0) return;
    planetRoadPoint(this.angle + .004 * direction, this.roadAhead);
    this.roadAhead.subtractToRef(this.bus.position, this.forward);
    Vector3.CrossToRef(this.up, this.forward, this.right);
    this.right.normalize();
    Vector3.CrossToRef(this.right, this.up, this.forward);
    Matrix.FromXYZAxesToRef(this.right, this.up, this.forward, this.orientation);
    Quaternion.FromRotationMatrixToRef(this.orientation, this.bus.rotationQuaternion!);
  }

  private pollGamepad(): void {
    const pad = navigator.getGamepads?.().find((candidate) => candidate?.connected);
    if (!pad || document.activeElement !== this.canvas) {
      this.gamepadButtons.clear();
      return;
    }
    const buttons: [string, boolean][] = [
      ["ArrowLeft", !!pad.buttons[14]?.pressed || (pad.axes[0] ?? 0) < -.65],
      ["ArrowRight", !!pad.buttons[15]?.pressed || (pad.axes[0] ?? 0) > .65],
      ["ArrowUp", !!pad.buttons[12]?.pressed || (pad.axes[1] ?? 0) < -.65],
      ["ArrowDown", !!pad.buttons[13]?.pressed || (pad.axes[1] ?? 0) > .65],
      ["Enter", !!pad.buttons[0]?.pressed], ["Escape", !!pad.buttons[1]?.pressed],
    ];
    for (const [key, pressed] of buttons) {
      if (pressed && !this.gamepadButtons.has(key)) this.canvas.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      if (pressed) this.gamepadButtons.add(key);
      else this.gamepadButtons.delete(key);
    }
  }

  private async load(): Promise<boolean> {
    if (this.bus) {
      await this.scene.whenReadyAsync();
      return !this.disposed;
    }
    const [mapReady, busReady, hasGalaxy] = await Promise.all([
      this.assets.preload(MAP_MODEL),
      this.assets.preload(BUS_MODEL),
      assetCache.fetch(absoluteUrl(GALAXY_URL), "background").then(() => true, () => false),
    ]);
    if (this.disposed) return false;
    if (!mapReady || !busReady) throw new Error("A required map model could not be loaded");

    const planet = this.assets.instantiateLoaded(MAP_MODEL, { namePrefix: "", parent: this.planetRoot });
    const busModel = this.assets.instantiateLoaded(BUS_MODEL, { namePrefix: "planet-bus-" });
    const meshes = this.scene.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    const landmarks = LANDMARKS.map(({ mesh }) => meshes.find((candidate) => candidate.name === mesh));
    if (!planet || !busModel || landmarks.some((mesh) => !mesh)) {
      planet?.dispose();
      busModel?.dispose();
      throw new Error("The planet asset is missing a landmark");
    }
    this.instances.push(planet, busModel);
    for (const mesh of meshes) {
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      if (mesh.name.startsWith("planet-bus-")) continue;
      this.shadows.addShadowCaster(mesh, false);
    }
    const foliage = meshes.find((mesh) => mesh.name === "planet-vegetation");
    if (foliage?.material) {
      const animated = foliage.material.clone("map-vegetation-wind");
      if (animated) {
        foliage.material = animated;
        this.wind = new PlanetWind(animated);
      }
    }
    this.places = landmarks.map((mesh, index) => {
      const landmark = mesh!;
      landmark.computeWorldMatrix(true);
      const key = this.keys[index] ?? "";
      landmark.metadata = { levelKey: key };
      landmark.isPickable = Boolean(key);
      return { mesh: landmark, center: landmark.getBoundingInfo().boundingBox.centerWorld.clone(), key };
    });

    const holder = new TransformNode("planet-bus-holder", this.scene);
    for (const root of busModel.rootNodes) {
      root.parent = holder;
      for (const node of [root, ...root.getDescendants(false)]) {
        if (node instanceof TransformNode && /wheel-(front|rear)-(l|r)$/.test(node.name)) {
          if (node.rotationQuaternion) node.rotation = node.rotationQuaternion.toEulerAngles();
          this.wheels.push(node);
        }
      }
    }
    fitHolderToSize(holder, busModel.rootNodes, .98);
    this.bus = new TransformNode("planet-bus", this.scene);
    this.bus.parent = this.planetRoot;
    this.bus.rotationQuaternion = Quaternion.Identity();
    holder.parent = this.bus;
    this.poseBus(1);
    this.space.create(hasGalaxy);
    this.resize();
    await this.scene.whenReadyAsync();
    if (this.disposed) return false;
    void this.space.loadTravelers().catch((error: unknown) => console.warn("Level map travelers could not load", error));
    const terrain = meshes.find((mesh) => mesh.name === "planet-terrain");
    if (terrain) void this.walkers.load(terrain).catch((error: unknown) => console.warn("Level map walkers could not load", error));
    return true;
  }
}
