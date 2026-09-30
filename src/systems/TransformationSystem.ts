import { BALANCE } from "../data/balance";
import { createIngredient, getIngredient } from "../data/ingredients";
import { TRANSFORMATIONS } from "../data/transformations";
import type { IngredientInstance, StationId, Transformation } from "../types/game";
import { clamp, lerp } from "../utils/math";

export interface TransformationOptions {
  now?: number;
  cookingAccuracy?: number;
  presentation?: number;
  temperature?: number;
  qualityRetention?: number;
}

export interface TransformationResult {
  transformation: Transformation;
  output: IngredientInstance;
  consumed: IngredientInstance[];
  remaining: IngredientInstance[];
}

const toInputIds = (
  inputs: readonly IngredientInstance[] | readonly string[],
): readonly string[] => inputs.map((input) => (typeof input === "string" ? input : input.ingredientId));

export const containsIngredientSubset = (
  available: readonly string[],
  required: readonly string[],
): boolean => {
  const counts = new Map<string, number>();
  for (const ingredientId of available) {
    counts.set(ingredientId, (counts.get(ingredientId) ?? 0) + 1);
  }

  for (const ingredientId of required) {
    const count = counts.get(ingredientId) ?? 0;
    if (count === 0) {
      return false;
    }
    counts.set(ingredientId, count - 1);
  }
  return true;
};

const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

const selectConsumed = (
  available: readonly IngredientInstance[],
  requiredIds: readonly string[],
): IngredientInstance[] => {
  const selectedIndices = new Set<number>();
  const selected: IngredientInstance[] = [];

  for (const requiredId of requiredIds) {
    const index = available.findIndex(
      (item, itemIndex) => item.ingredientId === requiredId && !selectedIndices.has(itemIndex),
    );
    if (index < 0) {
      return [];
    }
    selectedIndices.add(index);
    const item = available[index];
    if (item !== undefined) {
      selected.push(item);
    }
  }
  return selected;
};

export class TransformationSystem {
  private readonly transformations: readonly Transformation[];

  constructor(transformations: readonly Transformation[] = TRANSFORMATIONS) {
    this.transformations = [...transformations].sort(
      (left, right) => right.inputs.length - left.inputs.length,
    );
  }

  getAll(): readonly Transformation[] {
    return this.transformations;
  }

  findMatch(
    stationId: StationId,
    inputs: readonly IngredientInstance[] | readonly string[],
  ): Transformation | undefined {
    const inputIds = toInputIds(inputs);
    return this.transformations.find(
      (transformation) =>
        transformation.stationId === stationId &&
        containsIngredientSubset(inputIds, transformation.inputs),
    );
  }

  canTransform(
    stationId: StationId,
    inputs: readonly IngredientInstance[] | readonly string[],
  ): boolean {
    return this.findMatch(stationId, inputs) !== undefined;
  }

  tryTransform(
    stationId: StationId,
    inputs: readonly IngredientInstance[],
    options: TransformationOptions = {},
  ): TransformationResult | null {
    const transformation = this.findMatch(stationId, inputs);
    if (transformation === undefined) {
      return null;
    }

    const consumed = selectConsumed(inputs, transformation.inputs);
    if (consumed.length !== transformation.inputs.length) {
      return null;
    }

    const outputData = getIngredient(transformation.output);
    if (outputData === undefined) {
      throw new Error(
        `Transformation ${transformation.id} references unknown output ${transformation.output}`,
      );
    }

    const retention = clamp(
      options.qualityRetention ?? BALANCE.transformation.qualityRetention,
      0,
      1,
    );
    const ingredientQuality = average(
      consumed.map((item) => item.process.ingredientQuality),
    );
    const inheritedCookingAccuracy = average(
      consumed.map((item) => item.process.cookingAccuracy),
    );
    const cookingAccuracy = Math.min(
      inheritedCookingAccuracy,
      clamp(options.cookingAccuracy ?? 1, 0, 1),
    );
    const inheritedPresentation = average(consumed.map((item) => item.process.presentation));
    const presentation = clamp(options.presentation ?? inheritedPresentation, 0, 1);
    const inheritedTemperature = average(consumed.map((item) => item.temperature));
    const temperature =
      options.temperature ??
      lerp(
        inheritedTemperature,
        outputData.baseTemperature,
        BALANCE.transformation.stationTemperatureInfluence,
      );
    const corruption = 1 - consumed.reduce((purity, item) => purity * (1 - item.corruption), 1);
    const oldestCreatedAt = Math.min(...consumed.map((item) => item.createdAt));

    const output = createIngredient(transformation.output, {
      quality: average(consumed.map((item) => item.quality)) * retention,
      corruption,
      temperature,
      createdAt:
        options.now ?? (Number.isFinite(oldestCreatedAt) ? oldestCreatedAt : undefined),
      ingredientQuality,
      cookingAccuracy,
      presentation,
    });
    const consumedSet = new Set(consumed);
    return {
      transformation,
      output,
      consumed,
      remaining: inputs.filter((item) => !consumedSet.has(item)),
    };
  }

  transform(
    stationId: StationId,
    inputs: readonly IngredientInstance[],
    options: TransformationOptions = {},
  ): TransformationResult {
    const result = this.tryTransform(stationId, inputs, options);
    if (result === null) {
      const ids = inputs.map((item) => item.ingredientId).join(", ") || "none";
      throw new Error(`No transformation for ${stationId} with inputs: ${ids}`);
    }
    return result;
  }
}
