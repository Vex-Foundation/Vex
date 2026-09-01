/// <reference types="vitest/config" />
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build target for the Vex Studio pty host (`src/pty-host` -> `dist/pty-host`).
 *
 * Mirrors `vite.main.config.ts` because the pty host runs in the SAME runtime
 * class - an Electron `utilityProcess` is a Node process, not a browser - and
 * the same resolution hazards apply: without Node conditions and
 * `platform: "node"`, Vite substitutes browser variants and rolldown emits a
 * throwing `__require` shim for transitive CJS.
 *
 * It is a SEPARATE config rather than a second entry on the main build because
 * the two produce independently launched processes with different lifetimes,
 * different externals and different packaging entries. Sharing one `lib.entry`
 * would emit shared chunks across a process boundary.
 */
const bareNodeBuiltins = builtinModules.filter(
  (name) => !name.startsWith("node:"),
);

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@vex-lib": path.resolve(__dirname, "../src/lib"),
    },
    conditions: ["module", "node", "development|production"],
    mainFields: ["module", "jsnext:main", "jsnext", "main"],
  },
  build: {
    outDir: path.resolve(__dirname, "dist/pty-host"),
    // Same `--watch` rule as the main build: emptying the directory races the
    // dev launcher, which waits on the emitted entry file.
    emptyOutDir: !process.argv.includes("--watch"),
    target: "node22",
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, "src/pty-host/index.ts"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rolldownOptions: {
      platform: "node",
      external: [
        ...bareNodeBuiltins,
        /^node:/,
        // NEVER bundle node-pty. It is a native module: its JS loader resolves
        // `prebuilds/<platform>-<arch>/pty.node` RELATIVE to its own location
        // inside node_modules, and on macOS it spawns the sibling
        // `spawn-helper` binary by the same relative path. Inlining the loader
        // into dist/pty-host/index.js breaks both lookups. It stays external
        // and is loaded from the asarUnpack'd node_modules at runtime.
        "node-pty",
        "@xterm/headless",
        "electron",
        "electron-log",
        "electron-log/main",
        "electron-log/main.js",
      ],
      output: {
        format: "esm",
        entryFileNames: "[name].js",
      },
    },
  },
});
