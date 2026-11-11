/**
 * THE CARD PROOF (docs/design/H3-DESKTOP.md sections 3.6 and 6.4; plan row
 * S4-16): a waiting money card never moves, and is never covered, when Vex
 * hides or shows, on any frame. Desktop's port of the H3 mockup's own proof
 * (`h3-merged__plate-proof`), rewritten for D2 (owner decision 2026-11-09:
 * Vex at the right edge, hidden and shown whole; and 2026-11-10: her column
 * is a panel docked at the chat's top right, the chat running to the
 * window's edge under it), run as a CI gate: a card that moves, or that her
 * panel covers, fails the build.
 *
 * WHAT IS READ, in the H3 shell harness's `swap-waiting` state (the real
 * shell and the real approval card, with only the preload bridge stood in
 * for), at the five widths the mockup proved, 1280, 1366, 1440, 1920 and 2560:
 *
 *   1. HIDE AND SHOW, LIVE. The header's VEX key pressed as a person
 *      presses it, Hide Vex then Show Vex, the card, Vex's panel, the grid's
 *      tracks and the reading column's line and width read on every frame
 *      the browser paints for longer than her old wipe took (720ms). D2 has
 *      no wipe: her panel goes and comes at the press, so the frames must
 *      also show it hidden and shown, and a press that did nothing cannot
 *      pass.
 *   2. TURNED AROUND. Hide Vex, then Show Vex 80ms later: read on every
 *      painted frame; the card never moves and she ends shown.
 *   3. THE CHORD. Ctrl+Shift+B (Cmd+Shift+B on a Mac) hides and shows her
 *      the same way, the card standing.
 *   4. PIXELS. The card's own pixels in the shown render of the state
 *      against the hidden render (`?vex=closed`): not one may differ.
 *
 * On every frame of every path the card's box must equal the shown render's,
 * and the grid's column template and the reading column must not change
 * either; her panel, shown, is the shown render's box at the window's right
 * edge, and hidden it is gone (0 high, no ground), its room kept (section
 * 6.4). On no frame does the card meet her panel.
 *
 * The Lighter desk keeps its approved plate (section 4.9) and Kimm's section
 * with its wipe there, so its leg still seeks her motion frame by frame.
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
import { openHarness } from "./h3-harness-load.js";

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
/** Kimm's section: the desk's, and her band's under 1024. */
const SECTION = '[data-vex-area="kimm-section"]';
/** Her section's own key: the desk's corner key, the band's foot row. */
const KEY = '[data-vex-area="kimm-key"]';
/** D2's panel at the chat's top right, and the header's VEX key that hides and shows it. */
const COLUMN = '[data-vex-area="vex-sidebar"]';
const HEAD_KEY = '[data-vex-area="vex-key"]';

/** The seek step, as the mockup's proof read it. */
const SEEK_STEP_MS = 30;
/** Her motion's two legs (section 3.1; `DURATION_VEX_*_MS` in the renderer). */
const OPEN_MS = 720;
const CLOSE_MS = 420;
/** The strip her section folds to (`--vex-h3-strip-h`), before the wide zoom. */
const STRIP_PX = 56;

/**
 * The wide zoom at a window width (docs/design/H3-DESKTOP.md section 1.11,
 * `lib/wide-zoom.ts`): clamp(1, width / 1760, 1.5) to three decimals, 1.091
 * at 1920 and 1.455 at 2560 as VEX Cloud's `renders/checks.json` reads them.
 * Her console zooms with it, so her strip is 56 x zoom: 61.1 at 1920 and
 * 81.5 at 2560.
 */
function zoomAt(width: number): number {
  return Math.round(Math.min(1.5, Math.max(1, width / 1760)) * 1000) / 1000;
}

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

/**
 * Open the swap-waiting state with Vex as asked and wait until it is whole:
 * her column shown or hidden from 1024 up, her band resting closed under it.
 */
async function open(page: Page, size: Size, vex: "open" | "closed"): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(size);
  await openHarness(page, `/?state=swap-waiting&vex=${vex}`, 30_000);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  if (size.width >= 1024) {
    await expect(page.locator(COLUMN)).toHaveAttribute("data-vex-shown", vex === "open" ? "true" : "false");
  } else {
    await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
  }
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
 * The wipe's bottom inset in screen px, from a computed clip and her box's
 * screen height: `inset(0px)` when open, `inset(0px 0px calc(A% - Bpx))`
 * mid-wipe, and `inset(0px 0px calc(100% - 56px))` at the strip. A computed
 * clip is in her section's own pixels, which the wide zoom scales (section
 * 1.11), so it is read at the box's own height and scaled back by `zoom`.
 */
