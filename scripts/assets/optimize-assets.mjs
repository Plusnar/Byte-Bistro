/**
 * Asset optimization pipeline: `npm run assets:optimize` (or `--check` in CI).
 *
 * Reads asset-pipeline.json, writes an optimized copy of every listed model to
 * `optimized/<source path>` and records it in `optimized/manifest.json`. Originals are never
 * touched. The game resolves every model through src/core/assets/assetRegistry.ts, which
 * prefers the optimized copy (and `?assets=original` in the URL switches back, for A/B
 * comparison and rollback).
 *
 * Nothing is compressed blindly. Each output is re-read and checked against its source:
 * same triangles, same skins and joints, same animation names, same alpha modes, same
 * bounds (within quantization precision), node names kept wherever the profile keeps the
 * hierarchy. A failed check keeps the original and reports why; an output that does not
 * save at least `minSavingsRatio` is not kept either.
 *
 *   node scripts/assets/optimize-assets.mjs            optimize what changed
 *   node scripts/assets/optimize-assets.mjs --force    redo everything
 *   node scripts/assets/optimize-assets.mjs --check    fail if any output is missing/stale
 */
import { createHash } from "node:crypto";
import { copyFile, glob, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const FORCE = args.has("--force");

// The encoders are only loaded to optimize: `--check` runs before every build (Cloudflare
// included) and must stay light.
const tools = CHECK ? null : {
  ...await import("@gltf-transform/core"),
  ...await import("@gltf-transform/extensions"),
  ...await import("@gltf-transform/functions"),
  ...await import("meshoptimizer"),
  sharp: (await import("sharp")).default,
};
/** Bump when the transforms change, so every output is rebuilt. */
const PIPELINE_VERSION = 1;
const DECODER_SOURCE = "node_modules/meshoptimizer/meshopt_decoder.cjs";

const config = JSON.parse(await readFile(path.join(root, "asset-pipeline.json"), "utf8"));
const outputRoot = path.join(root, config.outputDir);
const manifestPath = path.join(outputRoot, "manifest.json");
const previous = await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => ({ files: {} }));

const posix = (file) => file.split(path.sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every input file with its profile, in a stable order. */
const resolveInputs = async () => {
  const seen = new Map();
  for (const input of config.inputs) {
    if (!config.profiles[input.profile]) throw new Error(`Unknown profile "${input.profile}"`);
    const files = input.glob
      ? (await Array.fromAsync(glob(input.glob, { cwd: root }))).map(posix).sort()
      : [input.path];
    if (files.length === 0) throw new Error(`No file matches ${input.glob ?? input.path}`);
    for (const file of files) seen.set(file, input.profile);
  }
  return [...seen].map(([file, profile]) => ({ file, profile }));
};

const profileKey = (profile) => sha256(JSON.stringify({ PIPELINE_VERSION, profile })).slice(0, 12);

// --- facts compared before and after ---------------------------------------------------

const meshTriangles = (mesh) => {
  let triangles = 0;
  for (const primitive of mesh.listPrimitives()) {
    const indices = primitive.getIndices();
    const position = primitive.getAttribute("POSITION");
    const count = indices ? indices.getCount() : position?.getCount() ?? 0;
    if (primitive.getMode() === 4) triangles += count / 3;
  }
  return triangles;
};

const describe = (document) => {
  const gltfRoot = document.getRoot();
  // Triangles as drawn: a mesh used by three nodes is drawn three times. (Joining turns such
  // instances into real geometry, and pruning drops meshes no node draws; neither changes
  // what is on screen, which is what this has to hold constant.)
  let triangles = 0;
  for (const node of gltfRoot.listNodes()) {
    const mesh = node.getMesh();
    if (mesh) triangles += meshTriangles(mesh);
  }
  const scene = gltfRoot.getDefaultScene() ?? gltfRoot.listScenes()[0];
  const bounds = scene ? tools.getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    triangles: Math.round(triangles),
    meshes: gltfRoot.listMeshes().length,
    primitives: gltfRoot.listMeshes().reduce((sum, mesh) => sum + mesh.listPrimitives().length, 0),
    nodeNames: gltfRoot.listNodes().map((node) => node.getName()).filter(Boolean),
    skins: gltfRoot.listSkins().map((skin) => skin.listJoints().length),
    animations: gltfRoot.listAnimations().map((animation) => animation.getName()).sort(),
    alphaModes: gltfRoot.listMaterials().map((material) => `${material.getAlphaMode()}:${material.getDoubleSided()}`).sort(),
    textures: gltfRoot.listTextures().map((texture) => texture.getSize() ?? [0, 0]),
    bounds,
  };
};

