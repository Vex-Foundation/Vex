/**
 * Both-themes screenshot QA pass - evidence for the owner's eyes-on
 * calibration review, NOT a CI gate. Runs only when VEX_QA_SHOTS=1 and
 * expects a build made with VITE_VEX_SETUP_TOUR=1 (the tour is the only
 * sanctioned way to reach the shell and the unlock screen without a live
 * Docker runtime).
 *
 * Round 2 (2026-08-21) widened the set. The headline fix of the round is
 * that everything AFTER the Chronos Gate follows the active theme, so the
 * pre-shell stages are now captured per theme, not once:
 *
 *   gate-act3            the invariant brand moment (identical in both
 *                        themes by design - captured in both to prove it)
 *   systemcheck          the themed pre-shell system/port screen
 *   unlock-empty         armed CTA at rest (quiet outline capsule)
 *   unlock-typed         armed CTA inverted after the first keystroke
 *   unlock-error         the failed-unlock rail + the restyled
 *                        "Open logs folder" link (settles the owner's
 *                        "red Doto underline" report)
 *   welcome-shell        hero + composer + rail + starter pills
 *   settings-appearance  the theme picker itself
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

type Theme = "chronos" | "celeris";
const THEMES: readonly Theme[] = ["chronos", "celeris"];

function shotPath(theme: Theme, name: string): string {
  const dir = path.join(QA_DIR, theme);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

/**
 * Screenshot with the dev tour navigator hidden. The panel is QA
 * scaffolding docked bottom-left (z-70), never a shipped surface, so it
 * must not appear in evidence the owner calibrates against.
 */
async function shot(page: Page, theme: Theme, name: string): Promise<void> {
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.visibility = "hidden";
  });
  await page.screenshot({ path: shotPath(theme, name) });
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

/** Open Settings from the shell, pick a theme, capture, and close. */
async function pickTheme(page: Page, theme: Theme): Promise<void> {
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.display = "none";
  });
  await page.getByRole("button", { name: /Open menu/ }).click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await expect(page.locator("[data-vex-settings-preferences]")).toBeVisible();
  await page.locator("[data-vex-settings-appearance]").scrollIntoViewIfNeeded();
  await page.locator(`[data-vex-theme-cube="${theme}"]`).click();
  await page.waitForTimeout(500);
  await expect(page.locator("html")).toHaveAttribute("data-vex-theme", theme);
  await page.screenshot({ path: shotPath(theme, "settings-appearance") });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-vex-screen="appShell"]')).toBeVisible();
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.display = "";
  });
}

/** The unlock triptych: at rest, armed, and after a failed attempt. */
async function captureUnlock(page: Page, theme: Theme): Promise<void> {
  await tourTo(page, "unlock");
  await page.waitForTimeout(900); // the vex-rise entrance settles
  await shot(page, theme, "unlock-empty");

  const field = page.locator("#vex-unlock-password");
  await field.fill("not-the-real-password");
  await page.waitForTimeout(400); // the 150ms armed colour transition
  await shot(page, theme, "unlock-typed");

  await page.getByRole("button", { name: /^Unlock/ }).click();
  // Either branch is legitimate evidence: a rejected attempt (danger rail
  // + Open logs folder) or a throttle window (warning rail + countdown).
  await expect(page.locator('[role="alert"]').first()).toBeVisible({
    timeout: 20_000,
  });
  await page.waitForTimeout(300);
  await shot(page, theme, "unlock-error");
}

test.skip(
  process.env.VEX_QA_SHOTS !== "1" || QA_DIR === "",
  "QA screenshot pass runs only with VEX_QA_SHOTS=1 and VEX_QA_DIR set",
);

test("captures both-theme screenshot evidence for the owner's eyes-on pass", async ({
  vexApp,
}: {
  vexApp: VexElectronFixture;
}) => {
  test.setTimeout(600_000);
  const { firstWindow: page } = vexApp;
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Cold open: gate, then the first-run handoff to SystemCheck. The theme
  // preference at this point is the un-migrated default (`system`), so the
  // gate/systemCheck pair is re-captured per theme below rather than here.
  await expect(page.locator('[data-vex-screen="chronos-gate"]')).toBeVisible();
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();

  for (const theme of THEMES) {
    // The theme picker lives in the shell, so every pass starts there.
    await tourTo(page, "appShell");
    await page.waitForTimeout(1200);
    await pickTheme(page, theme);

    await page.waitForTimeout(1200);
    await shot(page, theme, "welcome-shell");

    await captureUnlock(page, theme);

    await tourTo(page, "systemCheck");
    await page.waitForTimeout(800);
    await shot(page, theme, "systemcheck");

    // A real cold open under the now-persisted preference: proves the gate
    // is theme-invariant and that first paint after it is themed.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-vex-screen="chronos-gate"]')).toBeVisible();
    await page.waitForTimeout(1500);
    await shot(page, theme, "gate-act3");
    await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
    await page.waitForTimeout(600);
    await shot(page, theme, "systemcheck-boot");
  }
});
