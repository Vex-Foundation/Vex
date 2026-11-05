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

/** A window size: the proof's five, and the narrower legs' own. */
interface Size {
  readonly width: number;
  readonly height: number;
}

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
async function seekedPress(page: Page, durationMs: number, cardSelector: string = CARD): Promise<Frame[]> {
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
    { card: cardSelector, section: SECTION, key: KEY, duration: durationMs, step: SEEK_STEP_MS },
  );
}

/**
 * Press her corner key (and, for the turn, again 80ms later) and read the
 * card, her section and her clip on every painted frame until her section
 * rests as `rest`. The second press is marked with `at: -1`.
 */
async function liveFrames(
  page: Page,
  turn: boolean,
  rest: "open" | "closed",
  cardSelector: string = CARD,
): Promise<Frame[]> {
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
    { card: cardSelector, section: SECTION, key: KEY, turn, rest },
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

/**
 * THE DESK LEG (docs/design/H3-DESKTOP.md sections 3.6 and 4.9; plan row
 * S8-11): on the Lighter desk the waiting card is the desk's own Review
 * order, in the ticket's column at the desk's right edge, beside her column.
 * Her section opening and closing never moves it, on any frame; the chats
 * column's Expand (which changes the window's columns) never moves it
 * either; and while it waits the desk chat's drag handle is not drawn, so
 * nothing can move it.
 */
const DESK_SIZES = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;
const DESK_CARD = '[data-vex-area="lighter-desk-approval"] [data-vex-area="approval-card"]';

async function openDesk(page: Page, size: (typeof DESK_SIZES)[number], vex: "open" | "closed"): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(size);
  await page.goto(`/?state=lighter-desk-review&vex=${vex}`);
  await page.waitForSelector('[data-vex-h3-ready="true"]', { timeout: 30_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", vex);
  expect(await page.evaluate(() => window.__vexH3Harness.unanswered())).toEqual([]);
  expect(errors).toEqual([]);
}

async function deskCardBox(page: Page): Promise<Box> {
  const box = await page.locator(DESK_CARD).boundingBox();
  expect(box).not.toBeNull();
  return box as Box;
}

test.describe("H3 card proof on the Lighter desk: the Review order never moves", () => {
  for (const size of DESK_SIZES) {
    test(`her section seeked and live, the rail's Expand, no drag at ${sizeName(size)}`, async ({ page }) => {
      await openDesk(page, size, "open");
      const card = await deskCardBox(page);
      const section = (await page.locator(SECTION).boundingBox()) as Box;
      expect(section).not.toBeNull();
      // While the review waits the drag between the desk and her column is
      // not drawn.
      await expect(page.locator(".vex-shell-handle")).toHaveCount(0);

      const close = await seekedPress(page, CLOSE_MS, DESK_CARD);
      await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
      const reopen = await seekedPress(page, OPEN_MS, DESK_CARD);
      await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "open");
      for (const frame of [...close, ...reopen]) {
        expect(frame.card, `seek ${String(frame.at)}ms`).toEqual(card);
        expect(frame.section, `seek ${String(frame.at)}ms`).toEqual(section);
      }
      const closedInset = section.height - STRIP_PX;
      const insets = (frames: Frame[]): number[] => frames.map((f) => bottomInset(f.clip, section.height));
      expect(insets(close).at(-1)).toBeCloseTo(closedInset, 0);
      expect(insets(reopen).at(-1)).toBeCloseTo(0, 0);

      const liveClose = await liveFrames(page, false, "closed", DESK_CARD);
      const liveOpen = await liveFrames(page, false, "open", DESK_CARD);
      for (const frame of [...liveClose, ...liveOpen]) {
        expect(frame.card, `live ${frame.at.toFixed(1)}ms`).toEqual(card);
      }

      // The chats column's Expand opens the 248 for the visit: the desk
      // narrows at its left, the card at its right stands.
      await page.getByRole("button", { name: "Expand sessions sidebar" }).click();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
      );
      await page.waitForTimeout(400);
      expect(await deskCardBox(page)).toEqual(card);
    });

    test(`the Review order's pixels open and closed at ${sizeName(size)}`, async ({ page }) => {
      await openDesk(page, size, "open");
      const openBox = await deskCardBox(page);
      const openPixels = await page.screenshot({ clip: onScreen(openBox, size as Size), animations: "disabled", caret: "hide" });
      await openDesk(page, size, "closed");
      const closedBox = await deskCardBox(page);
      expect(closedBox).toEqual(openBox);
      const closedPixels = await page.screenshot({ clip: onScreen(closedBox, size as Size), animations: "disabled", caret: "hide" });
      expect(closedPixels.equals(openPixels)).toBe(true);
    });
  }
});

