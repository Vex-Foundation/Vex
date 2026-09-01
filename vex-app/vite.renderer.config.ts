/// <reference types="vitest/config" />
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(__dirname, "src/renderer");

// JSON read instead of `import pkg from "./package.json" assert {...}` —
// import-assert syntax has drifted between TS/Node versions; readFileSync
// is stable and the renderer config already uses node:url / node:path.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { readonly version: string };

/**
 * Production CSP is strict (skill §7). Vite's dev server injects HMR
 * styles as dynamically-created <style> elements and uses eval() in the
 * HMR client — both of which strict CSP blocks. Skill §7 explicitly
 * allows dev relaxations on 127.0.0.1:5173.
 *
 * This plugin rewrites the <meta http-equiv="Content-Security-Policy">
 * tag in `serve` (dev) mode only. The `build` output keeps the strict
 * CSP from index.html verbatim, so the postbuild check
 * (`scripts/check-build-artifacts.mjs` — gate #3) still asserts no
 * `'unsafe-inline'` / `'unsafe-eval'` in production artifacts.
 */
function devCspRelaxer(isDev: boolean): Plugin {
  const DEV_CSP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // img-src intentionally widened to https: for agent-surfaced token logos
    // (Option A2). script-src/connect-src stay strict — kept in sync with the
    // prod CSP in src/renderer/index.html.
    "img-src 'self' data: https:",
    "font-src 'self'",
    "connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173",
    // Kept in step with the prod CSP: the Studio viewer's shiki worker needs
    // this in dev too, and a dev session that silently lost highlighting would
    // be debugged as a code bug rather than as a policy one.
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");

  return {
    name: "vex-dev-csp-relaxer",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!isDev) return html;
        const replaced = html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]+"\s*\/?>/i,
          `<meta http-equiv="Content-Security-Policy" content="${DEV_CSP}" />`
        );
        // Fail-fast: if the regex did not match (markup format changed), the
        // dev session would silently inherit the strict CSP and Tailwind
        // utilities would be blocked again. Better to crash the dev server
        // than ship a confusingly-broken UI.
        if (replaced === html) {
          throw new Error(
            "[vex-dev-csp-relaxer] could not find <meta http-equiv=\"Content-Security-Policy\" ...> in index.html — dev CSP relax not applied. Check src/renderer/index.html for format drift."
          );
        }
        return replaced;
      },
    },
  };
}

export default defineConfig(({ command }) => ({
  root: rendererRoot,
  appType: "spa",
  base: command === "serve" ? "/" : "./",
  envDir: __dirname,
  envPrefix: "VITE_",
  publicDir: path.resolve(rendererRoot, "public"),

  define: {
    // Stamped at build time straight from package.json `version` — the same
    // mechanism for dev and packaged builds (main uses app.getVersion(), which
    // reads the same field). Nothing appends a dev suffix: the current
    // `-dev` prerelease IS the package.json version on development trees and
    // must be bumped as part of the release cut (release-track), together
    // with the signed/publish electron-builder profile.
    __VEX_APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Pre-bundle renderer deps that the dev server should optimize BEFORE it
  // reports ready, so the first client (Electron) doesn't hit the page mid
  // re-optimize and abort the initial loadURL. `marked` (stage 8-2a markdown)
  // triggered exactly this cold-start optimizer race.
  optimizeDeps: {
    include: ["marked"],
  },

  plugins: [
    react(),
    tailwindcss(),
    devCspRelaxer(command === "serve"),
  ],

  resolve: {
    alias: {
      "@": rendererRoot,
      "@shared": path.resolve(__dirname, "src/shared"),
      "@vex-lib": path.resolve(__dirname, "../src/lib"),
    },
  },

  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    hmr: {
      host: "127.0.0.1",
      port: 5173,
      clientPort: 5173,
      overlay: true,
    },
  },

  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },

  /**
   * Worker bundling for the Studio file viewer's shiki tokenizer.
   *
   * `format: "es"` because the worker is created with `{ type: "module" }` and
   * loads its grammars with dynamic `import()`. Vite's own default here is
   * `iife`, which has no `import()` at all, so the grammar loaders would fail
   * at runtime and every file would render as plain text with a reason - a
   * degradation that is honest but entirely avoidable.
   *
   * `rolldownOptions`, not `rollupOptions`: this Vite (8.0.11) bundles rolldown
   * and its own types mark `worker.rollupOptions` as a deprecated alias of
   * `worker.rolldownOptions` (node_modules/vite/dist/node/index.d.ts). The
   * hashed name is what `scripts/check-build-artifacts.mjs` looks for in
   * `dist/renderer/assets/`.
   */
  worker: {
    format: "es",
    rolldownOptions: {
      output: { entryFileNames: "assets/[name]-[hash].js" },
    },
  },

  build: {
    outDir: path.resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    sourcemap: command === "serve",
    target: "es2024",
    assetsInlineLimit: 0,
    rollupOptions: {
      input: path.resolve(rendererRoot, "index.html"),
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [path.resolve(rendererRoot, "test/setup.ts")],
  },
}));
