import { t } from "../../i18n";
import {
  CHOP_SECONDS,
  DIRTY_PLATE_RETURN_SECONDS,
  EXTINGUISH_SECONDS,
  FIRE_SPREAD_SECONDS,
  KITCHEN_TILE,
  MIX_SECONDS,
  STATE_OF_VESSEL,
  STARTING_CLEAN_PLATES,
  WASH_SECONDS,
  getFoodDefinition,
} from "../../data/kitchen";
import type { KitchenStationKind, RecipeData } from "../../types/game";
import {
  bowlHasUnmixed,
  combineItems,
  decayProgress,
  createFood,
  createPlate,
  emptyCookware,
  findMatchingRecipe,
  isCookware,
  isHeatedCookware,
  tickCookware,
  type CookEvent,
  type FoodItem,
  type KitchenItem,
  type PlateItem,
} from "./KitchenItems";

export interface StationSpec {
  readonly id: string;
  readonly kind: KitchenStationKind;
  readonly x: number;
  /** Floor height the station stands on; 0 when omitted. */
  readonly y?: number;
  readonly z: number;
  readonly rotationY: number;
  /** Crates only: the raw ingredient they hand out. */
  readonly ingredientId?: string;
  /** Item placed on the station at the start of every shift. */
  readonly initialItem?: () => KitchenItem;
}

export interface Workstation {
  readonly spec: StationSpec;
  item: KitchenItem | null;
  cleanPlates: number;
  dirtyPlates: number;
  washProgress: number;
  /** 0..1 progress of held mixing at a mixer; rewinds when the cook walks off. */
  mixProgress: number;
  onFire: boolean;
  /** 1 = full fire, 0 = extinguished. */
  fireHealth: number;
  fireSpreadTimer: number;
}

export type KitchenEvent =
  | { readonly type: "chopped"; readonly station: Workstation; readonly food: FoodItem }
  | { readonly type: "washed"; readonly station: Workstation }
  | { readonly type: "mixed"; readonly station: Workstation }
  | { readonly type: "cook"; readonly station: Workstation; readonly event: CookEvent }
  | { readonly type: "fire"; readonly station: Workstation }
  | { readonly type: "extinguished"; readonly station: Workstation }
  | { readonly type: "dirtyReturned"; readonly station: Workstation };

/** Stations with something lit under them: they cook, overcook and catch fire. */
const HEATED_STATIONS: ReadonlySet<KitchenStationKind> = new Set<KitchenStationKind>([
  "stove",
  "oven",
]);

/** Stations a thrown item may come to rest on or in. */
const LANDABLE_STATIONS: ReadonlySet<KitchenStationKind> = new Set<KitchenStationKind>([
  "counter",
  "cutting_board",
  "stove",
  "oven",
  "mixer",
]);

export type GrabOutcome =
  | { readonly kind: "changed"; readonly held: KitchenItem | null; readonly message?: string }
  | { readonly kind: "blocked"; readonly message: string }
  | {
      readonly kind: "deliver";
      readonly plate: PlateItem;
      readonly recipe: RecipeData;
    };

export type WorkOutcome =
  | { readonly kind: "none" }
  | { readonly kind: "chopping"; readonly progress: number }
  | { readonly kind: "mixing"; readonly progress: number }
  | { readonly kind: "washing"; readonly progress: number }
  | { readonly kind: "extinguishing"; readonly progress: number };

/**
 * Pure kitchen state: which item sits on which station, plate stacks, cooking,
 * fire and dirty-plate returns. Rendering and input live in KitchenScene.
 */
export class KitchenModel {
  readonly stations: Workstation[];
  private readonly pendingDirtyPlates: number[] = [];
  private readonly events: KitchenEvent[] = [];
  /**
   * Stations a player worked this frame, so `update` knows which progress bars were
   * abandoned. REQUIRES that every `work()` call for a frame happens before `update()` —
   * KitchenScene.update runs the player loop first, which is what makes this exact.
   */
  private readonly touchedThisFrame = new Set<Workstation>();

  constructor(specs: readonly StationSpec[], private readonly recipes: readonly RecipeData[]) {
    this.stations = specs.map((spec) => ({
      spec,
      item: null,
      cleanPlates: 0,
      dirtyPlates: 0,
      washProgress: 0,
      mixProgress: 0,
      onFire: false,
      fireHealth: 0,
      fireSpreadTimer: 0,
    }));
    this.reset();
  }

  reset(): void {
    this.pendingDirtyPlates.length = 0;
    this.events.length = 0;
    for (const station of this.stations) {
      station.item = station.spec.initialItem?.() ?? null;
      station.cleanPlates = station.spec.kind === "plate_rack" ? STARTING_CLEAN_PLATES : 0;
      station.dirtyPlates = 0;
      station.washProgress = 0;
      station.onFire = false;
      station.fireHealth = 0;
      station.fireSpreadTimer = 0;
    }
  }

