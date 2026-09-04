/**
 * THE MEASUREMENT OWNERS behind `studio-terminal-glass.spec.ts`.
 *
 * The spec makes claims about the Studio terminal as PAINTED in the built app:
 * the gutter, the pane's renderer and filters, scroll throughput, the
 * scrollbar's geometry and reveal states, foreground contrast over the glass,
 * what the terminal answers an OSC 11 query, and how reverse video reads. Each
 * of those is a measurement with its own apparatus, and none of it is an
 * assertion. This module owns the apparatus; the spec keeps the walk and every
 * claim it makes about the numbers.
 *
 * Two things deliberately stay OUT of here:
 *
 *  - the tour navigator is QA scaffolding the spec owns, so the two probes
 *    that need a screenshot take a `CaptureClip` from the caller rather than
 *    reaching for the tour themselves;
 *  - the theme walk (`pickTheme`) and the output directory are the spec's own
 *    route through the product, not a measurement.
 *
 * `expect` appears here only where a probe cannot continue without the thing
 * it is measuring (no layout, no grid, no reply), the same way
 * `studio-shell.ts` uses it inside `focusTerminalGrid`.
 */

import fs from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { focusTerminalGrid } from "./studio-shell.js";

/** Lines the burst writes. Thirty times the 1000-row scrollback, so the buffer wraps. */
export const BURST_LINES = 30_000;
/** How long the burst may take on a cold, loaded box before the run counts as wedged. */
export const BURST_TIMEOUT_MS = 90_000;
/** Wheel ticks and their spacing while measuring scroll frames. */
export const WHEEL_TICKS = 60;
export const WHEEL_TICK_DELTA = -120;
export const WHEEL_TICK_GAP_MS = 16;

/**
 * A clipped screenshot of the page. The caller supplies it, because what has
 * to be hidden for a capture (the tour navigator) belongs to the caller.
 */
export type CaptureClip = (clip: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}) => Promise<Buffer>;

export interface GutterMeasurement {
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

export interface PaneFacts {
  readonly renderer: "webgl" | "dom";
  /** Whether this environment can hand out a WebGL2 context at all. */
  readonly webgl2Available: boolean;
  readonly paneBackdropFilter: string;
  readonly paneBackground: string;
  readonly hostBackground: string;
  readonly foreground: string;
}

export interface Throughput {
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

/**
 * The terminal's scrollbar as PAINTED. xterm 6 mounts VS Code's
 * ScrollableElement, so the bar is a real `.slider` element sized inline and
 * coloured by scrollbars.css; none of that is readable in jsdom.
 */
export interface ScrollbarFacts {
  /** The vestigial `.xterm-viewport`'s own native gutter, in CSS px. 0 means gone. */
  readonly viewportGutter: number;
  readonly trackWidth: number;
  readonly sliderWidth: number;
  /** The transparent inset each side of the thumb (the slider's padding). */
  readonly sliderInset: number;
  readonly sliderRadius: string;
  readonly sliderBackground: string;
  /** `--vex-scrollbar-thumb` resolved in the track's own scope, for comparison. */
  readonly tokenBackground: string;
  /**
   * xterm's injected `<style>` elements inside the terminal, and how many of
   * them the document actually applied. The renderer's CSP (`style-src
   * 'self'`) refuses inline sheets, which is why the slider's colour cannot
   * come from the palette bridge and lives in scrollbars.css instead.
   */
  readonly injectedSheets: { readonly count: number; readonly applied: number };
  /** The track's class list right after the wheel, with the pointer still over the grid. */
  readonly classesAfterWheel: string;
  /** The track's class list once the pointer left and the idle hide ran. */
  readonly classesAfterLeave: string;
  /** The track's class list once the pointer came back over the grid. */
  readonly classesOnHover: string;
  /** The show/fade transition duration under `prefers-reduced-motion: reduce`. */
  readonly reducedMotionTransition: string;
}

export interface Contrast {
  readonly theme: string;
  readonly sample: { readonly mean: [number, number, number]; readonly extreme: [number, number, number] };
  readonly foreground: [number, number, number];
  readonly contrastMean: number;
  readonly contrastWorst: number;
}

/**
 * What the terminal ANSWERED when the shell asked for its background colour
 * (OSC 11), read back from the file the shell wrote, not from the DOM.
 */
export interface Osc11Reply {
  readonly theme: string;
  /** The reply as `printf %q` escaped it, verbatim from the file. */
  readonly raw: string;
  /** The reply's RGB scaled to 8 bits, the way xterm's own `parseColor` does. */
  readonly rgb: [number, number, number];
  /** Claude Code's `auto` rule over that RGB: what it would pick in this pane. */
  readonly claudeCodeTheme: "light" | "dark";
}

/**
 * An SGR 7 (reverse video) sample as PAINTED: the box takes the palette
 * foreground and the glyphs inside it take the theme background, which is
 * alpha 0 in the token and made opaque by the WebGL renderer's `color.opaque`
 * under `allowTransparency`. So the glyph colour a user sees is the token's
 * RGB, and the legibility of reverse video is a consequence of that RGB.
 */
export interface ReverseVideoSample {
  readonly measured: true;
  readonly theme: string;
  readonly foreground: [number, number, number];
  /** The solid box found in the capture, in clip-relative px. */
  readonly box: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
  readonly boxMean: [number, number, number];
  /** The pixel inside the box furthest from the box colour: a glyph stroke. */
  readonly glyphExtreme: [number, number, number];
  /** Pixels inside the box that are clearly not the box colour. 0 means no visible glyphs. */
  readonly glyphPixels: number;
  /** Contrast of that stroke against the box. */
  readonly contrast: number;
}

/**
 * The DOM renderer cannot be measured this way: it paints every colour,
 * reverse video included, through a `<style>` it injects, and the renderer's
 * CSP (`style-src 'self'`) refuses it, so the sample shows no box at all
 * (measured under xvfb, where WebGL2 is unavailable, 2026-09-04). A WebGL run
 * that finds no box is a defect; a DOM run is recorded as unmeasured.
 */
export interface ReverseVideoUnmeasured {
  readonly measured: false;
  readonly theme: string;
  readonly renderer: "dom";
  readonly reason: string;
}

export type ReverseVideoResult = ReverseVideoSample | ReverseVideoUnmeasured;

export async function measureGutter(page: Page, width: number, height: number): Promise<GutterMeasurement> {
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

export async function readPaneFacts(page: Page): Promise<PaneFacts> {
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
export async function startFrameCounter(page: Page): Promise<void> {
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

export async function readFrameCounter(page: Page): Promise<{ frames: number; ms: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __vexFrames?: { count: number; running: boolean; start: number } };
    const state = w.__vexFrames;
    if (state === undefined) return { frames: 0, ms: 0 };
    return { frames: state.count, ms: performance.now() - state.start };
  });
}

export async function stopFrameCounter(page: Page): Promise<{ frames: number; ms: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __vexFrames?: { count: number; running: boolean; start: number } };
    const state = w.__vexFrames;
    if (state === undefined) return { frames: 0, ms: 0 };
    state.running = false;
    return { frames: state.count, ms: performance.now() - state.start };
  });
}

