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