  /** Drains the events produced since the last call. */
  takeEvents(): KitchenEvent[] {
    return this.events.splice(0);
  }

  get anyFire(): boolean {
    return this.stations.some((station) => station.onFire);
  }

  /** The E / grab button: pick up, put down, combine or deliver. */
  grab(station: Workstation, held: KitchenItem | null, now: number): GrabOutcome {
    if (station.onFire) {
      // The one thing worth grabbing out of a fire is the tool that puts it out; refusing
      // it would leave a kitchen whose only extinguisher sits in the flames unwinnable.
      if (!held && station.item?.kind === "extinguisher") {
        const extinguisher = station.item;
        station.item = null;
        return { kind: "changed", held: extinguisher };
      }
      return { kind: "blocked", message: t("kitchen.blockedFire") };
    }
    const kind = station.spec.kind;

    switch (kind) {
      case "crate": {
        if (held) return this.combineWithNew(held, station, now);
        return { kind: "changed", held: createFood(station.spec.ingredientId ?? "", now) };
      }
      case "plate_rack": {
        if (!held) {
          if (station.cleanPlates <= 0) return { kind: "blocked", message: t("kitchen.noCleanPlates") };
          station.cleanPlates -= 1;
          return { kind: "changed", held: createPlate() };
        }
        if (held.kind === "plate" && !held.dirty && held.contents.length === 0) {
          station.cleanPlates += 1;
          return { kind: "changed", held: null };
        }
        return { kind: "blocked", message: t("kitchen.onlyCleanPlates") };
      }
      case "dirty_return": {
        if (!held) {
          if (station.dirtyPlates <= 0) return { kind: "blocked", message: t("kitchen.noDirtyPlates") };
          station.dirtyPlates -= 1;
          return { kind: "changed", held: createPlate(true) };
        }
        if (held.kind === "plate" && held.dirty) {
          station.dirtyPlates += 1;
          return { kind: "changed", held: null };
        }
        return { kind: "blocked", message: t("kitchen.bringDirtyPlates") };
      }
      case "sink": {
        if (!held) {
          if (station.cleanPlates <= 0) {
            return {
              kind: "blocked",
              message: station.dirtyPlates > 0 ? t("kitchen.holdToWash") : t("kitchen.sinkEmpty"),
            };
          }
          station.cleanPlates -= 1;
          return { kind: "changed", held: createPlate() };
        }
        if (held.kind === "plate" && held.dirty) {
          station.dirtyPlates += 1;
          return { kind: "changed", held: null, message: t("kitchen.holdToWash") };
        }
        return { kind: "blocked", message: t("kitchen.sinkOnlyDirty") };
      }
      case "trash": {
        if (!held) return { kind: "blocked", message: t("kitchen.trash") };
        if (held.kind === "food") return { kind: "changed", held: null, message: t("kitchen.discarded") };
        if (held.kind === "plate") {
          if (held.contents.length === 0) return { kind: "blocked", message: t("kitchen.plateEmpty") };
          held.contents.length = 0;
          // Scraping a plate dirties it; wash it before it can be used again.
          held.dirty = true;
          return { kind: "changed", held, message: t("kitchen.plateScraped") };
        }
        if (isCookware(held)) {
          if (held.contents.length === 0) return { kind: "blocked", message: t("kitchen.alreadyEmpty") };
          emptyCookware(held);
          return { kind: "changed", held, message: t("kitchen.contentsDiscarded") };
        }
        return { kind: "blocked", message: t("kitchen.keepExtinguisher") };
      }
      case "delivery": {
        if (!held || held.kind !== "plate") return { kind: "blocked", message: t("kitchen.deliverAssembled") };
        if (held.dirty) return { kind: "blocked", message: t("kitchen.plateDirty") };
        const recipe = findMatchingRecipe(held.contents, this.recipes);
        if (!recipe) return { kind: "blocked", message: t("kitchen.plateIncomplete") };
        this.pendingDirtyPlates.push(DIRTY_PLATE_RETURN_SECONDS);
        return { kind: "deliver", plate: held, recipe };
      }
      default:
        return this.grabSlot(station, held);
    }
  }

