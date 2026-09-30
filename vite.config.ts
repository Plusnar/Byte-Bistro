import { defineConfig, loadEnv } from "vite";
import { weddingApi } from "./server/wedding-api.mjs";

export default defineConfig(({ mode }) => ({
  plugins: [{
    name: 'wedding-dialogue-api',
    configureServer(server) {
      server.middlewares.use(weddingApi(loadEnv(mode, '.', '').OPENROUTER_API_KEY ?? ''));
    },
    configurePreviewServer(server) {
      server.middlewares.use(weddingApi(loadEnv(mode, '.', '').OPENROUTER_API_KEY ?? ''));
    },
  }],
  server: {
    host: "127.0.0.1",
    port: 5173,
  },
  build: {
    target: "es2022",
  },
}));
