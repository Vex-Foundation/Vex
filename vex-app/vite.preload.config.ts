import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@vex-lib": path.resolve(__dirname, "../src/lib"),
    },
  },
  build: {
    outDir: path.resolve(__dirname, "dist/preload"),
    // Same race as vite.main.config.ts: keep the prebuilt bundle while the
    // dev watcher starts, so the window never loads a missing preload.
    emptyOutDir: !process.argv.includes("--watch"),
    target: "node22",
    sourcemap: true,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, "src/preload/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.cjs",
    },
    rollupOptions: {
      external: ["electron"],
      output: {
        format: "cjs",
        entryFileNames: "index.cjs",
      },
    },
  },
});
