/**
 * The Studio terminal on GLASS, measured in the built app.
 *
 * ## Why a built-app spec and not a fixture test
 *
 * jsdom resolves no cascade, paints no backdrop-filter and has no WebGL, so the
 * three claims the glass pane makes are provable only here:
 *
 *  - THE BACKDROP SHOWS THROUGH THE TERMINAL. The pane is a `.vex-glass-pane`
 *    and the xterm canvas keeps `allowTransparency` with an alpha-0 background,
 *    so what a screenshot of the pane shows is the wallpaper, blurred and
 *    tinted, under the text. The evidence is the screenshot itself plus a
 *    pixel read: the pane's blank region is NOT the opaque `surface-1` the card
 *    used to paint.
 *  - THE GUTTER. The distance from the studio sidebar's right edge to the first
 *    terminal column is a layout fact (the TERM lane measured the xterm grid as
 *    flush left, so the strip the owner circled in 11.png is the column and
 *    pane padding). It is read at 1920 and 1280 wide and written to the
 *    measurement file, so before/after a padding change is a number, not a
 *    feeling.
 *  - SCROLL THROUGHPUT. Glass under a WebGL canvas costs a backdrop-filter
 *    pass per frame; whether that is visible is measured as frames per second
 *    while a 30 000-line burst lands and while the scrollback is wheeled, and
 *    written next to the gutter numbers for the same before/after comparison.
 *  - THE ANSWER TO OSC 11. xterm tells a program that asks for the background
 *    colour whatever `theme.background` says, alpha dropped, and Claude Code
 *    (in `auto`), bat, delta and nvim pick light or dark from that answer. The
 *    shell asks, the reply travels the real pty round trip, and the file the
 *    shell writes is asserted to classify light in celeris and dark in
 *    chronos. A reverse-video sample is measured alongside, since its glyphs
 *    take the same token's RGB.
 *
 * ## The completion signal for the burst
 *
 * The pty host derives a terminal's title from the process name, not from OSC
 * sequences, and under the WebGL renderer `.xterm-rows` carries no text, so
 * neither the title nor the DOM can say when the burst has landed. The
 * DIRECTORY can: the host refreshes `displayCwd` after the shell's cwd moves
 * and the panel header renders it, so the burst is followed by a `cd` into a
 * directory named after a marker, and the header showing that marker is the
 * end of the measurement. The cwd refresh adds a constant few hundred
 * milliseconds; it is the same constant before and after a renderer change,
 * which is what this comparison is for.
 *
 * ## Prerequisites
 *
 * The same as `studio-terminal-input.spec.ts`: the isolated database stack, a
 * build with the diagnostic tour (`VITE_VEX_SETUP_TOUR=1`) and a project, since
 * a terminal's cwd is resolved from the project row. Output goes to
 * `VEX_GLASS_OUT` when set, else the test's own output directory.
 */

import fs from "node:fs";
import path from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import {
  test,
  expect,
  type VexDatabaseFixture,
} from "./fixtures/vex-app-with-database.js";
import {
  focusTerminalGrid,
  openFirstProjectWithATerminal,
  tourIsPresent,
  tourTo,
  TOUR_SKIP_REASON,
} from "./fixtures/studio-shell.js";
import {
  measureContrast,
  measureGutter,
  measureReverseVideo,
  measureScrollbar,
  measureThroughput,
  probeOsc11,
  readPaneFacts,
  durationMs,
  type CaptureClip,
  type Contrast,
  type GutterMeasurement,
  type Osc11Reply,
  type ReverseVideoResult,
} from "./fixtures/terminal-glass-probes.js";

const OUT_DIR = process.env["VEX_GLASS_OUT"] ?? "";

/** Hide the tour navigator (QA scaffolding, never a shipped surface) for a capture. */
async function withTourHidden<T>(page: Page, run: () => Promise<T>): Promise<T> {
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.visibility = "hidden";
  });
  try {
    return await run();
  } finally {
    await page.evaluate(() => {
      const tour = document.querySelector("[data-vex-setup-tour]");
      if (tour instanceof HTMLElement) tour.style.visibility = "";
    });
  }
}

/**
 * Flip the theme through Settings (the product path: the appearance cubes),
 * from whatever mode the shell is in. The menu that reaches Settings lives in
 * the Agent rail, so a Studio caller is switched there and back; the project
 * stays selected across the switch, and is reopened from the rail when it did
 * not.
 */
