import { readdir, readFile, mkdir, copyFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const destination = path.join(root, "public", "asset-library");
const apply = process.argv.includes("--apply");
const manifestPath = path.join(root, "src", "data", "assetLibrary.json");
const manifest = new Map((JSON.parse(await readFile(manifestPath, "utf8"))).map(entry => [entry.id, entry]));
const copies = new Map();
const protectedFiles = new Set();
const humanize = value => value.replace(/[_-]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());

async function walk(directory, depth = 0) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(file, depth + 1));
    // A pack is a folder. Loose files at the top (the level map's diorama) are not
    // props, and would otherwise show up in the editor's catalogue.
    else if (depth > 0 && /\.(glb|gltf)$/i.test(entry.name)) result.push(file);
  }
  return result.sort();
}

/**
 * Optional `pack.json` at the root of a pack folder: a display name, a placement scale
 * (number or {x,y,z}) and per-file overrides of label (with `labelEn`), category and scale. Packs without
 * one keep the names and categories guessed from their file names.
 */
const packMeta = new Map();
async function readPackMeta(packFolder) {
  if (packMeta.has(packFolder)) return packMeta.get(packFolder);
  const file = path.join(root, packFolder, "pack.json");
  let meta = null;
  try {
    await access(file);
    meta = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Invalid pack.json in ${packFolder}: ${error.message}`);
  }
  packMeta.set(packFolder, meta);
  return meta;
}

const asVector = value => typeof value === "number" ? { x: value, y: value, z: value } : value;

async function copy(file) {
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Asset outside project: ${file}`);
  if (copies.has(file) || protectedFiles.has(relative)) return;
  const output = path.join(destination, relative);
  const previous = await readFile(output).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (previous?.equals(await readFile(file))) return;
  if (previous && /^Char[\\/]/i.test(relative)) {
    protectedFiles.add(relative);
    return;
  }
  copies.set(file, { output, relative, replacing: previous !== null });
}

function category(name) {
  if (/floor|wall|room|roof|door|window|stairs|basemodule|platform|tile|pillar|barrier/.test(name)) return "room";
  if (/pipe|cable|wire/.test(name)) return "pipe";
  if (/screen|monitor|display/.test(name)) return "screen";
  if (/machine|oven|stove|fridge|freezer|conveyor|scanner|robot/.test(name)) return "machine";
  if (/shelf|cabinet|box|crate|counter|table|locker|storage/.test(name)) return "storage";
  return "decor";
}

for (const source of ["Scenario", "Char"]) {
  for (const file of await walk(path.join(root, source))) {
    const bytes = await readFile(file);
    let document;
    if (file.endsWith(".gltf")) document = JSON.parse(bytes.toString("utf8"));
    else {
      if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error(`Unsupported GLB: ${file}`);
      const length = bytes.readUInt32LE(12);
      document = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8").replace(/\0+$/u, "").trim());
    }
    await copy(file);
    // Keep the original relative layout so GLTF buffers and GLB textures work
    // both in Vite development and in the published static build.
    for (const resource of [...(document.buffers ?? []), ...(document.images ?? [])]) {
      if (!resource.uri || resource.uri.startsWith("data:")) continue;
      if (/^[a-z]+:/i.test(resource.uri)) throw new Error(`Non-local asset dependency: ${resource.uri}`);
      await copy(path.resolve(path.dirname(file), decodeURIComponent(resource.uri)));
    }
    const relative = path.relative(root, file).split(path.sep).join("/");
    const parts = relative.split("/");
    const name = path.basename(file, path.extname(file));
    const variant = path.basename(path.dirname(file));
    const meta = source === "Scenario" ? await readPackMeta(`${parts[0]}/${parts[1]}`) : null;
    const override = meta?.assets?.[path.basename(file)] ?? {};
    const inPackRoot = parts.length === 3;
    const label = override.label
      ?? humanize(name) + (!inPackRoot && !/^(gltf|glb|glb format)$/i.test(variant) ? ` (${humanize(variant)})` : "");
    const scale = override.scale ?? meta?.scale;
    const id = "library:" + relative;
    if (manifest.has(id)) continue;
    manifest.set(id, {
      id,
      path: `asset-library/${relative.split("/").map(encodeURIComponent).join("/")}`,
      label,
      // English name for packs labelled in Portuguese; the rest are named in English already.
      ...(override.labelEn ? { labelEn: override.labelEn } : {}),
      pack: source === "Char"
        ? "Personagens e acessórios"
        : meta?.name ?? humanize(parts[1].replace(/(?:_?\d+\.\d+|_FREE)/g, "")),
      category: override.category ?? category(name.toLowerCase()),
      ...(scale !== undefined ? { scale: asVector(scale) } : {}),
    });
  }
}
for (const { relative, replacing } of copies.values()) console.log((replacing ? "Replace " : "Add ") + relative);
for (const relative of protectedFiles) console.log("Keep edited character file " + relative);
console.log("Asset library: " + manifest.size + " models, " + copies.size + " file changes.");
if (apply) {
  for (const [file, { output }] of copies) {
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(file, output);
  }
  await writeFile(manifestPath, JSON.stringify([...manifest.values()], null, 2) + "\n");
} else {
  console.log("Preview only. Run npm run assets:library -- --apply to write these changes.");
}
