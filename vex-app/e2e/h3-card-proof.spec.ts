/**
 * THE CARD PROOF (docs/design/H3-DESKTOP.md section 3.6; plan row S4-16): a
 * waiting money card never moves when Kimm's section opens or closes, on any
 * frame. Desktop's port of the H3 mockup's own proof (`h3-merged__plate-proof`),
 * run as a CI gate: a card that moves fails the build.
 *
 * WHAT IS READ, in the H3 shell harness's `swap-waiting` state (the real
 * shell and the real approval card, with only the preload bridge stood in
 * for), at the five widths the mockup proved, 1280, 1366, 1440, 1920 and 2560:
 *
 *   1. SEEKED, the mockup's `&seek=` frames. Her corner key is pressed, every
 *      CSS transition of her motion (the clip, the scan head, her drop) is
 *      paused, and all are set to the same time every 30ms from 0 to the
 *      motion's end: Hide Vex (420ms), then Show Vex (720ms). On each frame
 *      the card's box and her section's box are read, and her clip.
 *   2. LIVE. The same two presses as a person makes them, the card read on
 *      every frame the browser paints until her section rests again.
 *   3. TURNED AROUND. Hide Vex, then Show Vex 80ms later: read on every
 *      painted frame; the wipe goes no deeper after the second press and
 *      ends open (section 3.4).
 *   4. PIXELS. The card's own pixels in the open render of the state against
 *      the closed render (`?vex=closed`): not one may differ.
 *
 * On every frame of every path the card's box must equal the open render's,
 * and her section's box must not change either: only her clip moves (section
 * 3.2). The seeks must also show her moving, from open to the strip and
 * back, so a wipe that never ran cannot pass.
 *
 * WHY THE HARNESS. The built app stops at SystemCheck without a running
 * runtime and an unlocked vault (`smoke.spec.ts`), so a waiting card cannot
 * be put on screen there on demand, and the shell and the stylesheet are the
 * product's (`vite.h3-shell.config.ts`). Motion is ON here, unlike the parity
 * captures: the motion is what is under test.
 *
 * Run: pnpm --dir vex-app exec playwright test --project h3-card-proof
 * (VEX_H3_PORT=<port> to use or start a harness on another port).
 */

import { expect, test, type Page } from "@playwright/test";

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
] as const;

type Size = (typeof SIZES)[number];

const CARD = '[data-vex-area="approvals-region"] [data-vex-area="approval-card"]';
const SECTION = '[data-vex-area="kimm-section"]';
const KEY = '[data-vex-area="kimm-key"]';

/** The seek step, as the mockup's proof read it. */
const SEEK_STEP_MS = 30;
/** Her motion's two legs (section 3.1; `DURATION_VEX_*_MS` in the renderer). */
const OPEN_MS = 720;
const CLOSE_MS = 420;
/** The strip her section folds to (`--vex-h3-strip-h`). */
const STRIP_PX = 56;

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Frame {
  readonly at: number;
  readonly card: Box;
  readonly section: Box;
  readonly clip: string;
}

const sizeName = (size: Size): string => `${String(size.width)}x${String(size.height)}`;

test.use({
  timezoneId: "UTC",
  locale: "en-US",
  colorScheme: "dark",
  contextOptions: { reducedMotion: "no-preference" },
});

