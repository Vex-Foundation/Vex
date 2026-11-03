/**
 * Playwright config for Vex desktop smoke tests (PR4).
 *
 * Drives the *built* Electron app via `_electron.launch({ args: [<built main>] })`.
 * NOT a browser test — we never use a chromium binary directly; only
 * Playwright's system-library deps are needed in CI (`pnpm exec
 * playwright install-deps chromium`).
 *
 * On Linux CI the runner needs an X server; wrap the run with
 * `xvfb-run -a pnpm run test:e2e`.
 *
 * Workers are pinned to 1 because:
 *   - xvfb + Electron + WSL2 + parallel display servers = flake;
 *   - main-process global state (cancelRegistry, single-instance lock,
 *     etc.) is per-process and would collide across parallel launches.
 */

import { defineConfig } from "@playwright/test";

const isCI = process.env.CI === "true";

/**
 * The H3 shell harness server, started only when the H3 parity captures are
 * asked for. The captures are opt-in evidence (`e2e/h3-parity.spec.ts`), and
 * Playwright starts every listed web server for every run, so an
 * unconditional entry would add a second Vite boot to each electron smoke run
 * for a spec that then skips itself.
 */
const h3ShellServer =
  process.env.VEX_H3_SHOTS === "1"
    ? [
        {
          command: "pnpm exec vite --config vite.h3-shell.config.ts",
          url: "http://127.0.0.1:5274/",
          reuseExistingServer: !isCI,
          timeout: 120_000,
          stdout: "ignore" as const,
          stderr: "pipe" as const,
        },
      ]
    : [];

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: isCI ? 1 : 0,
  reporter: isCI
    ? [["list"], ["html", { open: "never" }], ["github"]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "./test-results",
  use: {
    trace: isCI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    video: "off",
  },
  // The board layout harness is a Vite dev server, not the Electron app, and
  // only the `board-layout` project uses it. Playwright starts it on demand
  // and reuses an already-running one locally. The H3 shell harness joins it
  // only for an H3 capture run (above).
  webServer: [
    {
      command: "pnpm exec vite --config vite.board-layout.config.ts",
      url: "http://127.0.0.1:5273/",
      reuseExistingServer: !isCI,
      timeout: 120_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    ...h3ShellServer,
  ],
  projects: [
    {
      name: "electron-smoke",
      testMatch: /.*\.spec\.ts$/,
      testIgnore: /(board-layout|h3-parity)\.spec\.ts$/,
    },
    /**
     * BOARD GEOMETRY, in a real engine at real widths.
     *
     * Chromium rather than Electron because the board modal is unreachable
     * from the Electron fixture (see `e2e/smoke.spec.ts`: everything past
     * SystemCheck needs a running local runtime and an unlocked vault), and
     * because geometry is decided entirely by the renderer's own container
     * queries over the real production stylesheet - which is exactly what
     * `vite.board-layout.config.ts` serves.
     */
    {
      name: "board-layout",
      testMatch: /board-layout\.spec\.ts$/,
      use: {
        browserName: "chromium",
        baseURL: "http://127.0.0.1:5273/",
      },
    },
    /**
     * H3 PARITY CAPTURES, the real shell in fixed states at five window sizes.
     *
     * Chromium for the same reason as the board project: the states are
     * unreachable from the Electron fixture, and what they show is decided by
     * the renderer's own components over the production stylesheet, which
     * `vite.h3-shell.config.ts` serves with only the preload bridge stood in
     * for. Opt-in: the spec skips itself unless VEX_H3_SHOTS=1.
     */
    {
      name: "h3-parity",
      testMatch: /h3-parity\.spec\.ts$/,
      timeout: 60_000,
      use: {
        browserName: "chromium",
        baseURL: "http://127.0.0.1:5274/",
      },
    },
  ],
});
