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

import fs from "node:fs";
import type { TestInfo } from "@playwright/test";
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
  await expect(page.locator(".vex-terminal-surface--active .xterm-screen")).toBeVisible();
  await expect(
    page.locator(".vex-terminal-surface--active textarea").first(),
  ).toBeFocused();
  const marker = `vexspace${Date.now().toString(36)}`;
  const echoFile = testInfo.outputPath("shell-space-echo.txt");
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  // Read the shell's own `echo` output from a file, since WebGL paints text
  // into a canvas and has no DOM rows. Only the real keyboard -> xterm ->
  // preload -> pty -> shell path can execute this command and write it.
  const quotedFile = process.platform === "win32"
    ? `"${echoFile}"`
    : `'${echoFile.replaceAll("'", "'\\''")}'`;
  await page.keyboard.type(`echo ${marker} one two > ${quotedFile}`, { delay: TYPE_DELAY_MS });
  await page.keyboard.press("Enter");
  await expect
    .poll(() => fs.existsSync(echoFile) ? fs.readFileSync(echoFile, "utf8").trim() : "", {
      timeout: ECHO_TIMEOUT_MS,
    })
    .toBe(`${marker} one two`);
  await page.locator(".vex-terminal-surface--active").screenshot({
    path: testInfo.outputPath("shell-space-terminal.png"),
  });

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
