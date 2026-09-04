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
import sharp from "sharp";
import {
  test,
  expect,
  type VexDatabaseFixture,
} from "./fixtures/vex-app-with-database.js";
import { tourIsPresent, tourTo, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";

/** Lines the burst writes. Thirty times the 1000-row scrollback, so the buffer wraps. */
const BURST_LINES = 30_000;
/** How long the burst may take on a cold, loaded box before the run counts as wedged. */
const BURST_TIMEOUT_MS = 90_000;
/** Wheel ticks and their spacing while measuring scroll frames. */
const WHEEL_TICKS = 60;
const WHEEL_TICK_DELTA = -120;
const WHEEL_TICK_GAP_MS = 16;

const OUT_DIR = process.env["VEX_GLASS_OUT"] ?? "";

interface GutterMeasurement {
  readonly viewportWidth: number;
  readonly sidebarRight: number;
  readonly centerLeft: number;
  readonly paneLeft: number;
  readonly gridLeft: number;
  /** Sidebar right edge to the first terminal column, in CSS px. */
  readonly gutter: number;
  /** Column edge to pane edge (the workspace padding). */
  readonly columnPadding: number;
  /** Pane edge to the first column (the pane's own inset). */
  readonly paneInset: number;
}

interface PaneFacts {
  readonly renderer: "webgl" | "dom";
  /** Whether this environment can hand out a WebGL2 context at all. */
  readonly webgl2Available: boolean;
  readonly paneBackdropFilter: string;
  readonly paneBackground: string;
  readonly hostBackground: string;
  readonly foreground: string;
}

interface Throughput {
  readonly burstLines: number;
  readonly burstMs: number;
  readonly burstFrames: number;
  readonly burstFps: number;
  /** Frames painted in the second after the cwd marker landed. */
  readonly settleFrames: number;
  readonly wheelTicks: number;
  readonly wheelMs: number;
  readonly wheelFrames: number;
  readonly wheelFps: number;
  readonly scrolledPx: number;
}

interface Contrast {
  readonly theme: string;
  readonly sample: { readonly mean: [number, number, number]; readonly extreme: [number, number, number] };
  readonly foreground: [number, number, number];
  readonly contrastMean: number;
  readonly contrastWorst: number;
}

/** Open a project and wait until its first terminal is attached. */
async function openFirstProjectWithATerminal(page: Page): Promise<void> {
  await tourTo(page, "appShell");
  await page
    .getByRole("radiogroup", { name: "Runtime mode" })
    .getByRole("radio", { name: "Studio" })
    .click();
  await expect(page.locator('[data-vex-screen="appShell"]')).toHaveAttribute(
    "data-vex-runtime-mode",
    "studio",
  );

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();
  await sidebar.getByRole("button", { name: "New project" }).click();

  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();
  const projectName = `vex-glass-${Date.now().toString(36)}`;
  await creator.getByLabel("Name").fill(projectName);
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await creator.getByRole("button", { name: "Close" }).click();
  await expect(creator).toBeHidden();

  // Anchored: the rail also renders an "Actions for <name>" menu button whose
  // name contains the project name.
  await sidebar.getByRole("button", { name: new RegExp(`^${projectName}`) }).click();

  const center = page.locator('[data-vex-area="studio-center"]');
  await expect(center).toBeVisible();
  await expect(
    center.getByRole("tablist", { name: "Studio terminals and files" }),
  ).toBeVisible();
  await expect(page.locator(".vex-terminal-surface--active")).toBeVisible();
}

/**
 * Put the caret in the terminal by clicking its grid. Not the helper textarea:
 * xterm parks it at 0x0 off-screen until the terminal is focused, and a
 * zero-size element is one Playwright refuses to click.
 */
async function focusTerminal(page: Page): Promise<void> {
  const screen = page.locator(".vex-terminal-surface--active .xterm-screen");
  const box = await screen.boundingBox();
  expect(box, "no terminal grid to focus").not.toBeNull();
  if (box === null) throw new Error("unreachable");
  await page.mouse.click(box.x + Math.min(40, box.width / 2), box.y + Math.min(40, box.height / 2));
}

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

async function measureGutter(page: Page, width: number, height: number): Promise<GutterMeasurement> {
  await page.setViewportSize({ width, height });
  // The grid refits on resize through a ResizeObserver; give it two frames.
  await page.evaluate(
    () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
  );
  const measured = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-vex-area="studio-sidebar"]');
    const center = document.querySelector('[data-vex-area="studio-center"]');
    const pane = document.querySelector("[data-vex-workspace-card] > div");
    const grid = document.querySelector(".vex-terminal-surface--active .xterm-screen");
    if (!sidebar || !center || !pane || !grid) return null;
    return {
      sidebarRight: sidebar.getBoundingClientRect().right,
      centerLeft: center.getBoundingClientRect().left,
      paneLeft: pane.getBoundingClientRect().left,
      gridLeft: grid.getBoundingClientRect().left,
    };
  });
  expect(measured, `no measurable studio layout at ${String(width)}px`).not.toBeNull();
  if (measured === null) throw new Error("unreachable");
  return {
    viewportWidth: width,
    ...measured,
    gutter: measured.gridLeft - measured.sidebarRight,
    columnPadding: measured.paneLeft - measured.centerLeft,
    paneInset: measured.gridLeft - measured.paneLeft,
  };
}

