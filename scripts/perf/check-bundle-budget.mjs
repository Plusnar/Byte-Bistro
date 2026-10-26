/**
 * JavaScript budget, run after `vite build` (part of `npm run build`).
 *
 * Reads dist/index.html for the chunks the page loads up front (the entry script and its
 * modulepreloads), gzips them as a CDN would, and compares with performance-budget.json →
 * bundle. Lazily loaded chunks (the editor) only have to fit the single-chunk limit.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dist = path.join(root, process.argv[2] ?? "dist");
const budget = JSON.parse(await readFile(path.join(root, "performance-budget.json"), "utf8")).bundle;

const html = await readFile(path.join(dist, "index.html"), "utf8");
const initial = [...html.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((match) => match[1]);
const kb = (bytes) => bytes / 1024;

const sizeOf = async (file) => {
  const bytes = await readFile(path.join(dist, file));
  return { file, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
};

const problems = [];
const initialSizes = await Promise.all(initial.map(sizeOf));
const entry = initialSizes.find((size) => /\/index-[^/]+\.js$/.test(`/${size.file}`)) ?? initialSizes[0];
const initialGzip = initialSizes.reduce((sum, size) => sum + size.gzip, 0);
if (entry && kb(entry.gzip) > budget.maxMainChunkGzipKb) {
  problems.push(`main chunk ${entry.file}: ${kb(entry.gzip).toFixed(0)} kB gzip, over ${budget.maxMainChunkGzipKb} kB`);
}
if (kb(initialGzip) > budget.maxInitialJsGzipKb) {
  problems.push(`initial JavaScript: ${kb(initialGzip).toFixed(0)} kB gzip, over ${budget.maxInitialJsGzipKb} kB`);
}
const bundleDir = path.join(dist, "bundle");
for (const file of await readdir(bundleDir)) {
  if (!file.endsWith(".js")) continue;
  const { raw } = await sizeOf(path.join("bundle", file));
  if (kb(raw) > budget.maxSingleChunkKb) problems.push(`chunk bundle/${file}: ${kb(raw).toFixed(0)} kB, over ${budget.maxSingleChunkKb} kB`);
}

console.log(`Initial JS: ${initialSizes.length} file(s), ${kb(initialGzip).toFixed(0)} kB gzip`
  + (entry ? ` (main ${kb(entry.raw).toFixed(0)} kB raw / ${kb(entry.gzip).toFixed(0)} kB gzip)` : ""));
if (problems.length) {
  console.error(`\nBundle budget exceeded (performance-budget.json → bundle):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("Bundle budget: OK.");
