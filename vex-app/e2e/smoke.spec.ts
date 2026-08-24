/**
 * PR4 boot smoke — single spec that proves the whole
 * main↔preload↔renderer triangle works against the *built* Electron
 * bundle.
 *
 * What we assert (and why this is enough for a smoke):
 *   1. Electron launches without crashing.
 *   2. The first window opens within the fixture's launch timeout.
 *   3. `window.vex` is bridged through preload (proves the
 *      contextBridge boundary is intact).
 *   4. `window.vex.system.health` is a callable function (proves the
 *      bridged surface matches the `VexBridge` contract — if the
 *      preload `satisfies VexBridge` check ever drifts, this catches
 *      it).
 *   5. The Chronos Gate boot overlay renders first, its orchestrator
 *      runs the launch probes, and — because the per-spec CONFIG_DIR is
 *      fresh (first run, `setupCompleteFlag === false`) — it hands off
 *      to the SystemCheck view with NO user interaction (proves the
 *      Zustand uiStore + the setup orchestrator run in the renderer).
 *      The first-run handoff deliberately never auto-starts compose,
 *      so this assertion stays deterministic on CI runners that DO
 *      have a Docker daemon.
 *
 * What we INTENTIONALLY do NOT assert:
 *   - Anything past SystemCheck. Docker bootstrap, compose up,
 *     migrations, wizard, unlock — all of those require either a
 *     real Docker daemon or a bypass hook that doesn't exist yet
 *     (Codex S2 turn 2). A real E2E for those screens is a separate
 *     decision, tracked under #13 follow-ups + task #9.
 */

import path from "node:path";
import { test, expect } from "./fixtures/electron-app.js";

test("boots through the setup gate to SystemCheck with the bridged window.vex surface", async ({
  vexApp,
}) => {
  const { app, firstWindow, configDir } = vexApp;

  // 1. Per-spec config isolation actually took effect.
  // Verified via Electron's own `app.getPath("userData")`, which the
  // main process remaps to `CONFIG_DIR/.electron-state` after the
  // VEX_CONFIG_DIR override resolves CONFIG_DIR to our tmpdir.
  const userDataDir = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData"),
  );
  expect(userDataDir).toBe(path.join(configDir, ".electron-state"));

  // Wait for the renderer to finish loading before probing globals.
  // Electron's first window event fires before the preload script
  // has finished bridging contextBridge values; `waitForLoadState`
  // gives us a stable point to query.
  await firstWindow.waitForLoadState("domcontentloaded");

  // 2. contextBridge surface is bound.
  const bridgeShape = await firstWindow.evaluate(() => ({
    vexType: typeof (window as unknown as { vex?: unknown }).vex,
    healthType: typeof (
      window as unknown as { vex?: { system?: { health?: unknown } } }
    ).vex?.system?.health,
  }));
  expect(bridgeShape.vexType).toBe("object");
  expect(bridgeShape.healthType).toBe("function");

  // 3. The Chronos Gate cold-open renders first — but unlike the old
  // click-gated intro it self-dismisses once the probes resolve, so on a
  // fast runner the curtain may already have revealed SystemCheck by the
  // time this line runs. Accept either surface as the first paint to keep
  // the smoke deterministic (review lens finding, 2026-07-22); step 4
  // still pins the final SystemCheck state.
  await expect(
    firstWindow
      .locator(
        '[data-vex-screen="chronos-gate"], [data-vex-screen="systemCheck"]'
      )
      .first()
  ).toBeVisible();

  // 4. The orchestrator's probes resolve (system.health + docker.detect
  // + envState — real IPC, bounded by `expect.timeout: 15_000` from
  // playwright.config.ts; docker.detect's own subprocess timeout is 8s).
  // Fresh CONFIG_DIR ⇒ first run ⇒ the gate hands off to SystemCheck
  // and curtain-reveals it — no clicks, no Begin button anymore.
  await expect(
    firstWindow.locator('[data-vex-screen="systemCheck"]')
  ).toBeVisible();
});
