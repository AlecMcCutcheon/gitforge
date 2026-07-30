import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Relative base so a Freenet website publish can host under any contract path.
  base: "./",
  resolve: {
    alias: {
      "@gitforge/linguist": path.resolve(
        rootDir,
        "../freenet-linguist/src/index.ts",
      ),
      "@gitforge/licensee": path.resolve(
        rootDir,
        "../freenet-licensee/src/index.ts",
      ),
    },
  },
  // OLD CODE - KEEP UNTIL CONFIRMED WORKING
  // Local Vite :5173 + proxy to Express :8787 — retired; test via
  // `npm run publish:website` against the Freenet node instead.
  // server: {
  //   port: 5173,
  //   proxy: {
  //     "/api": {
  //       target: "http://127.0.0.1:8787",
  //       changeOrigin: true,
  //     },
  //   },
  // },
  // preview: { port: 5173 },
  appType: "spa",
});
