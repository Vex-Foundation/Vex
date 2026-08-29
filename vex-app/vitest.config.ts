import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Two projects so renderer component tests run under jsdom while main /
 * shared / preload unit tests stay in pure node — keeps the existing
 * suite fast and avoids accidental DOM globals in main-process code.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
      "@vex-lib": path.resolve(__dirname, "../src/lib"),
      "@vex-agent": path.resolve(__dirname, "../src/vex-agent"),
      "@tools": path.resolve(__dirname, "../src/tools"),
      "@utils": path.resolve(__dirname, "../src/utils"),
      "@config": path.resolve(__dirname, "../src/config"),
      "@": path.resolve(__dirname, "src/renderer"),
    },
  },
  test: {
    /**
     * 15s instead of vitest's 5s default (UIUX round 2, 2026-08-21).
     *
     * Reason, measured not guessed: on the WSL2 drvfs mount this repo lives
     * on, a FULL parallel `vitest run` intermittently times out ~7 files
     * under `features/appShell/__tests__/AppShell/*` at exactly 5000ms; the
     * same files pass 113/113 in isolation and a second full run is green.
     * The cost is transform-time I/O contention across workers, not a
     * product race, so a per-suite timeout would only chase the symptom
     * from file to file as the suite grows.
     *
     * This raises the CEILING for a hung test; it does not slow a passing
     * one and it weakens no assertion. A genuine deadlock still fails, just
     * 10s later. Per-test `{ timeout: ... }` overrides (e.g. the 60s
     * design-guard I/O budget) still win over this default.
     */
    testTimeout: 15_000,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          globals: true,
          include: [
            "src/main/**/__tests__/**/*.test.ts",
            "src/preload/**/__tests__/**/*.test.ts",
            "src/shared/**/__tests__/**/*.test.ts",
          ],
          /**
           * `*.int.test.ts` needs a real PostgreSQL with every migration
           * applied, and this config starts none. Those files belong to the
           * repository's `test:studio-postgres` lane, which owns the
           * container; running them here would fail on a missing database
           * rather than on the behaviour they assert.
           */
          exclude: ["**/node_modules/**", "**/dist/**", "**/*.int.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "jsdom",
          globals: true,
          include: [
            "src/renderer/**/__tests__/**/*.test.ts",
            "src/renderer/**/__tests__/**/*.test.tsx",
          ],
          setupFiles: [path.resolve(__dirname, "src/renderer/test/setup.ts")],
        },
      },
    ],
  },
});
