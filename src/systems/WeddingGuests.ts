import { Color3, DynamicTexture, Matrix, Mesh, MeshBuilder, StandardMaterial, Texture, Vector3, type Scene } from '@babylonjs/core';
import type { AssetManager } from '../core/AssetManager';
import { CharacterController } from '../entities/CharacterController';
import { isCharacterBody, markCharacterBody } from '../physics/groundProbe';
import { ROBOT_COLLISION_MASK, STEP_OVER_HEIGHT } from '../physics/collisionPolicy';
import { NavGrid, decideRightOfWay, type Mover, type NavPoint, type Rect } from './RobotNavigation';
import type { MovementBounds } from '../entities/Player';
import type { CharacterDefinition } from '../data/characters';
import type { Order } from '../types/game';
import { publicUrl } from '../utils/assetUrl';
import { bundledModelUrl } from '../core/assets/assetRegistry';
import { onLanguageChange, t } from '../i18n';
import { integrateFall, isGroundedOn } from '../entities/groundedMove';
import type { NearbyColliders } from '../physics/nearbyColliders';
import {
  DEFAULT_ROBOT_CONFIG, ROBOT_ASSET_ID, getRobotClip,
  type RobotConfig, type RobotSpawn,
} from '../data/robotConfig';
import { ROBOT_VARIANT_CHARACTERS, type RobotVariant } from '../data/robotVariants';

export const MANNEQUIN: CharacterDefinition = {
  id: 'wedding-mannequin', get displayName() { return t('wedding.guest'); }, get role() { return t('wedding.guestRole'); },
  modelAssetId: ROBOT_ASSET_ID,
  modelUrl: bundledModelUrl("Anim/Mannequin Character/characters/Mannequin_Medium.glb"),
  previewUrl: '', targetHeight: 1.8, rig: 'Rig_Medium',
};
/** The model a robot wears: the plain Mannequin, or one of the dressed variants. */
export const robotCharacter = (variant: RobotVariant): CharacterDefinition =>
  variant === 'plain' ? MANNEQUIN : ROBOT_VARIANT_CHARACTERS[variant];

/** Dishes a guest can be seen eating; names live with the recipes. */
const DISH_IDS = ['ram_cake', 'cache_cookies', 'cooling_gelato'] as const;
/** Four robots keeps the reception readable and the frame budget predictable. */
const NAMES = ['Ada-01', 'Turing-02', 'Pixel-03', 'Nina-04'];
/** A flat sign with the couple's name, hung where a decorated hall has room for it. */
export interface ReceptionBanner {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
}

export interface WeddingGuest {
  id: number; name: string; root: Mesh; controller: CharacterController;
  target: Vector3; active: boolean; wait: number; requestedRecipe: string | null;
  icon: Mesh;
  /** Seconds spent unable to make progress toward `target`. */
  blockedFor: number;
  /** Remaining waypoints to `target`, nearest first. */
  path: NavPoint[];
  /** Metres covered last frame, used to tell walking robots from stopped ones. */
  lastSpeed: number;
  /** Where this robot belongs: its editor position, or its spot in the reception. */
  anchor: Vector3;
  config: RobotConfig;
  /** Seconds left of a one-shot (a throw) that must not be cut by the idle clip. */
  busy: number;
}

/** A guest's outstanding kitchen ticket. */
interface GuestTicket {
  recipeId: string;
  guest: WeddingGuest;
  /** Latches the one-off "is my order coming?" complaint. */
  nagged: boolean;
}

/** How quickly a robot turns toward its heading. */
const TURN_RESPONSE = 7;
/** A waypoint counts as reached inside this radius. */
const WAYPOINT_RADIUS = 0.35;
/** Robot height, for deciding which geometry can actually block one. */
const ROBOT_HEIGHT = 1.8;
/** How often the scene is rescanned for layout changes. Colliders are static
 *  once the kitchen has loaded, so this only needs to catch the load itself. */
const GRID_RECHECK_SECONDS = 1;
/** Seconds of no progress before re-routing, then before giving up on a target. */
const REPATH_AFTER = 1.2;
const ABANDON_AFTER = 3;

