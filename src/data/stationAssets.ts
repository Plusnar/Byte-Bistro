import { bundledModelUrl } from "../core/assets/assetRegistry";

/**
 * Bespoke station models (built by scripts/model-stations.py). KayKit has no stand mixer,
 * and its oven did not match the stove beside it, so these two are our own. Each keeps
 * one named node the game animates: the oven's door, hinged along its bottom edge, and
 * the mixer's whisk, spinning about its own axis.
 */
export const OVEN_ASSET_ID = "station:oven";
export const MIXER_ASSET_ID = "station:mixer";

export const STATION_ASSETS: readonly { id: string; url: string; required: boolean }[] = [
  { id: OVEN_ASSET_ID, url: bundledModelUrl("src/assets/stations/oven.glb"), required: true },
  { id: MIXER_ASSET_ID, url: bundledModelUrl("src/assets/stations/mixer.glb"), required: true },
];

/** Names of the animated nodes inside the station models. */
export const OVEN_DOOR_NODE = "Door";
export const MIXER_WHISK_NODE = "Whisk";