  /** The F / action button held with empty hands (or holding the extinguisher). */
  work(station: Workstation, held: KitchenItem | null, deltaSeconds: number): WorkOutcome {
    if (held?.kind === "extinguisher") return this.extinguish(station, deltaSeconds);
    if (held || station.onFire) return { kind: "none" };

    if (station.spec.kind === "cutting_board" && station.item?.kind === "food") {
      const food = station.item;
      const definition = getFoodDefinition(food.ingredientId);
      if (!definition?.chop || food.state !== "raw") return { kind: "none" };
      this.touchedThisFrame.add(station);
      food.chopProgress = Math.min(1, food.chopProgress + deltaSeconds / CHOP_SECONDS);
      if (food.chopProgress >= 1) {
        food.state = "chopped";
        food.chopProgress = 0;
        this.events.push({ type: "chopped", station, food });
        return { kind: "chopping", progress: 1 };
      }
      return { kind: "chopping", progress: food.chopProgress };
    }

    if (station.spec.kind === "mixer" && station.item?.kind === "bowl") {
      const bowl = station.item;
      if (!bowlHasUnmixed(bowl)) return { kind: "none" };
      this.touchedThisFrame.add(station);
      station.mixProgress = Math.min(1, station.mixProgress + deltaSeconds / MIX_SECONDS);
      if (station.mixProgress >= 1) {
        station.mixProgress = 0;
        // Every ingredient in the bowl is beaten and stays itself: the cook pours the bowl
        // onto a plate, the same way a fried pan is poured.
        for (const food of bowl.contents) food.state = STATE_OF_VESSEL.bowl;
        this.events.push({ type: "mixed", station });
        return { kind: "mixing", progress: 1 };
      }
      return { kind: "mixing", progress: station.mixProgress };
    }

    if (station.spec.kind === "sink" && station.dirtyPlates > 0) {
      this.touchedThisFrame.add(station);
      station.washProgress = Math.min(1, station.washProgress + deltaSeconds / WASH_SECONDS);
      if (station.washProgress >= 1) {
        station.washProgress = 0;
        station.dirtyPlates -= 1;
        station.cleanPlates += 1;
        this.events.push({ type: "washed", station });
        return { kind: "washing", progress: 1 };
      }
      return { kind: "washing", progress: station.washProgress };
    }
    return { kind: "none" };
  }

  /**
   * A thrown item landing on a station: rests on a free slot, drops into a pan,
   * pot or plate, or vanishes into the trash. Returns false to bounce it off.
   */
  land(station: Workstation, item: KitchenItem): boolean {
    if (station.onFire) return false;
    const kind = station.spec.kind;
    if (kind === "trash") return item.kind === "food";
    if (!LANDABLE_STATIONS.has(kind)) return false;
    if (!station.item) {
      if (this.placementRejection(kind, item)) return false;
      station.item = item;
      return true;
    }
    // Only food can end up inside what it lands on. combineItems mutates both items before
    // returning, so a plate or pan landing here must bounce before it is ever called:
    // otherwise the food on the station is copied into it and still left behind.
    if (item.kind !== "food") return false;
    const combined = combineItems(item, station.item);
    if (!combined || combined.held) return false;
    station.item = combined.target;
    return true;
  }

  canWork(station: Workstation, held: KitchenItem | null): boolean {
    if (held?.kind === "extinguisher") return this.stations.some((entry) => entry.onFire);
    if (held || station.onFire) return false;
    if (station.spec.kind === "sink") return station.dirtyPlates > 0;
    if (station.spec.kind === "mixer") {
      return station.item?.kind === "bowl" && bowlHasUnmixed(station.item);
    }
    if (station.spec.kind !== "cutting_board" || station.item?.kind !== "food") return false;
    return station.item.state === "raw" && getFoodDefinition(station.item.ingredientId)?.chop === true;
  }

  update(deltaSeconds: number): void {
    for (const station of this.stations) {
      if (HEATED_STATIONS.has(station.spec.kind) && isHeatedCookware(station.item)) {
        for (const event of tickCookware(station.item, deltaSeconds)) {
          this.events.push({ type: "cook", station, event });
          if (event === "ignite") this.ignite(station);
        }
      }
    }
    this.spreadFire(deltaSeconds);
    this.returnDirtyPlates(deltaSeconds);
    this.decayAbandonedProgress(deltaSeconds);
    this.touchedThisFrame.clear();
  }

  /** Overcooked rewinds a half-done chop or wash the moment you walk away from it. */
  private decayAbandonedProgress(deltaSeconds: number): void {
    for (const station of this.stations) {
      if (this.touchedThisFrame.has(station)) continue;
      if (station.item?.kind === "food" && station.item.chopProgress > 0) {
        station.item.chopProgress = decayProgress(station.item.chopProgress, deltaSeconds);
      }
      if (station.washProgress > 0) {
        station.washProgress = decayProgress(station.washProgress, deltaSeconds);
      }
      if (station.mixProgress > 0) {
        station.mixProgress = decayProgress(station.mixProgress, deltaSeconds);
      }
    }
  }

  ignite(station: Workstation): void {
    if (station.onFire) return;
    station.onFire = true;
    station.fireHealth = 1;
    station.fireSpreadTimer = 0;
    this.events.push({ type: "fire", station });
  }