/** Seconds left on a ticket before its guest starts complaining. */
const NAG_THRESHOLD_SECONDS = 15;
/** Leave room between the couple's bodies when the bride reaches the altar. */
const ALTAR_MEETING_DISTANCE = 1.05;
/** Bounded reception, staggered arrivals and one kitchen ticket per guest. */
export class WeddingGuests {
  readonly guests: WeddingGuest[] = [];
  readonly ready: Promise<void>;
  readonly area: MovementBounds;
  private readonly ownedMeshes: Mesh[] = [];
  private readonly materials: StandardMaterial[] = [];
  private readonly textures: Texture[] = [];
  /** Signs drawn with text, redrawn when the language changes. */
  private readonly signs: (() => void)[] = [];
  private readonly stopLanguage = onLanguageChange(() => { for (const draw of this.signs) draw(); });
  private readonly dishMaterials = new Map<string, StandardMaterial>();
  private elapsed = 0;
  private nextArrival = 0;
  /** Orders currently held by a guest, keyed by order id. */
  private readonly tickets = new Map<string, GuestTicket>();
  /** Orders waiting for a free guest; retried every frame from `update`. */
  private pending: { orderId: string; recipeId: string }[] = [];
  private lastRecipient = -1;
  private generation = 0;
  /** True when the cast came from a map's placed robots rather than the wedding default. */
  private readonly placed: boolean;
  private grid: NavGrid | null = null;
  /** Collider count the grid was built from; a change means the level moved. */
  private gridColliders = -1;
  /** Seconds since the collider set was last checked. */
  private gridAge = Number.POSITIVE_INFINITY;
  private readonly bounds: MovementBounds;
  private readonly ceremony: {
    bride: WeddingGuest;
    groom: WeddingGuest;
    destination: Vector3;
    yaw: number;
    arrived: boolean;
  } | null;