/**
 * THE CHATS PANEL LEG (docs/design/H3-DESKTOP.md section 4.12): under 1280
 * the chats column is the rail at every moment, and its key slides the chats
 * panel over Vex's column. Nothing in the grid changes, so a waiting card
 * never moves while the panel opens or closes, on any frame: read seeked
 * every 30ms through both slides and live on every painted frame, with the
 * grid's column template read beside the card. The panel must be seen to
 * move, so a slide that never ran cannot pass.
 */
const PANEL_SIZES = [
  { width: 1024, height: 768 },
  { width: 1180, height: 800 },
] as const;
const PANEL = '[data-vex-area="chats-panel"]';
const PANEL_KEY = '[data-chats-panel-key="toggle"]';

interface PanelFrame {
  readonly at: number;
  readonly card: Box;
  readonly columns: string;
  readonly panelX: number;
}

/** Press the rail's key and read every seek of the slide it starts, or every painted frame. */
async function panelPress(page: Page, mode: "seek" | "live", durationMs: number): Promise<PanelFrame[]> {
  return page.evaluate(
    async ({ card, panel, key, mode, duration, step }) => {
      const cardEl = document.querySelector(card);
      const panelEl = document.querySelector<HTMLElement>(panel);
      const keyEl = document.querySelector<HTMLElement>(key);
      const frameEl = document.querySelector<HTMLElement>(".vex-shell-frame");
      if (cardEl === null || panelEl === null || keyEl === null || frameEl === null) {
        throw new Error("the card, the panel, its key or the frame is missing");
      }
      const read = (at: number): PanelFrame => {
        const r = cardEl.getBoundingClientRect();
        return {
          at,
          card: { x: r.x, y: r.y, width: r.width, height: r.height },
          columns: getComputedStyle(frameEl).gridTemplateColumns,
          panelX: panelEl.getBoundingClientRect().x,
        };
      };
      const wasOpen = panelEl.hasAttribute("inert");
      keyEl.click();
      while (panelEl.hasAttribute("inert") === wasOpen) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const running = document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
        return target !== null && (panelEl.contains(target) || target === panelEl.previousElementSibling);
      });
      if (running.length === 0) throw new Error("the press started no motion");
      const frames: PanelFrame[] = [];
      if (mode === "seek") {
        for (const animation of running) animation.pause();
        for (let at = 0; at <= duration; at += step) {
          for (const animation of running) animation.currentTime = at;
          frames.push(read(at));
        }
        for (const animation of running) animation.finish();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        frames.push(read(duration + 1));
        return frames;
      }
      const start = performance.now();
      await new Promise<void>((resolve, reject) => {
        const tick = (): void => {
          const at = performance.now() - start;
          frames.push(read(at));
          if (running.every((animation) => animation.playState === "finished" || animation.playState === "idle") && at > 120) {
            resolve();
            return;
          }
          if (at > 6000) {
            reject(new Error("the panel never came to rest"));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return frames;
    },
    { card: CARD, panel: PANEL, key: PANEL_KEY, mode, duration: durationMs, step: SEEK_STEP_MS },
  );
}

test.describe("H3 card proof: the chats panel never moves a waiting card", () => {
  for (const size of PANEL_SIZES) {
    test(`the chats panel opens and closes over Vex's column at ${sizeName(size)}`, async ({ page }) => {
      await open(page, size, "open");
      const card = await cardBox(page);
      const columns = await page.evaluate(
        () => getComputedStyle(document.querySelector(".vex-shell-frame") as Element).gridTemplateColumns,
      );
      // The rail at every moment, the panel closed.
      expect(columns.split(" ")[0]).toBe("76px");
      await expect(page.locator(PANEL)).toHaveAttribute("inert", "");

      const seekOpen = await panelPress(page, "seek", OPEN_MS);
      const seekClose = await panelPress(page, "seek", CLOSE_MS);
      const liveOpen = await panelPress(page, "live", OPEN_MS);
      const liveClose = await panelPress(page, "live", CLOSE_MS);
      for (const [name, frames] of [
        ["seek open", seekOpen],
        ["seek close", seekClose],
        ["live open", liveOpen],
        ["live close", liveClose],
      ] as const) {
        for (const frame of frames) {
          expect(frame.card, `${name} ${frame.at.toFixed(1)}ms`).toEqual(card);
          expect(frame.columns, `${name} ${frame.at.toFixed(1)}ms`).toBe(columns);
        }
      }
      // The panel moved: out of the rail to its place at x 76, and back.
      expect(seekOpen[0]?.panelX).toBeLessThan(0);
      expect(seekOpen.at(-1)?.panelX).toBe(76);
      expect(seekClose[0]?.panelX).toBe(76);
      expect(seekClose.at(-2)?.panelX).toBeLessThan(0);
      expect(liveOpen.length).toBeGreaterThanOrEqual(2);
      expect(liveClose.length).toBeGreaterThanOrEqual(2);
      expect(await cardBox(page)).toEqual(card);
    });
  }
});

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