async function pickTheme(page: Page, theme: "chronos" | "celeris"): Promise<void> {
  const html = page.locator("html");
  if ((await html.getAttribute("data-vex-theme")) === theme) return;
  const shell = page.locator('[data-vex-screen="appShell"]');
  const wasStudio = (await shell.getAttribute("data-vex-runtime-mode")) === "studio";
  const modes = page.getByRole("radiogroup", { name: "Runtime mode" });
  if (wasStudio) await modes.getByRole("radio", { name: "Agent" }).click();
  // The tour navigator is docked over the rail's menu button; it is QA
  // scaffolding and is taken out of the way for the click, as qa-screenshots
  // does.
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.display = "none";
  });
  try {
    await page.getByRole("button", { name: /Open menu/ }).click();
    await page.getByRole("menuitem", { name: /Settings/ }).click();
    await expect(page.locator("[data-vex-settings-preferences]")).toBeVisible();
    await page.locator("[data-vex-settings-appearance]").scrollIntoViewIfNeeded();
    await page.locator(`[data-vex-theme-cube="${theme}"]`).click();
    await expect(html).toHaveAttribute("data-vex-theme", theme);
    await page.keyboard.press("Escape");
    await expect(shell).toBeVisible();
  } finally {
    await page.evaluate(() => {
      const tour = document.querySelector("[data-vex-setup-tour]");
      if (tour instanceof HTMLElement) tour.style.display = "";
    });
  }
  if (!wasStudio) return;
  await modes.getByRole("radio", { name: "Studio" }).click();
  const surface = page.locator(".vex-terminal-surface--active");
  if ((await surface.count()) === 0) {
    await page
      .locator('[data-vex-area="studio-sidebar"]')
      .getByRole("button", { name: /^vex-glass-/ })
      .click();
  }
  await expect(surface).toBeVisible();
}

