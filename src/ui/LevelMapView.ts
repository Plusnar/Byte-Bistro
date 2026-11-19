import { AbstractMesh, ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight, Matrix, Mesh, MeshBuilder, PBRMaterial, PointerEventTypes, Scene, ShadowGenerator, StandardMaterial, TransformNode, Vector3, VertexBuffer, VertexData } from "@babylonjs/core";
import type { AssetManager, ModelInstance } from "../core/AssetManager";
import { assetStreaming } from "../core/assets/AssetStreamingManager";
import { assetCache, absoluteUrl } from "../core/assets/AssetCache";
import { qualityManager } from "../core/perf/QualityManager";
import { neighbourInDirection } from "../data/levelMap";
import { MAP_BUSHES, MAP_LAMPS, MAP_STOPS, mapRoute, sampleMapEdge } from "../data/mapRoute";
import { publicUrl } from "../utils/assetUrl";
import grassTextureUrl from "../../optimized/src/assets/map-textures/grass-natural.webp?url";
import stoneTextureUrl from "../../optimized/src/assets/map-textures/cobblestone.webp?url";
import hillsTextureUrl from "../../optimized/src/assets/map-textures/hills.webp?url";
import { bundledModelUrl, publicModelUrl } from "../core/assets/assetRegistry";

const FUTURE_KEYS = ["future:univille", "future:schlachtfest", "future:pauli"] as const;
const PLACES = [
  { image: "church", x: -4.1, z: -4.0, width: 3.0, height: 4.2 },
  { image: "univille", x: 4.1, z: -4.0, width: 4.0, height: 1.95 },
  { image: "schlachtfest", x: 4.1, z: 4.0, width: 4.0, height: 1.85 },
  { image: "pauli", x: -4.1, z: 4.0, width: 3.7, height: 1.85 },
] as const;
interface Place { key: string; mesh: Mesh; base: Vector3; }