export async function measureThroughput(page: Page): Promise<Throughput> {
  await focusTerminalGrid(page);
  const marker = `glassdone${Date.now().toString(36)}`;
  // The HEADER's location line, not the whole center: under the DOM renderer
  // `.xterm-rows` carries the typed command, marker included, so a poll on
  // the center's text matched before Enter had even landed (measured:
  // burstMs 17, burstFrames 0).
  const location = page
    .locator('[data-vex-area="studio-center"]')
    .locator("p:has([data-vex-terminal-shell])");

  await page.keyboard.type(
    `seq 1 ${String(BURST_LINES)}; mkdir -p ${marker}; cd ${marker}`,
  );
  await startFrameCounter(page);
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => await location.textContent(), { timeout: BURST_TIMEOUT_MS })
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

export const TRACK_SELECTOR =
  ".vex-terminal-surface--active .xterm-scrollable-element > .scrollbar.vertical";

export async function trackClasses(page: Page): Promise<string> {
  return page.evaluate(
    (selector) => document.querySelector(selector)?.className ?? "",
    TRACK_SELECTOR,
  );
}

/**
 * Read the bar with the pointer still over the grid (the wheel just ran, so
 * VS Code's state machine holds it `visible`), then prove the auto-hide: the
 * pointer leaves, the 500ms idle hide runs and the track turns `invisible`;
 * the pointer returns and it is `visible` again. Reduced motion is emulated
 * last and undone before returning, so the capture that follows is unaffected.
 */