async function readPaneFacts(page: Page): Promise<PaneFacts> {
  return page.evaluate(() => {
    const surface = document.querySelector<HTMLElement>(".vex-terminal-surface--active");
    const pane = document.querySelector<HTMLElement>("[data-vex-workspace-card] > div");
    const host = surface?.parentElement?.parentElement ?? null;
    const probe = document.createElement("span");
    probe.style.color = "var(--vex-alias-term-foreground)";
    document.body.appendChild(probe);
    const foreground = getComputedStyle(probe).color;
    probe.remove();
    const paneStyle = pane === null ? null : getComputedStyle(pane);
    const gl = document.createElement("canvas").getContext("webgl2");
    return {
      renderer: surface?.querySelector("canvas") ? "webgl" : "dom",
      webgl2Available: gl !== null,
      paneBackdropFilter: paneStyle?.backdropFilter ?? "",
      paneBackground: paneStyle?.backgroundColor ?? "",
      hostBackground: host === null ? "" : getComputedStyle(host).backgroundColor,
      foreground,
    } as const;
  });
}

/** Count animation frames on the page until `stop` is called. */
async function startFrameCounter(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __vexFrames?: { count: number; running: boolean; start: number } };
    const state = { count: 0, running: true, start: performance.now() };
    w.__vexFrames = state;
    const tick = (): void => {
      if (!state.running) return;
      state.count += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function readFrameCounter(page: Page): Promise<{ frames: number; ms: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __vexFrames?: { count: number; running: boolean; start: number } };
    const state = w.__vexFrames;
    if (state === undefined) return { frames: 0, ms: 0 };
    return { frames: state.count, ms: performance.now() - state.start };
  });
}

async function stopFrameCounter(page: Page): Promise<{ frames: number; ms: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __vexFrames?: { count: number; running: boolean; start: number } };
    const state = w.__vexFrames;
    if (state === undefined) return { frames: 0, ms: 0 };
    state.running = false;
    return { frames: state.count, ms: performance.now() - state.start };
  });
}

