/// <reference types="vitest/config" />
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Bare Node built-in specifiers (e.g. `os`, `fs`, `http` — no `node:`
 * prefix). Third-party libraries like winston / `@colors/colors` still
 * import them this way; without listing them explicitly as external,
 * Vite's default browser-compat resolver replaces them with a
 * `__vite-browser-external` stub of `{}`, which crashes at runtime on
 * Windows the moment `@colors/colors` calls `os.release()`. The
 * `^node:` regex below covers the prefixed variants.
 */
const bareNodeBuiltins = builtinModules.filter(
  (name) => !name.startsWith("node:"),
);

export default defineConfig({
  // `conditions: ["node"]` + Node-preferred `mainFields` keep Vite from
  // selecting the `browser` package variants (e.g. `@dabh/diagnostics/browser`,
  // `readable-stream/*-browser`) that some transient deps ship alongside
  // their Node entrypoints. Without this, `target: "node22"` alone is not
  // enough — `target` only controls emitted JS syntax, not resolution.
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@vex-lib": path.resolve(__dirname, "../src/lib"),
      "@vex-agent": path.resolve(__dirname, "../src/vex-agent"),
      "@tools": path.resolve(__dirname, "../src/tools"),
      "@utils": path.resolve(__dirname, "../src/utils"),
      "@config": path.resolve(__dirname, "../src/config"),
    },
    // Mirror Vite's own Node/SSR condition set. `["node"]` alone works
    // for the current bundle but is narrower than what Vite uses for
    // SSR and may miss `module`/`development`/`production` exports
    // some packages ship. Codex turn 3 YELLOW.
    conditions: ["module", "node", "development|production"],
    mainFields: ["module", "jsnext:main", "jsnext", "main"],
  },
  // Rolldown inlines CJS deps that read bare `__filename` (@solana/spl-token →
  // buffer-layout-utils → bigint-buffer → bindings) into this ESM bundle, where
  // that identifier does not exist; `bindings.getFileName()` reads it from
  // INSIDE an `Error.prepareStackTrace` hook, so the ReferenceError escapes
  // through `dummy.stack` and the following line — the one that restores the
  // previous hook — never runs. `Error.prepareStackTrace` then stays poisoned
  // process-wide, so every later `error.stack` read in main throws and the app
  // logs "[ReferenceError: __filename is not defined]" instead of real errors.
  //
  // NEVER add `__dirname` here: main sources DECLARE `const __dirname = …`
  // (src/main/index.ts, src/main/database/migrate-runner.ts,
  // src/main/windows/main-window.ts) and a define would rewrite those
  // declaration sites into a syntax error. No source declares `__filename`.
  // Guarded by the postbuild gate in scripts/check-privileged-bundles.mjs.
  define: {
    __filename: "import.meta.filename",
  },
  build: {
    outDir: path.resolve(__dirname, "dist/main"),
    // In `--watch` (dev) the prebuilt index.js must survive watcher startup:
    // emptying the dir here races dev:electron, which launches the moment the
    // renderer is up and dies on a missing dist/main/index.js.
    emptyOutDir: !process.argv.includes("--watch"),
    target: "node22",
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, "src/main/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    // Rolldown's `platform: "node"` is the DOCUMENTED fix for CJS deps
    // bundled into ESM main. Without it, rolldown emits a throwing
    // `__require` shim that crashes at startup on `require("buffer")`
    // / `require("crypto")` / etc. — these calls come from transitive
    // CJS deps (safe-buffer, secp256k1, bn.js, viem internals) that
    // we cannot rewrite.
    //
    // With platform="node", rolldown emits:
    //   import { createRequire } from "node:module";
    //   const __require = createRequire(import.meta.url);
    // …which routes `require("buffer")` to Node's real CJS resolver.
    // (Verified via in-memory Vite build + rolldown docs.)
    //
    // `rolldownOptions` is the Vite 8 native name; `rollupOptions`
    // remains as a deprecated alias.
    rolldownOptions: {
      platform: "node",
      external: [
        ...bareNodeBuiltins,
        /^node:/,
        "electron",
        // NEVER bundle @parcel/watcher. It is a native module: its JS loader
        // dlopens `watcher.node` out of a per-platform sibling package resolved
        // relative to its own file location, and inlining that loader into
        // dist/main/index.js breaks the lookup. It stays external and ships
        // unpacked - electron-builder.release.yml already carries the
        // asarUnpack and files entries for it.
        "@parcel/watcher",
        "electron-log",
        "electron-log/main",
        "electron-log/main.js",
        "electron-updater",
        "@sentry/electron/main",
      ],
      output: {
        format: "esm",
        entryFileNames: "[name].js",
        // The main process keeps the lazy internal-tool loader map in memory.
        // Content-hashed dynamic chunks make a clean rebuild delete the chunk
        // names that a still-running Electron process will resolve later. Keep
        // chunk paths stable so a rebuilt main bundle cannot strand read-only
        // tools such as WalletBalances or the Lighter onboarding shortcuts.
        chunkFileNames: "[name].js",
      },
    },
  },
});
