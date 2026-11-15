// The site: React (web/src), built to dist/site, which the Worker
// serves as static assets (wrangler.jsonc → assets.directory). `npm run dev:web` runs Vite against an API on
// localhost:8790: `npm run dev:example` (the fictional family) or `wrangler dev --port 8790` (your D1).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const api = process.env.FT_API || "http://localhost:8790";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: { outDir: fileURLToPath(new URL("../dist/site", import.meta.url)), emptyOutDir: true, sourcemap: true },
  server: { port: 5173, proxy: { "/api": api, "/media": api } },
});
