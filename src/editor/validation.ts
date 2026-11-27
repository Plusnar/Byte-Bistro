import { t } from "../i18n";
import { ASSET_LIBRARY_BY_ID } from "../data/assetLibrary";
import { SCENARIO_ASSETS } from "../data/scenarioAssets";
import { KITCHEN_ASSETS } from "../data/kitchen";
import { INGREDIENT_ASSETS } from "../data/ingredientAssets";
import { ROBOT_VARIANT_ASSETS } from "../data/robotVariants";
import { MANNEQUIN } from "../systems/WeddingGuests";
import { isBuildingAsset } from "./building";
import type { MapPlacedObject, MapData } from "./MapData";
import { isFloorAsset } from "../physics/collisionPolicy";
import { footprintOf, marchInWorld, unpairedPortalIds } from "../gameplay/mechanisms/MechanismSystem";
import { WEDDING_SCENARIO, getScenario, type ScenarioDefinition } from "../data/scenarios";

export interface MapRequirement {
  readonly label: string;
  readonly satisfied: boolean;
  readonly blocking?: false;
}

const sceneryModels = new Set<string>([
  MANNEQUIN.modelAssetId,
  ...[...SCENARIO_ASSETS, ...KITCHEN_ASSETS, ...INGREDIENT_ASSETS, ...ROBOT_VARIANT_ASSETS].map(asset => asset.id),
]);
const knownScenery = (id: string): boolean =>
  isBuildingAsset(id) || sceneryModels.has(id) || ASSET_LIBRARY_BY_ID.has(id);

const sameStorey = (a: MapPlacedObject, b: MapPlacedObject): boolean =>
  Math.abs(a.position.y - b.position.y) < 0.12;
const horizontalDistance = (a: MapPlacedObject, b: MapPlacedObject): number =>
  Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);

const hasFloor = (map: MapData): boolean =>
  map.objects.some(o => o.role === "decor" && knownScenery(o.assetId) && (
    o.assetId === "scenario-room-wide" || isFloorAsset(o.assetId) ||
    (o.assetId.startsWith("library:") && /\/room[^/]*\.(?:glb|gltf)$/i.test(o.assetId))));

/**
 * What the map is still missing before it can be played, driven by the scenario's own rules.
 *
 * `scenario` defaults to the map's own — a level built for a different scenario must be
 * checked against that scenario's requirements, or every new scenario would be born
 * unplayable with the Play button permanently disabled.
 */