const sameMultiset = (a, b) => {
  const count = new Map();
  for (const value of a) count.set(value, (count.get(value) ?? 0) + 1);
  for (const value of b) count.set(value, (count.get(value) ?? 0) - 1);
  return [...count.values()].every((value) => value === 0);
};

/** Problems with `after` as a replacement for `before`; empty when it is safe. */
const compare = (before, after, profile) => {
  const problems = [];
  if (before.triangles !== after.triangles) problems.push(`triangles ${before.triangles} -> ${after.triangles}`);
  if (JSON.stringify(before.skins) !== JSON.stringify(after.skins)) problems.push(`skins/joints changed`);
  if (JSON.stringify(before.animations) !== JSON.stringify(after.animations)) problems.push("animation names changed");
  // dedup may merge identical materials; what must survive is exactly the set of alpha modes.
  const modesBefore = [...new Set(before.alphaModes)].sort();
  const modesAfter = [...new Set(after.alphaModes)].sort();
  if (!sameMultiset(modesBefore, modesAfter)) problems.push(`alpha modes ${modesBefore} -> ${modesAfter}`);
  if (!profile.flattenAndJoin) {
    const kept = new Set(after.nodeNames);
    const lost = before.nodeNames.filter((name) => !kept.has(name));
    if (lost.length) problems.push(`node names lost: ${lost.slice(0, 5).join(", ")}${lost.length > 5 ? "…" : ""}`);
  }
  const size = Math.max(...before.bounds.max.map((value, axis) => value - before.bounds.min[axis]), 1e-6);
  const drift = Math.max(
    ...before.bounds.min.map((value, axis) => Math.abs(value - after.bounds.min[axis])),
    ...before.bounds.max.map((value, axis) => Math.abs(value - after.bounds.max[axis])),
  );
  // 16-bit position quantization is accurate to ~1/32768 of the extent; allow a margin.
  if (drift > size * 2e-3) problems.push(`bounds moved by ${drift.toFixed(4)} (size ${size.toFixed(3)})`);
  for (const [width, height] of after.textures) {
    if (Math.max(width, height) > profile.maxTextureSize) problems.push(`texture ${width}x${height} over ${profile.maxTextureSize}`);
  }
  return problems;
};

// --- the transforms ----------------------------------------------------------------------

const io = tools && new tools.NodeIO()
  .registerExtensions(tools.ALL_EXTENSIONS)
  .registerDependencies({ "meshopt.decoder": tools.MeshoptDecoder, "meshopt.encoder": tools.MeshoptEncoder });

/** Everything prune may remove; nodes and skins are left out where the hierarchy is kept. */
const PRUNABLE = ["Node", "Skin", "Mesh", "Camera", "Primitive", "PrimitiveTarget", "Animation", "Material", "Texture", "Accessor", "Buffer"];