export async function measureScrollbar(page: Page, gridBox: { x: number; y: number; width: number; height: number }): Promise<ScrollbarFacts> {
  const geometry = await page.evaluate((selector) => {
    const viewport = document.querySelector<HTMLElement>(".vex-terminal-surface--active .xterm-viewport");
    const track = document.querySelector<HTMLElement>(selector);
    const slider = track?.querySelector<HTMLElement>(".slider") ?? null;
    const probe = document.createElement("span");
    probe.style.backgroundColor = "var(--vex-scrollbar-thumb)";
    (track ?? document.body).appendChild(probe);
    const tokenBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const sliderStyle = slider === null ? null : getComputedStyle(slider);
    const sheets = [...document.querySelectorAll<HTMLStyleElement>(".vex-terminal-surface--active style")];
    const injectedSheets = {
      count: sheets.length,
      applied: sheets.filter((sheet) => (sheet.sheet?.cssRules.length ?? 0) > 0).length,
    };
    return {
      injectedSheets,
      viewportGutter: viewport === null ? Number.NaN : viewport.offsetWidth - viewport.clientWidth,
      trackWidth: track?.offsetWidth ?? Number.NaN,
      sliderWidth: slider?.offsetWidth ?? Number.NaN,
      sliderInset: sliderStyle === null ? Number.NaN : Number.parseFloat(sliderStyle.paddingLeft),
      sliderRadius: sliderStyle?.borderRadius ?? "",
      sliderBackground: sliderStyle?.backgroundColor ?? "",
      tokenBackground,
      classesAfterWheel: track?.className ?? "",
    };
  }, TRACK_SELECTOR);

  // Leave the terminal: the hide is scheduled 500ms after the pointer goes
  // and the fade takes 800ms; the class flips at the schedule, not the fade.
  // `invisible` contains `visible`, so the states are matched on word
  // boundaries, never by substring.
  await page.mouse.move(2, 2);
  await expect.poll(() => trackClasses(page), { timeout: 5_000 }).toMatch(/\binvisible\b/);
  const classesAfterLeave = await trackClasses(page);

  await page.mouse.move(gridBox.x + gridBox.width / 2, gridBox.y + gridBox.height / 2);
  await expect
    .poll(async () => /\bvisible\b/.test(await trackClasses(page)), { timeout: 5_000 })
    .toBe(true);
  const classesOnHover = await trackClasses(page);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotionTransition = await page.evaluate(
    (selector) => {
      const track = document.querySelector<HTMLElement>(selector);
      return track === null ? "" : getComputedStyle(track).transitionDuration;
    },
    TRACK_SELECTOR,
  );
  await page.emulateMedia({ reducedMotion: null });

  return { ...geometry, classesAfterLeave, classesOnHover, reducedMotionTransition };
}

/** A computed `transition-duration` ("0.01ms", "1e-05s", "0.8s") in milliseconds. */
export function durationMs(value: string): number {
  const match = /^([0-9.e+-]+)(ms|s)$/.exec(value.trim());
  if (match === null) throw new Error(`not a duration: ${value}`);
  const amount = Number(match[1]);
  return match[2] === "s" ? amount * 1000 : amount;
}

export function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