/** Open the swap-waiting state with her section as asked and wait until it is whole. */
async function open(page: Page, size: Size, vex: "open" | "closed"): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(size);
  await page.goto(`/?state=swap-waiting&vex=${vex}`);
  await page.waitForSelector('[data-vex-h3-ready="true"]', { timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", vex);
  expect(await page.evaluate(() => window.__vexH3Harness.unanswered())).toEqual([]);
  expect(errors).toEqual([]);
}

/**
 * Press her corner key and read every seek frame of the motion it starts:
 * once the press has landed, every running transition in her section is
 * paused and set to the same time, and the card and her section are read
 * after each seek.
 */
async function seekedPress(page: Page, durationMs: number): Promise<Frame[]> {
  return page.evaluate(
    async ({ card, section, key, duration, step }) => {
      const box = (selector: string): Box => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`missing ${selector}`);
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const sectionEl = document.querySelector<HTMLElement>(section);
      const keyEl = document.querySelector<HTMLElement>(key);
      if (sectionEl === null || keyEl === null) throw new Error("her section is missing");
      const was = sectionEl.dataset["kimmOpen"];
      keyEl.click();
      while (sectionEl.dataset["kimmOpen"] === was) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      // Reading her clip makes the style change that starts the transitions.
      void getComputedStyle(sectionEl).clipPath;
      const running = document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
        return target !== null && sectionEl.contains(target);
      });
      if (running.length === 0) throw new Error("the press started no motion");
      for (const animation of running) animation.pause();
      const frames: Frame[] = [];
      for (let at = 0; at <= duration; at += step) {
        for (const animation of running) animation.currentTime = at;
        frames.push({ at, card: box(card), section: box(section), clip: getComputedStyle(sectionEl).clipPath });
      }
      for (const animation of running) animation.finish();
      return frames;
    },
    { card: CARD, section: SECTION, key: KEY, duration: durationMs, step: SEEK_STEP_MS },
  );
}

/**
 * Press her corner key (and, for the turn, again 80ms later) and read the
 * card, her section and her clip on every painted frame until her section
 * rests as `rest`. The second press is marked with `at: -1`.
 */