const optimize = async (document, profile) => {
  const propertyTypes = profile.flattenAndJoin
    ? PRUNABLE
    : PRUNABLE.filter((type) => type !== "Node" && type !== "Skin");
  const steps = [
    tools.dedup(),
    tools.prune({ propertyTypes, keepLeaves: true, keepAttributes: true, keepExtras: true, keepSolidTextures: true }),
  ];
  if (profile.flattenAndJoin) steps.push(tools.flatten(), tools.join({ keepNamed: false }));
  steps.push(tools.textureCompress({
    encoder: tools.sharp,
    targetFormat: profile.textureFormat,
    quality: profile.textureQuality,
    resize: [profile.maxTextureSize, profile.maxTextureSize],
  }));
  if (profile.meshopt) steps.push(tools.meshopt({ encoder: tools.MeshoptEncoder, level: "medium" }));
  await document.transform(...steps);
  return document;
};

// --- main ----------------------------------------------------------------------------------

if (tools) {
  await tools.MeshoptDecoder.ready;
  await tools.MeshoptEncoder.ready;
}
const inputs = await resolveInputs();
const manifest = { pipelineVersion: PIPELINE_VERSION, decoder: null, files: {} };
const stale = [];
let savedBytes = 0;

for (const { file, profile: profileName } of inputs) {
  const profile = config.profiles[profileName];
  const sourcePath = path.join(root, file);
  const source = await readFile(sourcePath);
  const sourceHash = sha256(source);
  const key = profileKey(profile);
  const outputRel = posix(path.join(config.outputDir, file));
  const outputPath = path.join(root, outputRel);
  const known = previous.files?.[file];
  const upToDate = known && known.sourceHash === sourceHash && known.profileKey === key
    && (known.status !== "optimized" || await stat(outputPath).then(() => true, () => false));

  if (CHECK) {
    if (!upToDate) stale.push(file);
    if (known) manifest.files[file] = known;
    continue;
  }
  if (upToDate && !FORCE) {
    manifest.files[file] = known;
    console.log(`= ${file} (${known.status})`);
    continue;
  }

  const entry = { profile: profileName, profileKey: key, sourceHash, sourceBytes: source.length };
  try {
    const before = describe(await io.readBinary(source));
    const document = await optimize(await io.readBinary(source), profile);
    const output = await io.writeBinary(document);
    const after = describe(await io.readBinary(output));
    const problems = compare(before, after, profile);
    const ratio = 1 - output.length / source.length;
    if (problems.length) {
      Object.assign(entry, { status: "rejected", reason: problems.join("; ") });
    } else if (ratio < config.minSavingsRatio) {
      Object.assign(entry, { status: "unchanged", reason: `saves only ${(ratio * 100).toFixed(1)}%` });
    } else {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, output);
      savedBytes += source.length - output.length;
      Object.assign(entry, {
        status: "optimized",
        output: outputRel,
        outputHash: sha256(output),
        outputBytes: output.length,
        meshopt: profile.meshopt,
        before: { meshes: before.meshes, primitives: before.primitives, textures: before.textures },
        after: { meshes: after.meshes, primitives: after.primitives, textures: after.textures },
      });
    }
  } catch (error) {
    Object.assign(entry, { status: "rejected", reason: `failed: ${error.message}` });
  }
  if (entry.status !== "optimized") await rm(outputPath, { force: true });
  manifest.files[file] = entry;
  const detail = entry.status === "optimized"
    ? `${(entry.sourceBytes / 1048576).toFixed(2)} -> ${(entry.outputBytes / 1048576).toFixed(2)} MB, primitives ${entry.before.primitives} -> ${entry.after.primitives}`
    : entry.reason;
  console.log(`${entry.status === "optimized" ? "+" : "!"} ${file}: ${entry.status} (${detail})`);
}

// --- standalone images ---------------------------------------------------------------------