  /**
   * `area` places the reception explicitly; otherwise it is centred in `bounds`.
   *
   * `spawns` is the cast: the robots a map placed in the editor. Without it the wedding's own
   * four robots are built and the reception carpet is drawn, so the built-in level is
   * unchanged. With it, each robot stands where it was dropped and there is no carpet, because
   * a custom map decides its own decor.
   */
  constructor(
    private readonly scene: Scene,
    assets: AssetManager,
    bounds: MovementBounds,
    area?: MovementBounds | null,
    spawns: readonly RobotSpawn[] = [],
    /** Set when the room is already decorated: no carpet, and the sign hangs here. */
    banner: ReceptionBanner | null = null,
    /**
     * Everywhere the level's moving parts can ever reach. Taken once and treated as
     * permanently blocked, which is what keeps the grid from needing a rebuild when a
     * platform moves — see the mechanism exception in AGENTS.md. Robots mill about the
     * reception and have no business riding the kitchen's machinery.
     *
     * Read lazily, not snapshotted: the environment places its mechanisms asynchronously,
     * so at construction time there are none to take.
     */
    private readonly mechanismFootprints: () => readonly Rect[] = () => [],
    choreographWedding = false,
  ) {
    if (area) {
      this.area = { ...area };
    } else {
      const centerX = (bounds.minX + bounds.maxX) / 2;
      const centerZ = (bounds.minZ + bounds.maxZ) / 2 + 0.6;
      const width = Math.min(9, (bounds.maxX - bounds.minX) * 0.48);
      const depth = Math.min(4.4, (bounds.maxZ - bounds.minZ) * 0.34);
      this.area = { minX: centerX - width / 2, maxX: centerX + width / 2, minZ: centerZ - depth / 2, maxZ: centerZ + depth / 2 };
    }
    this.placed = spawns.length > 0;
    this.bounds = { ...bounds };
    if (banner) {
      this.createBanner(banner);
    } else if (!this.placed) {
      const cx = (this.area.minX + this.area.maxX) / 2;
      const cz = (this.area.minZ + this.area.maxZ) / 2;
      this.createReception(cx, cz, this.area.maxX - this.area.minX, this.area.maxZ - this.area.minZ);
    }
    for (const id of DISH_IDS) {
      const mat = this.material(`dish-${id}`, '#ffffff', 0.8);
      const texture = assets.createTexture(publicUrl(`images/dishes/${id}.png`), { hasAlpha: true });
      mat.diffuseTexture = texture;
      mat.emissiveTexture = texture;
      mat.useAlphaFromDiffuseTexture = true;
      this.textures.push(texture);
      this.dishMaterials.set(id, mat);
    }
    const cast: { name: string; anchor: Vector3; rotationY: number; config: RobotConfig; variant: RobotVariant }[] =
      this.placed
        ? spawns.map(spawn => ({
            name: spawn.name,
            // Robots stand on the floor they were placed on (a raised altar, a terrace).
            anchor: new Vector3(spawn.position.x, spawn.position.y > 0.05 ? spawn.position.y : 0, spawn.position.z),
            rotationY: spawn.rotationY,
            config: spawn.config,
            variant: spawn.variant,
          }))
        : NAMES.map((name, index) => {
            const spot = this.receptionSpot(index, NAMES.length);
            return {
              name,
              anchor: new Vector3(spot.x, 0, spot.z),
              rotationY: Math.random() * Math.PI * 2,
              config: DEFAULT_ROBOT_CONFIG,
              variant: 'plain' as RobotVariant,
            };
          });
    for (const [id, entry] of cast.entries()) {
      // The root doubles as the robot's collider, so it is body-sized rather
      // than a marker: the cooks sweep against these triangles, which is what
      // stops them walking through a guest. Baking the translation puts the
      // origin at the feet without shifting the model parented to it.
      const root = MeshBuilder.CreateBox(
        `guest-${id}`,
        { width: 0.64, height: 1.6, depth: 0.64 },
        scene,
      );
      root.bakeTransformIntoVertices(Matrix.Translation(0, 0.8, 0));
      root.isVisible = false;
      root.isPickable = false;
      root.checkCollisions = true;
      markCharacterBody(root);
      root.ellipsoid.set(0.32, 0.8, 0.32);
      // Robots stay on y = 0: ground-level floor tiles are not in their way.
      root.collisionMask = ROBOT_COLLISION_MASK;
      root.ellipsoidOffset.set(0, 0.8, 0);
      const controller = new CharacterController(scene, assets, root);
      const icon = this.billboard(`guest-order-${id}`, 1.1, 1.1, true);
      icon.parent = root;
      icon.position.y = 2.6;
      icon.setEnabled(false);
      root.setEnabled(false);
      root.rotation.y = entry.rotationY;
      this.guests.push({ id, name: entry.name, root, controller, target: entry.anchor.clone(),
        active: false, wait: 0, requestedRecipe: null, icon, blockedFor: 0, busy: 0,
        path: [], lastSpeed: 0,
        anchor: entry.anchor, config: entry.config });
    }
    const bride = choreographWedding ? this.guests[cast.findIndex(entry => entry.variant === 'bride')] : undefined;
    const groom = choreographWedding ? this.guests[cast.findIndex(entry => entry.variant === 'groom')] : undefined;
    this.ceremony = null;
    if (bride && groom) {
      const dx = groom.anchor.x - bride.anchor.x;
      const dz = groom.anchor.z - bride.anchor.z;
      const distance = Math.hypot(dx, dz);
      if (distance > ALTAR_MEETING_DISTANCE) {
        const fraction = 1 - ALTAR_MEETING_DISTANCE / distance;
        this.ceremony = {
          bride, groom,
          destination: Vector3.Lerp(bride.anchor, groom.anchor, fraction),
          yaw: Math.atan2(dx, dz),
          arrived: false,
        };
        bride.config = { ...bride.config, canMove: false };
        groom.config = { ...groom.config, canMove: false };
      }
    }
    this.ready = Promise.all(this.guests.map((guest, index) =>
      guest.controller.selectCharacter(robotCharacter(cast[index]!.variant)))).then(() => undefined);
  }

  reset(shiftDuration: number): void {
    this.generation++;
    this.elapsed = 0; this.nextArrival = 0;
    this.tickets.clear(); this.pending = []; this.lastRecipient = -1;
    for (const g of this.guests) {
      g.active = false; g.requestedRecipe = null; g.blockedFor = 0;
      g.path = []; g.lastSpeed = 0;
      g.icon.setEnabled(false); g.root.setEnabled(false);
    }
    for (let i = 0; i < this.guests.length; i += 1) this.spawn();
    if (this.ceremony) {
      const { bride, groom, destination, yaw } = this.ceremony;
      this.ceremony.arrived = false;
      bride.root.rotation.y = yaw;
      groom.root.rotation.y = yaw + Math.PI;
      bride.controller.setLocomotion('walk');
      // Slow both the travel and the existing walk cycle to match the ceremony's pace.
      const speed = Vector3.Distance(bride.anchor, destination) / shiftDuration;
      bride.controller.setAnimationSpeed(speed);
    }
  }

