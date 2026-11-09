/// <reference types="vite/client" />
/**
 * H3 SHELL HARNESS - the dev server that renders the real shell in fixed states.
 *
 * WHY A SECOND ROOT AND NOT THE ELECTRON APP. The built app stops at
 * SystemCheck without a running local runtime and an unlocked vault
 * (`e2e/smoke.spec.ts`), and the setup tour only reaches the welcome, so a
 * waiting swap card, a live turn or a filled receipt cannot be put on screen on
 * demand. Everything the H3 revamp has to look at and measure - the columns,
 * the header and bottom rows, the card's box - is decided by the renderer's own
 * components over the renderer's own stylesheet, so it can be rendered in a
 * real Chromium at real window sizes with the process boundary stood in for,
 * and that is what this config serves (`src/renderer/dev/h3-shell/`).
 *
 * IT NEVER TOUCHES THE SHIPPED BUNDLE. `vite.renderer.config.ts` builds exactly
 * its listed HTML inputs (`index.html` and the two terminal consent pages); the
 * harness is a separate root that only this config and only
 * `playwright.config.ts` know about. `scripts/check-build-artifacts.mjs` then
 * proves it: a production build that carries any harness file, fixture or
 * stand-in art into `dist/` fails the build.
 *
 * The plugins, the aliases, the public dir and the imported
 * `styles/globals.css` are the renderer's own, as in
 * `vite.board-layout.config.ts`: a harness that compiled a different
 * stylesheet, or fell back to a system font, would show a shell the product
 * does not have. The one thing this root adds is the renderer's
 * `optimizeDeps` pre-bundle, because the shell pulls `marked` in through the
 * transcript and a cold optimizer pass mid-load reloads the page under a
 * running spec, and the server keeps an idle connection open (below).
 *
 * Port 5274, beside the board layout harness on 5273, so both can be served
 * at once and Playwright can start each on demand.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(dirname, "src/renderer/dev/h3-shell");

/**
 * IDLE CONNECTIONS STAY OPEN. The harness specs fetch every request of the
 * page from Node and fulfil it into the browser (`e2e/h3-harness-load.ts`:
 * a request waiting in Chromium's socket pool is failed whenever the
 * machine's network configuration changes). Node's client keeps its sockets
 * alive and reuses them, and Node's server closes a socket idle for 5
 * seconds: a reuse that meets that close is a `read ECONNRESET` on a module
 * request, and a module graph that fails for good. With no idle timeout the
 * server never closes under the client; the client closes its own sockets.
 */
function keepIdleConnections(): Plugin {
  return {
    name: "vex-h3-keep-idle-connections",
    configureServer(server) {
      const http = server.httpServer;
      if (http !== null && "keepAliveTimeout" in http) http.keepAliveTimeout = 0;
    },
  };
}

export default defineConfig({
  root: harnessRoot,
  appType: "spa",
  base: "/",
  envDir: dirname,
  envPrefix: "VITE_",
  // The renderer's OWN public dir: the fonts, the pixel art and the protocol
  // marks are served from it exactly as the packaged app serves them.
  publicDir: path.resolve(dirname, "src/renderer/public"),
  // Its own dependency cache. The board layout harness starts beside it on
  // every Playwright run, and with one shared `node_modules/.vite` each
  // server threw the other's optimized deps away on start ("vite config has
  // changed"), which can leave a first load answered with 504s.
  cacheDir: path.resolve(dirname, "node_modules/.vite-h3-shell"),

  define: {
    __VEX_APP_VERSION__: JSON.stringify("h3-shell-harness"),
  },

  optimizeDeps: {
    include: ["marked"],
  },

  plugins: [react(), tailwindcss(), keepIdleConnections()],

  resolve: {
    alias: {
      "@": path.resolve(dirname, "src/renderer"),
      "@shared": path.resolve(dirname, "src/shared"),
      "@vex-lib": path.resolve(dirname, "../src/lib"),
    },
  },

  server: {
    host: "127.0.0.1",
    port: 5274,
    strictPort: true,
  },
});