/** A 3D São Bento diorama with the illustrated landmarks as camera-facing pick targets. */
export class LevelMapView {
  static readonly assetUrl = publicUrl("assets/ui/level-map/church.webp");
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly camera: ArcRotateCamera;
  private readonly assets: AssetManager;
  private readonly sceneryInstances: ModelInstance[] = [];
  private ready: Promise<boolean> | null = null;
  private readonly observer: ResizeObserver;
  private readonly unregisterQuality: () => void;
  private readonly stopMapQuality: () => void;
  private readonly shadows: ShadowGenerator;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  private keys: string[] = [];
  private places: Place[] = [];
  private selected: string | null = null;
  private hovered: string | null = null;
  private active = false;
  private disposed = false;
  private baseRadius = 18;
  private bus: TransformNode | null = null;
  private wheels: TransformNode[] = [];
  private readonly gamepadButtons = new Set<string>();
  private gamepadElapsed = 0;
  private currentStop = 0;
  private nextStop = 0;
  private route: number[] = [];
  private openOnArrival = false;
  private readonly stops = MAP_STOPS.map(({ x, z }) => new Vector3(x, .1, z));
  private readonly paths: Vector3[][] = [];
  private segmentPath: readonly Vector3[] = [];
  private segmentCursor = 0;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: { onPick: (key: string | null) => void }) {
    this.engine = new Engine(canvas, true, { antialias: true, stencil: true }, true);
    this.unregisterQuality = qualityManager.registerEngine(this.engine, { followsDevicePixelRatio: true });
    this.scene = new Scene(this.engine);
    this.scene.clearColor = new Color4(0.38, 0.72, 0.92, 1);
    this.camera = new ArcRotateCamera("level-map-camera", Math.PI / 2, Math.PI / 3, this.baseRadius, Vector3.Zero(), this.scene);
    this.camera.fov = 1.08;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 200;
    const ambient = new HemisphericLight("level-map-ambient", new Vector3(0, 1, 0), this.scene);
    ambient.intensity = 0.76;
    ambient.groundColor = Color3.FromHexString("#9bb3c7");
    const sun = new DirectionalLight("level-map-sun", new Vector3(0.4, -1, 0.5), this.scene);
    sun.intensity = 0.38;
    sun.position = new Vector3(-12, 25, -12);
    this.shadows = new ShadowGenerator(1024, sun);
    this.shadows.usePercentageCloserFiltering = true;
    this.shadows.filteringQuality = ShadowGenerator.QUALITY_LOW;
    this.shadows.setDarkness(.38);
    this.stopMapQuality = qualityManager.subscribe((settings) => {
      this.scene.shadowsEnabled = settings.level !== "low";
      this.shadows.filteringQuality = settings.level === "high" ? ShadowGenerator.QUALITY_MEDIUM : ShadowGenerator.QUALITY_LOW;
    });
    this.assets = assetStreaming.createSceneAssets(this.scene, [
      { id: "town-surroundings", url: publicModelUrl("assets/environment/cidade_fundo.glb"), priority: "background", required: false },
      { id: "town-street", url: bundledModelUrl("src/assets/selection-street/Selection Street.glb"), priority: "background", required: false },
      { id: "rainha-bus", url: bundledModelUrl("src/assets/map-vehicles/city-bus.glb"), priority: "background", required: false },
      ...["timber-house-medium", "timber-house-large"].map((id) => ({
        id, url: bundledModelUrl(`src/assets/map-town/${id}.glb`), priority: "background" as const, required: false,
      })),
      ...["araucaria", "coreto", "banco_praca", "poste_globo", "canteiro_flores"].map((id) => ({
        id, url: publicModelUrl(`asset-library/Scenario/Praca/${id}.glb`), priority: "background" as const, required: false,
      })),
    ]);
    this.canvas.inert = true;
    this.scene.onPointerObservable.add((info) => {
      if (info.type !== PointerEventTypes.POINTERUP && info.type !== PointerEventTypes.POINTERMOVE) return;
      const picked = this.scene.pick(this.scene.pointerX, this.scene.pointerY, (mesh) => mesh.metadata?.levelKey !== undefined);
      const key = (picked?.pickedMesh?.metadata?.levelKey as string | undefined) ?? null;
      if (info.type === PointerEventTypes.POINTERUP) { if (key) this.travelTo(key, true); else this.options.onPick(null); }
      else { this.hovered = key; this.canvas.style.cursor = key ? "pointer" : ""; }
    });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
  }
  whenReady(): Promise<boolean> { return this.ready ?? this.startLoading(); }
  retry(): void { if (!this.disposed) { assetCache.retryFailed(); this.startLoading(); } }
  private startLoading(): Promise<boolean> {
    const stage = this.canvas.parentElement;
    if (stage) stage.dataset.mapState = "loading";
    this.canvas.inert = true;
    const pending = this.load().catch((error: unknown) => { console.error("Level map could not load", error); return false; }).then((loaded) => {
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
    this.ready = pending;
    return pending;
  }
  setLevels(keys: readonly string[]): void {
    this.keys = [keys[0] ?? "", ...FUTURE_KEYS];
    this.places.forEach((place, i) => { place.key = this.keys[i] ?? ""; place.mesh.metadata.levelKey = place.key; });
  }
  select(key: string | null): void {
    this.selected = key;
    if (key && this.bus && key !== this.places[this.nextStop]?.key) this.travelTo(key, false);
  }
  isMoving(): boolean { return this.route.length > 0; }
  private travelTo(key: string, open: boolean): void {
    const destination = this.places.findIndex((place) => place.key === key);
    if (destination < 0 || !this.bus) return;
    this.selected = key;
    this.openOnArrival = open;
    const start = this.route.length ? this.route[0]! : this.currentStop;
    const remaining = mapRoute(start, destination);
    if (this.route.length) this.route = [start, ...remaining];
    else this.route = remaining;
    if (!this.route.length && open) { this.openOnArrival = false; this.options.onPick(key); }
  }
  neighbour(key: string | null, dx: number, dy: number): string | null {
    const from = this.places.findIndex((place) => place.key === key);
    if (from < 0) return this.keys[0] || null;
    const viewport = this.camera.viewport.toGlobal(this.engine.getRenderWidth(), this.engine.getRenderHeight());
    const points = this.places.map((place) => {
      const p = Vector3.Project(place.mesh.position, Matrix.IdentityReadOnly, this.scene.getTransformMatrix(), viewport);
      return { x: p.x, y: p.y };
    });
    const index = neighbourInDirection(points, from, dx, dy);
    return index < 0 ? null : this.places[index]?.key || null;
  }
  setActive(active: boolean): void {
    if (this.disposed || active === this.active) return;
    this.active = active;
    if (active) { this.resize(); if (!this.ready) this.startLoading(); this.engine.runRenderLoop(this.frame); }
    else this.engine.stopRenderLoop(this.frame);
  }
  resize(): void {
    if (this.disposed) return;
    this.engine.resize();
    const aspect = this.engine.getAspectRatio(this.camera) || 1;
    this.camera.radius = this.baseRadius * Math.max(1, 1.25 / aspect);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer.disconnect();
    this.engine.stopRenderLoop(this.frame);
    for (const instance of this.sceneryInstances) instance.dispose();
    this.assets.dispose();
    this.stopMapQuality();
    this.shadows.dispose();
    this.scene.dispose();
    this.unregisterQuality();
    this.engine.dispose();
  }
  private readonly frame = (): void => {
    if (this.disposed) return;
    const delta = Math.min(this.engine.getDeltaTime() / 1000, 0.1);
    this.gamepadElapsed += delta;
    if (this.gamepadElapsed >= .08) { this.gamepadElapsed = 0; this.pollGamepad(); }
    if (this.bus && this.route.length) {
      const index = this.route[0]!;
      this.nextStop = index;
      if (!this.segmentPath.length) {
        const forward = (index - this.currentStop + 4) % 4 === 1;
        const path = this.paths[forward ? this.currentStop : index]!;
        this.segmentPath = forward ? path : [...path].reverse();
        this.segmentCursor = 1;
      }
      const destination = this.segmentPath[this.segmentCursor]!;
      const dx = destination.x - this.bus.position.x, dz = destination.z - this.bus.position.z;
      const distance = Math.hypot(dx, dz), advance = Math.min(distance, delta * (this.reducedMotion.matches ? 10 : 3.2));
      if (distance > .0001) {
        this.bus.position.x += dx / distance * advance; this.bus.position.z += dz / distance * advance;
        const heading = Math.atan2(dx, dz);
        const turn = Math.atan2(Math.sin(heading-this.bus.rotation.y), Math.cos(heading-this.bus.rotation.y));
        this.bus.rotation.y += turn * Math.min(1, delta * 10);
        for (const wheel of this.wheels) wheel.rotation.x += advance * 5;
      }
      if (distance <= advance + .0001) {
        this.segmentCursor++;
        if (this.segmentCursor >= this.segmentPath.length) {
          this.currentStop = index; this.route.shift(); this.segmentPath = [];
          if (!this.route.length && this.openOnArrival) {
            this.openOnArrival = false; this.options.onPick(this.places[index]?.key || null);
          }
        }
      }
    }
    for (const place of this.places) {
      const target = place.key === this.selected || place.key === this.hovered ? 1.09 : 1;
      const scale = this.reducedMotion.matches ? target : place.mesh.scaling.x + (target - place.mesh.scaling.x) * (1 - Math.exp(-delta * 10));
      place.mesh.scaling.setAll(scale);
      // Keep the lower edge on the plaza even while the artwork grows on hover.
      place.mesh.position.y = place.base.y * scale;
    }
    this.scene.render();
  };
  /** Held gamepad controls emit one key press, at a reduced polling rate. */
  private pollGamepad(): void {
    const pad = navigator.getGamepads?.().find((candidate) => candidate?.connected);
    if (pad && document.activeElement === this.canvas) {
      const buttons: [string, boolean][] = [
        ["ArrowLeft", !!pad.buttons[14]?.pressed || (pad.axes[0] ?? 0) < -.65],
        ["ArrowRight", !!pad.buttons[15]?.pressed || (pad.axes[0] ?? 0) > .65],
        ["ArrowUp", !!pad.buttons[12]?.pressed || (pad.axes[1] ?? 0) < -.65],
        ["ArrowDown", !!pad.buttons[13]?.pressed || (pad.axes[1] ?? 0) > .65],
        ["Enter", !!pad.buttons[0]?.pressed], ["Escape", !!pad.buttons[1]?.pressed],
      ];
      for (const [key, pressed] of buttons) {
        if (pressed && !this.gamepadButtons.has(key)) this.canvas.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        if (pressed) this.gamepadButtons.add(key); else this.gamepadButtons.delete(key);
      }
    } else this.gamepadButtons.clear();
  }
  private async load(): Promise<boolean> {
    // Verify every source before constructing the scene, so a failed request cannot
    // expose a half-built map. The shared cache also lets retry reuse successful files.
    const modelIds = ["town-surroundings", "town-street", "rainha-bus", "araucaria", "coreto", "banco_praca", "poste_globo", "canteiro_flores", "timber-house-medium", "timber-house-large"];
    const textureUrls = [grassTextureUrl, stoneTextureUrl, hillsTextureUrl, ...PLACES.map((place) => publicUrl(`assets/ui/level-map/${place.image}.webp`))];
    const [models] = await Promise.all([
      Promise.all(modelIds.map((id) => this.assets.preload(id))),
      Promise.all(textureUrls.map((url) => assetCache.fetch(absoluteUrl(url), "background"))),
    ]);
    if (models.some((loaded) => !loaded)) throw new Error("A required map model could not be loaded");
    if (this.disposed) return false;
    const material = (name: string, color: string): StandardMaterial => {
      const result = new StandardMaterial(name, this.scene);
      result.diffuseColor = Color3.FromHexString(color);
      result.specularColor = Color3.Black();
      return result;
    };
    const sky = new StandardMaterial("distant-hills-material", this.scene);
    sky.diffuseTexture = this.assets.createTexture(hillsTextureUrl, { priority: "background" });
    sky.emissiveColor = Color3.White(); sky.disableLighting = true; sky.backFaceCulling = false;
    const horizon = MeshBuilder.CreatePlane("distant-hills", { width: 60, height: 14 }, this.scene);
    horizon.position.set(0, 6, -18); horizon.material=sky; horizon.isPickable=false;
    const grass = material("map-grass", "#5da947");
    const earth = material("map-earth", "#816047");
    const pavement = material("map-paving", "#ffffff");
    const pavingTexture = this.assets.createTexture(stoneTextureUrl, { priority: "background" });
    pavingTexture.uScale = 4; pavingTexture.vScale = 4; pavement.diffuseTexture = pavingTexture;
    grass.diffuseColor = Color3.FromHexString("#c2d2bb");
    const grassTexture = this.assets.createTexture(grassTextureUrl, { priority: "background" });
    grassTexture.uScale = 80; grassTexture.vScale = 80; grass.diffuseTexture = grassTexture;
    const roadEdge = material("map-road-edge", "#b49c78");
    const trunk = material("map-trunk", "#79523b");
    const leaves = material("map-araucaria", "#397a42");
    const shrub = material("map-shrub", "#76ad52");
    const ground = MeshBuilder.CreateBox("new-town-earth", { width: 240, depth: 240, height: 0.65 }, this.scene);
    ground.position.y = -0.38; ground.material = earth; ground.isPickable = false;
    // One continuous terrain mesh: a flat playable center transitions into distant hills.
    const lawn = MeshBuilder.CreateGround("new-town-grass", { width:240, height:240, subdivisions:160, updatable:true }, this.scene);
    const positions = lawn.getVerticesData(VertexBuffer.PositionKind);
    const indices = lawn.getIndices();
    if (positions && indices) {
      for (let i=0;i<positions.length;i+=3) {
        const x=positions[i]!, z=positions[i+2]!, t=Math.min(1,Math.max(0,(-z-11)/14));
        const blend=t*t*(3-2*t), hills=Math.max(.1,.85+.42*Math.sin(x*.17+z*.11)+.35*Math.cos(x*.09-z*.15));
        positions[i+1]=.02+blend*hills*2.2;
      }
      const normals:number[]=[]; VertexData.ComputeNormals(positions,indices,normals);
      lawn.updateVerticesData(VertexBuffer.PositionKind,positions); lawn.updateVerticesData(VertexBuffer.NormalKind,normals);
    }
    lawn.material = grass; lawn.isPickable = false;
    // Curved roads are a succession of small flat 3D pieces, not an image baked into the ground.
    const road = (points: readonly (readonly [number, number])[], width: number): void => {
      const controls = points.map(([x,z]) => new Vector3(x,.046,z)), sampled: Vector3[] = [];
      for (let i=0;i<controls.length-1;i++) {
        const a=controls[Math.max(0,i-1)]!, b=controls[i]!, c=controls[i+1]!, d=controls[Math.min(controls.length-1,i+2)]!;
        for (let step=0;step<8;step++) sampled.push(Vector3.CatmullRom(a,b,c,d,step/8));
      }
      sampled.push(controls.at(-1)!);
      const left:Vector3[]=[], right:Vector3[]=[];
      for (let i=0;i<sampled.length;i++) {
        const point=sampled[i]!,prev=sampled[Math.max(0,i-1)]!,next=sampled[Math.min(sampled.length-1,i+1)]!;
        const dx=next.x-prev.x,dz=next.z-prev.z,inv=1/Math.max(.00001,Math.hypot(dx,dz));
        left.push(new Vector3(point.x+dz*inv*width*.5,.046,point.z-dx*inv*width*.5));
        right.push(new Vector3(point.x-dz*inv*width*.5,.046,point.z+dx*inv*width*.5));
      }
      const path=MeshBuilder.CreateRibbon("town-footpath",{pathArray:[left,right],sideOrientation:Mesh.DOUBLESIDE},this.scene);
      path.material=pavement;path.isPickable=false;
    };
    const asphalt = material("town-asphalt", "#5f6664");
    const stripe = material("town-road-marking", "#f4df9f");
    for (let edge=0;edge<MAP_STOPS.length;edge++) {
      const points = sampleMapEdge(edge).map(({ x, z }) => new Vector3(x, .1, z));
      this.paths.push(points);
      const buildRibbon = (width: number, height: number, name: string, mat: StandardMaterial): void => {
        const left: Vector3[] = [], right: Vector3[] = [];
        for (let i=0;i<points.length;i++) {
          const point=points[i]!, prev=points[Math.max(0,i-1)]!, next=points[Math.min(points.length-1,i+1)]!;
          const dx=next.x-prev.x, dz=next.z-prev.z, inv=1/Math.max(.00001,Math.hypot(dx,dz));
          const ox=dz*inv*width*.5, oz=-dx*inv*width*.5;
          left.push(new Vector3(point.x+ox,height,point.z+oz)); right.push(new Vector3(point.x-ox,height,point.z-oz));
        }
        const ribbon=MeshBuilder.CreateRibbon(name,{pathArray:[left,right],sideOrientation:Mesh.DOUBLESIDE},this.scene);
        ribbon.material=mat;ribbon.isPickable=false;
      };
      buildRibbon(1.24,.05,"town-sidewalk",pavement); buildRibbon(.95,.07,"town-street",asphalt);
      for (let i=1;i<points.length;i+=3) {
        const v0=points[i-1]!,v1=points[i]!,angle=Math.atan2(v1.x-v0.x,v1.z-v0.z);
        const dash=MeshBuilder.CreateBox("road-dash",{width:.035,height:.01,depth:.16},this.scene);
        dash.position.set((v0.x+v1.x)/2,.09,(v0.z+v1.z)/2);dash.rotation.y=angle;dash.material=stripe;dash.isPickable=false;
      }
      const stop=this.stops[edge]!;
      const sidewalk=MeshBuilder.CreateCylinder("town-sidewalk-corner",{diameter:1.24,height:.02,tessellation:24},this.scene);
      sidewalk.position.set(stop.x,.04,stop.z);sidewalk.material=pavement;sidewalk.isPickable=false;
      const junction=MeshBuilder.CreateCylinder("town-street-corner",{diameter:.95,height:.02,tessellation:24},this.scene);
      junction.position.set(stop.x,.071,stop.z);junction.material=asphalt;junction.isPickable=false;
    }
    road([[-4.1,-2.25],[-2.2,-1.65]],.55); road([[4.1,-4.0],[4.1,-3.0]],.55);
    road([[-4.1,4.0],[-4.1,3.0]],.55); road([[4.1,4.0],[4.1,3.0]],.55);
    // A pedestrian promenade links the foreground gardens and houses, outside the bus loop.
    road([[-7,6.5],[-5.4,6.1],[-3.8,6.45],[-2,6.1],[0,6.5],[2,6.1],[3.8,6.45],[5.4,6.1],[7,6.5]],.52);
    const centralSquare = MeshBuilder.CreateGround("town-square-paving", { width: 3.45, height: 2.05 }, this.scene);
    centralSquare.position.y=.045; centralSquare.material=pavement; centralSquare.isPickable=false;
    const plaza = MeshBuilder.CreateCylinder("town-square", { diameter: 2.1, height: 0.07, tessellation: 32 }, this.scene);
    plaza.position.y = 0.06; plaza.material = roadEdge; plaza.isPickable = false;
    const square = MeshBuilder.CreateCylinder("town-square-inner", { diameter: 1.85, height: 0.075, tessellation: 32 }, this.scene);
    square.position.y = 0.08; square.material = pavement; square.isPickable = false;
    // A small octagonal bandstand recalls the coreto in São Bento's central square.
    const roofColor = material("gazebo-roof", "#666e73");
    const gazeboPillar = material("gazebo-pillars", "#dfdeda");
    const base = MeshBuilder.CreateCylinder("gazebo-base", { diameter: 1.15, height: .18, tessellation: 8 }, this.scene);
    base.position.y = .21; base.material = roadEdge; base.isPickable = false;
    for (let i=0; i<8; i++) {
      const angle = i*Math.PI/4;
      const pillar = MeshBuilder.CreateCylinder("gazebo-column", { diameter: .06, height: .72, tessellation: 6 }, this.scene);
      pillar.position.set(Math.cos(angle)*.43,.65,Math.sin(angle)*.43);
      pillar.material = gazeboPillar; pillar.isPickable = false;
    }
    const roof = MeshBuilder.CreateCylinder("gazebo-roof", { diameterTop: .05, diameterBottom: 1.32, height: .38, tessellation: 8 }, this.scene);
    roof.position.y = 1.18; roof.material = roofColor; roof.isPickable = false;
    // The plaza pads give every landmark an explicit ground contact and a shared visual anchor.
    for (const place of PLACES) {
      const pad = MeshBuilder.CreateGround(`plaza-${place.image}`, { width: place.width * .8, height: 1.15 }, this.scene);
      pad.position.set(place.x, place.image === "church" ? .69 : .10, place.z); pad.material = pavement; pad.isPickable = false;
    }
    // Festival bunting sits in the Schlachtfest district as physical 3D geometry.
    const flagColors = [material("festival-black", "#252b2b"), material("festival-red", "#d64b36"), material("festival-gold", "#e9ba41")];
    for (const color of flagColors) { color.backFaceCulling=false; color.emissiveColor=color.diffuseColor.scale(.22); }
    const flagPoleMaterial=material("festival-pole", "#71533b");
    for (const x of [2.4,5.8]) {
      const pole=MeshBuilder.CreateCylinder("festival-pole",{height:1.96,diameter:.055,tessellation:8},this.scene);
      pole.position.set(x,.98,4.18);pole.material=flagPoleMaterial;pole.isPickable=false;
    }
    const flagLine = MeshBuilder.CreateLines("festival-line", { points:[new Vector3(2.4,1.95,4.18),new Vector3(4.1,1.68,4.18),new Vector3(5.8,1.95,4.18)] }, this.scene);
    flagLine.color=Color3.FromHexString("#e9dcc5"); flagLine.isPickable=false;
    for(let i=0;i<12;i++) {
      const x=2.5+i*.27, top=1.68+Math.abs(x-4.1)*.16;
      const flag=new Mesh("festival-flag",this.scene), data=new VertexData();
      data.positions=[x,top,4.18,x+.22,top,4.18,x+.11,top-.23,4.18]; data.indices=[0,1,2];
      const normals:number[]=[]; VertexData.ComputeNormals(data.positions,data.indices,normals); data.normals=normals; data.applyToMesh(flag);
      flag.material=flagColors[i%3]!;flag.isPickable=false;
    }
    // Terraced masonry and a central stone stairway support the church illustration.
    const stone = material("church-stone", "#969b96");
    const lightStone = material("church-light-stone", "#c8c3b4");
    const retaining = MeshBuilder.CreateBox("church-terrace", {width: 3.35, height: .56, depth: 1.45}, this.scene);
    retaining.position.set(-4.1,.32,-4.25); retaining.material=stone; retaining.isPickable=false;
    const terraceTop = MeshBuilder.CreateBox("church-terrace-top", {width: 3.45, height: .08, depth: 1.5}, this.scene);
    terraceTop.position.set(-4.1,.64,-4.25); terraceTop.material=lightStone; terraceTop.isPickable=false;
    for(let i=0;i<6;i++) {
      const step=MeshBuilder.CreateBox("church-stone-step",{width:1.65,height:.095,depth:.25},this.scene);
      step.position.set(-4.1,.12+(5-i)*.095,-3.48+i*.25);step.material=lightStone;step.isPickable=false;
      for(const sign of [-1,1]) {
        const wall=MeshBuilder.CreateBox("church-retaining-wall",{width:.18,height:.14+(5-i)*.085,depth:.26},this.scene);
        wall.position.set(-4.1+sign*.92,.08+(.14+(5-i)*.085)/2,-3.48+i*.25);
        wall.material=stone;wall.isPickable=false;
      }
    }
    const plaque = material("church-plaque", "#f3e9d6");
    const plaqueImage = material("church-plaque-detail", "#81a9ba");
    for (let i=0; i<4; i++) for (const sign of [-1,1]) {
      const z=-3.52+i*.35, h=.19+(3-i)*.095;
      const frame=MeshBuilder.CreateBox("church-way-of-cross",{width:.25,height:.26,depth:.045},this.scene);
      frame.position.set(-4.1+sign*1.22,h+.2,z);frame.material=plaque;frame.isPickable=false;
      const image=MeshBuilder.CreateBox("church-way-of-cross-image",{width:.16,height:.17,depth:.05},this.scene);
      image.position.set(-4.1+sign*1.22,h+.2,z+.025);image.material=plaqueImage;image.isPickable=false;
    }
    const trees: readonly (readonly [number, number, number])[] = [
      [-6.6,-3.9,1.15],[-2.1,-4.0,.9],[1.3,-4.0,1.1],[6.5,-3.8,1.5],
      [-6.7,0,.95],[6.7,0,1.1],[-6.4,4.0,1.5],[-1.6,4.1,.9],[1.7,4.0,1.5],[6.4,4,1.0],
    ];
    for (const [x,z,scale] of trees) {
      const stem = MeshBuilder.CreateCylinder("araucaria-trunk", { height: 1.6*scale, diameter: .18*scale, tessellation: 8 }, this.scene);
      stem.position.set(x,.8*scale,z); stem.material = trunk; stem.isPickable = false;
      for (let level=0; level<3; level++) {
        const crown = MeshBuilder.CreateSphere("araucaria-crown", { diameter: (1.35-level*.22)*scale, segments: 8 }, this.scene);
        crown.scaling.y=.24; crown.position.set(x,(1.25+level*.3)*scale,z); crown.material=leaves; crown.isPickable=false;
      }
    }
    for (const {x,z} of MAP_BUSHES) {
      const bush = MeshBuilder.CreateSphere("town-bush", { diameter: .65, segments: 8 }, this.scene);
      bush.position.set(x,.26,z); bush.scaling.y=.8; bush.material=shrub; bush.isPickable=false;
    }
    // Compact city blocks, foliage and street furniture build a town around the route.
    const lampMat = material("lamp-post", "#4c4b3c");
    // Timber-frame village houses, placed outside the traffic and destination areas.
    const villageWalls = [material("village-ivory", "#ece1c4"), material("village-sand", "#d8be91"), material("village-pale-blue", "#c4d8d0")];
    const villageTimber = material("village-timber", "#765039");
    const villageRoof = material("village-roof", "#a9533f");
    const villageGlass = material("village-glass", "#608e9b");
    const villageTrim = material("village-trim", "#f1e4ca");
    const housePart = (name: string, x: number, y: number, z: number, w: number, h: number, d: number, mat: StandardMaterial, angle = 0): Mesh => {
      const mesh = MeshBuilder.CreateBox(name, { width:w, height:h, depth:d }, this.scene);
      mesh.position.set(x,y,z); mesh.rotation.x=angle; mesh.material=mat; mesh.isPickable=false; return mesh;
    };
    const houseSpots = [[0,-7.2,-6.3,.75],[1,-4.9,-7.4,.9],[2,-2.4,-7.8,.8],[3,.2,-8.1,.85],
      [4,2.8,-7.8,.85],[5,5.3,-7.4,.9],[6,7.5,-6.2,.75],
      [7,-7.8,-3.2,.8],[8,7.8,-3.2,.8],[9,-8,3.5,.75],[10,8,3.5,.75],
      [11,-6.8,7,.8],[12,6.8,7,.8], [13,-6.5,-.8,.8],[14,6.5,-.8,.8],[15,-6.5,1.5,.75],[16,6.5,1.5,.75]] as const;
    for (const [index,x,z,scale] of houseSpots) {
      const h=.9*scale, w=1.25*scale, depth=.85*scale, front=z+depth/2;
      housePart("village-wall",x,h/2,z,w,h,depth,villageWalls[index%3]!);
      for (const side of [-1,1]) {
        housePart("village-corner",x+side*w*.46,h/2,front,.07*scale,h,.035*scale,villageTimber);
        housePart("village-window-frame",x+side*w*.25,h*.58,front+.024,.33*scale,.31*scale,.04*scale,villageTrim);
        housePart("village-window",x+side*w*.25,h*.58,front+.05,.23*scale,.22*scale,.02*scale,villageGlass);
        housePart("village-window-divider",x+side*w*.25,h*.58,front+.064,.025*scale,.22*scale,.016*scale,villageTrim);
        housePart("village-roof-slope",x,h+depth*.26,z+side*depth*.25,w*1.12,.075*scale,depth*.63,villageRoof,side*.55);
      }
      housePart("village-horizontal-beam",x,h*.31,front+.025,w,.07*scale,.04*scale,villageTimber);
      housePart("village-door",x,h*.22,front+.04,.2*scale,.43*scale,.035*scale,villageTimber);
    }
    for (const {x,z} of MAP_LAMPS) {
      const post=MeshBuilder.CreateCylinder("street-lamp",{height:.8,diameter:.045,tessellation:6},this.scene);
      post.position.set(x,.4,z);post.material=lampMat;post.isPickable=false;
      const globe=MeshBuilder.CreateSphere("street-light",{diameter:.17,segments:6},this.scene);
      globe.position.set(x,.85,z);globe.material=pavement;globe.isPickable=false;
    }
    this.bus = new TransformNode("rainha-bus",this.scene);
    this.bus.position.copyFrom(this.stops[0]!);
    const orange=material("bus-orange","#ec721c"), glass=material("bus-glass","#285269"), tires=material("bus-tires","#252d32");
    const body=MeshBuilder.CreateBox("bus-body",{width:.47,height:.5,depth:1.05},this.scene);
    body.parent=this.bus;body.position.y=.36;body.material=orange;body.isPickable=false;
    const windows=MeshBuilder.CreateBox("bus-windows",{width:.475,height:.22,depth:.92},this.scene);
    windows.parent=this.bus;windows.position.y=.52;windows.material=glass;windows.isPickable=false;
    const busTrim=material("bus-detail-white","#f5e6d0");
    const trim=MeshBuilder.CreateBox("bus-side-stripe",{width:.485,height:.035,depth:1.01},this.scene);
    trim.parent=this.bus;trim.position.y=.27;trim.material=busTrim;trim.isPickable=false;
    for (const x of [-.24,.24]) for (const z of [-.3,-.1,.1,.3]) {
      const divider=MeshBuilder.CreateBox("bus-window-divider",{width:.012,height:.22,depth:.025},this.scene);
      divider.parent=this.bus;divider.position.set(x,.52,z);divider.material=orange;divider.isPickable=false;
    }
    const roofBus=MeshBuilder.CreateBox("bus-roof",{width:.48,height:.07,depth:1.04},this.scene);
    roofBus.parent=this.bus;roofBus.position.y=.67;roofBus.material=orange;roofBus.isPickable=false;
    for (const x of [-.245,.245]) for (const z of [-.33,.33]) {
      const wheel=MeshBuilder.CreateCylinder("bus-wheel",{diameter:.19,height:.07,tessellation:12},this.scene);
      wheel.rotation.z=Math.PI/2;wheel.parent=this.bus;wheel.position.set(x,.16,z);wheel.material=tires;wheel.isPickable=false;this.wheels.push(wheel);
    }
    const oldBusMeshes = this.bus.getChildMeshes();
    const detailedBus = await this.assets.instantiateModel("rainha-bus", { namePrefix: "rainha-", cloneMaterials: true });
    if (detailedBus && !this.disposed) {
      this.sceneryInstances.push(detailedBus);
      const modelRoot = new TransformNode("rainha-model-root", this.scene);
      modelRoot.parent = this.bus; modelRoot.scaling.setAll(.13);
      this.wheels = [];
      for (const root of detailedBus.rootNodes) {
        root.parent = modelRoot;
        for (const node of [root, ...root.getDescendants(false)]) {
          if (node instanceof TransformNode && /wheel-(front|rear)-(l|r)$/.test(node.name)) this.wheels.push(node);
          if (node instanceof AbstractMesh) {
            node.isPickable = false;
            if (node.name.includes("azure") && node.material instanceof PBRMaterial) node.material.albedoColor = Color3.FromHexString("#ed741b");
          }
        }
      }
      for (const mesh of oldBusMeshes) mesh.setEnabled(false);
    } else if (detailedBus) detailedBus.dispose();
    const scenery = await this.assets.instantiateModel("town-surroundings", { namePrefix: "surroundings-" });
    if (scenery && !this.disposed) {
      this.sceneryInstances.push(scenery);
      const environment = new TransformNode("surrounding-city", this.scene);
      environment.scaling.setAll(.22);
      environment.position.y = -.12;
      for (const root of scenery.rootNodes) {
        root.parent = environment;
        for (const node of [root, ...root.getDescendants(false)]) {
          if (node instanceof Mesh) {
            node.isPickable = false;
            if (node.name.includes("Calcada") || node.name.includes("Nuvem")) node.setEnabled(false);
          }
        }
      }
    } else if (scenery) scenery.dispose();
    // Reuse local town assets as scenery, all loaded through the central asset manager.
    const street = await this.assets.instantiateModel("town-street", { namePrefix: "outskirts-" });
    if (street && !this.disposed) {
      this.sceneryInstances.push(street);
      const outskirts = new TransformNode("outskirts-root", this.scene);
      outskirts.scaling.setAll(.18); outskirts.position.set(0, 0, -7.5);
      const skip = /street_(asphalt|curb|road_line|paver|grass|church|church_dark|church_trim|cross|clock|cloud|hill|stone|stone_dark)/;
      for (const root of street.rootNodes) {
        root.parent = outskirts;
        for (const node of [root, ...root.getDescendants(false)]) if (node instanceof AbstractMesh) {
          node.isPickable = false;
          if (skip.test(node.name)) node.setEnabled(false);
        }
      }
    } else if (street) street.dispose();
    const addModel = async (id: string, x: number, z: number, scale: number, rotation = 0): Promise<boolean> => {
      const instance = await this.assets.instantiateModel(id, { namePrefix: `map-${id}-` });
      if (!instance) return false;
      if (this.disposed) { instance.dispose(); return false; }
      this.sceneryInstances.push(instance);
      const root = new TransformNode(`map-${id}-root`, this.scene);
      root.position.set(x, .02, z); root.scaling.setAll(scale); root.rotation.y = rotation;
      for (const node of instance.rootNodes) {
        node.parent = root;
        for (const mesh of [node, ...node.getDescendants(false)]) if (mesh instanceof AbstractMesh) {
          mesh.isPickable = false;
          if (id.startsWith("timber-house") && mesh.material instanceof PBRMaterial && mesh.material.name.includes("tile")) {
            mesh.material.albedoColor = Color3.FromHexString("#a9563b");
          }
          if (id === "coreto" && mesh.material instanceof PBRMaterial && mesh.material.name.includes("Telha")) {
            mesh.material.albedoColor = Color3.FromHexString("#878d8c");
          }
        }
      }
      return true;
    };
    // Fill the distant districts with the same shared geometry, offset beyond the route.
    for (const [x,z,rotation] of [[-8.5,-7.5,0],[8.5,-7.5,0],[-8,12,Math.PI],[8,12,Math.PI]] as const) {
      const district = await this.assets.instantiateModel("town-street", { namePrefix: "district-" });
      if (!district) continue;
      if (this.disposed) { district.dispose(); continue; }
      this.sceneryInstances.push(district);
      const rootNode = new TransformNode("district-root", this.scene);
      rootNode.scaling.setAll(.15); rootNode.position.set(x, 0, z); rootNode.rotation.y = rotation;
      for (const root of district.rootNodes) {
        root.parent = rootNode;
        for (const node of [root, ...root.getDescendants(false)]) if (node instanceof AbstractMesh) {
          node.isPickable = false;
          if (/street_(asphalt|curb|road_line|paver|grass|church|church_dark|church_trim|cross|clock|cloud|hill|stone|stone_dark)/.test(node.name)) node.setEnabled(false);
        }
      }
    }
    const [hasCoreto, ...treeResults] = await Promise.all([
      addModel("coreto", 0, 0, .27, Math.PI / 2),
      ...trees.map(([x,z,scale]) => addModel("araucaria", x, z, scale * .32)),
      addModel("banco_praca", -1, -.5, .30, Math.PI / 2),
      addModel("banco_praca", 1, .5, .30, -Math.PI / 2),
      addModel("poste_globo", -1.1, .6, .25),
      addModel("poste_globo", 1.1, -.6, .25),
      addModel("banco_praca", -2.5, 5.65, .3, Math.PI),
      addModel("banco_praca", 2.5, 5.65, .3, Math.PI),
      addModel("poste_globo", 0, 6.65, .25),
    ]);
    const detailedHouses = await Promise.all(houseSpots.map(([index,x,z,scale]) =>
      addModel(index % 3 === 0 ? "timber-house-large" : "timber-house-medium", x, z, scale * .115, z > 0 ? Math.PI : 0),
    ));
    if (detailedHouses.every(Boolean)) for (const mesh of this.scene.meshes) {
      if (mesh.name.startsWith("village-")) mesh.setEnabled(false);
    }
    if (hasCoreto) for (const mesh of this.scene.meshes) {
      if (["gazebo-base", "gazebo-column", "gazebo-roof"].includes(mesh.name)) mesh.setEnabled(false);
    }
    if (treeResults.slice(0, trees.length).every(Boolean)) for (const mesh of this.scene.meshes) {
      if (mesh.name === "araucaria-trunk" || mesh.name === "araucaria-crown") mesh.setEnabled(false);
    }
    // Small flower beds and low stone edging give the districts an inhabited scale.
    const flowers = [material("flower-blue", "#638bd4"), material("flower-pink", "#dc92b7"), material("flower-gold", "#efc357")];
    const flowerSpots = [[0,-5.5,-3.2],[1,-2.8,-4.6],[2,2.8,-4.6],[3,5.5,-3.2],
      [4,-5.5,3.2],[5,-2.8,4.6],[6,2.8,4.6],[7,5.5,3.2],[8,-1.4,-.3],[9,1.4,.3],
      [10,-4.2,5.7],[11,-1.3,5.65],[12,1.3,5.65],[13,4.2,5.7]] as const;
    for (const [i,x,z] of flowerSpots) {
      const bed=MeshBuilder.CreateSphere("flower-bed",{diameter:.64,segments:7},this.scene);
      bed.position.set(x,.12,z);bed.scaling.set(1,.38,.72);bed.material=shrub;bed.isPickable=false;
      for(let j=0;j<5;j++) {
        const bloom=MeshBuilder.CreateSphere("flower-bloom",{diameter:.16,segments:5},this.scene);
        const angle=j*Math.PI*2/5;bloom.position.set(x+Math.cos(angle)*.19,.26,z+Math.sin(angle)*.13);
        bloom.material=flowers[(i+j)%3]!;bloom.isPickable=false;
      }
    }
    const detailedFlowers = await Promise.all(flowerSpots.map(([i,x,z]) => addModel("canteiro_flores", x, z, .55, i * .7)));
    if (detailedFlowers.every(Boolean)) for (const mesh of this.scene.meshes) {
      if (mesh.name === "flower-bed" || mesh.name === "flower-bloom") mesh.setEnabled(false);
    }
    this.camera.target.set(0, .55, 0);
    this.baseRadius = 12.0;
    for (let i = 0; i < PLACES.length; i++) {
      const place = PLACES[i]!;
      const mesh = MeshBuilder.CreatePlane(`landmark-${place.image}`, { width: place.width, height: place.height }, this.scene);
      // Y-only billboard stays vertical: its bottom edge rests on the plaza, including on mobile.
      mesh.billboardMode = Mesh.BILLBOARDMODE_Y;
      mesh.position.set(place.x, place.height / 2 + (place.image === "church" ? .72 : .13), place.z);
      const art = new StandardMaterial(`landmark-${place.image}-material`, this.scene);
      art.diffuseTexture = this.assets.createTexture(publicUrl(`assets/ui/level-map/${place.image}.webp`), { hasAlpha: true, priority: "critical" });
      art.useAlphaFromDiffuseTexture = true; art.emissiveColor = Color3.White(); art.disableLighting = true; art.backFaceCulling = false;
      mesh.material = art;
      const key = this.keys[i] ?? ""; mesh.metadata = { levelKey: key };
      this.places.push({ key, mesh, base: mesh.position.clone() });
    }
    for (const mesh of this.scene.meshes) {
      if (mesh.name === "new-town-grass" || mesh.name === "town-square-inner" || mesh.name === "town-square-paving" || mesh.name.startsWith("town-street")) mesh.receiveShadows = true;
      if (/^(map-araucaria-|map-coreto-|map-timber-house-|village-|rainha-city-bus)/.test(mesh.name)) this.shadows.addShadowCaster(mesh, false);
    }
    this.resize();
    await this.scene.whenReadyAsync();
    return !this.disposed;
  }
}

