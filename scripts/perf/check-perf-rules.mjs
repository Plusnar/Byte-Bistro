/**
 * Static performance rules: `npm run check:perf` (also run by `prebuild`, so a violation
 * stops a deploy). Each rule is the mechanical half of a rule in
 * docs/PERFORMANCE_ARCHITECTURE.md; the id printed with a violation is its section there.
 *
 * A line can opt out with a trailing `// perf-allow: <reason>`. Opt-outs are listed in the
 * report, so they stay visible in review. Per-file exceptions live in
 * performance-budget.json → codeRules, each with its reason.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const budget = JSON.parse(await readFile(path.join(root, "performance-budget.json"), "utf8"));
const config = budget.codeRules;

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) files.push(full);
  }
  return files;
};

const rel = (file) => path.relative(root, file).split(path.sep).join("/");
const isTest = (file) => /(__tests__\/|\.test\.ts$)/.test(file);
const within = (file, prefixes) => prefixes.some((prefix) => file === prefix || (prefix.endsWith("/") && file.startsWith(prefix)));
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** The text of a call, from its opening parenthesis to the matching closing one. */
const callText = (text, open) => {
  let depth = 0;
  let quote = null;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return text.slice(open, index + 1);
  }
  return text.slice(open);
};

/** Strips comments so a rule never matches prose about the thing it forbids. */
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
  .replace(/(^|[^:"'`\\])\/\/(?! perf-allow:).*$/gm, (match, lead) => lead + " ".repeat(match.length - lead.length));

const RULES = [
  {
    id: "R1-asset-loading",
    what: "Babylon loaders are only called by the asset layer (AssetStreamingManager / AssetManager).",
    pattern: /\b(LoadAssetContainerAsync|ImportMeshAsync|AppendSceneAsync|LoadSceneAsync|SceneLoader\.\w+|new\s+(?:Texture|CubeTexture|Sound|HDRCubeTexture)\s*\()/g,
    skip: (file) => within(file, config.assetLoaderFiles) || file in config.assetLoaderAllow,
  },
  {
    id: "R2-raw-fetch",
    what: "Asset bytes come from assetCache/assetStreaming, never a bare fetch().",
    pattern: /(?<![.\w$])fetch\s*\(/g,
    skip: (file) => within(file, config.assetLoaderFiles),
  },
  {
    id: "R3-model-url",
    what: "Model URLs come from the asset registry (bundledModelUrl/publicModelUrl).",
    pattern: /(new\s+URL\(\s*["'`][^"'`]*\.(glb|gltf)\b|publicUrl\(\s*["'`][^"'`]*\.(glb|gltf)\b|import\.meta\.glob\([^)]*\.(glb|gltf))/g,
    skip: (file) => within(file, config.registryFiles),
  },
  {
    id: "R4-asset-manager",
    what: "Scene asset managers are created by assetStreaming.createSceneAssets().",
    pattern: /new\s+AssetManager\s*\(/g,
    skip: (file) => within(file, config.assetManagerFactory),
  },
];

/** Rules that look at a whole file. */
const FILE_RULES = [
  {
    id: "R5-engine-quality",
    what: "Every on-screen engine registers with qualityManager.registerEngine().",
    check: (file, text) => /new\s+(Engine|WebGPUEngine)\s*\(/.test(text)
      && !(file in config.offscreenEngines)
      && !/qualityManager\.registerEngine\(/.test(text),
  },
  {
    id: "R6-particles-quality",
    what: "Every particle system goes through trackParticleSystem() (quality profile).",
    check: (_file, text) => (text.match(/new\s+(GPU)?ParticleSystem\s*\(/g) ?? []).length
      > (text.match(/trackParticleSystem\s*\(/g) ?? []).length,
  },
  {
    id: "R7-effects-quality",
    what: "Glow, shadows and post-processing follow the quality profile (qualityManager).",
    check: (file, text) => /new\s+(GlowLayer|ShadowGenerator|CascadedShadowGenerator|DefaultRenderingPipeline|SSAO2RenderingPipeline|SSRRenderingPipeline|VolumetricLightScatteringPostProcess|MotionBlurPostProcess|LensRenderingPipeline)\s*\(/.test(text)
      && !(file in config.qualityExemptEffects)
      && !/qualityManager\./.test(text),
  },
  {
    id: "R8-timers",
    what: "Every setInterval has a clearInterval and every runRenderLoop a stopRenderLoop in the same file.",
    check: (_file, text) => (/setInterval\s*\(/.test(text) && !/clearInterval\s*\(/.test(text))
      || (/runRenderLoop\s*\(/.test(text) && !/stopRenderLoop\s*\(/.test(text)),
  },
  {
    id: "R9-global-listeners",
    what: "Listeners on window/document are removed (removeEventListener, an AbortSignal or once).",
    check: (_file, text) => {
      if (/removeEventListener\s*\(/.test(text)) return false;
      for (const match of text.matchAll(/\b(window|document)\.addEventListener\s*\(/g)) {
        if (!/\bsignal\b|\bonce\s*:\s*true/.test(callText(text, match.index + match[0].length - 1))) return true;
      }
      return false;
    },
  },
];

const violations = [];
const optOuts = [];
for (const full of await walk(path.join(root, "src"))) {
  const file = rel(full);
  if (isTest(file)) continue;
  const raw = await readFile(full, "utf8");
  const text = stripComments(raw);
  // CRLF too: with core.autocrlf a Windows checkout has it, and `(.+)$` stops at the \r.
  const lines = raw.split(/\r?\n/);
  for (const rule of RULES) {
    if (rule.skip?.(file)) continue;
    for (const match of text.matchAll(rule.pattern)) {
      const line = lineOf(text, match.index);
      const source = lines[line - 1] ?? "";
      const allow = source.match(/\/\/ perf-allow:\s*(.+)$/);
      if (allow) { optOuts.push(`${file}:${line} ${rule.id} — ${allow[1].trim()}`); continue; }
      violations.push(`${file}:${line}  ${rule.id}  ${rule.what}\n      ${source.trim().slice(0, 140)}`);
    }
  }
  for (const rule of FILE_RULES) {
    if (rule.check(file, text)) violations.push(`${file}  ${rule.id}  ${rule.what}`);
  }
}

if (optOuts.length) {
  console.log(`Opt-outs (${optOuts.length}):`);
  for (const optOut of optOuts) console.log(`  ${optOut}`);
}
if (violations.length) {
  console.error(`\nPerformance rules: ${violations.length} violation(s). See docs/PERFORMANCE_ARCHITECTURE.md.\n`);
  for (const violation of violations) console.error(`  ${violation}`);
  process.exit(1);
}
console.log("Performance rules: OK.");