function outDir(testInfo: TestInfo): string {
  const dir = OUT_DIR === "" ? testInfo.outputDir : OUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("Studio terminal on glass: backdrop shows through, gutter and scroll throughput are measured", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(420_000);
  const page = vexDb.shell;
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  test.skip(!(await tourIsPresent(page)), TOUR_SKIP_REASON);

  const dir = outDir(testInfo);
  // The probes take their screenshots through here, so the tour navigator is
  // hidden by the surface that owns it rather than by the measurement.
  const capture: CaptureClip = (clip) => withTourHidden(page, () => page.screenshot({ clip }));
  const report: Record<string, unknown> = {};
  const save = (): void => {
    fs.writeFileSync(path.join(dir, "glass-measurements.json"), JSON.stringify(report, null, 2));
  };

  // The dark theme first, by the product path, before Studio is entered: the
  // shell resolves the system preference on a fresh config dir, which under a
  // headless X server is light.
  await tourTo(page, "appShell");
  await pickTheme(page, "chronos");
  await openFirstProjectWithATerminal(page, "vex-glass-");

  /* ---- 1. THE GUTTER, at the two widths the owner named ---------------- */
  report["gutters"] = [
    await measureGutter(page, 1920, 1080),
    await measureGutter(page, 1280, 800),
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  save();

  /* ---- 2. THE PANE: renderer, filter, backgrounds, a screenshot -------- */
  await focusTerminalGrid(page);
  await page.keyboard.type("printf 'glass pane over the wallpaper\\n'; ls -la");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const facts = await readPaneFacts(page);
  report["facts"] = facts;
  const theme = (await page.locator("html").getAttribute("data-vex-theme")) ?? "unknown";
  const shot = path.join(dir, `terminal-glass-${theme}.png`);
  await withTourHidden(page, () => page.screenshot({ path: shot }));
  const paneBox = await page.locator("[data-vex-workspace-card] > div").boundingBox();
  if (paneBox !== null) {
    await withTourHidden(page, () =>
      page.screenshot({ path: path.join(dir, `terminal-glass-${theme}-pane.png`), clip: paneBox }),
    );
  }
  report["screenshots"] = { [theme]: shot };
  save();

  /* ---- 3. CONTRAST of the palette foreground over the painted pane ---- */
  await focusTerminalGrid(page);
  await page.keyboard.type("clear");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const contrasts: Contrast[] = [await measureContrast(page, theme, facts.foreground, capture)];
  report["contrasts"] = contrasts;
  save();

  /* ---- 3b. WHAT THE TERMINAL TELLS A PROGRAM, and reverse video --------- */
  const osc11: Osc11Reply[] = [await probeOsc11(page, theme, dir)];
  const reverseVideo: ReverseVideoResult[] = [await measureReverseVideo(page, theme, facts, capture)];
  report["osc11"] = osc11;
  report["reverseVideo"] = reverseVideo;
  await withTourHidden(page, () =>
    page.screenshot({ path: path.join(dir, `terminal-osc11-${theme}.png`) }),
  );
  save();

  /* ---- 4. THROUGHPUT: a 30 000-line burst, then the wheel -------------- */
  const throughput = await measureThroughput(page);
  report["throughput"] = throughput;
  save();

  /* ---- 4b. THE SCROLLBAR the wheel just revealed ------------------------ */
  const gridBox = await page.locator(".vex-terminal-surface--active .xterm-screen").boundingBox();
  expect(gridBox, "no terminal grid to hover").not.toBeNull();
  if (gridBox === null) throw new Error("unreachable");
  const scrollbar = await measureScrollbar(page, gridBox);
  report["scrollbar"] = scrollbar;
  save();

  /* ---- 5. THE OTHER THEME, best effort: a capture and its contrast ----- */
  try {
    await pickTheme(page, "celeris");
    await page.waitForTimeout(400);
    await focusTerminalGrid(page);
    await page.keyboard.type("clear");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const celerisFacts = await readPaneFacts(page);
    contrasts.push(await measureContrast(page, "celeris", celerisFacts.foreground, capture));
    osc11.push(await probeOsc11(page, "celeris", dir));
    reverseVideo.push(await measureReverseVideo(page, "celeris", celerisFacts, capture));
    const celerisShot = path.join(dir, "terminal-glass-celeris.png");
    await withTourHidden(page, () => page.screenshot({ path: celerisShot }));
    (report["screenshots"] as Record<string, string>)["celeris"] = celerisShot;
  } catch (error) {
    report["celerisSkipped"] = error instanceof Error ? error.message : String(error);
  }
  save();

  testInfo.annotations.push({ type: "glass-measurements", description: JSON.stringify(report) });
  // Unpiped, so the numbers are in the run's own output as well.
  console.log(`[glass] ${JSON.stringify(report)}`);

  // The claims that hold before AND after the glass change.
  expect(throughput.scrolledPx).toBeGreaterThan(0);
  expect(throughput.burstFrames).toBeGreaterThan(0);
  for (const gutter of report["gutters"] as GutterMeasurement[]) {
    expect(gutter.gutter).toBeGreaterThanOrEqual(0);
  }

  // THE SCROLLBAR (owner review 2026-09-04: "rounder, smaller, smoother").
  // The `.vex-scroll` shape on xterm's slider, the vestigial viewport gutter
  // gone, the colour from the app's ladder, VS Code's reveal/hide, and the
  // fade collapsed under reduced motion.
  expect(scrollbar.viewportGutter).toBe(0);
  expect(scrollbar.trackWidth).toBe(6);
  expect(scrollbar.sliderWidth).toBe(6);
  expect(scrollbar.sliderInset).toBe(2);
  expect(scrollbar.sliderRadius).toBe("9999px");
  expect(scrollbar.sliderBackground).toBe(scrollbar.tokenBackground);
  expect(scrollbar.classesAfterWheel).toMatch(/\bvisible\b/);
  expect(scrollbar.classesAfterLeave).toMatch(/\binvisible\b/);
  expect(scrollbar.classesOnHover).toMatch(/\bvisible\b/);
  // base.css collapses every transition to 0.01ms; Chromium serializes that
  // as "1e-05s", so the value is parsed rather than matched as text.
  expect(durationMs(scrollbar.reducedMotionTransition)).toBeLessThanOrEqual(0.01);

  // THE CONTRAST FLOOR (rule 08, both themes): the palette foreground over
  // the pane as painted, at its worst sampled pixel, never below 7:1.
  for (const contrast of contrasts) {
    expect(contrast.contrastWorst, `${contrast.theme} contrastWorst`).toBeGreaterThanOrEqual(7);
  }

  // THE OSC 11 ANSWER (both themes; the light one is the claim, so a skipped
  // celeris is a failure here rather than a note). xterm answers from
  // `theme.background` with the alpha dropped, and Claude Code in `auto` mode
  // picks its theme from that answer by the rule `probeOsc11` applies. A
  // pane that answered black in light mode got dark chrome painted over it.
  expect(
    osc11.map((reply) => reply.theme).sort(),
    `celerisSkipped: ${String(report["celerisSkipped"] ?? "no")}`,
  ).toEqual(["celeris", "chronos"]);
  for (const reply of osc11) {
    expect(reply.claudeCodeTheme, `${reply.theme} OSC 11 answered ${reply.raw}`).toBe(
      reply.theme === "celeris" ? "light" : "dark",
    );
  }

  // REVERSE VIDEO: the glyphs take the background token's RGB, made opaque by
  // the WebGL renderer, so with the token carrying the pane's surface they
  // read against the foreground-coloured box. Before the token carried an
  // RGB the light theme painted black glyphs on a near-black box (1.6:1).
  // Under the DOM renderer (xvfb: no WebGL2) the sample is unmeasurable and
  // is recorded as such; the floor holds wherever the WebGL renderer paints.
  for (const sample of reverseVideo) {
    if (!sample.measured) continue;
    expect(sample.glyphPixels, `${sample.theme} reverse video shows no glyphs`).toBeGreaterThan(0);
    expect(sample.contrast, `${sample.theme} reverse video contrast`).toBeGreaterThanOrEqual(4.5);
  }
});
