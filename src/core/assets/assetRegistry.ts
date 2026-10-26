import { MeshoptCompression } from "@babylonjs/core";
import pipelineManifest from "../../../optimized/manifest.json";

/**
 * The central registry of model files: the only place that turns "this model, by its path
 * in the repository" into a URL the game can load.
 *
 * Every model goes through the asset pipeline (asset-pipeline.json → `npm run
 * assets:optimize`), which writes an optimized copy to `optimized/<path>`. This module
 * hands out that copy when there is one and the original otherwise. Optimized copies are
 * bundled by Vite, so their URLs carry a content hash and can be cached forever.
 *
 * `?assets=original` in the page URL serves every original instead: the A/B switch for
 * checking a visual difference, and the runtime rollback if an optimized file is ever wrong.
 *
 * `npm run check:perf` fails when a source file references a model any other way.
 */

type UrlMap = Readonly<Record<string, string>>;

// Every bundled model the game can load. Listed explicitly (not `/**`) so the build only
// emits what the game uses; add a pattern here when adding a new folder of models.
const ORIGINAL_BUNDLED: UrlMap = import.meta.glob([
  "/src/assets/**/*.glb",
  "/Anim/Mannequin Character/characters/Mannequin_Medium.glb",
  "/Anim/Animations/gltf/Rig_Medium/Rig_Medium_General.glb",
  "/Anim/Animations/gltf/Rig_Medium/Rig_Medium_MovementBasic.glb",
  "/Anim/Animations/gltf/Rig_Medium/Rig_Medium_Simulation.glb",
  "/Scenario/sao_bento_do_sul.glb",
], { query: "?url", import: "default", eager: true });

const OPTIMIZED: UrlMap = import.meta.glob("/optimized/**/*.glb", { query: "?url", import: "default", eager: true });

export type AssetVariant = "optimized" | "original";

const readVariant = (): AssetVariant => {
  if (typeof window === "undefined") return "optimized";
  return new URLSearchParams(window.location.search).get("assets") === "original" ? "original" : "optimized";
};

export const assetVariant: AssetVariant = readVariant();

interface PipelineEntry {
  readonly status: string;
  readonly output?: string;
}

const pipelineFiles = (pipelineManifest as { files: Record<string, PipelineEntry> }).files;

const optimizedUrl = (sourcePath: string): string | undefined => {
  if (assetVariant === "original") return undefined;
  const entry = pipelineFiles[sourcePath];
  if (entry?.status !== "optimized" || !entry.output) return undefined;
  return OPTIMIZED[`/${entry.output}`];
};

const missing = (what: string): never => {
  throw new Error(`Asset not in the registry: ${what}. Add it to src/core/assets/assetRegistry.ts and asset-pipeline.json.`);
};

/**
 * A model bundled with the game, by its path from the repository root:
 * `bundledModelUrl("src/assets/scenario/food-cake.glb")`.
 */
export const bundledModelUrl = (sourcePath: string): string =>
  optimizedUrl(sourcePath) ?? ORIGINAL_BUNDLED[`/${sourcePath}`] ?? missing(sourcePath);

/**
 * A model under `public/`, by its path inside it (unencoded):
 * `publicModelUrl("asset-library/Char/Characters/Jean.glb")`. Optimized copies are bundled
 * and hashed; files without one are served from `public/` as they are.
 */
export const publicModelUrl = (publicPath: string): string =>
  optimizedUrl(`public/${publicPath}`)
  ?? `${import.meta.env.BASE_URL}${publicPath.split("/").map(encodeURIComponent).join("/")}`;

/** For tests and the perf report: what the pipeline did with each file. */
export const pipelineStatus = (sourcePath: string): string => pipelineFiles[sourcePath]?.status ?? "not in pipeline";

/**
 * EXT_meshopt_compression's decoder, from our own origin (copied by the pipeline with its
 * version in the name) rather than Babylon's default CDN: no third-party request, and it
 * is cached with the rest of the game.
 */
const decoder = (pipelineManifest as { decoder?: { path: string } | null }).decoder;
if (decoder) {
  MeshoptCompression.Configuration = {
    decoder: { url: `${import.meta.env.BASE_URL}${decoder.path}` },
  };
}
