/**
 * Texture fidelity report for the asset pipeline: `node scripts/assets/compare-textures.mjs`.
 *
 * For every optimized model whose textures were resized or re-encoded, compares each
 * texture with the original's at the optimized resolution (what the GPU samples once the
 * model is small enough on screen to use that mip level) and prints PSNR in dB:
 * above ~40 dB is visually identical, 35–40 dB is very close, below 30 dB needs a look.
 * It only reports; the pipeline's own checks decide what ships.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(await readFile(path.join(root, "optimized/manifest.json"), "utf8"));
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });

const raw = async (image, width, height) =>
  sharp(Buffer.from(image)).resize(width, height, { fit: "fill", kernel: "lanczos3" }).removeAlpha().raw().toBuffer();

const psnr = (a, b) => {
  let squared = 0;
  for (let index = 0; index < a.length; index++) {
    const difference = a[index] - b[index];
    squared += difference * difference;
  }
  const mse = squared / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
};

const only = process.argv[2];
for (const [source, entry] of Object.entries(manifest.files)) {
  if (entry.status !== "optimized" || (only && !source.includes(only))) continue;
  const before = (await io.read(path.join(root, source))).getRoot().listTextures();
  if (before.length === 0) continue;
  const after = (await io.read(path.join(root, entry.output))).getRoot().listTextures();
  const results = [];
  for (const [index, original] of before.entries()) {
    const optimized = after.find((texture) => texture.getName() === original.getName()) ?? after[index];
    if (!optimized) continue;
    const [width, height] = optimized.getSize() ?? [0, 0];
    const [a, b] = await Promise.all([raw(original.getImage(), width, height), raw(optimized.getImage(), width, height)]);
    const [ow, oh] = original.getSize() ?? [0, 0];
    results.push(`${original.getName() || `#${index}`} ${ow}->${width}px ${psnr(a, b).toFixed(1)} dB`);
  }
  console.log(`${source}\n  ${results.join("\n  ")}`);
}
