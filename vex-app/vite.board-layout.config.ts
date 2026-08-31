/// <reference types="vite/client" />
/**
 * BOARD LAYOUT HARNESS - the dev server the board geometry spec drives.
 *
 * WHY A SECOND CONFIG AND NOT THE ELECTRON SMOKE APP. The board modal is
 * unreachable from `e2e/smoke.spec.ts`: that fixture launches the built app
 * against a throwaway config dir and, by its own head note, stops at
 * SystemCheck because everything past it needs a real Docker daemon, a
 * migrated Postgres and an unlocked vault. Geometry, however, is decided
 * entirely by the renderer's own CSS - the container queries in
 * `global-css/board-layout.css` - so it can be proven in a real Chromium at
 * real widths with the real production stylesheet, and that is what this
 * config serves.
 *
 * IT NEVER TOUCHES THE SHIPPED BUNDLE. `vite.renderer.config.ts` still has
 * exactly one rollup input (`src/renderer/index.html`); the harness entry is
 * a separate root that only this config and only `playwright.config.ts` know
 * about, so no harness byte can reach a packaged build.
 *
 * The plugins, the aliases and the imported `styles/globals.css` are the
 * renderer's own, because a harness that compiled a different stylesheet
 * would prove a layout the product does not have.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(dirname, "src/renderer/dev/board-layout");

export default defineConfig({
  root: harnessRoot,
  appType: "spa",
  base: "/",
  envDir: dirname,
  envPrefix: "VITE_",
  // The renderer's OWN public dir: the display font is served from it, and a
  // harness that fell back to a system font would measure text the product
  // never renders.
  publicDir: path.resolve(dirname, "src/renderer/public"),

  define: {
    __VEX_APP_VERSION__: JSON.stringify("board-layout-harness"),
  },

  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(dirname, "src/renderer"),
      "@shared": path.resolve(dirname, "src/shared"),
      "@vex-lib": path.resolve(dirname, "../src/lib"),
    },
  },

  server: {
    host: "127.0.0.1",
    port: 5273,
    strictPort: true,
  },
});