  private grabSlot(station: Workstation, held: KitchenItem | null): GrabOutcome {
    const target = station.item;
    if (!held) {
      if (!target) return { kind: "blocked", message: t("kitchen.nothingHere") };
      // Carrying it away abandons the chop outright — no slow rewind to game.
      if (target.kind === "food") target.chopProgress = 0;
      station.item = null;
      return { kind: "changed", held: target };
    }
    if (!target) {
      const rejection = this.placementRejection(station.spec.kind, held);
      if (rejection) return { kind: "blocked", message: rejection };
      station.item = held;
      return { kind: "changed", held: null };
    }
    const combined = combineItems(held, target);
    if (!combined) return { kind: "blocked", message: t("kitchen.doesNotCombine") };
    station.item = combined.target;
    return { kind: "changed", held: combined.held };
  }

  private placementRejection(kind: KitchenStationKind, held: KitchenItem): string | null {
    // Each heat source takes its own vessel: a pan on the stove, a tray in the oven, a
    // bowl on the mixer. Mixing them up is the commonest fumble, so it says which is wanted.
    if (kind === "stove" && !(held.kind === "pan" || held.kind === "pot")) {
      return t("kitchen.stoveNeedsCookware");
    }
    if (kind === "oven" && held.kind !== "tray") return t("kitchen.ovenNeedsTray");
    if (kind === "mixer" && held.kind !== "bowl") return t("kitchen.mixerNeedsBowl");
    if (kind === "extinguisher_stand" && held.kind !== "extinguisher") return t("kitchen.extinguisherStand");
    return null;
  }

  /** Holding a plate or cookware at a crate drops a fresh ingredient straight in. */
  private combineWithNew(held: KitchenItem, station: Workstation, now: number): GrabOutcome {
    const fresh = createFood(station.spec.ingredientId ?? "", now);
    const combined = combineItems(held, fresh);
    if (!combined || combined.target) return { kind: "blocked", message: t("kitchen.handsFullDot") };
    return { kind: "changed", held: combined.held };
  }

  private extinguish(station: Workstation, deltaSeconds: number): WorkOutcome {
    // The spray covers the targeted tile plus its direct neighbours.
    const reach = KITCHEN_TILE * 1.05;
    let hit = false;
    let remaining = 0;
    for (const candidate of this.stations) {
      if (!candidate.onFire) continue;
      const dx = candidate.spec.x - station.spec.x;
      const dz = candidate.spec.z - station.spec.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      hit = true;
      candidate.fireHealth -= deltaSeconds / EXTINGUISH_SECONDS;
      if (candidate.fireHealth <= 0) {
        candidate.onFire = false;
        candidate.fireHealth = 0;
        this.events.push({ type: "extinguished", station: candidate });
      }
      remaining = Math.max(remaining, candidate.fireHealth);
    }
    return hit ? { kind: "extinguishing", progress: 1 - remaining } : { kind: "none" };
  }

  private spreadFire(deltaSeconds: number): void {
    const burning = this.stations.filter((station) => station.onFire);
    for (const station of burning) {
      station.fireSpreadTimer += deltaSeconds;
      if (station.fireSpreadTimer < FIRE_SPREAD_SECONDS) continue;
      station.fireSpreadTimer = 0;
      const neighbour = this.findFlammableNeighbour(station);
      if (neighbour) this.ignite(neighbour);
    }
  }

  private findFlammableNeighbour(origin: Workstation): Workstation | null {
    const reach = KITCHEN_TILE * 1.05;
    for (const station of this.stations) {
      if (station === origin || station.onFire) continue;
      // The extinguisher stand never burns: the fire must not be able to lock away its cure.
      if (station.spec.kind === "sink" || station.spec.kind === "delivery" ||
        station.spec.kind === "extinguisher_stand") continue;
      const dx = station.spec.x - origin.spec.x;
      const dz = station.spec.z - origin.spec.z;
      if (dx * dx + dz * dz <= reach * reach) return station;
    }
    return null;
  }

  private returnDirtyPlates(deltaSeconds: number): void {
    for (let index = this.pendingDirtyPlates.length - 1; index >= 0; index -= 1) {
      const remaining = (this.pendingDirtyPlates[index] ?? 0) - deltaSeconds;
      if (remaining > 0) {
        this.pendingDirtyPlates[index] = remaining;
        continue;
      }
      this.pendingDirtyPlates.splice(index, 1);
      const target =
        this.stations.find((station) => station.spec.kind === "dirty_return") ??
        this.stations.find((station) => station.spec.kind === "sink");
      if (target) {
        target.dirtyPlates += 1;
        this.events.push({ type: "dirtyReturned", station: target });
      } else {
        // Maps without a dish pipeline get the plate back clean.
        const rack = this.stations.find((station) => station.spec.kind === "plate_rack");
        if (rack) rack.cleanPlates += 1;
      }
    }
  }
}
