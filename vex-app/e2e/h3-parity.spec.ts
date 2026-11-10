/**
 * H3 PARITY CAPTURES - every H3 shell harness state at the five window sizes
 * the revamp is checked at, for side-by-side review against the mockup
 * plates. Evidence for eyes, NOT a CI gate: it runs only with
 * VEX_H3_SHOTS=1 and VEX_H3_DIR set, like `qa-screenshots.spec.ts`.
 *
 * WHY THE HARNESS AND NOT THE ELECTRON APP. The built app stops at
 * SystemCheck without a running local runtime and an unlocked vault
 * (`smoke.spec.ts`), so none of these moments can be reached there on demand.
 * `vite.h3-shell.config.ts` serves the real shell over the real stylesheet
 * with only the preload bridge stood in for (`src/renderer/dev/h3-shell/`),
 * which is exactly what a layout capture needs.
 *
 * WHAT A CAPTURE IS. One state (`?state=<id>`) at one viewport, taken once the
 * harness stamps `data-vex-h3-ready` (its element on screen, its deliveries
 * landed, no query in flight) and the web fonts have settled. The browser is
 * pinned so two runs on two machines draw the same pixels: UTC (the harness
 * clock is 14:30 UTC on 3 November 2026), en-US, dark, reduced motion (the
 * product's own still frames, and no mid-animation frame), and Playwright's
 * `animations: "disabled"` for anything left running. Each capture also
 * proves the state is whole: no bridge read went unanswered and the page threw
 * nothing.
 *
 * THE CARD BOX. In the swap-waiting state the approval card's bounding box is
 * read at every size, with the Vex column as the state opens it and with it
 * hidden (`?vex=closed`), and written to `approval-card.json` beside the
 * images. H3's money rule is that showing or hiding Vex never moves a waiting
 * card; these numbers are where that starts being measured.
 *
 * THE WINDOW'S PLATFORM. The harness draws a macOS window unless asked
 * (`?os=`); VEX_H3_OS=win or linux takes the whole set on that platform's
 * chrome instead (the Windows caption overlay and its reserve), into the same
 * layout of files, so a second VEX_H3_DIR holds the second platform.
 *
 * OUTPUT, under VEX_H3_DIR:
 *   <width>x<height>/<state>.png                 every state
 *   <width>x<height>/swap-waiting--vex-closed.png the card with Vex hidden
 *   approval-card.json                           the card boxes
 *
 * Run: VEX_H3_SHOTS=1 VEX_H3_DIR=/abs/out pnpm --dir vex-app exec playwright test --project h3-parity
 */

import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { openHarness } from "./h3-harness-load.js";

const OUT_DIR = process.env.VEX_H3_DIR ?? "";

/** The window's platform for the whole set; the harness's own (mac) unless set. */
const OS = ["mac", "win", "linux"].find((os) => os === process.env.VEX_H3_OS) ?? null;

/** The sizes the H3 contract is checked at: the proof plates and the window floor. */
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1920, height: 1080 },
  { width: 1000, height: 720 },
] as const;

/** Every state but the bare shell, in the harness's own order (`states/index.ts`). */
const STATES = [
  "new-chat",
  "thinking",
  "thought",
  "swap-waiting",
  "approval-kinds",
  "filled",
  // A mission chat with its contract drafted: the next-step bar
  // (H3-DESKTOP.md section 5.10).
  "mission-ready",
  "portfolio",
  // The pages H3 draws no plate for, in the page frame (H3-DESKTOP.md
  // section 4.9): captured so the owner's plates can be judged against them.
  "activity",
  "markets",
  "how-vex-works",
  // Studio on a project (our approved Studio plates, H3-DESKTOP.md section
  // 4.9): one terminal, a split, and under 1024 the rail's files drawer.
  "studio-project",
  "studio-split",
  "studio-band-files",
  // The Lighter desk (section 4.9), for review beside its approved plates
  // (`?plate=lighter-desk` and the rest).
  "lighter-desk",
  "lighter-desk-review",
  "lighter-desk-two-step",
  "lighter-zen",
  "lighter-zen-folded",
  "lighter-zen-ask",
] as const;

/**
 * Harness states this spec does NOT capture, after the captured ones in the
 * harness's order. Settings and Memory render over reads the stand-in bridge
 * does not answer (the runtime, the preferences, the Superboard key, the
 * user's MCP servers, the wizard state; the memory register and inspector),
 * so a capture would fail the wholeness rule below, rightly. They stay in the
 * harness for a look in the browser until their fixtures exist.
 */
const HARNESS_ONLY = ["settings", "memory"] as const;

const CARD = '[data-vex-area="approvals-region"] [data-vex-area="approval-card"]';

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

type Size = (typeof SIZES)[number];

const sizeName = (size: Size): string => `${String(size.width)}x${String(size.height)}`;

function shotPath(size: Size, name: string): string {
  const dir = path.join(OUT_DIR, sizeName(size));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${name}.png`);
}

/** Open one state and wait until the harness says it is on screen and whole. */
async function open(page: Page, size: Size, query: string): Promise<void> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize(size);
  await openHarness(page, `/?${query}${OS === null ? "" : `&os=${OS}`}`, 20_000);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)));
    });
  });
  expect(await page.evaluate(() => window.__vexH3Harness.unanswered())).toEqual([]);
  expect(errors).toEqual([]);
}

async function capture(page: Page, size: Size, name: string): Promise<void> {
  await page.screenshot({ path: shotPath(size, name), animations: "disabled", caret: "hide" });
}

async function cardBox(page: Page): Promise<Box> {
  const box = await page.locator(CARD).boundingBox();
  expect(box).not.toBeNull();
  return box as Box;
}

test.skip(
  process.env.VEX_H3_SHOTS !== "1" || OUT_DIR === "",
  "H3 parity captures run only with VEX_H3_SHOTS=1 and VEX_H3_DIR set",
);

test.use({
  timezoneId: "UTC",
  locale: "en-US",
  colorScheme: "dark",
  contextOptions: { reducedMotion: "reduce" },
});

const cardBoxes: Record<string, { readonly vexAsOpened: Box; readonly vexClosed: Box }> = {};

test.describe.configure({ mode: "serial" });

test.describe("H3 parity captures", () => {
  test("the harness lists exactly the states this spec captures", async ({ page }) => {
    await page.goto("/?state=__index");
    const states = await page.evaluate(() => window.__vexH3Harness.states);
    expect(states.filter((id) => id !== "shell")).toEqual([...STATES, ...HARNESS_ONLY]);
  });

  for (const size of SIZES) {
    for (const state of STATES) {
      test(`${state} at ${sizeName(size)}`, async ({ page }) => {
        await open(page, size, `state=${state}`);
        await capture(page, size, state);
        if (state !== "swap-waiting") return;
        const vexAsOpened = await cardBox(page);
        await open(page, size, `state=${state}&vex=closed`);
        await capture(page, size, `${state}--vex-closed`);
        cardBoxes[sizeName(size)] = { vexAsOpened, vexClosed: await cardBox(page) };
      });
    }
  }

  test.afterAll(() => {
    if (Object.keys(cardBoxes).length === 0) return;
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUT_DIR, "approval-card.json"),
      `${JSON.stringify(
        {
          state: "swap-waiting",
          selector: CARD,
          os: OS ?? "mac",
          note: "CSS px from the viewport's top-left. vexAsOpened is the state's own Vex column choice; vexClosed is ?vex=closed.",
          boxes: cardBoxes,
        },
        null,
        2,
      )}\n`,
    );
  });
});
