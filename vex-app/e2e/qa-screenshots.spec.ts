/**
 * F6 both-themes screenshot QA pass - evidence for the owner's eyes-on
 * calibration review, NOT a CI gate. Runs only when VEX_QA_SHOTS=1 and
 * expects a build made with VITE_VEX_SETUP_TOUR=1 (the tour is the only
 * sanctioned way to reach the shell without a live Docker runtime).
 *
 * Captures per theme (chronos, then celeris via the Appearance cube +
 * reload for the gate): gate mid-choreography, SystemCheck, shell welcome
 * (hero + composer + book), Settings/Appearance.
 */

import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures/electron-app.js";

const QA_DIR = process.env.VEX_QA_DIR ?? "";

function shotPath(theme: "chronos" | "celeris", name: string): string {
  const dir = path.join(QA_DIR, theme);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

test.skip(
  process.env.VEX_QA_SHOTS !== "1" || QA_DIR === "",
  "QA screenshot pass runs only with VEX_QA_SHOTS=1 and VEX_QA_DIR set",
);

test("captures both-theme screenshot evidence for the owner's eyes-on pass", async ({
  vexApp,
}) => {
  test.setTimeout(180_000);
  const { firstWindow: page } = vexApp;
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });

  // --- chronos: gate choreography (act III window) + SystemCheck.
  await expect(page.locator('[data-vex-screen="chronos-gate"]')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shotPath("chronos", "gate-act3") });
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath("chronos", "systemcheck") });

  // --- tour jump to the shell (welcome stage).
  const tour = page.locator("[data-vex-setup-tour]");
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: "appShell", exact: true }).click();
  await expect(page.locator('[data-vex-screen="appShell"]')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shotPath("chronos", "welcome-shell") });

  // --- Settings via the sidebar profile menu. The dev tour panel (z-70,
  // bottom-left) overlaps the profile row, so hide it for the click - it is
  // QA scaffolding, not a shipped surface.
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.display = "none";
  });
  await page.getByRole("button", { name: /Open menu/ }).click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await expect(page.locator("[data-vex-settings-preferences]")).toBeVisible();
  await page
    .locator("[data-vex-settings-appearance]")
    .scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: shotPath("chronos", "settings-appearance") });

  // --- switch to celeris and re-capture the shell set.
  await page.locator('[data-vex-theme-cube="celeris"]').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: shotPath("celeris", "settings-appearance") });
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-vex-screen="appShell"]')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: shotPath("celeris", "welcome-shell") });

  // --- celeris boot surfaces: the persisted preference survives reload,
  // so a fresh boot replays the gate under the light theme.
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator('[data-vex-screen="chronos-gate"]')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shotPath("celeris", "gate-act3") });
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: shotPath("celeris", "systemcheck") });
});
