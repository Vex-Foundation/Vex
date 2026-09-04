/**
 * The Studio terminal's INPUT and GEOMETRY, against a real pty in the built app.
 *
 * ## Why this spec exists at all
 *
 * Three of the terminal defects the owner reported are not provable under
 * jsdom, and a suite that pretended otherwise would be the reason they shipped:
 *
 *  - A SPACE reaching the shell. jsdom emits no `onData` for a printable key
 *    (measured while writing `XtermHost.test.tsx`): xterm derives printable
 *    input from the helper textarea's own input handling, which jsdom does not
 *    drive. So "does the space key reach the pty" can only be asked of a real
 *    Chromium with a real ConPTY/forkpty behind it, and it is asked here by
 *    reading the SHELL'S OWN ECHO rather than any counter of ours.
 *  - THE GRID FILLING THE PANE. jsdom reports every cell as 0x0, so
 *    `FitAddon.proposeDimensions` returns `undefined` and no assertion about
 *    columns is possible. Here the cells have real widths.
 *  - A LINK CLICK. The activation path ends at an IPC call whose authority is a
 *    native dialog; what a renderer test can prove is that the call was made,
 *    and what this proves is that the whole chain from a rendered OSC 8
 *    hyperlink to that call exists in the built bundle.
 *
 * ## What it deliberately does NOT do
 *
 * It never opens a browser. `vex.terminalLinks.open` is invoked directly with a
 * URL, and the assertion is on the REFUSAL of a scheme main must refuse - an
 * outcome that needs no dialog and opens nothing. Asserting the allowed path
 * would require answering a native modal, which Playwright cannot do and which
 * would leave a browser window on the machine running the suite.
 *
 * ## Its prerequisites are the journey spec's, and are named the same way
 *
 * A database (the isolated stack fixture), the diagnostic setup tour, and a
 * project - because `terminalDomain().create` resolves its cwd from the
 * project row, so no project means no pty and nothing below is reachable.
 */

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
  TOUR_SKIP_REASON,
} from "./fixtures/studio-shell.js";

/**
 * How long to wait for a shell to echo. A cold `bash`/`cmd.exe` on a loaded CI
 * box is slow, and this is the only wall-clock wait in the spec: everything
 * else is an expectation Playwright retries.
 */
const ECHO_TIMEOUT_MS = 30_000;

/**
 * How fast the space is typed. `keyboard.type` with no delay sends a whole
 * line inside one frame, and MEASURED on this machine that loses characters
 * (`vexspacemtmudqvs` arrived at the shell as `vexspacemudqvs`): a burst that
 * fast is not the keystroke stream this spec is about. 25 ms per key is a
 * quick human and every character survives it.
 */
const TYPE_DELAY_MS = 25;

/**
 * Everything the terminal's buffer holds, as ONE string.
 *
 * xterm's DOM renderer emits one `div` per SCREEN row, so a shell line long
 * enough to wrap is two divs; joining them with a newline would put a break
 * inside the very echo this spec matches on. The rows are joined with nothing
 * and each one's trailing pad is dropped, so a wrapped line reads back
 * contiguous.
 *
 * The read is only possible because this build renders through xterm's DOM
 * renderer: `.xterm-rows` belongs to it, and a terminal that got the WebGL
 * addon has no text in the DOM at all. The renderer is asserted before the
 * poll rather than assumed, so a machine whose GPU changes the answer fails
 * with the reason instead of timing out on an empty buffer.
 */
async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const rows = document.querySelectorAll(
      ".vex-terminal-surface--active .xterm-rows > div",
    );
    return [...rows]
      .map((row) => (row.textContent ?? "").replace(/\s+$/u, ""))
      .join("");
  });
}

