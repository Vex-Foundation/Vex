import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@tools": resolve(__dirname, "src/tools"),
      "@utils": resolve(__dirname, "src/utils"),
      "@config": resolve(__dirname, "src/config"),
      "@vex-agent": resolve(__dirname, "src/vex-agent"),
    },
  },
  test: {
    // Limit concurrent transforms so dynamic SDK loading does not starve the
    // short-lived lexical/evaluation tests under a full repository run.
    maxWorkers: Number.parseInt(process.env.VEX_VITEST_MAX_WORKERS ?? "4", 10) || 4,
    include: [
      "src/__tests__/**/*.test.ts",
      "src/tools/solana-ecosystem/jupiter/__tests__/**/*.test.ts",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/__tests__/integration/**",
    ],
    globals: false,
    environment: "node",
    setupFiles: ["src/__tests__/setup.ts"],
    testTimeout: 10000,
  },
});
