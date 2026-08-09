import react from "@vitejs/plugin-react";
// vitest's defineConfig, not vite's -- vite's UserConfig has no `test` key.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Dev only. In production the built assets are served by FastAPI from the
  // same origin, so there's no proxy and no CORS.
  server: {
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