async function liveFrames(page: Page, turn: boolean, rest: "open" | "closed"): Promise<Frame[]> {
  return page.evaluate(
    async ({ card, section, key, turn, rest }) => {
      const box = (selector: string): Box => {
        const el = document.querySelector(selector);
        if (el === null) throw new Error(`missing ${selector}`);
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const sectionEl = document.querySelector<HTMLElement>(section);
      const keyEl = document.querySelector<HTMLElement>(key);
      if (sectionEl === null || keyEl === null) throw new Error("her section is missing");
      const frames: Frame[] = [];
      const read = (at: number): Frame => ({
        at,
        card: box(card),
        section: box(section),
        clip: getComputedStyle(sectionEl).clipPath,
      });
      const start = performance.now();
      keyEl.click();
      if (turn) {
        window.setTimeout(() => {
          frames.push(read(-1));
          keyEl.click();
        }, 80);
      }
      await new Promise<void>((resolve, reject) => {
        const tick = (): void => {
          const at = performance.now() - start;
          frames.push(read(at));
          if (sectionEl.dataset["kimmPhase"] === rest && at > 120 + (turn ? 80 : 0)) {
            resolve();
            return;
          }
          if (at > 6000) {
            reject(new Error(`her section never rested ${rest}`));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return frames;
    },
    { card: CARD, section: SECTION, key: KEY, turn, rest },
  );
}

/**
 * The wipe's bottom inset in px, from a computed clip and her box's height:
 * `inset(0px)` when open, `inset(0px 0px calc(A% - Bpx))` mid-wipe, and
 * `inset(0px 0px calc(100% - 56px))` at the strip.
 */
function bottomInset(clip: string, height: number): number {
  const calc = /calc\(\s*([\d.e+-]+)%\s*-\s*([\d.e+-]+)px\s*\)/.exec(clip);
  if (calc !== null) return (Number(calc[1]) / 100) * height - Number(calc[2]);
  const parts = /inset\(([^)]*)\)/.exec(clip)?.[1]?.trim().split(/\s+/) ?? [];
  const bottom = parts.length >= 3 ? parts[2] : parts[0];
  if (bottom === undefined) return 0;
  if (bottom.endsWith("%")) return (Number.parseFloat(bottom) / 100) * height;
  return Number.parseFloat(bottom);
}

async function cardBox(page: Page): Promise<Box> {
  const box = await page.locator(CARD).boundingBox();
  expect(box).not.toBeNull();
  return box as Box;
}

/** The part of a box the viewport shows: what a screenshot can hold. */
function onScreen(box: Box, size: Size): Box {
  const x = Math.max(0, box.x);
  const y = Math.max(0, box.y);
  return {
    x,
    y,
    width: Math.min(size.width, box.x + box.width) - x,
    height: Math.min(size.height, box.y + box.height) - y,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("H3 card proof: a waiting money card never moves", () => {
  for (const size of SIZES) {
    test(`seeked, live and turned around at ${sizeName(size)}`, async ({ page }) => {
      await open(page, size, "open");
      const card = await cardBox(page);
      const section = (await page.locator(SECTION).boundingBox()) as Box;
      expect(section).not.toBeNull();
      const closedInset = section.height - STRIP_PX;

      // 1. Seeked: Hide Vex every 30ms to 420, then Show Vex every 30ms to 720.
      const close = await seekedPress(page, CLOSE_MS);
      await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
      const reopen = await seekedPress(page, OPEN_MS);
      await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "open");
      expect(close).toHaveLength(Math.floor(CLOSE_MS / SEEK_STEP_MS) + 1);
      expect(reopen).toHaveLength(Math.floor(OPEN_MS / SEEK_STEP_MS) + 1);
      for (const frame of [...close, ...reopen]) {
        expect(frame.card, `seek ${String(frame.at)}ms`).toEqual(card);
        expect(frame.section, `seek ${String(frame.at)}ms`).toEqual(section);
      }
      // The seeks moved her: open to the strip, and back to open.
      const insets = (frames: Frame[]): number[] => frames.map((f) => bottomInset(f.clip, section.height));
      expect(insets(close)[0]).toBeCloseTo(0, 0);
      expect(insets(close).at(-1)).toBeCloseTo(closedInset, 0);
      expect(insets(reopen)[0]).toBeCloseTo(closedInset, 0);
      expect(insets(reopen).at(-1)).toBeCloseTo(0, 0);

      // 2. Live: every painted frame of a close, then of an open.
      const liveClose = await liveFrames(page, false, "closed");
      const liveOpen = await liveFrames(page, false, "open");
      for (const frame of [...liveClose, ...liveOpen]) {
        expect(frame.card, `live ${frame.at.toFixed(1)}ms`).toEqual(card);
        expect(frame.section, `live ${frame.at.toFixed(1)}ms`).toEqual(section);
      }
      expect(liveClose.length).toBeGreaterThanOrEqual(2);
      expect(liveOpen.length).toBeGreaterThanOrEqual(2);

      // 3. Turned around: Hide Vex, then Show Vex 80ms later.
      const turned = await liveFrames(page, true, "open");
      for (const frame of turned) expect(frame.card, `turned ${frame.at.toFixed(1)}ms`).toEqual(card);
      const second = turned.findIndex((frame) => frame.at === -1);
      expect(second).toBeGreaterThan(0);
      const atPress = bottomInset(turned[second - 1]?.clip ?? "", section.height);
      const after = turned.slice(second + 1).map((frame) => bottomInset(frame.clip, section.height));
      for (const inset of after) expect(inset).toBeLessThanOrEqual(atPress + 0.5);
      expect(after.at(-1)).toBeCloseTo(0, 0);
    });

    test(`the card's pixels open and closed at ${sizeName(size)}`, async ({ page }) => {
      await open(page, size, "open");
      const openBox = await cardBox(page);
      const openPixels = await page.screenshot({
        clip: onScreen(openBox, size),
        animations: "disabled",
        caret: "hide",
      });
      await open(page, size, "closed");
      const closedBox = await cardBox(page);
      expect(closedBox).toEqual(openBox);
      const closedPixels = await page.screenshot({
        clip: onScreen(closedBox, size),
        animations: "disabled",
        caret: "hide",
      });
      expect(closedPixels.equals(openPixels)).toBe(true);
    });
  }
});