export function mapRequirements(
  map: MapData,
  scenario: ScenarioDefinition = getScenario(map.scenarioId) ?? WEDDING_SCENARIO,
): MapRequirement[] {
  const requirements: MapRequirement[] = [];
  if (scenario.requirements.requiresSpawns) {
    requirements.push(
      { label: t("editor.requirementSpawn1"), satisfied: map.objects.some(o => o.role === "spawn" && o.playerIndex === 1) },
      { label: t("editor.requirementSpawn2"), satisfied: map.objects.some(o => o.role === "spawn" && o.playerIndex === 2) },
    );
  }
  if (scenario.requirements.requiresFloor) {
    requirements.push({ label: t("editor.requirementFloor"), satisfied: hasFloor(map) });
  }
  for (const station of scenario.requirements.stations) {
    const placed = map.objects.filter(o => o.role === "station" && o.stationId === station.id).length;
    requirements.push({
      label: station.label,
      satisfied: placed >= (station.count ?? 1),
    });
  }
  for (const ingredient of scenario.requirements.ingredients) {
    const placed = map.objects.filter(
      o => o.role === "dispenser" && o.ingredientId === ingredient.id,
    ).length;
    requirements.push({
      label: t("editor.requirementIngredient", { name: ingredient.label }),
      satisfied: placed >= (ingredient.count ?? 1),
    });
  }
  const reported = new Set<string>();
  for (const object of map.objects) {
    if ((object.role !== "decor" && object.role !== "mechanism") || knownScenery(object.assetId)) continue;
    const key = object.role + ':' + object.assetId;
    if (reported.has(key)) continue;
    reported.add(key);
    const name = object.label && object.label !== object.assetId ? object.label + " (" + object.assetId + ")" : object.assetId;
    requirements.push({
      label: t(object.role === "mechanism" ? "editor.unknownMechanism" : "editor.unknownDecoration", { name }),
      satisfied: false,
      ...(object.role === "decor" ? { blocking: false as const } : {}),
    });
  }

  const spawns = map.objects.filter(object => object.role === "spawn");
  const stations = map.objects.filter(object => object.role === "station" || object.role === "dispenser");
  const duplicateSpawn = spawns.some((object, index) => spawns.slice(0, index).some(other =>
    object.playerIndex === other.playerIndex || (sameStorey(object, other) && horizontalDistance(object, other) < 0.4)));
  if (duplicateSpawn) requirements.push({ label: t("editor.requirementUniqueSpawns"), satisfied: false });
  const overlaps = stations.some((object, index) => stations.slice(0, index).some(other =>
    sameStorey(object, other) && horizontalDistance(object, other) < 0.12));
  if (overlaps) requirements.push({ label: t("editor.requirementClearStations"), satisfied: false });

  // A station surrounded by other stations on its storey has no interaction side.
  // Warn here since custom geometry and raised platforms are measured in the live kitchen.
  const isolated = stations.filter(object => [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([dx, dz]) =>
    stations.some(other => other !== object && sameStorey(object, other) &&
      Math.hypot(other.position.x - object.position.x - dx!, other.position.z - object.position.z - dz!) < 0.55)));
  if (isolated.length) requirements.push({
    label: t("editor.warningEnclosedStations", { count: isolated.length }), satisfied: false, blocking: false,
  });
  // Stations and crates may stand on any floor: the kitchen builds each tile at the height
  // it was placed (kitchenLayout's `y`), so a counter up a staircase plays up there.
  // A platform that crosses a station would park on top of it and make it unreachable for
  // part of every cycle. Checked against the whole travel, not where it was dropped, which
  // is the only way to catch it in the editor rather than mid-shift.
  const blocked = stationsUnderMechanisms(map);
  if (blocked > 0) {
    requirements.push({
      label: t("editor.requirementMechanismClear", { count: blocked }),
      satisfied: false,
    });
  }

  // A portal links to exactly one other. Alone, or one of three with the same name, it
  // links nothing, and a player stepping into it would simply stand there.
  const portals = map.objects
    .filter((object) => object.role === "mechanism" && object.mechanism?.kind === "portal")
    .map((object) => object.mechanism!);
  const unpaired = unpairedPortalIds(portals);
  if (unpaired.length > 0) {
    requirements.push({
      label: t("editor.requirementPortalPairs", { pairs: unpaired.map((id) => id || "—").join(", ") }),
      satisfied: false,
    });
  }

  // A phase that names a mechanism the map no longer has (renamed, deleted) would silently
  // do nothing, which is the hardest kind of broken level to notice.
  const mechanismIds = new Set(
    map.objects.filter((object) => object.role === "mechanism").map((object) => object.id),
  );
  const missing = new Set<string>();
  for (const phase of map.meta?.layoutPhases ?? []) {
    for (const id of [...phase.enable, ...phase.disable]) if (!mechanismIds.has(id)) missing.add(id);
  }
  if (missing.size > 0) {
    requirements.push({
      label: t("editor.requirementPhaseTargets", { count: missing.size }),
      satisfied: false,
    });
  }
  return requirements;
}

/** How many stations sit somewhere one of the map's moving parts can reach. */
const stationsUnderMechanisms = (map: MapData): number => {
  const footprints = map.objects
    .filter((object) => object.role === "mechanism" && object.mechanism)
    .map((object) => ({ y: object.position.y, footprint: footprintOf(
      // A parade's route is stored in its own frame: turned into the world like in play.
      marchInWorld(object.mechanism!, object.rotation.y),
      { x: object.position.x, z: object.position.z },
      Math.max(0.5, object.scale.x * 0.6),
    ) }));
  if (footprints.length === 0) return 0;
  return map.objects.filter((object) => {
    if (object.role !== "station" && object.role !== "dispenser") return false;
    return footprints.some(({ y, footprint: print }) =>
      (object.role !== "dispenser" || Math.abs(object.position.y - y) < 1.2) &&
      object.position.x >= print.minX && object.position.x <= print.maxX &&
      object.position.z >= print.minZ && object.position.z <= print.maxZ);
  }).length;
};

/** True when every requirement is met, i.e. the level is playable. */
export const isMapPlayable = (map: MapData, scenario?: ScenarioDefinition): boolean =>
  mapRequirements(map, scenario).every(requirement => requirement.satisfied || requirement.blocking === false);
