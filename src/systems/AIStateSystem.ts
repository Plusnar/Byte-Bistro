import { BALANCE } from "../data/balance";
import type { AIState, AIStateEffects, AIStateKey, MiraExpression } from "../types/game";
import { clamp } from "../utils/math";

export const DEFAULT_AI_STATE: Readonly<AIState> = {
  ...BALANCE.ai.initialState,
};

export interface AICriticalCondition {
  key: AIStateKey;
  trigger: string;
  message: string;
}

const AI_KEYS: readonly AIStateKey[] = [
  "memory",
  "processing",
  "creativity",
  "stability",
  "temperature",
  "energy",
  "mood",
];

const normalizeState = (state: AIState): AIState => {
  const normalized = { ...state };
  for (const key of AI_KEYS) {
    normalized[key] = clamp(state[key], BALANCE.ai.minimum, BALANCE.ai.maximum);
  }
  return normalized;
};

export class AIStateSystem {
  private state: AIState;

  constructor(initialState: AIState = { ...DEFAULT_AI_STATE }) {
    this.state = normalizeState(initialState);
  }

  getState(): AIState {
    return { ...this.state };
  }

  setState(state: AIState): AIState {
    this.state = normalizeState(state);
    return this.getState();
  }

  applyEffects(effects: AIStateEffects, multiplier = 1): AIState {
    if (!Number.isFinite(multiplier)) {
      throw new Error("AI effect multiplier must be finite");
    }
    const next = this.getState();
    for (const key of AI_KEYS) {
      const effect = effects[key];
      if (effect !== undefined) {
        next[key] = clamp(
          next[key] + effect * multiplier,
          BALANCE.ai.minimum,
          BALANCE.ai.maximum,
        );
      }
    }
    this.state = next;
    return this.getState();
  }

  getCriticalConditions(state: AIState = this.state): AICriticalCondition[] {
    const conditions: AICriticalCondition[] = [];
    if (state.memory < BALANCE.ai.critical.memoryBelow) {
      conditions.push({ key: "memory", trigger: "ai:memory_low", message: "Memory levels are falling." });
    }
    if (state.temperature > BALANCE.ai.critical.temperatureAbove) {
      conditions.push({ key: "temperature", trigger: "ai:temperature_high", message: "THERMAL WARNING." });
    }
    if (state.stability < BALANCE.ai.critical.stabilityBelow) {
      conditions.push({ key: "stability", trigger: "ai:stability_low", message: "Core stability is critical." });
    }
    if (state.energy < BALANCE.ai.critical.energyBelow) {
      conditions.push({ key: "energy", trigger: "ai:energy_low", message: "Energy reserves are low." });
    }
    return conditions;
  }

  getExpression(state: AIState = this.state): MiraExpression {
    if (state.temperature > BALANCE.ai.critical.temperatureAbove) {
      return "overheated";
    }
    if (
      state.stability < BALANCE.ai.critical.stabilityBelow ||
      state.memory < BALANCE.ai.critical.memoryBelow ||
      state.energy < BALANCE.ai.critical.energyBelow
    ) {
      return "worried";
    }
    if (state.mood < BALANCE.ai.mood.angryBelow) {
      return "angry";
    }
    if (state.mood >= BALANCE.ai.mood.happyAtOrAbove) {
      return "happy";
    }
    return "neutral";
  }
}
