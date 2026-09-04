/**
 * THE DOOR INTO STUDIO, and the one place that decides what happens when it is
 * missing.
 *
 * Every Studio spec reaches the shell the same way: the built bundle renders a
 * diagnostic setup tour only when it was compiled with `VITE_VEX_SETUP_TOUR=1`,
 * and the tour is what jumps past the cold-open routing into `appShell`. That
 * fact was spelled out four times, in four specs, with four slightly different
 * messages and only two of them honouring `VEX_E2E_REQUIRE_TOUR`. A rule with
 * four spellings is a rule that drifts, and the direction it drifts in is a
 * silent skip: a build without the flag turned a required Studio gate into a
 * green run that proved nothing.
 *
 * So the pair lives here, once:
 *
 *   - `VITE_VEX_SETUP_TOUR=1` on the BUILD step bakes the tour in;
 *   - `VEX_E2E_REQUIRE_TOUR=1` on the TEST step declares that this run covers
 *     Studio, which turns a missing tour into a FAILURE with the repair in the
 *     message rather than a skip.
 *
 * A run that declares neither still skips, and says why.
 */

import { expect, type Page } from "@playwright/test";

/**
 * Does this run PROMISE Studio coverage?
 *
 * Read once, at module scope, so the expectation is a property of the run
 * rather than something a walk could reinterpret mid-flight.
 */
export const TOUR_REQUIRED = process.env.VEX_E2E_REQUIRE_TOUR === "1";

/** The reason a run WITHOUT the promise skips with. */
export const TOUR_SKIP_REASON =
  "this walk reaches the shell through the diagnostic setup tour, which is " +
  "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
  "vex-app build` and rerun";

/**
 * Is the tour in this build, and may this run proceed without it?
 *
 * @throws when the run declared `VEX_E2E_REQUIRE_TOUR=1` and the built bundle
 * renders no tour - the flags are a pair and losing either one must be loud.
 * @returns whether the tour is present; the caller skips on `false`.
 */
export async function tourIsPresent(page: Page): Promise<boolean> {
  const present = (await page.locator("[data-vex-setup-tour]").count()) > 0;
  if (TOUR_REQUIRED && !present) {
    // FAIL, never skip: this run declared that it covers the Studio journey.
    throw new Error(
      "VEX_E2E_REQUIRE_TOUR=1 declares this run must cover the Studio journey, " +
        "but the built bundle renders no `[data-vex-setup-tour]`, so it was " +
        "built without `VITE_VEX_SETUP_TOUR=1`. Those two flags are a pair: " +
        "`VITE_VEX_SETUP_TOUR=1` on the build step and `VEX_E2E_REQUIRE_TOUR=1` " +
        "on the test step of job `vex-app-e2e` in `.github/workflows/ci.yml`. " +
        "Losing either one would otherwise turn this required gate into a " +
        "silent skip that proves nothing about Studio. Rebuild with " +
        "`VITE_VEX_SETUP_TOUR=1 pnpm --dir vex-app build` and rerun.",
    );
  }
  return present;
}

/** Jump to a view through the diagnostic setup tour. */
export async function tourTo(page: Page, view: string): Promise<void> {
  const tour = page.locator("[data-vex-setup-tour]");
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: view, exact: true }).click();
  await expect(page.locator(`[data-vex-screen="${view}"]`)).toBeVisible();
}

/**
 * Reach the Studio shell at a fixed viewport.
 *
 * @returns `false` when this build has no tour and the run did not require one,
 * so the caller can `test.skip` with {@link TOUR_SKIP_REASON}. Under
 * `VEX_E2E_REQUIRE_TOUR=1` it never returns `false`: {@link tourIsPresent}
 * throws instead.
 */