function bottomInset(clip: string, height: number, zoom = 1): number {
  const own = height / zoom;
  const calc = /calc\(\s*([\d.e+-]+)%\s*-\s*([\d.e+-]+)px\s*\)/.exec(clip);
  if (calc !== null) return ((Number(calc[1]) / 100) * own - Number(calc[2])) * zoom;
  const parts = /inset\(([^)]*)\)/.exec(clip)?.[1]?.trim().split(/\s+/) ?? [];
  const bottom = parts.length >= 3 ? parts[2] : parts[0];
  if (bottom === undefined) return 0;
  if (bottom.endsWith("%")) return (Number.parseFloat(bottom) / 100) * height;
  return Number.parseFloat(bottom) * zoom;
}

/**
 * The Vex toggle's chord as the app announces it (`aria-keyshortcuts` on its
 * key). The app reads its platform from the window's user agent, which the
 * harness sets per `?os=` (a Mac by default), so the chord is the page's, never
 * the machine's that runs the browser: a Linux CI runner still presses Cmd.
 */
async function appChord(page: Page): Promise<string> {
  const chord = await page.locator('[aria-keyshortcuts$="Shift+B"]').first().getAttribute("aria-keyshortcuts");
  expect(chord, "the Vex key announces its chord").toMatch(/^(Meta|Control)\+Shift\+B$/);
  return chord ?? "";
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

/** One painted frame of a D2 press: the card, her panel, the tracks, the reading column, whether she shows. */
interface D2Frame {
  readonly at: number;
  readonly card: Box;
  readonly column: Box;
  readonly columns: string;
  /** The transcript's column: its x and width, the reading line and width. */
  readonly reading: string;
  readonly shown: string | null;
}

/**
 * Press the header's VEX key at each of `presses` (ms after the first, which
 * is at 0) and read the card, her column, the grid's column template and her
 * shown state on every painted frame until `ms` has passed. Each later press
 * is marked by a frame read just before it, at `at: -1`.
 */
async function d2Frames(page: Page, presses: readonly number[], ms: number): Promise<D2Frame[]> {
  return page.evaluate(
    async ({ card, column, key, presses, ms }) => {
      const cardEl = document.querySelector(card);
      const columnEl = document.querySelector<HTMLElement>(column);
      const keyEl = document.querySelector<HTMLElement>(key);
      const frameEl = document.querySelector<HTMLElement>(".vex-shell-frame");
      if (cardEl === null || columnEl === null || keyEl === null || frameEl === null) {
        throw new Error("the card, her column, the VEX key or the frame is missing");
      }
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const frames: D2Frame[] = [];
      const transcript = document.querySelector("[data-vex-transcript-column]");
      const read = (at: number): D2Frame => {
        const line = transcript?.getBoundingClientRect();
        return {
          at,
          card: box(cardEl),
          column: box(columnEl),
          columns: getComputedStyle(frameEl).gridTemplateColumns,
          reading: line === undefined ? "none" : `${String(line.x)} ${String(line.width)}`,
          shown: columnEl.getAttribute("data-vex-shown"),
        };
      };
      const start = performance.now();
      for (const at of presses) {
        if (at === 0) {
          keyEl.click();
          continue;
        }
        window.setTimeout(() => {
          frames.push(read(-1));
          keyEl.click();
        }, at);
      }
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          const at = performance.now() - start;
          frames.push(read(at));
          if (at > ms) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return frames;
    },
    { card: CARD, column: COLUMN, key: HEAD_KEY, presses, ms },
  );
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
  await openHarness(page, `/?state=lighter-desk-review&vex=${vex}`, 30_000);
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
      await page.getByRole("button", { name: "Expand sidebar" }).click();
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
 * THE CHATS PANEL LEG (docs/design/H3-DESKTOP.md sections 4.12 and 6): under
 * 1280 the chats column is the rail at every moment, and its key slides the
 * chats panel over the chat beside it. Nothing in the grid changes, so a waiting card
 * never moves while the panel opens or closes, on any frame: read seeked
 * every 30ms through both slides and live on every painted frame, with the
 * grid's column template read beside the card. The panel must be seen to
 * move, so a slide that never ran cannot pass.
 */
const PANEL_SIZES = [
  { width: 1024, height: 768 },
  { width: 1180, height: 800 },
  { width: 1279, height: 800 },
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
      // The panel's own slide, scrim and row entries; a running square's
      // blink in a row is a loop with no end, not the press's motion.
      const running = document.getAnimations().filter((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target ?? null;
        const end = animation.effect?.getComputedTiming().endTime;
        return (
          target !== null
          && (panelEl.contains(target) || target === panelEl.previousElementSibling)
          && typeof end === "number"
          && Number.isFinite(end)
        );
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
    test(`the chats panel opens and closes over the chat at ${sizeName(size)}`, async ({ page }) => {
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
      // Open, the chats panel lies beside Vex's panel, never under it: hers
      // stands at the right edge, past the chats panel's 248.
      const chatsPanelBox = await page.evaluate(
        (panel) => {
          const r = (document.querySelector(panel) as HTMLElement).getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        },
        PANEL,
      );
      const vexPanelBox = (await page.locator(COLUMN).boundingBox()) as Box;
      expect(vexPanelBox.x).toBe(size.width - 280);
      expect(chatsPanelBox.x + chatsPanelBox.width).toBeLessThanOrEqual(vexPanelBox.x);
      expect(seekClose[0]?.panelX).toBe(76);
      expect(seekClose.at(-2)?.panelX).toBeLessThan(0);
      expect(liveOpen.length).toBeGreaterThanOrEqual(2);
      expect(liveClose.length).toBeGreaterThanOrEqual(2);
      expect(await cardBox(page)).toEqual(card);
    });
  }
});

/**
 * THE BAND LEG (docs/design/H3-DESKTOP.md section 1.10; VEX Cloud's rule (a)
 * under 1024): at 1000 x 720, the window minimum, her console is a 48 line
 * under the header and her section a band laid over the chat's top. The
 * band rests while a card waits: with the swap card waiting it is closed
 * whatever the person chose (`?vex=open` asks for it open), her keys say why
 * instead of acting, and a press on the Vex key, on the console line's key
 * or on the chord changes nothing, on any painted frame, nor does the chats
 * panel opening and closing over the chat. The grid's rows and columns are
 * read beside the card throughout. With no card waiting the band does open
 * and close, so a band that never opened cannot pass.
 */
const BAND_SIZE = { width: 1000, height: 720 } as const;

interface BandFrame {
  readonly at: number;
  readonly card: Box;
  readonly rows: string;
  readonly columns: string;
  readonly phase: string | null;
}

/** Press a control (by selector) and read the card on every painted frame for `ms`. */
async function bandPress(page: Page, control: string, ms: number): Promise<BandFrame[]> {
  return page.evaluate(
    async ({ card, section, control, ms }) => {
      const cardEl = document.querySelector(card);
      const frameEl = document.querySelector<HTMLElement>(".vex-shell-frame");
      const sectionEl = document.querySelector<HTMLElement>(section);
      const controlEl = document.querySelector<HTMLElement>(control);
      if (cardEl === null || frameEl === null || sectionEl === null || controlEl === null) {
        throw new Error(`the card, the frame, her band or ${control} is missing`);
      }
      const frames: BandFrame[] = [];
      const read = (at: number): BandFrame => {
        const r = cardEl.getBoundingClientRect();
        return {
          at,
          card: { x: r.x, y: r.y, width: r.width, height: r.height },
          rows: getComputedStyle(frameEl).gridTemplateRows,
          columns: getComputedStyle(frameEl).gridTemplateColumns,
          phase: sectionEl.getAttribute("data-kimm-phase"),
        };
      };
      const start = performance.now();
      controlEl.click();
      await new Promise<void>((resolve) => {
        const tick = (): void => {
          const at = performance.now() - start;
          frames.push(read(at));
          if (at > ms) {
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return frames;
    },
    { card: CARD, section: SECTION, control, ms },
  );
}

test.describe("H3 card proof under 1024: the band never moves a waiting card", () => {
  test(`her band rests while the card waits, and nothing moves it at ${sizeName(BAND_SIZE)}`, async ({ page }) => {
    // Asked open: the band still rests, because a card waits.
    await open(page, BAND_SIZE, "closed");
    await openHarness(page, "/?state=swap-waiting&vex=open", 30_000);
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const frameEl = page.locator('[data-vex-area="shell-frame"]');
    await expect(frameEl).toHaveAttribute("data-vex-tier", "band");
    await expect(frameEl).toHaveAttribute("data-vex-band", "closed");
    await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
    const key = page.locator('[data-vex-area="vex-key"]');
    await expect(key).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('[data-vex-area="vex-console-line-key"]')).toHaveAttribute("aria-disabled", "true");
    // The console line is the frame's 48 row: the chat starts under it.
    const rows = await frameEl.evaluate((el) => getComputedStyle(el).gridTemplateRows);
    expect(rows.split(" ").slice(0, 2)).toEqual(["76px", "48px"]);
    const card = await cardBox(page);
    const columns = await frameEl.evaluate((el) => getComputedStyle(el).gridTemplateColumns);

    for (const control of ['[data-vex-area="vex-key"]', '[data-vex-area="vex-console-line-key"]']) {
      const frames = await bandPress(page, control, OPEN_MS + 120);
      for (const frame of frames) {
        expect(frame.card, `${control} ${frame.at.toFixed(1)}ms`).toEqual(card);
        expect(frame.rows, `${control} ${frame.at.toFixed(1)}ms`).toBe(rows);
        expect(frame.columns, `${control} ${frame.at.toFixed(1)}ms`).toBe(columns);
        expect(frame.phase, `${control} ${frame.at.toFixed(1)}ms`).toBe("closed");
      }
    }
    // The chord, from anywhere: the same rest.
    await page.keyboard.press(await appChord(page));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
    expect(await cardBox(page)).toEqual(card);

    // The chats panel over what is read: it covers, it never moves the card.
    const panelOpen = await bandPress(page, PANEL_KEY, OPEN_MS + 120);
    const panelClose = await bandPress(page, PANEL_KEY, CLOSE_MS + 120);
    for (const frame of [...panelOpen, ...panelClose]) {
      expect(frame.card, `panel ${frame.at.toFixed(1)}ms`).toEqual(card);
      expect(frame.rows, `panel ${frame.at.toFixed(1)}ms`).toBe(rows);
      expect(frame.columns, `panel ${frame.at.toFixed(1)}ms`).toBe(columns);
    }
  });

  test(`with no card waiting her band opens and closes over the chat at ${sizeName(BAND_SIZE)}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setViewportSize(BAND_SIZE);
    await openHarness(page, "/?state=new-chat", 30_000);
    // It starts closed on every visit: no band at all.
    await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    const frameEl = page.locator('[data-vex-area="shell-frame"]');
    const columns = await frameEl.evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    const rows = await frameEl.evaluate((el) => getComputedStyle(el).gridTemplateRows);
    await page.locator('[data-vex-area="vex-key"]').click();
    await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "open");
    await expect(frameEl).toHaveAttribute("data-vex-band", "open");
    // Under the line's rule, the chat's width, min(clamp(220, 34dvh, 296), 40dvh) high.
    const band = (await page.locator(SECTION).boundingBox()) as Box;
    expect(band.x).toBe(76);
    expect(band.y).toBe(124);
    expect(band.width).toBe(924);
    expect(band.height).toBeCloseTo(Math.min(Math.max(220, 0.34 * 720), 296, 0.4 * 720), 1);
    // The grid never changed; the band is a box over the chat.
    expect(await frameEl.evaluate((el) => getComputedStyle(el).gridTemplateColumns)).toBe(columns);
    expect(await frameEl.evaluate((el) => getComputedStyle(el).gridTemplateRows)).toBe(rows);
    // A press anywhere on its foot row closes it, and focus goes to the Vex key.
    const foot = (await page.locator(KEY).boundingBox()) as Box;
    expect(foot.height).toBe(56);
    expect(foot.width).toBe(924);
    await page.mouse.click(foot.x + 40, foot.y + foot.height / 2);
    await expect(page.locator(SECTION)).toHaveAttribute("data-kimm-phase", "closed");
    await expect(frameEl).toHaveAttribute("data-vex-band", "closed");
    await expect(page.locator('[data-vex-area="vex-key"]')).toBeFocused();
    expect(errors).toEqual([]);
  });
});

/**
 * THE CONVERSATION COLUMN AND THE WIDE WINDOWS (docs/design/H3-DESKTOP.md
 * sections 1.11, 6.3 and 6.6; owner decision 2026-11-10, "a central wide
 * space for the chat"): the transcript and the card stand on one column
 * centred in the room left of Vex's panel, the room less a 40 x zoom gutter
 * each side, capped at 1120 x zoom (288 to 1120 at 1440, 333 to 1555 at
 * 1920, 347.8 to 1620.2 at the owner's 2000, 449.2 to 2078.8 at 2560), the
 * card exactly the column's width and the chat's title on its line; the
 * docked approval band a box on the column, 24 x zoom off the foot; Vex's
 * panel is 280 at the right edge, flush under the header, as tall as what it
 * holds and never down past the chat's composer group, her portrait card its
 * width and 280 / 0.78 high where the window has the room (a tall 1440 x
 * 1250), giving way first, to 160 at the least, where it has not; her bars
 * are its foot strip; the foot row is 72 x zoom and its rule.
 */
const WIDE = [
  { size: { width: 1440, height: 900 }, zoom: 1, line: 288, right: 1120, foot: 73 },
  { size: { width: 1440, height: 1250 }, zoom: 1, line: 288, right: 1120, foot: 73 },
  { size: { width: 1920, height: 1080 }, zoom: 1.091, line: 333.04, right: 1554.96, foot: 79.55 },
  { size: { width: 2000, height: 1250 }, zoom: 1.136, line: 347.84, right: 1620.16, foot: 82.79 },
  { size: { width: 2560, height: 1440 }, zoom: 1.455, line: 449.2, right: 2078.8, foot: 105.76 },
] as const;

test.describe("D2 card proof: the conversation column, her panel and the foot row", () => {
  for (const wide of WIDE) {
    test(`the conversation column, her panel and the foot row at ${sizeName(wide.size)}`, async ({ page }) => {
      await open(page, wide.size, "open");
      expect(zoomAt(wide.size.width)).toBe(wide.zoom);
      const read = await page.evaluate(
        ({ card }) => {
          const title = document.querySelector<HTMLElement>('[data-vex-head-cell="title"]');
          const cardEl = document.querySelector<HTMLElement>(card);
          const column = document.querySelector<HTMLElement>("[data-vex-transcript-column]");
          const account = document.querySelector<HTMLElement>('[data-vex-area="account-cell"]');
          const band = document.querySelector<HTMLElement>('[data-vex-area="approval-dock"] [data-vex-area="approval-foot"]');
          if (title === null || cardEl === null || column === null || account === null || band === null) {
            throw new Error("the title, the card, the transcript, the account cell or the docked band is missing");
          }
          const zoom = Number(getComputedStyle(document.documentElement).getPropertyValue("--vex-zoom"));
          // The composer group's top: the highest of its parts with a box.
          const parts = [...document.querySelectorAll<HTMLElement>('[data-vex-composer-dock], [data-vex-area="approval-dock"]')]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.height > 0);
          return {
            zoom,
            title: title.getBoundingClientRect().x + Number.parseFloat(getComputedStyle(title).paddingLeft),
            transcript: column.getBoundingClientRect().x,
            transcriptRight: column.getBoundingClientRect().right,
            card: cardEl.getBoundingClientRect().x,
            cardRight: cardEl.getBoundingClientRect().right,
            foot: account.getBoundingClientRect().height,
            band: band.getBoundingClientRect().x,
            bandRight: band.getBoundingClientRect().right,
            bandBottom: band.getBoundingClientRect().bottom,
            composerTop: Math.min(...parts.map((r) => r.top)),
          };
        },
        { card: CARD },
      );
      expect(read.zoom).toBe(wide.zoom);
      expect(Math.abs(read.title - wide.line), `title ${String(read.title)}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(read.transcript - wide.line), `transcript ${String(read.transcript)}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(read.transcriptRight - wide.right), `transcript right ${String(read.transcriptRight)}`).toBeLessThanOrEqual(0.5);
      // The card is the column's width, no wider.
      expect(Math.abs(read.card - wide.line), `card ${String(read.card)}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(read.cardRight - wide.right), `card right ${String(read.cardRight)}`).toBeLessThanOrEqual(0.5);
      // Centred in the room: as far from the chats' 248 as from her panel.
      expect(Math.abs(read.transcript - 248 - (wide.size.width - 280 - read.transcriptRight))).toBeLessThanOrEqual(0.5);
      expect(read.foot).toBeCloseTo(wide.foot, 1);
      // Her panel at the right edge, flush under the header, 280 wide.
      const column = (await page.locator(COLUMN).boundingBox()) as Box;
      expect(column.x).toBe(wide.size.width - 280);
      expect(column.y).toBe(76);
      expect(column.width).toBe(280);
      // As tall as what it holds, never down past the composer group, and
      // the chat's own ground under it.
      expect(column.y + column.height).toBeLessThanOrEqual(read.composerTop + 0.5);
      // The docked band is a box on the column (section 6.5; owner decision
      // 2026-11-10), in the composer box's seat: the column's x and width,
      // 24 x zoom off the window's foot.
      expect(Math.abs(read.band - wide.line), `band ${String(read.band)}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(read.bandRight - wide.right), `band right ${String(read.bandRight)}`).toBeLessThanOrEqual(0.5);
      expect(Math.abs(wide.size.height - 24 * wide.zoom - read.bandBottom), `band foot ${String(read.bandBottom)}`).toBeLessThanOrEqual(0.5);
      // Her card fills the panel inside its 1px rule on the left; it keeps
      // 280 / 0.78 where the window has the room and gives way to 160 at
      // the least where it has not.
      const portrait = (await page.locator('[data-vex-area="vex-portrait-card"]').boundingBox()) as Box;
      expect(portrait.x).toBe(wide.size.width - 279);
      expect(portrait.y).toBe(76);
      expect(portrait.width).toBe(279);
      expect(portrait.height).toBeGreaterThanOrEqual(160);
      expect(portrait.height).toBeLessThanOrEqual(280 / 0.78 + 0.5);
      if (wide.size.height >= 1080) expect(portrait.height).toBeCloseTo(280 / 0.78, 0);
      // Her bars are her panel's foot strip, 48 high; no bars cell in the row.
      const bars = (await page.locator('[data-vex-area="vex-column-bars"]').boundingBox()) as Box;
      expect(bars.height).toBe(48);
      expect(bars.y + bars.height).toBeLessThanOrEqual(column.y + column.height);
      await expect(page.locator('[data-vex-area="tagline-cell"]')).toHaveCount(0);
      // Nothing readable lies under her panel: the card and the transcript's
      // column end at or before its left edge.
      const card = await cardBox(page);
      expect(card.x + card.width).toBeLessThanOrEqual(column.x);
      expect(read.transcriptRight).toBeLessThanOrEqual(column.x);
    });
  }
});

/**
 * THE COMPOSER BOX AND THE BAND'S BOX (docs/design/H3-DESKTOP.md section
 * 6.5; owner decision 2026-11-10, "Framed box on the column"): the composer
 * is one framed box on the conversation column, 24 x zoom off the window's
 * foot from 1280 up and 16 under it, the chat's track less 16 each side
 * under 1024; a waiting card's docked band takes the same seat; while the
 * field holds the focus the frame is the white focus rule, and no part of
 * either box lies under Vex's panel.
 */
const BOXES = [
  { size: { width: 1000, height: 720 }, x: 92, right: 984, lift: 16 },
  { size: { width: 1280, height: 800 }, x: 288, right: 960, lift: 24 },
  { size: { width: 1440, height: 900 }, x: 288, right: 1120, lift: 24 },
  { size: { width: 2000, height: 1250 }, x: 347.84, right: 1620.16, lift: 24 * 1.136 },
] as const;

test.describe("D2 card proof: the composer is a framed box on the column, and the band takes its seat", () => {
  for (const box of BOXES) {
    test(`the composer box and the band's box at ${sizeName(box.size)}`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(box.size);
      const read = async (selector: string): Promise<Box & { readonly frame: string }> =>
        page.evaluate((sel) => {
          const el = document.querySelector<HTMLElement>(sel);
          if (el === null) throw new Error(`${sel} is missing`);
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, frame: getComputedStyle(el).borderTopColor };
        }, selector);
      const near = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5;

      await openHarness(page, "/?state=thinking", 30_000);
      const composer = await read('[data-vex-area="chat-composer"]');
      expect(near(composer.x, box.x), `composer x ${String(composer.x)}`).toBe(true);
      expect(near(composer.x + composer.width, box.right), `composer right ${String(composer.x + composer.width)}`).toBe(true);
      expect(near(composer.y + composer.height, box.size.height - box.lift), `composer foot ${String(composer.y + composer.height)}`).toBe(true);
      // The live-step row sits on its top rule, on the column.
      const live = await read('[data-vex-area="composer-mission-strip"]');
      expect(near(live.x, composer.x) && near(live.width, composer.width)).toBe(true);
      expect(near(live.y + live.height, composer.y)).toBe(true);
      // Focus in the field: the frame is the white focus rule.
      expect(composer.frame).not.toBe("rgb(255, 255, 255)");
      await page.locator("textarea[data-vex-composer-field]").focus();
      expect((await read('[data-vex-area="chat-composer"]')).frame).toBe("rgb(255, 255, 255)");
      // Never under her panel.
      if (box.size.width >= 1024) {
        const panel = (await page.locator(COLUMN).boundingBox()) as Box;
        expect(composer.x + composer.width).toBeLessThanOrEqual(panel.x);
      }

      await openHarness(page, "/?state=swap-waiting", 30_000);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });
      const band = await read('[data-vex-area="approval-dock"] [data-vex-area="approval-foot"]');
      expect(near(band.x, box.x), `band x ${String(band.x)}`).toBe(true);
      expect(near(band.x + band.width, box.right), `band right ${String(band.x + band.width)}`).toBe(true);
      expect(near(band.y + band.height, box.size.height - box.lift), `band foot ${String(band.y + band.height)}`).toBe(true);
      // The composer gives way to it.
      await expect(page.locator('[data-vex-area="chat-composer"]')).toBeHidden();
      expect(errors).toEqual([]);
    });
  }
});