  /** The aisle is laid out in a straight line. The round clock owns the entire trip. */
  updateCeremony(progress: number): void {
    const ceremony = this.ceremony;
    if (!ceremony || ceremony.arrived) return;
    const { bride, destination } = ceremony;
    Vector3.LerpToRef(bride.anchor, destination, progress, bride.root.position);
    if (progress >= 1) {
      ceremony.arrived = true;
      bride.controller.setLocomotion('idle');
    }
  }

  setCeremonyPaused(paused: boolean): void {
    if (this.ceremony && !this.ceremony.arrived) {
      this.ceremony.bride.controller.setAnimationPaused(paused);
    }
  }

  /** The most urgent ticket's guest, for the HUD's single-guest readout. */
  get currentGuest(): WeddingGuest | null {
    return this.tickets.values().next().value?.guest ?? null;
  }

  /** Every guest currently waiting on a dish. */
  get ticketedGuests(): { orderId: string; recipeId: string; guest: WeddingGuest }[] {
    return [...this.tickets].map(([orderId, ticket]) => ({
      orderId,
      recipeId: ticket.recipeId,
      guest: ticket.guest,
    }));
  }

  /**
   * Reconciles the reception against the live order queue: new orders get a guest, vanished
   * ones release theirs, and a guest whose dish is nearly late complains once.
   *
   * `secondsRemaining` is keyed by order id; the scene owns the authoritative countdowns.
   */
  syncOrders(orders: readonly Order[], secondsRemaining: ReadonlyMap<string, number>): void {
    const live = new Set<string>();
    for (const order of orders) {
      if (order.status !== 'active' || !order.requestedRecipeId) continue;
      live.add(order.id);
      if (this.tickets.has(order.id)) continue;
      if (this.pending.some(entry => entry.orderId === order.id)) continue;
      this.pending.push({ orderId: order.id, recipeId: order.requestedRecipeId });
    }

    for (const [orderId, ticket] of [...this.tickets]) {
      if (!live.has(orderId)) { this.releaseTicket(orderId, 3); continue; }
      const left = secondsRemaining.get(orderId);
      if (ticket.nagged || left === undefined || left > NAG_THRESHOLD_SECONDS) continue;
      // The robots do not speak; urgency is communicated by the order card instead.
      ticket.nagged = true;
    }
    this.pending = this.pending.filter(entry => live.has(entry.orderId));
    this.assignPending();
  }

  /** Closes one ticket, with the guest reacting to how it went. */
  resolveOrder(orderId: string, success: boolean): void {
    void success;
    this.releaseTicket(orderId, 6);
    this.pending = this.pending.filter(entry => entry.orderId !== orderId);
  }

  private releaseTicket(orderId: string, wait: number): void {
    const ticket = this.tickets.get(orderId);
    if (!ticket) return;
    ticket.guest.requestedRecipe = null;
    ticket.guest.icon.setEnabled(false);
    ticket.guest.wait = wait;
    this.tickets.delete(orderId);
  }

  /** Narrows each robot's collision sweep to the colliders around it (see NearbyColliders). */
  nearbyColliders: NearbyColliders | null = null;

