import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// dice: one client-only SPA carrying both the site and the studio. MediaPipe
// WASM lives in public/wasm (copied at install time by scripts/copy-wasm.mjs)
// and the hand model in public/models.
//
// Generated backing comes from the dice engine, a local FastAPI service. To
// avoid CORS in dev, browser calls to "/engine/..." are proxied to it. The
// client uses VITE_DICE_ENGINE_URL if set, otherwise this proxy path.
const ENGINE_TARGET = "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    target: "es2020",
  },
  server: {
    // 5180, clear of the other projects in this folder that already sit on
    // 5173 and 5174, so dice can run alongside them.
    port: 5180,
    proxy: {
      "/engine": {
        target: ENGINE_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/engine/, ""),
      },
    },
  },
});