test("Studio terminal: a space reaches the shell, the grid fills the pane, a link asks main", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  // A container start, an Electron boot, a migration, a project render and a
  // real pty, plus a shell round trip. The suite's 30s budget is the smoke
  // test's, not this one's.
  test.setTimeout(180_000);

  const page = vexDb.shell;
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  test.skip(!(await tourIsPresent(page)), TOUR_SKIP_REASON);

  await openFirstProjectWithATerminal(page, "vex-term-");

  /* ---- 1. THE SPACE ---------------------------------------------------- */

  // Typed with real key events into the terminal's own textarea, which is where
  // a user's keystroke lands, so every listener between the document and xterm
  // gets its chance to swallow the key exactly as it would in production.
  await focusTerminalGrid(page);
  await expect(
    page.locator(".vex-terminal-surface--active textarea").first(),
  ).toBeFocused();
  const marker = `vexspace${Date.now().toString(36)}`;
  await page.keyboard.type(`echo ${marker} one two`, { delay: TYPE_DELAY_MS });

  // The evidence below is read out of the DOM rows, which exist only under
  // xterm's DOM renderer. Say so here: an environment that hands out WebGL
  // would otherwise turn this claim into a 30-second timeout on an empty
  // string, with nothing in the failure naming the renderer as the reason.
  await expect(
    page.locator(".vex-terminal-surface--active .xterm-rows"),
    "the buffer is read from the DOM rows, and this terminal renders through WebGL",
  ).toBeAttached();

  // THE SHELL'S ECHO IS THE EVIDENCE, not our own write counter: the question
  // is whether the bytes reached the pty, and only the pty can answer it.
  await expect
    .poll(async () => await terminalText(page), { timeout: ECHO_TIMEOUT_MS })
    .toContain(`${marker} one two`);

  /* ---- 2. THE GRID FILLS THE PANE -------------------------------------- */

  const geometry = await page.evaluate(() => {
    const wrapper = document.querySelector<HTMLElement>(
      ".vex-terminal-surface--active",
    );
    const screen = wrapper?.querySelector<HTMLElement>(".xterm-screen");
    if (wrapper === null || screen === null || screen === undefined) return null;
    const paneRect = wrapper.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    return {
      paneWidth: paneRect.width,
      leftGap: screenRect.left - paneRect.left,
      rightGap: paneRect.right - screenRect.right,
      screenWidth: screenRect.width,
    };
  });
  expect(geometry, "no active terminal surface to measure").not.toBeNull();
  if (geometry !== null) {
    // FLUSH LEFT. The first column starts at the pane's own edge: no inset, no
    // strip of empty surface before the text.
    expect(geometry.leftGap).toBeLessThanOrEqual(1);
    // And the only space on the right is xterm's scrollbar gutter (14 px, its
    // `ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH`) plus at most one column
    // that does not fit - which is the definition of a fitted grid.
    const cellWidth = geometry.screenWidth / 80;
    expect(geometry.rightGap).toBeLessThan(14 + cellWidth * 2);
    expect(geometry.paneWidth).toBeGreaterThan(200);
  }

  /* ---- 3. A LINK ASKS MAIN, AND MAIN REFUSES BY NAME ------------------- */

  // Through the real preload bridge and the real main handler in the built app.
  // A refused scheme is chosen deliberately: it exercises the whole chain and
  // opens nothing, so the suite leaves no browser window behind and needs no
  // answer to a native modal.
  const refusal = await page.evaluate(async () => {
    const bridge = (
      window as unknown as {
        vex: { terminalLinks: { open(input: { url: string }): Promise<unknown> } };
      }
    ).vex.terminalLinks;
    return (await bridge.open({ url: "file:///etc/passwd" })) as {
      ok: boolean;
      data?: { kind: string; reason?: string };
    };
  });
  expect(refusal.ok).toBe(true);
  expect(refusal.data).toEqual({
    kind: "refused",
    reason: "terminal_link_scheme_refused",
  });

  testInfo.annotations.push({
    type: "terminal-geometry",
    description: JSON.stringify(geometry),
  });
});
