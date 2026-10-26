import { defineConfig, loadEnv } from "vite";
import { weddingApi } from "./server/wedding-api.mjs";
import { assetManifest } from "./scripts/build/asset-manifest-plugin.mjs";

export default defineConfig(({ mode }) => ({
  plugins: [{
    name: 'wedding-dialogue-api',
    configureServer(server) {
      server.middlewares.use(weddingApi(loadEnv(mode, '.', '').OPENROUTER_API_KEY ?? ''));
    },
    configurePreviewServer(server) {
      server.middlewares.use(weddingApi(loadEnv(mode, '.', '').OPENROUTER_API_KEY ?? ''));
    },
  }, assetManifest()],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    target: "es2022",
    // Hashed output only, in a folder of its own: public/assets holds files without a hash,
    // so `/bundle/*` is the one path public/_headers can mark immutable safely.
    assetsDir: "bundle",
  },
}));