export async function enterStudio(page: Page): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  // WAIT FOR THE COLD OPEN TO SETTLE. `useSetupOrchestrator` routes
  // asynchronously: its probes resolve seconds after first paint and then SET
  // THE VIEW, so a tour jump made before that lands is silently undone. A fresh
  // `VEX_CONFIG_DIR` is a first run, so the settled handoff is systemCheck (the
  // fact `smoke.spec.ts` pins) and its arrival is the observable state that
  // says the orchestrator has stopped writing views.
  // 120s rather than the default: the orchestrator's probes are real (Docker,
  // the vault, the database), and this helper also runs after a RELOAD, where
  // the same settled handoff has to be waited for a second time.
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible({
    timeout: 120_000,
  });
  if (!(await tourIsPresent(page))) return false;
  await tourTo(page, "appShell");
  const shell = page.locator('[data-vex-screen="appShell"]');
  //
  // THE RETURN LEG IS A POINTER, and that is a measured gap rather than a
  // preference. `Ctrl+Shift+A` is a TOGGLE in the table and its handler answers
  // both directions (`useStudioKeybindings.test.tsx` drives the return), but
  // the only listener for it is mounted by `StudioCenter`, which `AppShell`
  // renders only while the mode is `studio`. So there is nothing listening in
  // an Agent session yet: the chord into Studio needs the hook mounted in a
  // seat that survives the mode switch, which belongs to `AppShell` and not to
  // the keyboard module. When that mount lands, the two lines below become
  // `await page.keyboard.press("Control+Shift+A")`.
  await page
    .getByRole("radiogroup", { name: "Runtime mode" })
    .getByRole("radio", { name: "Studio" })
    .click();
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");
  return true;
}

/**
 * Create a project, open it, and hand back a terminal that is AT ITS PROMPT.
 *
 * Both terminal specs need the same door and both had their own copy of it,
 * which is how one of them ended up clicking a locator the other had already
 * measured as wrong. The two facts that copy has to carry:
 *
 *  - THE ROW'S ACCESSIBLE NAME IS NOT THE PROJECT NAME. An expanded
 *    `RailRow` sets no `aria-label` (`components/ui/rail-list.tsx:75` labels
 *    only the collapsed rail), so the name is computed from the button's
 *    contents: the title plus the permission pill that `ProjectRailRow`
 *    renders in its trailing slot, i.e. `"<name> restricted"`. An anchored
 *    `^<name>$` therefore matches nothing and times out. The prefix is what
 *    the row and only the row starts with: the sibling menu button is
 *    `"Actions for <name>"` (`studio-copy.ts:423`), which starts with
 *    "Actions".
 *  - A LOGIN SHELL MAY NOT BE AT A PROMPT YET. A `sudo` in the developer's
 *    `.bashrc` blocks on a password read, and every keystroke a spec types
 *    would go to that read instead of to the shell. One interrupt hands the
 *    prompt over, and it is harmless on a shell that already had one.
 *
 * @param namePrefix distinguishes the specs' projects in a shared database;
 * the timestamp suffix makes each run's project unique.
 * @returns the created project's name.
 */
export async function openFirstProjectWithATerminal(
  page: Page,
  namePrefix: string,
): Promise<string> {
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
  const projectName = `${namePrefix}${Date.now().toString(36)}`;
  await creator.getByLabel("Name").fill(projectName);
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await creator.getByRole("button", { name: "Close" }).click();
  await expect(creator).toBeHidden();

  await sidebar.getByRole("button", { name: new RegExp(`^${projectName}\\b`) }).click();

  const center = page.locator('[data-vex-area="studio-center"]');
  await expect(center).toBeVisible();
  await expect(
    center.getByRole("tablist", { name: "Studio terminals and files" }),
  ).toBeVisible();
  // The visible surface is the one the registry marked active; until that
  // class is on, the pane measures the geometry of wherever it last was.
  await expect(page.locator(".vex-terminal-surface--active")).toBeVisible();

  await settleLoginShell(page);
  return projectName;
}

