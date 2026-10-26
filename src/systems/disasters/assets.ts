import type { ModelAssetDefinition } from "../../core/AssetManager";
import { bundledModelUrl } from "../../core/assets/assetRegistry";

/*
 * Props built from scratch by asset_source/disasters/build_disasters.py. Lazy: a
 * shift where every order is served never downloads them. A disaster's warning
 * card gives them a few seconds to arrive before they are needed.
 */
export const DISASTER_MODEL_IDS = {
  ufo: "disaster:ufo",
  tesla: "disaster:tesla",
  tomato: "disaster:tomato",
  rat: "disaster:rat",
} as const;

export const DISASTER_ASSETS: readonly ModelAssetDefinition[] = [
  { id: DISASTER_MODEL_IDS.ufo, url: bundledModelUrl("src/assets/disasters/ufo.glb"), required: false, lazy: true },
  { id: DISASTER_MODEL_IDS.tesla, url: bundledModelUrl("src/assets/disasters/tesla.glb"), required: false, lazy: true },
  { id: DISASTER_MODEL_IDS.tomato, url: bundledModelUrl("src/assets/disasters/tomato.glb"), required: false, lazy: true },
  { id: DISASTER_MODEL_IDS.rat, url: bundledModelUrl("src/assets/disasters/rat.glb"), required: false, lazy: true },
];