manifest.images = {};
const imageConfig = config.images ?? { inputs: [] };
for (const input of imageConfig.inputs) {
  const file = input.path;
  const source = await readFile(path.join(root, file));
  const sourceHash = sha256(source);
  const key = sha256(JSON.stringify({ PIPELINE_VERSION, input, minPsnrDb: imageConfig.minPsnrDb })).slice(0, 12);
  const outputRel = posix(path.join(config.outputDir, file.replace(/\.[^.]+$/, `.${input.format}`)));
  const known = previous.images?.[file];
  const upToDate = known && known.sourceHash === sourceHash && known.profileKey === key
    && (known.status !== "optimized" || await stat(path.join(root, outputRel)).then(() => true, () => false));
  if (CHECK) {
    if (!upToDate) stale.push(file);
    if (known) manifest.images[file] = known;
    continue;
  }
  if (upToDate && !FORCE) { manifest.images[file] = known; continue; }
  const entry = { profileKey: key, sourceHash, sourceBytes: source.length };
  const image = tools.sharp(source).resize(input.maxSize, input.maxSize, { fit: "inside", withoutEnlargement: true });
  const output = await image.clone().toFormat(input.format, { quality: input.quality, ...(input.lossless ? { lossless: true } : {}) }).toBuffer();
  const { width, height } = await tools.sharp(output).metadata();
  const [a, b] = await Promise.all([
    tools.sharp(source).resize(width, height, { fit: "fill" }).removeAlpha().raw().toBuffer(),
    tools.sharp(output).removeAlpha().raw().toBuffer(),
  ]);
  let squared = 0;
  for (let index = 0; index < a.length; index++) squared += (a[index] - b[index]) ** 2;
  const psnr = 10 * Math.log10((255 * 255) / Math.max(squared / a.length, 1e-9));
  if (psnr < imageConfig.minPsnrDb) {
    Object.assign(entry, { status: "rejected", reason: `PSNR ${psnr.toFixed(1)} dB under ${imageConfig.minPsnrDb}` });
  } else if (1 - output.length / source.length < config.minSavingsRatio) {
    Object.assign(entry, { status: "unchanged", reason: "no real saving" });
  } else {
    await mkdir(path.dirname(path.join(root, outputRel)), { recursive: true });
    await writeFile(path.join(root, outputRel), output);
    savedBytes += source.length - output.length;
    Object.assign(entry, { status: "optimized", output: outputRel, outputBytes: output.length, psnrDb: +psnr.toFixed(1) });
  }
  manifest.images[file] = entry;
  console.log(`${entry.status === "optimized" ? "+" : "!"} ${file}: ${entry.status} (${entry.status === "optimized"
    ? `${(entry.sourceBytes / 1024).toFixed(0)} -> ${(entry.outputBytes / 1024).toFixed(0)} kB, PSNR ${entry.psnrDb} dB` : entry.reason})`);
}

if (CHECK) {
  if (stale.length) {
    console.error(`\nAsset pipeline is stale for ${stale.length} file(s). Run \`npm run assets:optimize\`:`);
    for (const file of stale) console.error(`  - ${file}`);
    process.exit(1);
  }
  console.log(`Asset pipeline up to date (${inputs.length} inputs).`);
  process.exit(0);
}

// The decoder for EXT_meshopt_compression, served from our own origin with its version in
// the name (immutable caching), instead of Babylon's default CDN.
const decoderVersion = JSON.parse(await readFile(path.join(root, "node_modules/meshoptimizer/package.json"), "utf8")).version;
const decoderRel = `public/vendor/meshopt_decoder-${decoderVersion}.js`;
await mkdir(path.join(root, "public/vendor"), { recursive: true });
await copyFile(path.join(root, DECODER_SOURCE), path.join(root, decoderRel));
manifest.decoder = { path: decoderRel.replace(/^public\//, ""), version: decoderVersion };

await mkdir(outputRoot, { recursive: true });
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const counts = Object.values(manifest.files).reduce((tally, entry) => ({ ...tally, [entry.status]: (tally[entry.status] ?? 0) + 1 }), {});
console.log(`\nDone: ${JSON.stringify(counts)}; this run saved ${(savedBytes / 1048576).toFixed(2)} MB.`);