export function parseRgb(css: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (match === null) throw new Error(`not an rgb() colour: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Contrast of the terminal foreground over the pane as PAINTED: the mean of
 * the blank region's pixels and the extreme one (brightest on a dark theme,
 * darkest on a light one), since the wallpaper under glass is not uniform.
 */
export async function measureContrast(
  page: Page,
  theme: string,
  foregroundCss: string,
  capture: CaptureClip,
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
  const png = await capture(clip);
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

/** How long the shell gets to write the OSC 11 reply file before the probe counts as unanswered. */
const OSC11_REPLY_TIMEOUT_MS = 10_000;

/**
 * Ask the terminal for its background colour THE WAY A PROGRAM DOES.
 *
 * The shell writes the OSC 11 query, reads the answer xterm types back into
 * the pty (up to the `ESC \` terminator) and writes it, `printf %q`-escaped so
 * it is both legible on screen and parseable, to a file the test then reads.
 * The file is the evidence: it proves the bytes travelled renderer -> bridge
 * -> pty -> shell, which is exactly the path Claude Code's theme detection
 * takes, and it is readable under the WebGL renderer where the rows are not.
 */
export async function probeOsc11(page: Page, theme: string, dir: string): Promise<Osc11Reply> {
  const file = path.join(dir, `osc11-${theme}.txt`);
  fs.rmSync(file, { force: true });
  await focusTerminalGrid(page);
  await page.keyboard.type(
    `printf '\\e]11;?\\a'; IFS= read -rs -d '\\' -t 3 vex_osc11; printf '%q\\n' "$vex_osc11" | tee '${file}'`,
  );
  await page.keyboard.press("Enter");
  await expect
    .poll(() => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : ""), {
      timeout: OSC11_REPLY_TIMEOUT_MS,
    })
    .not.toBe("");
  const raw = fs.readFileSync(file, "utf8").trim();
  // xterm answers `rgb:RRRR/GGGG/BBBB`; each channel is scaled by its own
  // digit count, as xterm's `parseColor` scales an incoming one.
  const match = /rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(raw);
  if (match === null) throw new Error(`no rgb: in the OSC 11 reply for ${theme}: ${raw}`);
  const channel = (hex: string | undefined): number => {
    const digits = hex ?? "";
    return Math.round((parseInt(digits, 16) / (16 ** digits.length - 1)) * 255);
  };
  const rgb: [number, number, number] = [channel(match[1]), channel(match[2]), channel(match[3])];
  // Claude Code 2.1.260's detector, verbatim: linear channel weights over 0..1.
  const weighted = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return { theme, raw, rgb, claudeCodeTheme: weighted > 0.5 ? "light" : "dark" };
}

/** How far (Euclidean, 0..441) a pixel may sit from a colour and still count as it. */
export const SAME_COLOUR_DISTANCE = 40;
/** A horizontal run of foreground-coloured pixels this long is a reverse-video box, never a glyph stroke. */
export const BOX_RUN_MIN_PX = 30;

export function colourDistance(a: [number, number, number], b: [number, number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Print an SGR 7 sample and measure it as painted. The box is found by
 * colour: reverse video paints its cells solid in the palette foreground, so
 * the leading and trailing blank cells are the only place in the grid where
 * foreground-coloured pixels run unbroken for whole cells. Rows carrying such
 * a run are the box; the glyphs are whatever inside it is not the box colour.
 */
export async function measureReverseVideo(
  page: Page,
  theme: string,
  facts: PaneFacts,
  capture: CaptureClip,
): Promise<ReverseVideoResult> {
  const foregroundCss = facts.foreground;
  await focusTerminalGrid(page);
  await page.keyboard.type("printf '\\e[7m      REVERSE VIDEO      \\e[0m plain\\n'");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const grid = page.locator(".vex-terminal-surface--active .xterm-screen");
  const gridBox = await grid.boundingBox();
  expect(gridBox, "no terminal grid to sample").not.toBeNull();
  if (gridBox === null) throw new Error("unreachable");
  // The sample sits in the first rows after a `clear`; the upper half is enough.
  const clip = {
    x: Math.round(gridBox.x),
    y: Math.round(gridBox.y),
    width: Math.round(gridBox.width),
    height: Math.round(gridBox.height * 0.5),
  };
  const png = await capture(clip);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const foreground = parseRgb(foregroundCss);
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * info.width + x) * info.channels;
    return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
  };
  const isForeground = (x: number, y: number): boolean =>
    colourDistance(at(x, y), foreground) <= SAME_COLOUR_DISTANCE;

  // Rows that carry a box run, and the run extents across them.
  let top = -1;
  let bottom = -1;
  let left = info.width;
  let right = -1;
  for (let y = 0; y < info.height; y += 1) {
    let run = 0;
    let rowHasBox = false;
    for (let x = 0; x <= info.width; x += 1) {
      if (x < info.width && isForeground(x, y)) {
        run += 1;
        continue;
      }
      if (run >= BOX_RUN_MIN_PX) {
        rowHasBox = true;
        left = Math.min(left, x - run);
        right = Math.max(right, x - 1);
      }
      run = 0;
    }
    if (rowHasBox) {
      if (top === -1) top = y;
      bottom = y;
    }
  }
  if (top === -1 && facts.renderer === "dom") {
    return {
      measured: false,
      theme,
      renderer: "dom",
      reason: "the DOM renderer's injected colour sheet is refused by the renderer CSP; no box is painted",
    };
  }
  expect(top, `${theme}: no reverse-video box found in the capture`).toBeGreaterThanOrEqual(0);

  let boxCount = 0;
  const boxSum = [0, 0, 0];
  let glyphPixels = 0;
  let glyphExtreme: [number, number, number] = foreground;
  let glyphDistance = -1;
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const px = at(x, y);
      const distance = colourDistance(px, foreground);
      if (distance <= SAME_COLOUR_DISTANCE) {
        boxCount += 1;
        boxSum[0] = (boxSum[0] ?? 0) + px[0];
        boxSum[1] = (boxSum[1] ?? 0) + px[1];
        boxSum[2] = (boxSum[2] ?? 0) + px[2];
        continue;
      }
      glyphPixels += 1;
      if (distance > glyphDistance) {
        glyphDistance = distance;
        glyphExtreme = px;
      }
    }
  }
  const boxMean: [number, number, number] = [
    Math.round((boxSum[0] ?? 0) / Math.max(1, boxCount)),
    Math.round((boxSum[1] ?? 0) / Math.max(1, boxCount)),
    Math.round((boxSum[2] ?? 0) / Math.max(1, boxCount)),
  ];
  return {
    measured: true,
    theme,
    foreground,
    box: { left, top, width: right - left + 1, height: bottom - top + 1 },
    boxMean,
    glyphExtreme,
    glyphPixels,
    contrast: contrastRatio(boxMean, glyphExtreme),
  };
}