  update(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed >= this.nextArrival) this.spawn();
    this.assignPending();
    this.gridAge += dt;
    const grid = this.navGrid();
    for (const g of this.guests) {
      if (!g.active) continue;
      if (g === this.ceremony?.bride) continue;
      if (g.busy > 0) {
        g.busy -= dt;
        continue;
      }
      g.wait = Math.max(0, g.wait - dt);
      if (!g.config.canMove || g.requestedRecipe || g.wait > 0) { this.playIdle(g); continue; }
      const position = g.root.position;

      // Follow the route rather than walking at the target in a straight line:
      // with the scenery solid, a direct heading walks into furniture.
      let waypoint = g.path[0];
      while (waypoint && Math.hypot(waypoint.x - position.x, waypoint.z - position.z) < WAYPOINT_RADIUS) {
        g.path.shift();
        waypoint = g.path[0];
      }

      const reachedTarget =
        Math.hypot(g.target.x - position.x, g.target.z - position.z) < WAYPOINT_RADIUS + 0.1;
      if (!waypoint && reachedTarget) {
        g.wait = 2 + Math.random() * 4;
        this.retarget(g);
        this.playIdle(g);
        g.lastSpeed = 0;
        continue;
      }
      if (!waypoint) {
        // No route yet, or the last one ran out before arriving.
        this.route(g);
        waypoint = g.path[0] ?? { x: g.target.x, z: g.target.z };
      }

      const direction = new Vector3(waypoint.x - position.x, 0, waypoint.z - position.z);
      if (direction.lengthSquared() < 1e-6) { this.playIdle(g); g.lastSpeed = 0; continue; }
      direction.normalize();

      // Right of way replaces the old radial separation: a robot now queues
      // behind whoever is in front instead of being shoved sideways by every
      // neighbour, including the ones walking away from it.
      const decision = decideRightOfWay(this.asMover(g, direction), this.movers(g));
      if (decision.mode === 'sidestep') {
        direction.addInPlace(new Vector3(decision.sideX, 0, decision.sideZ).scale(1.2)).normalize();
      }

      // Turn toward the heading instead of snapping to it, which read as jitter.
      const desiredYaw = Math.atan2(direction.x, direction.z);
      const deltaYaw = Math.atan2(
        Math.sin(desiredYaw - g.root.rotation.y),
        Math.cos(desiredYaw - g.root.rotation.y),
      );
      g.root.rotation.y += deltaYaw * Math.min(1, TURN_RESPONSE * dt);

      const before = position.clone();
      const speed = g.config.moveSpeed * decision.speedScale;
      // The Y component is not decoration: a purely horizontal sweep makes Babylon's
      // collider degenerate and pins the guest in place. See entities/groundedMove.ts.
      const step = direction.scale(dt * speed);
      step.y = integrateFall(0, dt, isGroundedOn(position.y, g.anchor.y)) * dt;
      this.nearbyColliders?.assign(g.root);
      g.root.moveWithCollisions(step);
      // Placed robots roam the whole room; the wedding's own four stay on the carpet.
      const limit = this.placed ? this.bounds : this.area;
      position.x = Math.max(limit.minX + 0.35, Math.min(limit.maxX - 0.35, position.x));
      position.z = Math.max(limit.minZ + 0.35, Math.min(limit.maxZ - 0.35, position.z));
      position.y = g.anchor.y;

      const travelled = Vector3.Distance(before, position);
      g.lastSpeed = dt > 0 ? travelled / dt : 0;

      if (speed <= 0) {
        // Waiting for someone is not being stuck: holding still here is the
        // whole point, so it must never count toward abandoning the target.
        g.blockedFor = 0;
        this.playIdle(g);
        continue;
      }

      if (travelled < dt * speed * 0.35) {
        g.blockedFor += dt;
        if (g.blockedFor > ABANDON_AFTER) {
          this.retarget(g);
          g.blockedFor = 0;
        } else if (g.blockedFor > REPATH_AFTER) {
          // Try a different way round before giving up on where it was going.
          this.route(g, grid);
        }
      } else {
        g.blockedFor = 0;
      }
      g.controller.setLocomotion('walk');
    }
  }

  /**
   * The walkability grid, built the first time it is needed and rebuilt only
   * when the set of colliders changes. The kitchen finishes loading after the
   * guests are constructed, so there is nothing useful to build in the
   * constructor.
   */
  private navGrid(): NavGrid {
    if (this.grid && this.gridAge < GRID_RECHECK_SECONDS) return this.grid;
    this.gridAge = 0;
    const colliders = this.countColliders();
    if (this.grid && colliders === this.gridColliders) return this.grid;
    this.gridColliders = colliders;
    this.grid = new NavGrid(this.placed ? this.bounds : this.area, this.collectObstacles());
    // The route each robot is on was planned against the old layout.
    for (const g of this.guests) g.path = [];
    return this.grid;
  }

  private countColliders(): number {
    let count = 0;
    for (const mesh of this.scene.meshes) {
      if (mesh.checkCollisions && !isCharacterBody(mesh)) count += 1;
    }
    return count;
  }

  /**
   * Solid geometry as flat rectangles the grid can stamp out.
   *
   * Two filters matter. Anything outside the robot's own vertical band is
   * ignored, so a ceiling pipe does not close a corridor it passes well above.
   * And a box covering most of the floor is the hollow room shell, whose walls
   * are already handled by clamping to the bounds — stamping its bounding box
   * would mark every cell in the level as blocked.
   */
  private collectObstacles(): Rect[] {
    const limit = this.placed ? this.bounds : this.area;
    const floorArea = (limit.maxX - limit.minX) * (limit.maxZ - limit.minZ);
    const rects: Rect[] = [];
    for (const mesh of this.scene.meshes) {
      if (!mesh.checkCollisions || !mesh.isEnabled() || mesh.getTotalVertices() === 0) continue;
      if (isCharacterBody(mesh)) continue;
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      const minimum = box.minimumWorld;
      const maximum = box.maximumWorld;
      // Robots never climb, so every collider low enough to exist is in their way.
      if (maximum.y <= STEP_OVER_HEIGHT || minimum.y >= ROBOT_HEIGHT) continue;
      const rect: Rect = {
        minX: minimum.x, maxX: maximum.x, minZ: minimum.z, maxZ: maximum.z,
      };
      const area = (rect.maxX - rect.minX) * (rect.maxZ - rect.minZ);
      if (area > floorArea * 0.8) continue;
      rects.push(rect);
    }
    // A mechanism's whole travel, not where it happens to be: the grid only rebuilds when
    // the collider count changes, and a platform sliding along changes nothing.
    rects.push(...this.mechanismFootprints());
    return rects;
  }

  /** Picks a fresh destination the robot can actually stand on, and routes to it. */
  private retarget(g: WeddingGuest): void {
    const grid = this.navGrid();
    const wanted = this.wanderTarget(g);
    const reachable = grid.nearestWalkable({ x: wanted.x, z: wanted.z });
    if (reachable) g.target = new Vector3(reachable.x, 0, reachable.z);
    else g.target = wanted;
    this.route(g, grid);
  }

  private route(g: WeddingGuest, grid: NavGrid = this.navGrid()): void {
    const from = { x: g.root.position.x, z: g.root.position.z };
    const to = { x: g.target.x, z: g.target.z };
    const path = grid.findPath(from, to);
    if (path.length > 0) {
      g.path = path;
      return;
    }
    // Unreachable from here: take the nearest place we can stand instead of
    // walking into the wall that blocks the way.
    const fallback = grid.nearestWalkable(to);
    g.path = fallback ? grid.findPath(from, fallback) : [];
    if (fallback && g.path.length > 0) g.target = new Vector3(fallback.x, 0, fallback.z);
  }

  private asMover(g: WeddingGuest, heading: Vector3): Mover {
    return {
      id: g.id,
      x: g.root.position.x,
      z: g.root.position.z,
      headingX: heading.x,
      headingZ: heading.z,
      speed: g.lastSpeed,
    };
  }

  /**
   * Every other active robot, as right-of-way input.
   *
   * A robot that is not trying to walk reports no heading, which is what tells
   * the rules it will never move aside on its own.
   */
  private movers(self: WeddingGuest): Mover[] {
    const result: Mover[] = [];
    for (const g of this.guests) {
      if (g === self || !g.active) continue;
      const walking = g.config.canMove && !g.requestedRecipe && g.wait <= 0;
      result.push({
        id: g.id,
        x: g.root.position.x,
        z: g.root.position.z,
        headingX: walking ? Math.sin(g.root.rotation.y) : 0,
        headingZ: walking ? Math.cos(g.root.rotation.y) : 0,
        speed: g.lastSpeed,
      });
    }
    return result;
  }

  private spawn(): void {
    const g = this.guests.find(candidate => !candidate.active);
    // Push the clock even when the reception is full, or this re-scans all guests every frame.
    if (!g) { this.nextArrival = this.elapsed + 5; return; }
    g.root.position.set(g.anchor.x, g.anchor.y, g.anchor.z);
    g.wait = Math.random() * 1.5;
    g.blockedFor = 0;
    g.lastSpeed = 0;
    g.active = true; g.root.setEnabled(true);
    // Routed rather than aimed: the destination has to be somewhere the robot
    // can stand, and it needs a path before it takes its first step.
    this.retarget(g);
    if (g !== this.ceremony?.bride) this.playIdle(g);
    this.nextArrival = this.elapsed + 5;
  }

  /** Loops whatever this robot idles as, falling back to the stock idle for unknown clips. */
  /** Robots standing in the kitchen, free to throw something. */
  get idleRobots(): WeddingGuest[] {
    return this.guests.filter((g) => g.active && g.busy <= 0 && g.controller.hasCharacter &&
      g !== this.ceremony?.bride && g !== this.ceremony?.groom);
  }

  /**
   * Turns `g` to face `target` and plays a throw. Resolves with the seconds from
   * now until the hand lets go, or null when the clip is not available.
   */
  async throwAt(g: WeddingGuest, target: Vector3): Promise<number | null> {
    const dx = target.x - g.root.position.x;
    const dz = target.z - g.root.position.z;
    g.root.rotationQuaternion = null;
    g.root.rotation.y = Math.atan2(dx, dz);
    g.busy = 1.2;
    const seconds = await g.controller.playOneShot("Throw", "general", 1.25);
    if (seconds <= 0) {
      g.busy = 0;
      return null;
    }
    g.busy = seconds;
    // The arm comes over and lets go a little before the middle of the clip.
    return seconds * 0.42;
  }

  private playIdle(g: WeddingGuest): void {
    const clip = getRobotClip(g.config.idleClip);
    if (!clip) { g.controller.setLocomotion('idle'); return; }
    void g.controller.playAmbientClip(clip.id, clip.pack);
  }

  /** A point inside the robot's wander disc, clipped to wherever it is allowed to walk. */
  private wanderTarget(g: WeddingGuest): Vector3 {
    if (!this.placed) return this.randomPoint();
    const radius = g.config.wanderRadius;
    if (radius <= 0) return g.anchor.clone();
    const angle = Math.random() * Math.PI * 2;
    // sqrt keeps the picks evenly spread over the disc instead of bunched at the centre.
    const distance = Math.sqrt(Math.random()) * radius;
    return new Vector3(
      Math.max(this.bounds.minX + 0.35, Math.min(this.bounds.maxX - 0.35, g.anchor.x + Math.cos(angle) * distance)),
      0,
      Math.max(this.bounds.minZ + 0.35, Math.min(this.bounds.maxZ - 0.35, g.anchor.z + Math.sin(angle) * distance)),
    );
  }

  /** Evenly spaced standing spots, one per robot, inset from the reception edges. */
  private receptionSpot(index: number, count: number): { x: number; z: number } {
    const inset = 0.9;
    const minX = this.area.minX + inset;
    const maxX = this.area.maxX - inset;
    const t = count <= 1 ? 0.5 : index / (count - 1);
    const centreZ = (this.area.minZ + this.area.maxZ) / 2;
    return {
      x: minX + (maxX - minX) * t,
      // Alternate rows so neighbours are never shoulder to shoulder.
      z: centreZ + (index % 2 === 0 ? -0.45 : 0.45),
    };
  }

  /**
   * Hands waiting orders to free guests, round-robin. Anything that cannot be placed stays
   * in `pending` — `update` retries every frame, so it lands as soon as a guest frees up.
   */
  private assignPending(): void {
    if (this.pending.length === 0) return;
    const held = new Set([...this.tickets.values()].map(ticket => ticket.guest));
    const remaining: typeof this.pending = [];

    for (const entry of this.pending) {
      const candidates = this.guests.filter(
        // A non-customer robot is animated scenery and never takes a ticket.
        g => g.active && g.config.customer && !held.has(g),
      );
      const g = candidates.find(g => g.id > this.lastRecipient) ?? candidates[0];
      if (!g) { remaining.push(entry); continue; }
      this.lastRecipient = g.id;
      held.add(g);
      this.tickets.set(entry.orderId, { recipeId: entry.recipeId, guest: g, nagged: false });
      g.requestedRecipe = entry.recipeId;
      // An unknown recipe would otherwise show an enabled, material-less white quad.
      const material = this.dishMaterials.get(entry.recipeId) ?? null;
      g.icon.material = material;
      g.icon.setEnabled(material !== null);
      this.playIdle(g);
    }
    this.pending = remaining;
  }

  private randomPoint(): Vector3 {
    return new Vector3(this.area.minX + 0.65 + Math.random() * (this.area.maxX - this.area.minX - 1.3), 0,
      this.area.minZ + 0.65 + Math.random() * (this.area.maxZ - this.area.minZ - 1.3));
  }

  private material(name: string, color: string, emissiveScale = 1): StandardMaterial {
    const mat = new StandardMaterial(name, this.scene);
    mat.diffuseColor = Color3.FromHexString(color);
    // Clone rather than alias: sharing the Color3 instance makes any later tweak to one
    // silently mutate the other.
    mat.emissiveColor = mat.diffuseColor.scale(emissiveScale);
    mat.disableLighting = true; mat.backFaceCulling = false;
    this.materials.push(mat); return mat;
  }

  /**
   * `overlay` puts the plane in rendering group 1 so room geometry cannot occlude it, the
   * same trick WorkstationView uses for its progress bars. Only for things that must always
   * be readable (bubbles, order icons) — not for props like the reception sign.
   */
  private billboard(name: string, width: number, height: number, overlay = false): Mesh {
    const plane = MeshBuilder.CreatePlane(name, { width, height }, this.scene);
    plane.billboardMode = Mesh.BILLBOARDMODE_ALL; plane.isPickable = false;
    if (overlay) plane.renderingGroupId = 1;
    this.ownedMeshes.push(plane); return plane;
  }

  /** Meshes that must stay out of the GlowLayer, which would otherwise blur them to mush. */
  get glowExcludedMeshes(): Mesh[] {
    return this.guests.map(g => g.icon);
  }

  /** The couple's name on a banner facing the room, for a hall that has its own decor. */
  private createBanner(banner: ReceptionBanner): void {
    const sign = MeshBuilder.CreatePlane('wedding-banner', { width: banner.width, height: banner.height }, this.scene);
    sign.position.set(banner.x, banner.y, banner.z);
    sign.isPickable = false;
    this.ownedMeshes.push(sign);
    const tex = new DynamicTexture('wedding-banner-text', { width: 1024, height: 200 }, this.scene, false);
    const draw = (): void => {
      const ctx = tex.getContext();
      ctx.clearRect(0, 0, 1024, 200);
      ctx.fillStyle = '#fff6e8'; ctx.fillRect(0, 0, 1024, 200);
      ctx.strokeStyle = '#d9a441'; ctx.lineWidth = 12; ctx.strokeRect(6, 6, 1012, 188);
      ctx.fillStyle = '#7a3b55'; ctx.font = 'bold 84px serif';
      const title = 'ChatGPT ♡ Gemini';
      ctx.fillText(title, (1024 - ctx.measureText(title).width) / 2, 118);
      ctx.fillStyle = '#b07a2a'; ctx.font = '30px serif';
      const subtitle = t('wedding.bannerSubtitle');
      ctx.fillText(subtitle, (1024 - ctx.measureText(subtitle).width) / 2, 170);
      tex.update();
    };
    draw();
    this.signs.push(draw);
    const mat = this.material('wedding-banner-material', '#ffffff');
    mat.diffuseTexture = tex; sign.material = mat;
    this.textures.push(tex);
  }

  private createReception(cx: number, cz: number, width: number, depth: number): void {
    const floor = MeshBuilder.CreateGround('wedding-reception', { width, height: depth }, this.scene);
    floor.position.set(cx, 0.035, cz); floor.material = this.material('wedding-carpet', '#57445e');
    floor.isPickable = false; this.ownedMeshes.push(floor);
    const gold = this.material('reception-border', '#e7c47c');
    for (const z of [this.area.minZ, this.area.maxZ]) {
      const edge = MeshBuilder.CreateBox('reception-boundary', { width, height: 0.035, depth: 0.06 }, this.scene);
      edge.position.set(cx, 0.07, z); edge.material = gold; edge.isPickable = false; this.ownedMeshes.push(edge);
    }
    for (const x of [this.area.minX, this.area.maxX]) {
      const edge = MeshBuilder.CreateBox('reception-boundary', { width: 0.06, height: 0.035, depth }, this.scene);
      edge.position.set(x, 0.07, cz); edge.material = gold; edge.isPickable = false; this.ownedMeshes.push(edge);
    }
    const sign = this.billboard('wedding-welcome', 3.7, 0.72);
    sign.position.set(cx, 0.8, this.area.maxZ);
    const tex = new DynamicTexture('wedding-sign', { width: 1024, height: 200 }, this.scene, false);
    const draw = (): void => {
      // drawText with a clear colour repaints the whole sign, so the old label goes too.
      tex.drawText('ChatGPT ♡ Gemini', null, 90, 'bold 60px sans-serif', '#ffe7b0', '#35293f');
      const ctx = tex.getContext(); ctx.font = '30px sans-serif'; ctx.fillStyle = '#fff4db';
      const label = t('wedding.hallSign');
      ctx.fillText(label, (1024 - ctx.measureText(label).width) / 2, 156); tex.update();
    };
    draw();
    this.signs.push(draw);
    const mat = this.material('wedding-sign-material', '#ffffff'); mat.diffuseTexture = tex; sign.material = mat;
    this.textures.push(tex);
  }

  dispose(): void {
    this.generation++;
    this.stopLanguage();
    this.signs.length = 0;
    for (const g of this.guests) { g.controller.dispose(); g.root.dispose(); }
    for (const mesh of this.ownedMeshes) mesh.dispose();
    for (const material of this.materials) material.dispose(false, false);
    for (const texture of this.textures) texture.dispose();
  }
}
