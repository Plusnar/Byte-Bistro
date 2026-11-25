import { t } from "../i18n";
import type { MapData } from "./MapData";
import { isFloorAsset } from "../physics/collisionPolicy";
import { footprintOf, marchInWorld, unpairedPortalIds } from "../gameplay/mechanisms/MechanismSystem";
import { WEDDING_SCENARIO, getScenario, type ScenarioDefinition } from "../data/scenarios";

export interface MapRequirement {
  readonly label: string;
  readonly satisfied: boolean;
}

const hasFloor = (map: MapData): boolean =>
  map.objects.some(o =>
    o.assetId === "scenario-room-wide" || isFloorAsset(o.assetId) ||
    (o.assetId.startsWith("library:") && /\/room[^/]*\.(?:glb|gltf)$/i.test(o.assetId)));

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
  // The kitchen builds its tiles on the ground whatever their height, so a station placed
  // on an upper storey would play somewhere else than where it was built. Only listed when
  // it applies, so ordinary maps keep their checklist.
  const raised = map.objects.filter(
    o => (o.role === "station" || o.role === "dispenser") && o.position.y > 0.05,
  ).length;
  if (raised > 0) {
    requirements.push({
      label: t("editor.requirementGrounded", { count: raised }),
      satisfied: false,
    });
  }
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
    .map((object) => footprintOf(
      // A parade's route is stored in its own frame: turned into the world like in play.
      marchInWorld(object.mechanism!, object.rotation.y),
      { x: object.position.x, z: object.position.z },
      Math.max(0.5, object.scale.x * 0.6),
    ));
  if (footprints.length === 0) return 0;
  return map.objects.filter((object) => {
    if (object.role !== "station" && object.role !== "dispenser") return false;
    return footprints.some((print) =>
      object.position.x >= print.minX && object.position.x <= print.maxX &&
      object.position.z >= print.minZ && object.position.z <= print.maxZ);
  }).length;
};

/** True when every requirement is met, i.e. the level is playable. */
export const isMapPlayable = (map: MapData, scenario?: ScenarioDefinition): boolean =>
  mapRequirements(map, scenario).every(requirement => requirement.satisfied);
