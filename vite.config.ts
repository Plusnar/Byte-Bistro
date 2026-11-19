import { defineConfig, loadEnv } from "vite";
import { weddingApi } from "./server/wedding-api.mjs";
import { assetManifest } from "./scripts/build/asset-manifest-plugin.mjs";

/**
 * `/api/mp` (phone controllers) goes to `wrangler dev` in development: `npm run mp:dev`.
 * In production the Pages Function serves it on the same origin.
 */
const multiplayerProxy = (target: string | undefined) => ({
  "/api/mp": { target: target || "http://127.0.0.1:8787", changeOrigin: false, ws: true },
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
    proxy: multiplayerProxy(loadEnv(mode, ".", "").MP_DEV_URL),
  },
  preview: {
    proxy: multiplayerProxy(loadEnv(mode, ".", "").MP_DEV_URL),
  },
  build: {
    target: "es2022",
    rollupOptions: {
      // The phone controller is a page of its own, without Babylon.
      input: { main: "index.html", controller: "controller.html" },
    },
    // Hashed output only, in a folder of its own: public/assets holds files without a hash,
    // so `/bundle/*` is the one path public/_headers can mark immutable safely.
    assetsDir: "bundle",
  },
}));
