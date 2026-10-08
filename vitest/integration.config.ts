import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");

export default defineConfig({
  root,
  resolve: {
    alias: {
      // Root-side tests and app imports must share the actual Electron module identity.
      electron: resolve(root, "vex-app/node_modules/electron"),
      "@tools": resolve(root, "src/tools"),
      "@utils": resolve(root, "src/utils"),
      "@config": resolve(root, "src/config"),
      "@vex-agent": resolve(root, "src/vex-agent"),
      "@shared": resolve(root, "vex-app/src/shared"),
      "@vex-lib": resolve(root, "src/lib"),
    },
  },
  test: {
    include: [
      "src/__tests__/integration/**/*.int.test.ts",
      // This existing suite also needs the isolated PostgreSQL and embeddings setup.
      "src/__tests__/integration/memory/long-mission.test.ts",
    ],
    globals: false,
    environment: "node",
    globalSetup: ["src/__tests__/integration/setup/globalSetup.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Serialize EVERYTHING — one Postgres, one worker, one file at a time.
    // `fileParallelism: false` stops separate files from racing each other's
    // `resetDb`; `maxWorkers/minWorkers: 1` forces a single worker regardless
    // of pool choice (flat config per Vitest 4's `poolOptions` rework).
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
