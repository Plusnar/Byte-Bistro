/**
 * Vite plugin: writes `asset-manifest.json` into the build, with a content hash for every
 * file under the `public/` folders the game loads models and textures from.
 *
 * Bundled files carry Vite's hash in their names already; files in `public/` keep theirs,
 * so the runtime (src/core/assets/distribution.ts) requests them as `?v=<hash>` from this
 * manifest. That makes every model request content-addressed: browsers and CDNs can never
 * serve a file from another build, and only changed files are downloaded again.
 *
 * Grouped by directory to keep it small (the editor's library is ~2,500 files).
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const walk = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
};

export const assetManifest = ({ publicDir = "public", folders = ["asset-library", "assets"] } = {}) => ({
  name: "byte-bistro-asset-manifest",
  apply: "build",
  async generateBundle() {
    const root = path.resolve(publicDir);
    const dirs = {};
    const all = createHash("sha256");
    for (const folder of folders) {
      const files = await walk(path.join(root, folder)).catch(() => []);
      for (const file of files.sort()) {
        const relative = path.relative(root, file).split(path.sep).join("/");
        const hash = createHash("sha256").update(await readFile(file)).digest("hex").slice(0, 12);
        const slash = relative.lastIndexOf("/") + 1;
        (dirs[relative.slice(0, slash)] ??= {})[relative.slice(slash)] = hash;
        all.update(`${relative}:${hash}\n`);
      }
    }
    this.emitFile({
      type: "asset",
      fileName: "asset-manifest.json",
      source: JSON.stringify({ version: all.digest("hex").slice(0, 12), dirs }),
    });
  },
});
