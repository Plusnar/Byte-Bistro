/**
 * Asset budget check: `npm run assets:check` (part of `check:perf`, run before every build).
 *
 * 1. Every model in the folders listed in performance-budget.json → assets.requirePipeline
 *    must be an input of asset-pipeline.json: a new model cannot reach the game without
 *    going through the optimization pipeline.
 * 2. Every model the game serves — the optimized copy when there is one — must fit the
 *    budget: file size, largest texture, triangles. Models the official levels place from
 *    the editor library are checked too.
 * Exceptions are listed in performance-budget.json with their reason.
 *
 * Dependency-free (reads GLB/glTF and PNG/JPEG/WebP headers itself) so it runs anywhere
 * `npm run build` does.
 */
import { glob, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = async (file) => readFile(path.join(root, file));
const json = async (file) => JSON.parse(await read(file).then((bytes) => bytes.toString("utf8")));
const posix = (file) => file.split(path.sep).join("/");

const budget = (await json("performance-budget.json")).assets;
const pipelineConfig = await json("asset-pipeline.json");
const pipeline = await json("optimized/manifest.json");

// --- format readers -------------------------------------------------------------------------

const imageSize = (bytes) => {
  if (bytes.length > 24 && bytes.readUInt32BE(0) === 0x89504e47) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let index = 2; index + 9 < bytes.length;) {
      if (bytes[index] !== 0xff) return null;
      const marker = bytes[index + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [bytes.readUInt16BE(index + 7), bytes.readUInt16BE(index + 5)];
      index += 2 + bytes.readUInt16BE(index + 2);
    }
    return null;
  }
  if (bytes.length > 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X") return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (chunk === "VP8L") { const bits = bytes.readUInt32LE(21); return [1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)]; }
    if (chunk === "VP8 ") return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  }
  return null;
};

/** Size, largest texture and drawn triangles of a .glb or .gltf (with its external files). */
const inspect = async (file) => {
  const bytes = await read(file);
  let gltf;
  let bin = null;
  let total = bytes.length;
  if (file.endsWith(".glb")) {
    const jsonLength = bytes.readUInt32LE(12);
    gltf = JSON.parse(bytes.toString("utf8", 20, 20 + jsonLength));
    const binStart = 20 + jsonLength;
    if (binStart + 8 <= bytes.length) bin = bytes.subarray(binStart + 8, binStart + 8 + bytes.readUInt32LE(binStart));
  } else {
    gltf = JSON.parse(bytes.toString("utf8"));
  }
  const directory = path.posix.dirname(file);
  const external = async (uri) => {
    const data = await read(path.posix.join(directory, decodeURIComponent(uri)));
    total += data.length;
    return data;
  };
  const images = [];
  for (const image of gltf.images ?? []) {
    let data = null;
    if (image.bufferView !== undefined && bin) {
      const view = gltf.bufferViews[image.bufferView];
      data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    } else if (image.uri && !image.uri.startsWith("data:")) {
      data = await external(image.uri);
    }
    const size = data ? imageSize(data) : null;
    if (size) images.push(size);
  }
  for (const buffer of gltf.buffers ?? []) if (buffer.uri && !buffer.uri.startsWith("data:")) await external(buffer.uri);
  const meshTriangles = (gltf.meshes ?? []).map((mesh) => mesh.primitives.reduce((sum, primitive) => {
    if ((primitive.mode ?? 4) !== 4) return sum;
    const accessor = gltf.accessors[primitive.indices ?? primitive.attributes.POSITION];
    return sum + (accessor?.count ?? 0) / 3;
  }, 0));
  const triangles = (gltf.nodes ?? []).reduce((sum, node) => sum + (node.mesh !== undefined ? meshTriangles[node.mesh] : 0), 0);
  return { bytes: total, maxTexture: Math.max(0, ...images.flat()), triangles: Math.round(triangles) };
};

// --- what the game serves -------------------------------------------------------------------

const problems = [];
const exceptions = budget.exceptions ?? {};
const inputs = new Set(Object.keys(pipeline.files));

// 1. New models must go through the pipeline.
for (const pattern of budget.requirePipeline) {
  for await (const match of glob(pattern, { cwd: root })) {
    const file = posix(match);
    if (!inputs.has(file) && !exceptions[file]) {
      problems.push(`${file}: not in asset-pipeline.json. Add it to "inputs" and run \`npm run assets:optimize\`.`);
    }
  }
}
// The configured inputs and the manifest must agree (a removed or renamed input).
const configured = pipelineConfig.inputs.filter((input) => input.path).map((input) => input.path);
for (const file of configured) if (!inputs.has(file)) problems.push(`${file}: listed in asset-pipeline.json but never optimized; run \`npm run assets:optimize\`.`);

// 2. Budgets, on what is actually served.
const served = [];
for (const [source, entry] of Object.entries(pipeline.files)) {
  served.push({ source, file: entry.status === "optimized" ? entry.output : source, character: entry.profile === "character" });
}
// Library models placed by the official levels (and the kitchen's own KayKit pieces).
const library = new Map((await json("src/data/assetLibrary.json")).map((entry) => [entry.id, entry.path]));
const placed = new Set();
for (const file of await readdir(path.join(root, "src/data/levels"))) {
  if (!file.endsWith(".json") || file === "README.md") continue;
  const level = await json(`src/data/levels/${file}`);
  for (const object of level.objects ?? []) if (library.has(object.assetId)) placed.add(object.assetId);
}
for (const id of placed) {
  const publicPath = decodeURIComponent(library.get(id));
  served.push({ source: `public/${publicPath}`, file: `public/${publicPath}`, character: false });
}

let checked = 0;
for (const { source, file, character } of served) {
  if (exceptions[source]) continue;
  const facts = await inspect(file).catch((error) => ({ error }));
  if (facts.error) { problems.push(`${file}: cannot be read (${facts.error.message})`); continue; }
  checked += 1;
  const maxBytes = character ? budget.maxCharacterBytes : budget.maxModelBytes;
  if (facts.bytes > maxBytes) problems.push(`${file}: ${(facts.bytes / 1048576).toFixed(2)} MB, over ${(maxBytes / 1048576).toFixed(2)} MB`);
  if (facts.maxTexture > budget.maxTextureSize) problems.push(`${file}: texture ${facts.maxTexture}px, over ${budget.maxTextureSize}px`);
  if (facts.triangles > budget.maxTrianglesPerModel) problems.push(`${file}: ${facts.triangles} triangles, over ${budget.maxTrianglesPerModel}`);
}

// 3. Optimized images must be the ones referenced: a stylesheet or page still pointing at
//    the original would ship the heavy file.
const optimizedImages = Object.entries(pipeline.images ?? {}).filter(([, entry]) => entry.status === "optimized");
if (optimizedImages.length) {
  const referencing = [];
  for await (const match of glob(["src/**/*.{css,ts}", "index.html"], { cwd: root })) referencing.push(posix(match));
  for (const file of referencing) {
    const text = await read(file).then((bytes) => bytes.toString("utf8"));
    for (const [source, entry] of optimizedImages) {
      const publicPath = source.replace(/^public\//, "");
      if (text.includes(publicPath)) problems.push(`${file}: references ${publicPath}; use the optimized ${entry.output}`);
    }
  }
}

if (problems.length) {
  console.error(`Asset budget: ${problems.length} problem(s). See performance-budget.json and docs/PERFORMANCE_ARCHITECTURE.md.\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`Asset budget: OK (${checked} served models checked, ${Object.keys(exceptions).length} documented exceptions).`);