test.describe.configure({ mode: "serial" });

test.describe("D2 card proof: a waiting money card never moves when Vex hides or shows", () => {
  for (const size of SIZES) {
    test(`hidden and shown, live, turned around and by the chord at ${sizeName(size)}`, async ({ page }) => {
      await open(page, size, "open");
      const card = await cardBox(page);
      const column = (await page.locator(COLUMN).boundingBox()) as Box;
      expect(column).not.toBeNull();
      // Her panel stands at the right edge, a fixed 280 (section 6.3), and
      // the card never runs under it.
      expect(column.x + column.width).toBe(size.width);
      expect(column.width).toBe(280);
      expect(card.x + card.width).toBeLessThanOrEqual(column.x);
      const columns = await page.evaluate(
        () => getComputedStyle(document.querySelector(".vex-shell-frame") as Element).gridTemplateColumns,
      );
      // Two tracks: the chats and the chat to the window's edge, no track for her.
      expect(columns.split(" ")).toHaveLength(2);
      const reading = await page.evaluate(() => {
        const r = document.querySelector("[data-vex-transcript-column]")?.getBoundingClientRect();
        return r === undefined ? "none" : `${String(r.x)} ${String(r.width)}`;
      });
      const same = (frames: readonly D2Frame[], name: string): void => {
        for (const frame of frames) {
          const at = `${name} ${frame.at.toFixed(1)}ms`;
          expect(frame.card, at).toEqual(card);
          expect(frame.columns, at).toBe(columns);
          expect(frame.reading, at).toBe(reading);
          // Shown, her panel is the shown render's box; hidden it is gone,
          // 0 high at the same x, its room kept.
          if (frame.shown === "true") expect(frame.column, at).toEqual(column);
          else expect(frame.column, at).toEqual({ ...column, height: 0 });
          expect(frame.card.x + frame.card.width, at).toBeLessThanOrEqual(frame.column.x);
        }
      };

      // 1. Live: Hide Vex, every painted frame past her old 720ms wipe, then
      // Show Vex the same way. Each press acted: she is hidden, then shown.
      const hide = await d2Frames(page, [0], OPEN_MS + 120);
      same(hide, "hide");
      expect(hide.length).toBeGreaterThanOrEqual(2);
      expect(hide.at(-1)?.shown).toBe("false");
      await expect(page.locator(HEAD_KEY)).toHaveAttribute("aria-label", "Show Vex");
      const show = await d2Frames(page, [0], OPEN_MS + 120);
      same(show, "show");
      expect(show.at(-1)?.shown).toBe("true");
      await expect(page.locator(HEAD_KEY)).toHaveAttribute("aria-label", "Hide Vex");

      // 2. Turned around: Hide Vex, then Show Vex 80ms later.
      const turned = await d2Frames(page, [0, 80], OPEN_MS + 120);
      same(turned, "turned");
      const second = turned.findIndex((frame) => frame.at === -1);
      expect(second).toBeGreaterThan(0);
      // The first press hid her before the second showed her again.
      expect(turned[second]?.shown).toBe("false");
      expect(turned.at(-1)?.shown).toBe("true");

      // 3. The chord, from anywhere: the same, the card standing.
      const chord = await appChord(page);
      for (const shown of ["false", "true"]) {
        await page.keyboard.press(chord);
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator(COLUMN)).toHaveAttribute("data-vex-shown", shown);
        expect(await cardBox(page)).toEqual(card);
        const now = (await page.locator(COLUMN).boundingBox()) as Box | null;
        // Hidden, the empty aside has no box Playwright can measure.
        expect(now ?? { ...column, height: 0 }).toEqual(shown === "true" ? column : { ...column, height: 0 });
      }
    });

    test(`the card's pixels shown and hidden at ${sizeName(size)}`, async ({ page }) => {
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

/**
 * A TOAST NEVER LIES OVER A WAITING CARD (docs/design/H3-DESKTOP.md section
 * 5.1; VEX Cloud's DG-3 decision 16). The toast stands 12 under the header,
 * centred on the content column; where a waiting approval card would meet
 * it, the toast takes the header's message slot instead. Read in a real
 * browser: a toast is raised through the window's own notification model,
 * and its box (the region's) must meet no `[data-vex-area="approval-card"]`,
 * at the widths and heights a person runs, on the chat's swap card and on
 * the desk's Review order card. A short window must show the detour.
 */
test.describe("H3 card proof: a toast never lies over a waiting card", () => {
  const TOAST_SIZES = [
    { width: 1280, height: 720 },
    { width: 1280, height: 800 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ] as const;
  const STATES = ["swap-waiting", "lighter-desk-review"] as const;

  /**
   * Raise a toast and read its box, its seat and every card's box once it
   * stands. A card that sits in an open modal dialog (the desk's Review order)
   * holds the top layer, where the model defers every ordinary toast to the
   * center: then there is no toast box at all.
   */
  async function raise(page: Page, message: string, withAction: boolean): Promise<{
    readonly seat: string | null;
    readonly toast: Box | null;
    readonly cards: readonly Box[];
    readonly modalCard: boolean;
    readonly panel: Box | null;
  }> {
    await page.evaluate(
      ({ text, action }) => {
        window.__vexH3Harness.notify({
          severity: "error",
          scope: { kind: "global" },
          source: "h3-card-proof",
          message: text,
          // Sticky, so it holds while it is read.
          sticky: true,
          actions: action ? [{ id: "retry", label: "Retry", rank: "secondary", run: () => {} }] : [],
        });
      },
      { text: message, action: withAction },
    );
    // The seat settles in the frame it is measured; give the observers a frame.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))),
    );
    return page.evaluate(() => {
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const stack = document.querySelector('[data-vex-area="notification-stack"]');
      const cards = [...document.querySelectorAll('[data-vex-area="approval-card"]')].filter((card) => {
        const r = card.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      // D2's panel, where the shell has one (the desk keeps its column).
      const panel = document.querySelector('.vex-shell-frame[data-vex-panel="shown"] [data-vex-area="vex-sidebar"]');
      return {
        seat: stack?.getAttribute("data-vex-toast-seat") ?? null,
        toast: stack === null ? null : box(stack),
        cards: cards.map(box),
        modalCard: cards.some((card) => card.closest("dialog[open]") !== null),
        panel: panel === null ? null : box(panel),
      };
    });
  }

  const meet = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  for (const state of STATES) {
    for (const size of TOAST_SIZES) {
      test(`${state} at ${String(size.width)}x${String(size.height)}`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.setViewportSize(size);
        await openHarness(page, `/?state=${state}`, 30_000);
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        for (const [message, action] of [
          ["Could not refresh the Lighter account. Try again.", false],
          [
            "Could not reach the Lighter gateway to read the order book; the desk keeps its last read until it answers again.",
            true,
          ],
        ] as const) {
          const read = await raise(page, message, action);
          expect(read.cards.length, "a card is on screen").toBeGreaterThan(0);
          if (read.modalCard) {
            // The Review order holds the top layer: the toast waits in the
            // center and is drawn nowhere.
            expect(read.toast).toBeNull();
            continue;
          }
          expect(read.toast, "the toast is on screen").not.toBeNull();
          for (const card of read.cards) {
            const toast = read.toast as Box;
            expect(meet(toast, card), `toast ${JSON.stringify(toast)} over card ${JSON.stringify(card)}`).toBe(false);
          }
          // Floating, it stands over the chat's room, clear of Vex's panel
          // (section 6.3): centred on the chat less her panel's 280.
          if (read.panel !== null && read.seat === "float") {
            const toast = read.toast as Box;
            expect(meet(toast, read.panel), `toast ${JSON.stringify(toast)} over her panel`).toBe(false);
          }
          // The card's top strip (network, REAL FUNDS) starts under the
          // header's rule at a short window: there the toast must have
          // stepped into the header.
          if (state === "swap-waiting" && size.height <= 720) expect(read.seat).toBe("header");
          await page.evaluate(() => {
            for (const button of document.querySelectorAll<HTMLButtonElement>(
              '[data-vex-area="notification-toast"] .vex-notification-dismiss',
            )) {
              button.click();
            }
          });
          await expect(page.locator('[data-vex-area="notification-stack"]')).toHaveCount(0);
        }
        expect(errors).toEqual([]);
      });
    }
  }
});
