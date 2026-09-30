import type { IngredientInstance, StationId, Transformation } from "../types/game";
import type { TransformationOptions } from "../systems/TransformationSystem";
import { TransformationSystem } from "../systems/TransformationSystem";
import type { TransformationResolver } from "./MachineRuntime";

const countIngredients = (ids: readonly string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  ids.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));
  return counts;
};

const isSubset = (candidate: readonly string[], required: readonly string[]): boolean => {
  const candidateCounts = countIngredients(candidate);
  const requiredCounts = countIngredients(required);
  for (const [id, count] of candidateCounts) {
    if (count > (requiredCounts.get(id) ?? 0)) return false;
  }
  return true;
};

const isExactMultiset = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && isSubset(left, right);

export class DomainTransformationResolver implements TransformationResolver {
  constructor(private readonly transformations: TransformationSystem) {}

  canAccept(
    stationId: StationId,
    currentInputIds: readonly string[],
    nextInputId: string,
  ): boolean {
    const candidate = [...currentInputIds, nextInputId];
    return this.transformations
      .getAll()
      .some(
        (transformation) =>
          transformation.stationId === stationId &&
          isSubset(candidate, transformation.inputs),
      );
  }

  findExact(stationId: StationId, inputIds: readonly string[]): Transformation | null {
    return (
      this.transformations
        .getAll()
        .find(
          (transformation) =>
            transformation.stationId === stationId &&
            isExactMultiset(inputIds, transformation.inputs),
        ) ?? null
    );
  }

  createOutput(
    transformation: Transformation,
    inputs: readonly IngredientInstance[],
    now: number,
    cookingAccuracy: number,
  ): IngredientInstance {
    const options: TransformationOptions = {
      now,
      cookingAccuracy,
      presentation: transformation.stationId === "plating_station" ? 0.98 : undefined,
    };
    return this.transformations.transform(transformation.stationId, inputs, options).output;
  }
}
