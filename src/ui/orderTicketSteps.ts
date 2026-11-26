import { getFoodDefinition, vesselForState } from "../data/kitchen";
import type { FoodState } from "../types/game";
import type { OrderTicketComponent } from "./GameUI";

/** The stations a ticket can point at under an ingredient, each with a HUD icon. */
export type PrepStation = "mixer" | "cutting_board" | "stove" | "oven";

export type PrepStepStatus = "done" | "active" | "todo";

/**
 * Every station a recipe component passes through, in order, so the ticket can show the
 * whole job under the ingredient: a fried RAM module is board *and* stove, a beaten cream
 * is board *and* mixer. Pans and pots share the stove icon, which already shows a pan.
 */
export const preparationSteps = (ingredientId: string, state: FoodState): PrepStation[] => {
  const steps: PrepStation[] = [];
  const food = getFoodDefinition(ingredientId);
  const vessel = vesselForState(state);
  if (state === "chopped" || (vessel && food?.chop)) steps.push("cutting_board");
  if (vessel) steps.push(vessel === "tray" ? "oven" : vessel === "bowl" ? "mixer" : "stove");
  return steps;
};

const STAGE_RANK: Readonly<Record<OrderTicketComponent["stage"], number>> = {
  fetch: 0, mix: 1, chop: 2, cook: 3, cooking: 4, plate: 5, plated: 6,
};

/** The stage band in which each station is the one being worked: [first, last]. */
const STEP_BAND: Readonly<Record<PrepStation, readonly [number, number]>> = {
  mixer: [STAGE_RANK.cook, STAGE_RANK.cooking],
  cutting_board: [STAGE_RANK.chop, STAGE_RANK.chop],
  stove: [STAGE_RANK.cook, STAGE_RANK.cooking],
  oven: [STAGE_RANK.cook, STAGE_RANK.cooking],
};

/** Whether a station is behind, at or ahead of where this component currently is. */
export const stepStatus = (
  step: PrepStation,
  stage: OrderTicketComponent["stage"],
): PrepStepStatus => {
  const rank = STAGE_RANK[stage];
  const [first, last] = STEP_BAND[step];
  return rank > last ? "done" : rank >= first ? "active" : "todo";
};
