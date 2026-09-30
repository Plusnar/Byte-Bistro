import type { MapData } from "./MapData";
import { isFloorAsset } from "../physics/collisionPolicy";
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
      { label: "Spawn do Player 1", satisfied: map.objects.some(o => o.role === "spawn" && o.playerIndex === 1) },
      { label: "Spawn do Player 2", satisfied: map.objects.some(o => o.role === "spawn" && o.playerIndex === 2) },
    );
  }
  if (scenario.requirements.requiresFloor) {
    requirements.push({ label: "Piso ou ambiente completo", satisfied: hasFloor(map) });
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
      label: `Ingrediente: ${ingredient.label}`,
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
      label: `Estações e caixas no chão (${raised} acima do piso)`,
      satisfied: false,
    });
  }
  return requirements;
}

/** True when every requirement is met, i.e. the level is playable. */
export const isMapPlayable = (map: MapData, scenario?: ScenarioDefinition): boolean =>
  mapRequirements(map, scenario).every(requirement => requirement.satisfied);
