/**
 * Screenshot QA pass - evidence for the owner's eyes-on calibration review,
 * NOT a CI gate. Runs only when VEX_QA_SHOTS=1 and
 * expects a build made with VITE_VEX_SETUP_TOUR=1 (the tour is the only
 * sanctioned way to reach the shell and the unlock screen without a running
 * local runtime).
 *
 * Round 2 (2026-08-21) widened the set to every pre-shell screen, captured
 * per theme. Since plan row S1-04 the app is dark only
 * (docs/design/H3-DESKTOP.md section 4.5): Celeris and the Appearance row
 * are retired, so the set is captured once, in the one theme, which each pass
 * asserts rather than picks:
 *
 *   gate-act3            the gate's resting frame on the stage print
 *   systemcheck          the themed pre-shell system/port screen
 *   unlock-empty         armed CTA at rest (the label box on the print)
 *   unlock-typed         armed CTA filled blue after the first keystroke
 *   unlock-error         the failed-unlock callout + the
 *                        "Open logs folder" link
 *   welcome-shell        hero + composer + rail + starter pills
 *
 * The unlock error is produced by submitting a wrong password of legal
 * length against the spec's own throwaway config dir: the vault is not
 * configured there, so the bridge returns a real error and the real error
 * branch renders. No secret and no real vault is involved.
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect, type VexElectronFixture } from "./fixtures/electron-app.js";
import type { Page } from "@playwright/test";

const QA_DIR = process.env.VEX_QA_DIR ?? "";

/** The app's one theme (dark only, S1-04); the shots keep its folder. */
const THEME = "chronos";

function shotPath(name: string): string {
  const dir = path.join(QA_DIR, THEME);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

/**
 * Screenshot with the dev tour navigator hidden. The panel is QA
 * scaffolding docked bottom-left (z-70), never a shipped surface, so it
 * must not appear in evidence the owner calibrates against.
 */
async function shot(page: Page, name: string): Promise<void> {
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.visibility = "hidden";
  });
  await page.screenshot({ path: shotPath(name) });
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.visibility = "";
  });
}

/** Jump to a pre-shell/shell view through the dev tour navigator. */
async function tourTo(page: Page, view: string): Promise<void> {
  const tour = page.locator("[data-vex-setup-tour]");
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: view, exact: true }).click();
  await expect(page.locator(`[data-vex-screen="${view}"]`)).toBeVisible();
}

/** The document root carries the app's one theme; there is none to pick. */
async function expectTheOneTheme(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-vex-theme", THEME);
}

/** The unlock triptych: at rest, armed, and after a failed attempt. */
async function captureUnlock(page: Page): Promise<void> {
  await tourTo(page, "unlock");
  await page.waitForTimeout(900); // the vex-rise entrance settles
  await shot(page, "unlock-empty");

  const field = page.locator("#vex-unlock-password");
  await field.fill("not-the-real-password");
  await page.waitForTimeout(400); // the 150ms armed colour transition
  await shot(page, "unlock-typed");

  await page.getByRole("button", { name: /^Unlock/ }).click();
  // Either branch is legitimate evidence: a rejected attempt (danger rail
  // + Open logs folder) or a throttle window (warning rail + countdown).
  await expect(page.locator('[role="alert"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(300);
  await shot(page, "unlock-error");
}

test.skip(
  process.env.VEX_QA_SHOTS !== "1" || QA_DIR === "",
  "QA screenshot pass runs only with VEX_QA_SHOTS=1 and VEX_QA_DIR set",
);

test("captures the one theme's screenshot evidence for the owner's eyes-on pass", async ({
  vexApp,
}: {
  vexApp: VexElectronFixture;
}) => {
  test.setTimeout(600_000);
  const { firstWindow: page } = vexApp;
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Cold open: gate, then the first-run handoff to SystemCheck, already in
  // the one theme.
  await expect(page.locator('[data-vex-screen="chronos-gate"]')).toBeVisible();
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  await expectTheOneTheme(page);

  await tourTo(page, "appShell");
  await page.waitForTimeout(1200);
  await expectTheOneTheme(page);
  await shot(page, "welcome-shell");

  await captureUnlock(page);

  await tourTo(page, "systemCheck");
  await page.waitForTimeout(800);
  await shot(page, "systemcheck");

  // A real cold open: the gate and the first paint after it carry the one
  // theme too.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-vex-screen="chronos-gate"]')).toBeVisible();
  await expectTheOneTheme(page);
  await page.waitForTimeout(1500);
  await shot(page, "gate-act3");
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  await page.waitForTimeout(600);
  await shot(page, "systemcheck-boot");
});