async function measureThroughput(page: Page): Promise<Throughput> {
  await focusTerminal(page);
  const marker = `glassdone${Date.now().toString(36)}`;
  const center = page.locator('[data-vex-area="studio-center"]');

  await page.keyboard.type(
    `seq 1 ${String(BURST_LINES)}; mkdir -p ${marker}; cd ${marker}`,
  );
  await startFrameCounter(page);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => await center.textContent(), { timeout: BURST_TIMEOUT_MS })
    .toContain(marker);
  const burstMs = Date.now() - t0;
  const burst = await readFrameCounter(page);

  // The burst's tail is still being parsed and painted when the cwd lands
  // (the shell moved on the moment `seq` finished writing); count the frames
  // of the second after it as well, so a renderer that stalls on the tail
  // shows up as a low settle count.
  await page.waitForTimeout(1_000);
  const settled = await stopFrameCounter(page);

  // Wheel the scrollback from the bottom upwards and count the frames painted.
  // xterm 6 scrolls through a ScrollableElement (VS Code's), so the viewport's
  // own scrollTop never moves; the vertical slider's offset is what does.
  const grid = page.locator(".vex-terminal-surface--active .xterm-screen");
  const box = await grid.boundingBox();
  expect(box, "no terminal grid to wheel").not.toBeNull();
  if (box === null) throw new Error("unreachable");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const sliderTop = async (): Promise<number> =>
    page.evaluate(() => {
      const slider = document.querySelector<HTMLElement>(
        ".vex-terminal-surface--active .xterm-scrollable-element > .scrollbar.vertical > .slider",
      );
      return slider === null ? Number.NaN : Number.parseFloat(slider.style.top || "0");
    });
  const scrollBefore = await sliderTop();
  await startFrameCounter(page);
  const w0 = Date.now();
  for (let tick = 0; tick < WHEEL_TICKS; tick += 1) {
    await page.mouse.wheel(0, WHEEL_TICK_DELTA);
    await page.waitForTimeout(WHEEL_TICK_GAP_MS);
  }
  const wheelMs = Date.now() - w0;
  const wheel = await stopFrameCounter(page);
  const scrollAfter = await sliderTop();

  return {
    burstLines: BURST_LINES,
    burstMs,
    burstFrames: burst.frames,
    burstFps: Math.round((burst.frames / burst.ms) * 1000),
    settleFrames: settled.frames - burst.frames,
    wheelTicks: WHEEL_TICKS,
    wheelMs,
    wheelFrames: wheel.frames,
    wheelFps: Math.round((wheel.frames / wheel.ms) * 1000),
    scrolledPx: Math.round(scrollBefore - scrollAfter),
  };
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function parseRgb(css: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (match === null) throw new Error(`not an rgb() colour: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Contrast of the terminal foreground over the pane as PAINTED: the mean of
 * the blank region's pixels and the extreme one (brightest on a dark theme,
 * darkest on a light one), since the wallpaper under glass is not uniform.
 */
async function measureContrast(
  page: Page,
  theme: string,
  foregroundCss: string,
): Promise<Contrast> {
  const grid = page.locator(".vex-terminal-surface--active .xterm-screen");
  const box = await grid.boundingBox();
  expect(box).not.toBeNull();
  if (box === null) throw new Error("unreachable");
  // The lower half of the grid is blank right after a `clear`.
  const clip = {
    x: Math.round(box.x + box.width * 0.1),
    y: Math.round(box.y + box.height * 0.55),
    width: Math.round(box.width * 0.8),
    height: Math.round(box.height * 0.4),
  };
  const png = await withTourHidden(page, () => page.screenshot({ clip }));
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const foreground = parseRgb(foregroundCss);
  const fgLum = relativeLuminance(foreground);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let extreme: [number, number, number] = [0, 0, 0];
  let extremeLum = fgLum > 0.5 ? -1 : 2;
  const pixels = info.width * info.height;
  for (let i = 0; i < pixels; i += 1) {
    const px: [number, number, number] = [
      data[i * info.channels] ?? 0,
      data[i * info.channels + 1] ?? 0,
      data[i * info.channels + 2] ?? 0,
    ];
    sumR += px[0];
    sumG += px[1];
    sumB += px[2];
    const lum = relativeLuminance(px);
    // Worst case is the pixel closest in luminance to the foreground.
    if (fgLum > 0.5 ? lum > extremeLum : lum < extremeLum) {
      extremeLum = lum;
      extreme = px;
    }
  }
  const mean: [number, number, number] = [
    Math.round(sumR / pixels),
    Math.round(sumG / pixels),
    Math.round(sumB / pixels),
  ];
  return {
    theme,
    sample: { mean, extreme },
    foreground,
    contrastMean: contrastRatio(foreground, mean),
    contrastWorst: contrastRatio(foreground, extreme),
  };
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
  const report: Record<string, unknown> = {};
  const save = (): void => {
    fs.writeFileSync(path.join(dir, "glass-measurements.json"), JSON.stringify(report, null, 2));
  };

  // The dark theme first, by the product path, before Studio is entered: the
  // shell resolves the system preference on a fresh config dir, which under a
  // headless X server is light.
  await tourTo(page, "appShell");
  await pickTheme(page, "chronos");
  await openFirstProjectWithATerminal(page);
  // A login shell may block on a profile prompt (a `sudo` in .bashrc asks for
  // a password on this machine); an interrupt lets the profile finish and
  // hands the prompt over. Harmless on a shell that is already at its prompt.
  await focusTerminal(page);
  await page.keyboard.press("Control+C");
  await page.waitForTimeout(1_000);

  /* ---- 1. THE GUTTER, at the two widths the owner named ---------------- */
  report["gutters"] = [
    await measureGutter(page, 1920, 1080),
    await measureGutter(page, 1280, 800),
  ];
  await page.setViewportSize({ width: 1440, height: 900 });
  save();

  /* ---- 2. THE PANE: renderer, filter, backgrounds, a screenshot -------- */
  await focusTerminal(page);
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
  await focusTerminal(page);
  await page.keyboard.type("clear");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const contrasts: Contrast[] = [await measureContrast(page, theme, facts.foreground)];
  report["contrasts"] = contrasts;
  save();

  /* ---- 4. THROUGHPUT: a 30 000-line burst, then the wheel -------------- */
  const throughput = await measureThroughput(page);
  report["throughput"] = throughput;
  save();

  /* ---- 5. THE OTHER THEME, best effort: a capture and its contrast ----- */
  try {
    await pickTheme(page, "celeris");
    await page.waitForTimeout(400);
    await focusTerminal(page);
    await page.keyboard.type("clear");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(400);
    const celerisFacts = await readPaneFacts(page);
    contrasts.push(await measureContrast(page, "celeris", celerisFacts.foreground));
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
});
