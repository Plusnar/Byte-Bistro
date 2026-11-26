import { defineConfig, loadEnv } from "vite";
import { weddingApi } from "./server/wedding-api.mjs";
import { assetManifest } from "./scripts/build/asset-manifest-plugin.mjs";

/**
 * `/api/mp` (phone controllers) and `/api/auth` (player accounts) go to `wrangler dev` in
 * development: `npm run mp:dev` and `npm run accounts:dev`. In production Pages Functions
 * serve both on the same origin.
 */
const multiplayerProxy = (env: Record<string, string>) => ({
  "/api/mp": { target: env.MP_DEV_URL || "http://127.0.0.1:8787", changeOrigin: false, ws: true },
  "/api/auth": { target: env.ACCOUNTS_DEV_URL || "http://127.0.0.1:8789", changeOrigin: false },
});

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
    // MP_LAN=1 serves on the local network, to open the controller on a real phone.
    host: loadEnv(mode, ".", "").MP_LAN ? true : "127.0.0.1",
    port: 5173,
    proxy: multiplayerProxy(loadEnv(mode, ".", "")),
  },
  preview: {
    proxy: multiplayerProxy(loadEnv(mode, ".", "")),
  },
  build: {
    target: "es2022",
    rollupOptions: {
      // The phone controller is a page of its own, without Babylon.
      input: { main: "index.html", controller: "controller.html" },
      output: {
        // The official levels (editor JSON, ~180 kB each) in a chunk of their own: still
        // loaded at boot, since the level picker needs them, but cached apart from the
        // engine code, so a new level or a code change does not re-download the other.
        manualChunks: (id) => (/\/src\/data\/levels\/[^/]+\.json$/.test(id) ? "levels" : undefined),
      },
    },
    // Hashed output only, in a folder of its own: public/assets holds files without a hash,
    // so `/bundle/*` is the one path public/_headers can mark immutable safely.
    assetsDir: "bundle",
  },
}));
