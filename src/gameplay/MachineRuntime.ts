import type {
  IngredientInstance,
  StationId,
  Transformation,
} from "../types/game";
import { CookingSystem } from "../systems/CookingSystem";
import { TRANSFORMATIONS } from "../data/transformations";

const cookingSystem = new CookingSystem();

const TIMING_STATIONS: ReadonlySet<StationId> = new Set(
  TRANSFORMATIONS.filter((entry) => entry.idealDuration !== undefined).map(
    (entry) => entry.stationId,
  ),
);

export interface TransformationResolver {
  canAccept(stationId: StationId, currentInputIds: readonly string[], nextInputId: string): boolean;
  findExact(stationId: StationId, inputIds: readonly string[]): Transformation | null;
  createOutput(
    transformation: Transformation,
    inputs: readonly IngredientInstance[],
    now: number,
    cookingAccuracy: number,
  ): IngredientInstance;
}

export type InsertResult =
  | { accepted: true; started: boolean; transformation: Transformation | null }
  | { accepted: false; reason: "busy" | "invalid" };

export interface TimingState {
  progress: number;
  quality: number;
  label: "UNDERCOOKED" | "IDEAL" | "COOKED" | "BURNED";
}

interface ActiveProcess {
  transformation: Transformation;
  inputs: IngredientInstance[];
  elapsed: number;
}

export class MachineRuntime {
  readonly buffer: IngredientInstance[] = [];
  private active: ActiveProcess | null = null;
  private output: IngredientInstance | null = null;

  constructor(
    readonly stationId: StationId,
    private readonly resolver: TransformationResolver,
  ) {}

  insert(item: IngredientInstance): InsertResult {
    if (this.active || this.output) return { accepted: false, reason: "busy" };
    const currentIds = this.buffer.map((entry) => entry.ingredientId);
    if (!this.resolver.canAccept(this.stationId, currentIds, item.ingredientId)) {
      return { accepted: false, reason: "invalid" };
    }

    this.buffer.push(item);
    const exact = this.resolver.findExact(
      this.stationId,
      this.buffer.map((entry) => entry.ingredientId),
    );
    if (!exact) return { accepted: true, started: false, transformation: null };

    this.active = {
      transformation: exact,
      inputs: this.buffer.splice(0),
      elapsed: 0,
    };
    return { accepted: true, started: true, transformation: exact };
  }

  update(deltaSeconds: number, now: number): IngredientInstance | null {
    if (!this.active || this.isTimingStation()) return null;
    this.active.elapsed += deltaSeconds;
    if (this.active.elapsed < this.active.transformation.duration) return null;
    return this.complete(now, 1);
  }

  advanceTiming(deltaSeconds: number): void {
    if (this.active && this.isTimingStation()) this.active.elapsed += deltaSeconds;
  }

  take(now: number): IngredientInstance | null {
    if (this.output) {
      const item = this.output;
      this.output = null;
      return item;
    }
    if (!this.active || !this.isTimingStation()) return null;
    const timing = this.getTimingState();
    const item = this.complete(now, timing?.quality ?? 0);
    this.output = null;
    return item;
  }

  peekOutput(): IngredientInstance | null {
    return this.output;
  }

  takeBuffered(): IngredientInstance | null {
    if (this.active || this.output) return null;
    return this.buffer.pop() ?? null;
  }

  getActiveTransformation(): Transformation | null {
    return this.active?.transformation ?? null;
  }

  getProgress(): number {
    if (!this.active) return this.output ? 1 : 0;
    return this.active.elapsed / Math.max(0.01, this.active.transformation.duration);
  }

  getTimingState(): TimingState | null {
    if (!this.active || !this.isTimingStation()) return null;
    return evaluateOvenTiming(
      this.getProgress(),
      this.active.transformation.idealDuration === undefined
        ? undefined
        : this.active.transformation.idealDuration /
          this.active.transformation.duration,
    );
  }

  isProcessing(): boolean {
    return this.active !== null;
  }

  isOutputReady(): boolean {
    return this.output !== null;
  }

  /** Stations with an ideal window (oven, freezer) are removed by hand and can over-process. */
  isTimingStation(): boolean {
    return TIMING_STATIONS.has(this.stationId);
  }

  reset(): void {
    this.buffer.length = 0;
    this.active = null;
    this.output = null;
  }

  private complete(now: number, cookingAccuracy: number): IngredientInstance {
    const process = this.active;
    if (!process) throw new Error("Cannot complete an idle machine.");
    const output = this.resolver.createOutput(
      process.transformation,
      process.inputs,
      now,
      cookingAccuracy,
    );
    this.active = null;
    this.output = output;
    return output;
  }
}

export const evaluateOvenTiming = (
  progress: number,
  idealProgress?: number,
): TimingState => {
  const safeProgress = Math.max(0, progress);
  const evaluation = cookingSystem.evaluate(safeProgress, 1, idealProgress);
  return {
    progress: safeProgress,
    quality: evaluation.accuracy,
    label: evaluation.state,
  };
};