/**
 * Put the caret in the terminal by clicking its GRID.
 *
 * Not the helper textarea: xterm parks it at 0x0 off-screen until the terminal
 * is focused, and a zero-size element is one Playwright refuses to click. The
 * click focuses the textarea, which is where the keystrokes then land.
 */
export async function focusTerminalGrid(page: Page): Promise<void> {
  const screen = page.locator(".vex-terminal-surface--active .xterm-screen");
  const box = await screen.boundingBox();
  expect(box, "no terminal grid to focus").not.toBeNull();
  if (box === null) throw new Error("unreachable");
  await page.mouse.click(
    box.x + Math.min(40, box.width / 2),
    box.y + Math.min(40, box.height / 2),
  );
}

/** How long a login shell may take to reach a prompt before the run counts as stuck. */
const LOGIN_SHELL_SETTLE_TIMEOUT_MS = 60_000;
/** How long each interrupt is given to land before the buffer is read again. */
const SETTLE_POLL_MS = 1_000;

/**
 * The active terminal's visible text, one entry per screen row, or `null` when
 * this build renders through xterm's WebGL addon.
 *
 * `.xterm-rows` belongs to xterm's DOM renderer and is gone under WebGL, so
 * `null` means "this environment cannot answer", not "the terminal is empty".
 * The caller degrades rather than looping blind against a buffer it cannot see.
 */
async function activeTerminalRows(page: Page): Promise<readonly string[] | null> {
  return page.evaluate(() => {
    const container = document.querySelector(
      ".vex-terminal-surface--active .xterm-rows",
    );
    if (container === null) return null;
    return [...container.children].map((row) =>
      (row.textContent ?? "").replace(/\s+$/u, ""),
    );
  });
}

/**
 * Wait until the shell behind the active terminal is AT ITS OWN PROMPT.
 *
 * The developer machine this suite runs on has a `sudo service postgresql
 * start` in `.bashrc`, so a fresh login shell is not at a prompt: it is inside
 * `sudo`'s password read, and every character a spec types goes into that read
 * instead of to the shell. MEASURED: a single blind `Control+C` a second after
 * the terminal attaches is a RACE - it can land before `sudo` has even printed
 * its prompt, leaving `^C[sudo] password for kubas:` on screen and the spec
 * typing into the password field.
 *
 * So the interrupt is driven by what the buffer says rather than by a timer: an
 * interrupt is sent while the last line is a password read, and the wait ends
 * only when a prompt line has been the last line for two consecutive reads, one
 * second apart. A shell that was already at its prompt settles on the second
 * read without a single keystroke being sent.
 *
 * @throws when no prompt appears within {@link LOGIN_SHELL_SETTLE_TIMEOUT_MS},
 * with the last line in the message: a spec that typed into whatever that is
 * would fail later with no trace of the reason.
 */
export async function settleLoginShell(page: Page): Promise<void> {
  await focusTerminalGrid(page);
  const deadline = Date.now() + LOGIN_SHELL_SETTLE_TIMEOUT_MS;
  let settledOnce: string | null = null;
  let last = "";
  while (Date.now() < deadline) {
    const rows = await activeTerminalRows(page);
    if (rows === null) {
      // WebGL: the buffer is unreadable here, so the best available action is
      // the one interrupt, sent once.
      await page.keyboard.press("Control+C");
      await page.waitForTimeout(SETTLE_POLL_MS);
      return;
    }
    last = [...rows].reverse().find((row) => row.trim() !== "") ?? "";
    if (/password for|\[sudo\]/iu.test(last)) {
      await page.keyboard.press("Control+C");
      settledOnce = null;
    } else if (/[$#>]$/u.test(last.trimEnd())) {
      if (settledOnce === last) return;
      settledOnce = last;
    } else {
      settledOnce = null;
    }
    await page.waitForTimeout(SETTLE_POLL_MS);
  }
  throw new Error(
    "the terminal's shell never reached a prompt within " +
      `${String(LOGIN_SHELL_SETTLE_TIMEOUT_MS)}ms; its last line is: ${last}`,
  );
}
