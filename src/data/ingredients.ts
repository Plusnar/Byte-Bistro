import type { IngredientData, IngredientInstance } from "../types/game";
import { clamp, createUid } from "../utils/math";
import { translate } from "../i18n";

type IngredientFields = Omit<IngredientData, "displayName" | "shortName">;

/** Names come from the catalogues (`ingredients.<id>`), read each time, so they follow the language. */
const ingredient = (data: IngredientFields): IngredientData => ({
  ...data,
  get displayName() { return translate(`ingredients.${data.id}.name`); },
  get shortName() { return translate(`ingredients.${data.id}.short`); },
});

export const INGREDIENTS: Record<string, IngredientData> = {
  ram_module: ingredient({
    id: "ram_module",
    category: "component",
    baseQuality: 0.92,
    baseCorruption: 0,
    baseTemperature: 22,
    color: "#32d9ff",
    emissiveColor: "#087eaa",
    shape: "box",
  }),
  binary_sugar: ingredient({
    id: "binary_sugar",
    category: "sweetener",
    baseQuality: 0.9,
    baseCorruption: 0,
    baseTemperature: 20,
    color: "#f7fbff",
    emissiveColor: "#8de8ff",
    shape: "sphere",
  }),
  cache_cream: ingredient({
    id: "cache_cream",
    category: "cream",
    baseQuality: 0.94,
    baseCorruption: 0,
    baseTemperature: 6,
    color: "#e6d7ff",
    emissiveColor: "#9f7aea",
    shape: "cylinder",
  }),
  cache_fragment: ingredient({
    id: "cache_fragment",
    category: "component",
    baseQuality: 0.9,
    baseCorruption: 0.02,
    baseTemperature: 18,
    color: "#ffcf56",
    emissiveColor: "#d58213",
    shape: "box",
  }),
  cooling_fluid: ingredient({
    id: "cooling_fluid",
    category: "coolant",
    baseQuality: 0.96,
    baseCorruption: 0,
    baseTemperature: -4,
    color: "#63f5e8",
    emissiveColor: "#00a99d",
    shape: "cylinder",
  }),
  data_cream: ingredient({
    id: "data_cream",
    category: "cream",
    baseQuality: 0.93,
    baseCorruption: 0,
    baseTemperature: 5,
    color: "#ffb8e8",
    emissiveColor: "#c83a9b",
    shape: "cylinder",
  }),
  ram_powder: ingredient({
    id: "ram_powder",
    category: "prepared",
    baseQuality: 0.92,
    baseCorruption: 0,
    baseTemperature: 24,
    color: "#74e8ff",
    emissiveColor: "#159ec0",
    shape: "sphere",
  }),
  ram_dough: ingredient({
    id: "ram_dough",
    category: "mixture",
    baseQuality: 0.91,
    baseCorruption: 0,
    baseTemperature: 24,
    color: "#8fc7ff",
    emissiveColor: "#426db8",
    shape: "sphere",
  }),
  ram_cake_base: ingredient({
    id: "ram_cake_base",
    category: "prepared",
    baseQuality: 0.9,
    baseCorruption: 0,
    baseTemperature: 82,
    color: "#4a94dd",
    emissiveColor: "#184f8f",
    shape: "cylinder",
  }),
  ram_cake: ingredient({
    id: "ram_cake",
    category: "dish",
    baseQuality: 0.94,
    baseCorruption: 0,
    baseTemperature: 38,
    color: "#6edcff",
    emissiveColor: "#2b80bb",
    shape: "cylinder",
  }),
  cookie_dough: ingredient({
    id: "cookie_dough",
    category: "mixture",
    baseQuality: 0.9,
    baseCorruption: 0.01,
    baseTemperature: 23,
    color: "#eac271",
    emissiveColor: "#9d681e",
    shape: "sphere",
  }),
  cache_cookies: ingredient({
    id: "cache_cookies",
    category: "dish",
    baseQuality: 0.92,
    baseCorruption: 0,
    baseTemperature: 58,
    color: "#f2b84b",
    emissiveColor: "#a86310",
    shape: "disc",
  }),
  gelato_mix: ingredient({
    id: "gelato_mix",
    category: "mixture",
    baseQuality: 0.95,
    baseCorruption: 0,
    baseTemperature: 2,
    color: "#9ff6ef",
    emissiveColor: "#31b6b2",
    shape: "sphere",
  }),
  ram_cake_baked: ingredient({
    id: "ram_cake_baked",
    category: "dish",
    baseQuality: 0.95,
    baseCorruption: 0,
    baseTemperature: 64,
    color: "#8ec8ff",
    emissiveColor: "#3573c4",
    shape: "cylinder",
  }),
  cookie_tray: ingredient({
    id: "cookie_tray",
    category: "dish",
    baseQuality: 0.93,
    baseCorruption: 0,
    baseTemperature: 70,
    color: "#ffc062",
    emissiveColor: "#b2701c",
    shape: "disc",
  }),
  gelato_parfait: ingredient({
    id: "gelato_parfait",
    category: "dish",
    baseQuality: 0.96,
    baseCorruption: 0,
    baseTemperature: -6,
    color: "#a6fff5",
    emissiveColor: "#1fc8bb",
    shape: "sphere",
  }),
  cooling_gelato: ingredient({
    id: "cooling_gelato",
    category: "dish",
    baseQuality: 0.96,
    baseCorruption: 0,
    baseTemperature: -8,
    color: "#71fff0",
    emissiveColor: "#11bfb0",
    shape: "sphere",
  }),
};

export interface CreateIngredientOptions {
  uid?: string;
  quality?: number;
  corruption?: number;
  temperature?: number;
  createdAt?: number;
  cookingAccuracy?: number;
  presentation?: number;
  ingredientQuality?: number;
}

export const getIngredient = (ingredientId: string): IngredientData | undefined =>
  INGREDIENTS[ingredientId];

export const createIngredient = (
  ingredientId: string,
  options: CreateIngredientOptions = {},
): IngredientInstance => {
  const data = getIngredient(ingredientId);
  if (data === undefined) {
    throw new Error(`Unknown ingredient: ${ingredientId}`);
  }

  const quality = clamp(options.quality ?? data.baseQuality, 0, 1);
  return {
    uid: options.uid ?? createUid(ingredientId),
    ingredientId,
    quality,
    corruption: clamp(options.corruption ?? data.baseCorruption, 0, 1),
    temperature: options.temperature ?? data.baseTemperature,
    createdAt: options.createdAt ?? Date.now(),
    process: {
      cookingAccuracy: clamp(options.cookingAccuracy ?? 1, 0, 1),
      presentation: clamp(options.presentation ?? 0.75, 0, 1),
      ingredientQuality: clamp(options.ingredientQuality ?? quality, 0, 1),
    },
  };
};
