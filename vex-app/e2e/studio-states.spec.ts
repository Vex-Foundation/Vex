/**
 * STUDIO STATES: the audit's screenshot walk, kept in the branch so a state and
 * its capture are reproducible instead of living in a scratchpad.
 *
 * The audit (`ux-audit-2026-09-02.md`) was produced by a throwaway spec that
 * drove every Studio state and photographed it. What made that pass worth
 * keeping is not the images: it is that a browser proved things vitest cannot -
 * layout, theme resolution, and whether a control is actually LEGIBLE - and each
 * finding it produced needs the same walk to prove it fixed. So the walk lives
 * here, one section per builder, and each section holds real assertions that run
 * on every invocation plus screenshots that are written only when a capture pass
 * asks for them.
 *
 * ## Two modes, one spec
 *
 * ASSERTIONS always run. SCREENSHOTS are written only when `VEX_UX_SHOTS=1` and
 * `VEX_UX_SHOTS_DIR` names a directory; a run without them still proves the
 * states, it just photographs nothing. That split is deliberate: a spec whose
 * only output is an image proves nothing in CI, and a capture pass that cannot
 * be run on demand leaves every future fix unverifiable against its before.
 *
 * ## Prerequisites, named where they fail
 *
 * THE SETUP TOUR, exactly as `studio-project-journey.spec.ts` documents it: the
 * shell is reached through the diagnostic tour, baked in at build time by
 * `VITE_VEX_SETUP_TOUR=1`. Without it this spec skips.
 *
 * THE BRIDGE BINARY, for any section that CREATES a project: the installer
 * writes no file when it cannot find the program its configs point at. Sections
 * that only open dialogs over an existing row do not need it.
 *
 * ## Sections
 *
 * - UX-4, below: the consent grammar (the Full-access grant, delete, repair) and
 *   the outcome rows. Owned by the consent lane.
 * - UX-3, at the foot: the welcome hero and the host status pill. Its per-cause
 *   half needs a build made with `VITE_VEX_STUDIO_HOST_PREVIEW=1` and says so
 *   when the build it runs against has no preview panel.
 * - UX-2, last: the rail and the explorer. The collapsed spine, the explorer
 *   pane's resolved height and its seam, the unified search, and the
 *   auto-collapse threshold measured on both sides. Owned by the rail lane.
 *
 * Other lanes append their own `test.describe` block; nothing here is shared
 * state, so two sections cannot interfere.
 */

import fs from "node:fs";
import path from "node:path";

import type { Page, TestInfo } from "@playwright/test";
import { test, expect, type VexDatabaseFixture } from "./fixtures/vex-app-with-database.js";

/** Where a capture pass writes. Empty means: assert, photograph nothing. */
const SHOTS_DIR =
  process.env.VEX_UX_SHOTS === "1" ? (process.env.VEX_UX_SHOTS_DIR ?? "") : "";

/**
 * Photograph a state, if this run is a capture pass.
 *
 * Fenced from the assertions on purpose: a screenshot that fails to write must
 * not take down a run whose job is proving the state, and a run that writes
 * nothing is the ordinary case.
 */
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === "") return;
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS_DIR, `${name}.png`) });
}

async function tourTo(page: Page, view: string): Promise<void> {
  const tour = page.locator("[data-vex-setup-tour]");
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: view, exact: true }).click();
  await expect(page.locator(`[data-vex-screen="${view}"]`)).toBeVisible();
}

/** Reach the Studio shell, or skip with the reason. */
async function enterStudio(page: Page): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('[data-vex-screen="systemCheck"]')).toBeVisible();
  if ((await page.locator("[data-vex-setup-tour]").count()) === 0) return false;
  await tourTo(page, "appShell");
  const shell = page.locator('[data-vex-screen="appShell"]');
  await page
    .getByRole("radiogroup", { name: "Runtime mode" })
    .getByRole("radio", { name: "Studio" })
    .click();
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");
  return true;
}

/* ========================= UX-4: the consent grammar ======================== */

test("UX-4 consent grammar: the strip, the grant, and the outcome rows", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(
    !reached,
    "this spec reaches the shell through the diagnostic setup tour, which is " +
      "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
      "vex-app build` and rerun",
  );

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();

  /* ---- 02..04: the creator, and the Full-access grant ------------------ */

  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();
  const strip = creator.locator("[data-vex-dialog-consequence]");
  // Restricted grants nothing outside the folder, so there is no strip. A
  // consequence strip that is always present is chrome, and chrome is not read.
  await expect(strip).toHaveCount(0);
  await shot(page, "02-creator-empty");

  const projectName = `vex-ux4-${Date.now().toString(36)}`;
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await shot(page, "03-creator-filled");

  const create = creator.getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeEnabled();

  // Clicked on the CARD, which is what a user clicks: the radio input itself is
  // `sr-only`, so driving it directly drives a node no pointer can reach and
  // Playwright waits out its actionability check. `studio-project-journey
  // .spec.ts` records the same for the agent checkboxes.
  await creator.getByText("Full access", { exact: true }).click();
  // VISIBLE, not merely present: the strip's whole purpose is that it cannot be
  // scrolled away from the button that acts on it, and only a browser can say
  // whether it is on screen.
  await expect(strip).toBeVisible();
  await expect(strip).toContainText("act outside its folder");
  const acknowledge = creator.locator("[data-vex-consent-acknowledge]");
  await expect(acknowledge).toBeVisible();
  await expect(acknowledge).not.toBeChecked();
  // The grant is CONFIRMED, not merely picked.
  await expect(create).toBeDisabled();
  await shot(page, "04-creator-full-access");

  await acknowledge.check();
  await expect(create).toBeEnabled();
  // Back and forth: the second grant is a new grant and asks again.
  await creator.getByText("Restricted", { exact: true }).click();
  await expect(strip).toHaveCount(0);
  await creator.getByText("Full access", { exact: true }).click();
  await expect(acknowledge).not.toBeChecked();
  await expect(create).toBeDisabled();

  // Create the project RESTRICTED: the rest of the walk is about the dialogs
  // over an existing row, and the grant has already been proven.
  await creator.getByText("Restricted", { exact: true }).click();
  await expect(create).toBeEnabled();

  /* ---- 05: the report, with a state glyph on every row ----------------- */

  await create.click();
  const pinned = creator.locator("[data-vex-dialog-pinned]");
  await expect(pinned).toBeVisible({ timeout: 120_000 });
  const report = pinned.locator("[data-vex-render-outcome]");
  await expect(report).toBeVisible();
  const runFailure = await report.getAttribute("data-vex-run-failure");
  expect(
    runFailure,
    "the render reported a run failure; `bridge_unavailable` means this build " +
      "has no bridge binary - run `pnpm --dir vex-app run build:bridge:dev` " +
      "before the e2e build",
  ).toBeNull();
  // Every row carries a glyph. The rows were a wall of sentences with nothing
  // to scan (audit I4).
  const outcomeRows = report.locator("[data-vex-artifact-status]");
  const outcomeCount = await outcomeRows.count();
  expect(outcomeCount).toBeGreaterThan(0);
  for (let i = 0; i < outcomeCount; i += 1) {
    await expect(
      outcomeRows.nth(i).locator(".vex-state-dot, .vex-state-matrix"),
    ).toHaveCount(1);
  }
  // The two panels no longer share one heading (audit I3).
  await expect(creator.getByRole("heading", { name: "What Vex did" })).toBeVisible();
  await expect(creator.getByRole("heading", { name: "Project files" })).toBeVisible();
  await shot(page, "05-creator-report");
  await creator.getByRole("button", { name: "Close" }).click();
  await expect(creator).toBeHidden();

  /* ---- 06: a refusal, by name ----------------------------------------- */

  await sidebar.getByRole("button", { name: "New project" }).click();
  const second = page.getByRole("dialog", { name: "New project" });
  await second.getByLabel("Name").fill(projectName);
  await second.getByRole("button", { name: "Create", exact: true }).click();
  await expect(second.locator("[data-vex-dialog-pinned]")).toBeVisible({
    timeout: 60_000,
  });
  await shot(page, "06-creator-error-slug-taken");
  await second.getByRole("button", { name: "Cancel" }).click();
  await expect(second).toBeHidden();

  /* ---- 09: settings, and the grant on an existing project -------------- */

  const actions = sidebar.getByRole("button", { name: `Actions for ${projectName}` });
  await actions.click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const settings = page.getByRole("dialog", { name: "Project settings" });
  await expect(settings).toBeVisible();
  const save = settings.getByRole("button", { name: /^(Save|Saving)$/ });
  await settings.getByText("Full access", { exact: true }).click();
  const settingsStrip = settings.locator("[data-vex-dialog-consequence]");
  await expect(settingsStrip).toBeVisible();
  // TO WHAT: the folder this grant is about, by path, not "this project".
  await expect(settingsStrip).toContainText(projectName);
  await expect(save).toBeDisabled();
  await shot(page, "09-project-settings");
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();

  /* ---- 10: repair is not dressed as a destructive act (audit A10) ------ */

  await actions.click();
  await page.getByRole("menuitem", { name: "Repair" }).click();
  const repair = page.getByRole("dialog", { name: "Repair project files" });
  await expect(repair).toBeVisible();
  const repairStrip = repair.locator("[data-vex-dialog-consequence]");
  await expect(repairStrip).toBeVisible();
  await expect(repairStrip).toHaveAttribute("data-vex-dialog-consequence", "notice");
  await expect(
    repair.getByRole("button", { name: "Repair" }),
  ).toHaveAttribute("data-vex-button", "primary");
  // The safer choice has focus (rule 08).
  await expect(repair.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shot(page, "10-project-repair");
  await page.keyboard.press("Escape");
  await expect(repair).toBeHidden();

  /* ---- 11..12: delete, and the strip that follows the checkbox --------- */

  await actions.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const del = page.getByRole("dialog", { name: "Delete project?" });
  await expect(del).toBeVisible();
  const delStrip = del.locator("[data-vex-dialog-consequence]");
  await expect(delStrip).toBeVisible();
  await expect(delStrip).toHaveAttribute("data-vex-dialog-consequence", "warning");
  await expect(delStrip).toContainText("cannot be undone");
  await expect(delStrip).toContainText("stay on disk");
  await expect(del.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shot(page, "11-project-delete");

  await del.getByLabel("Project name").fill("wrong-name");
  await expect(del.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await shot(page, "12-project-delete-mismatch");
  await page.keyboard.press("Escape");
  await expect(del).toBeHidden();

  testInfo.annotations.push({
    type: "ux4-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});

/* ========================= UX-1: the terminal surface ======================= */

/**
 * Switch the app to one explicit theme, so a capture pass photographs the theme
 * it says it does. The box's own default is not a theme this spec may assume:
 * the audit's light-theme findings were only visible because the machine that
 * ran it happened to default to celeris.
 */
async function pickTheme(page: Page, theme: "chronos" | "celeris"): Promise<void> {
  // The diagnostic tour docks bottom-left over the profile button; the QA pass
  // hides it before opening the menu, so this does too.
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.display = "none";
  });
  await page.getByRole("button", { name: /Open menu/ }).click();
  await page.getByRole("menuitem", { name: /Settings/ }).click();
  await expect(page.locator("[data-vex-settings-preferences]")).toBeVisible();
  await page.locator("[data-vex-settings-appearance]").scrollIntoViewIfNeeded();
  await page.locator(`[data-vex-theme-cube="${theme}"]`).click();
  await expect(page.locator("html")).toHaveAttribute("data-vex-theme", theme);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-vex-screen="appShell"]')).toBeVisible();
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.display = "";
  });
}

/** The alpha channel of a computed colour, or 1 for an opaque form. */
async function backgroundAlpha(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel: string) => {
    const node = document.querySelector(sel);
    if (node === null) return -1;
    const colour = window.getComputedStyle(node).backgroundColor;
    const match = /rgba?\([^)]*?(?:,\s*([\d.]+))?\)$/.exec(colour);
    if (colour === "transparent" || colour === "rgba(0, 0, 0, 0)") return 0;
    return match?.[1] === undefined ? 1 : Number(match[1]);
  }, selector);
}

/**
 * Is this element ACTUALLY on screen at its own centre - not merely laid out?
 *
 * `toBeVisible` reads a layout box and a computed style, so it passes for an
 * element an ancestor's `overflow` has clipped away or another surface covers.
 * The first per-cause capture pass photographed sixteen pills and not one card
 * for exactly that reason. `elementFromPoint` is the browser's own answer to
 * "what would a user's click land on here", which is the question.
 */
async function isOnScreenAt(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel: string) => {
    const node = document.querySelector(sel);
    if (node === null) return false;
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return false;
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    return hit !== null && node.contains(hit);
  }, selector);
}

/**
 * Wait for a surface's enter animation to finish before photographing it.
 *
 * `vex-surface-enter` fades a card in, so a screenshot taken the instant after
 * the click catches it part-way and shows whatever is behind it through the
 * card - which is indistinguishable, in the image, from the missing-background
 * defect the audit found on the shell picker (B5). Settling first makes the
 * picture mean what it appears to mean.
 */
async function settled(page: Page, selector: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((sel: string) => {
          const node = document.querySelector(sel);
          return node === null
            ? "0"
            : window.getComputedStyle(node).opacity;
        }, selector),
      { timeout: 5_000 },
    )
    .toBe("1");
}

/**
 * UX-1: the states the terminal findings are argued from.
 *
 * WHY THESE ARE BROWSER ASSERTIONS AND NOT VITEST ONES. Both defects this
 * section guards were invisible to a green jsdom suite, for the same reason:
 * they are about what a real style engine resolves.
 *
 *  - B5, the shell picker: the popup asked for `bg-surface-raised`, a utility
 *    the theme does not define, so Tailwind emitted no rule and the rows sat on
 *    whatever was behind them. In jsdom a class list is a string; only a browser
 *    can say the popup HAS a background.
 *  - B1, the terminal palette: the background token was the CSS keyword
 *    `transparent`, which xterm's own parser rejects, so the canvas painted
 *    opaque black in both themes. The renderer's own paint is what settles it.
 *
 * `VEX_UX_THEME` picks the theme; a capture pass runs it once per theme.
 */
test("UX-1 terminal surface: the card, the tab, the cluster and the picker", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(
    !reached,
    "this spec reaches the shell through the diagnostic setup tour, which is " +
      "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
      "vex-app build` and rerun",
  );

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(sidebar).toBeVisible();

  /* ---- a project with a terminal in it -------------------------------- */

  const projectName = `vex-ux1-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();
  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const tabs = centre.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs.getByRole("tab").first()).toBeVisible({ timeout: 60_000 });

  /* ---- 13: the card, the numbered tab, the header --------------------- */

  // I8: the workspace is a card inset from the shell's ground, not an
  // edge-to-edge rectangle. The inset is the visual difference the mockup draws.
  await expect(centre.locator("[data-vex-workspace-card]")).toBeVisible();
  // I5: `Terminal 1`, never the shell's path, and never in caps.
  await expect(tabs.getByRole("tab", { name: /Terminal 1/ })).toBeVisible();
  const heading = centre.getByRole("heading", { name: "Terminal 1" });
  await expect(heading).toBeVisible();
  expect(await heading.evaluate((node) => window.getComputedStyle(node).textTransform))
    .toBe("none");
  await expect(centre.locator("[data-vex-terminal-shell]").first()).toBeVisible();
  await shot(page, `${theme}-13-workspace-first-terminal`);

  await centre.locator(".xterm-helper-textarea, textarea").first().focus();
  await page.keyboard.type("ls -la && echo done");
  await page.keyboard.press("Enter");
  await shot(page, `${theme}-14-terminal-with-output`);

  /* ---- 15: three terminals, told apart by name ------------------------ */

  await tabs.getByRole("button", { name: "New terminal" }).click();
  await expect(tabs.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();
  await tabs.getByRole("button", { name: "New terminal" }).click();
  await expect(tabs.getByRole("tab", { name: /Terminal 3/ })).toBeVisible();
  // The strip at rest is a list of NAMES: no split control sits beside a tab.
  await expect(tabs.getByRole("button", { name: /^Split/ })).toHaveCount(0);
  await shot(page, `${theme}-15-terminal-three-tabs`);

  /* ---- 16: split, from the header that names the terminal ------------- */

  await centre.getByRole("button", { name: "Split Terminal 3 side by side" }).click();
  await expect(centre.getByRole("separator").first()).toBeVisible();
  await shot(page, `${theme}-16-terminal-split`);

  /* ---- 17: the picker, and the surface B5 was missing ----------------- */

  await centre.getByRole("button", { name: "Shell for new terminals" }).first().click();
  const listbox = page.getByRole("listbox", { name: "Shell for new terminals" });
  await expect(listbox).toBeVisible();
  // THE B5 ASSERTION. A popup with no background is a popup whose rows are read
  // against whatever is behind them, which is how the light theme ended up with
  // its available shells unreadable and its uninstalled ones legible.
  expect(await backgroundAlpha(page, '[role="listbox"]')).toBeGreaterThan(0.5);
  await shot(page, `${theme}-17-shell-picker-open`);
  await page.keyboard.press("Escape");

  /* ---- 29: every tab closed, and the watermark ------------------------ */

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const close = tabs.getByRole("button", { name: /^Close / }).first();
    if ((await close.count()) === 0) break;
    await close.click();
  }
  await expect(centre.getByRole("button", { name: "Open a terminal" })).toBeVisible();
  await expect(centre.locator("[data-vex-empty-watermark]")).toBeVisible();
  await shot(page, `${theme}-29-empty-workspace`);

  testInfo.annotations.push({
    type: "ux1-shots",
    description: SHOTS_DIR === "" ? `assertions only (${theme})` : `${SHOTS_DIR} (${theme})`,
  });
});

/* ==================== UX-3: the welcome hero and the pill =================== */

/**
 * UX-3: the two surfaces the audit's I1 and I7 are argued from.
 *
 * WHY THESE ARE BROWSER ASSERTIONS. Both findings are about what is on SCREEN
 * rather than what is in the tree, and jsdom can say neither:
 *
 *  - I1, the welcome: the complaint was never a missing string, it was that the
 *    screen offered a first-time user no act to perform. What settles it is that
 *    the primary action is VISIBLE in the shell's own centre column at a real
 *    viewport, with the three lines above it and the recents under it.
 *  - I7, the status band: `LOCKED` sat alone with no sentence. What settles it
 *    is that pressing the word in the real strip puts the reason and the next
 *    step on screen, at the strip's own height, over the shell.
 *
 * `VEX_UX_THEME` picks the theme, as in the UX-1 section.
 */
test("UX-3 welcome and status pill: the hero, the recents, the card", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(
    !reached,
    "this spec reaches the shell through the diagnostic setup tour, which is " +
      "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
      "vex-app build` and rerun",
  );

  // The preview build replaces the LIVE pill with the per-cause panel, so this
  // half has no live pill to assert and its shots would carry the panel across
  // them. The two halves are two builds by construction.
  test.skip(
    (await page.locator('[data-vex-area="studio-host-status-preview"]').count()) > 0,
    "this build has the host-status preview panel in place of the live pill: " +
      "rebuild WITHOUT `VITE_VEX_STUDIO_HOST_PREVIEW` and rerun",
  );

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const welcome = page.locator('[data-vex-area="studio-welcome"]');
  await expect(sidebar).toBeVisible();

  /* ---- 01: the hero with nothing yet ---------------------------------- */

  await expect(welcome).toBeVisible();
  // The three lines, in the order the hero reads them: what a project is, what
  // creating one does, the way back to the agent shell (audit I1).
  await expect(welcome).toContainText("A project is a folder on your disk");
  await expect(welcome).toContainText("writes each selected agent's config");
  await expect(welcome).toContainText("agent shell is one switch away");
  // The primary act, on screen rather than merely mounted.
  await expect(welcome.getByRole("button", { name: "New project" })).toBeVisible();
  // Nothing to open, so no second action pretending there is (rule 08: only
  // reachable states are modelled).
  await expect(welcome.getByRole("button", { name: /^Open / })).toHaveCount(0);
  await expect(welcome).toContainText("No projects yet.");
  // The way back is a real control here, not a sentence about one.
  await expect(
    welcome.getByRole("radiogroup", { name: "Runtime mode" }),
  ).toBeVisible();
  await shot(page, `${theme}-01-studio-welcome-empty`);

  /* ---- 13 (the band): the pill in the strip, and its card -------------- */

  // The band the audit photographed was 60px of nothing but a word. The strip
  // is the strip's own height and the word is now a control.
  const strip = page.locator('[data-vex-area="shell-status-strip"]');
  const pill = strip.getByRole("button", { name: "Vex Studio host status" });
  await expect(pill).toBeVisible();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  const card = page.locator('[data-vex-area="studio-host-status-card"]');
  await expect(card).toBeVisible();
  expect(
    await isOnScreenAt(page, '[data-vex-area="studio-host-status-card"]'),
    "the card has a layout box but nothing of it reaches the screen",
  ).toBe(true);
  // Rule 08's three answers, on screen: what is or is not available, and why.
  // Which state this build's host is in is not this spec's business, so the
  // assertion is that the card SAYS both, not which words it says.
  expect((await card.innerText()).trim().length).toBeGreaterThan(20);
  await expect(card.locator("p").first()).toBeVisible();
  await settled(page, '[data-vex-area="studio-host-status-card"]');
  await shot(page, `${theme}-13-status-pill-card`);
  // A disclosure, not a dialog: Escape closes it and the pill takes focus back.
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();
  await expect(pill).toBeFocused();
  // And the keyboard opens it in the first place.
  await page.keyboard.press("Enter");
  await expect(card).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();

  /* ---- 07: the hero once a project exists ----------------------------- */

  const projectName = `vex-ux3-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await expect(creator.locator("[data-vex-dialog-pinned]")).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: /Done|Close/ }).first().click();

  // Back to the welcome through the rail's own row, which is the path a user
  // has: creating a project leaves the user in its workspace.
  await sidebar.getByRole("button", { name: "Welcome", exact: true }).click();
  await expect(welcome).toBeVisible();
  const row = welcome.getByRole("button", { name: new RegExp(projectName) });
  await expect(row.first()).toBeVisible();
  // The second action names the project the list returned first, so the hero
  // has an act for a returning user and not only for a first-time one.
  await expect(
    welcome.getByRole("button", { name: `Open ${projectName}` }),
  ).toBeVisible();
  await shot(page, `${theme}-07-studio-welcome-with-project`);

  testInfo.annotations.push({
    type: "ux3-shots",
    description:
      SHOTS_DIR === "" ? `assertions only (${theme})` : `${SHOTS_DIR} (${theme})`,
  });
});

/**
 * UX-3: one card per wire cause, photographed.
 *
 * Section 6 of the audit recorded that NO renderer seam could drive the
 * unavailable causes: only `locked` was ever live, so nine of the ten error
 * surfaces had never been seen by anyone. `StudioHostStatusPreview` is that
 * seam - a dev-only panel, behind a build flag, that renders the real pill over
 * a local status per state and per cause. This test drives it.
 *
 * It SKIPS, with the build command, on a build made without the flag, because a
 * pass that silently photographed nothing would leave exactly the gap the audit
 * found.
 */
test("UX-3 host status: a card for every wire cause", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(
    !reached,
    "this spec reaches the shell through the diagnostic setup tour, which is " +
      "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
      "vex-app build` and rerun",
  );

  const panel = page.locator('[data-vex-area="studio-host-status-preview"]');
  test.skip(
    (await panel.count()) === 0,
    "the per-cause cards are driven by the host-status preview panel, which is " +
      "baked in at build time: rebuild with `VITE_VEX_STUDIO_HOST_PREVIEW=1 " +
      "VITE_VEX_SETUP_TOUR=1 pnpm --dir vex-app build` and rerun",
  );

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);
  await expect(panel).toBeVisible();

  const cases = panel.locator("[data-vex-host-preview-case]");
  const count = await cases.count();
  // The panel walks the schema's own options, so this is also the check that a
  // cause added on the wire reached the surface: the ten causes plus loading,
  // read-failed, running, at-capacity, starting and locked.
  expect(count).toBeGreaterThanOrEqual(16);

  for (let i = 0; i < count; i += 1) {
    const entry = cases.nth(i);
    const key = await entry.getAttribute("data-vex-host-preview-case");
    if (key === null) continue;
    await entry.getByRole("button", { name: "Vex Studio host status" }).click();
    const card = page.locator('[data-vex-area="studio-host-status-card"]');
    await expect(card).toBeVisible();
    // ON SCREEN, not merely laid out: the panel's first version wrapped these
    // pills in a scroll port, which clipped every card away while `toBeVisible`
    // still passed.
    expect(
      await isOnScreenAt(page, '[data-vex-area="studio-host-status-card"]'),
      `the ${key} card has a layout box but nothing of it reaches the screen`,
    ).toBe(true);
    // Every card answers rule 08's first question in words. `loading` is the one
    // state with no reason yet, and it is honest about that rather than
    // inventing one.
    await expect(card.locator("p").first()).not.toBeEmpty();
    await settled(page, '[data-vex-area="studio-host-status-card"]');
    await shot(page, `${theme}-host-${key}`);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
  }

  testInfo.annotations.push({
    type: "ux3-host-shots",
    description:
      SHOTS_DIR === "" ? `assertions only (${theme})` : `${SHOTS_DIR} (${theme})`,
  });
});

/* ================== UX-2: the rail, the pane and the search ================= */

/**
 * UX-2: the states the rail findings are argued from (B4, I6, I2, A7, A3).
 *
 * WHY THESE ARE BROWSER ASSERTIONS. Every one of them is about SIZE or about
 * what a real layout puts on screen, which is exactly what jsdom cannot answer:
 *
 *  - B4, the collapsed spine: the vitest suite proves no text NODE renders. It
 *    cannot prove the rail is 56px wide, or that nothing overflows it. Here the
 *    box is measured.
 *  - I6, the explorer pane: "takes the rail's remaining height" is a claim about
 *    resolved pixels. The unit suite can only prove the flex chain is unbroken;
 *    a browser can prove the tree is actually taller than the 256px box it
 *    replaced, and that dragging the seam moves it.
 *  - I2, the search: the grouped results and their bound lines are asserted in
 *    vitest; what is proven here is that they REPLACE the browsing region on a
 *    real rail rather than sitting under it off-screen.
 *
 * `VEX_UX_THEME` picks the theme; a capture pass runs it once per theme.
 */
test("UX-2 rail and explorer: the spine, the pane, the seam and the search", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(
    !reached,
    "this spec reaches the shell through the diagnostic setup tour, which is " +
      "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
      "vex-app build` and rerun",
  );

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();

  /* ---- 01: the welcome rail, and the way back to Agent ---------------- */

  // I9's rail half: the capsule is IN the rail, so Studio is never a one-way
  // door once a project is open and the welcome screen is gone.
  await expect(
    sidebar.getByRole("radiogroup", { name: "Runtime mode" }),
  ).toBeVisible();
  await shot(page, `${theme}-01-studio-welcome-empty`);

  /* ---- 07 + 18: a project, and the explorer as a PANE ------------------ */

  const projectName = `vex-ux2-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();
  await shot(page, `${theme}-07-studio-welcome-with-project`);

  await sidebar
    .getByRole("button", { name: new RegExp(projectName) })
    .first()
    .click();

  const explorerPane = sidebar.locator('[data-vex-rail-pane="explorer"]');
  await expect(explorerPane).toBeVisible();

  // THE I6 ASSERTION, and it is a number on purpose. The pane was a fixed 256px
  // box (`h-64`) inside a scrolling rail. At this viewport the rail is 900px
  // tall, so a pane that still measures anywhere near 256 has not become a pane.
  const paneBox = await explorerPane.boundingBox();
  expect(paneBox, "the explorer pane has no layout box").not.toBeNull();
  expect(paneBox?.height ?? 0).toBeGreaterThan(300);
  await shot(page, `${theme}-18-explorer-root`);

  /* ---- the seam: a real separator the user can move -------------------- */

  const seam = sidebar.getByRole("separator", {
    name: "Resize the projects and explorer panes",
  });
  await expect(seam).toBeVisible();
  await seam.focus();
  await page.keyboard.press("ArrowUp");
  const grown = await explorerPane.boundingBox();
  expect(
    grown?.height ?? 0,
    "the seam reported a resize the layout did not honour",
  ).toBeGreaterThan(paneBox?.height ?? 0);

  /* ---- 19: an expanded tree, hover, and a long name -------------------- */

  // The row is re-located by its NAME after the click: `expanded: false` stops
  // matching the moment the folder opens, and a locator that no longer matches
  // is not a row whose hover state can be photographed.
  const collapsedFolder = sidebar.getByRole("treeitem", { expanded: false }).first();
  if ((await collapsedFolder.count()) > 0) {
    const folderName = (await collapsedFolder.innerText()).trim();
    await collapsedFolder.click();
    const openFolder = sidebar
      .getByRole("treeitem", { name: folderName, exact: false })
      .first();
    await expect(openFolder).toHaveAttribute("aria-expanded", "true");
    await openFolder.hover();
  }
  await shot(page, `${theme}-19-explorer-expanded-hover-long-name`);

  /* ---- 28: keyboard focus, on the CONTAINER -------------------------- */

  // listWidget's model: the tree keeps DOM focus and names the focused row with
  // aria-activedescendant, so a row the virtualizer unmounts cannot drop the
  // user onto <body>.
  const treeEl = sidebar.getByRole("tree").first();
  await treeEl.click();
  await page.keyboard.press("ArrowDown");
  await expect(treeEl).toHaveAttribute("aria-activedescendant", /.+/);
  await shot(page, `${theme}-28-explorer-keyboard-focus`);

  /* ---- 30: the right rail, headed by the PROJECT (A3) ----------------- */

  const book = page.getByLabel("Project instrument");
  await expect(book).toBeVisible();
  await expect(book.getByText(projectName, { exact: true })).toBeVisible();
  await shot(page, `${theme}-30-workspace-right-rail`);

  /* ---- 31: ONE search, over two kinds of thing (I2) ------------------- */

  await sidebar
    .getByRole("button", { name: "Search projects and files" })
    .click();
  const field = sidebar.getByRole("combobox", {
    name: "Search projects and files",
  });
  await field.fill("vex-ux2");
  await expect(sidebar.getByRole("listbox", { name: "Search results" })).toBeVisible();
  // The results REPLACE the browsing region rather than sitting under it: the
  // tree is still mounted (its session and expanded folders survive) and hidden.
  await expect(explorerPane).toBeHidden();
  // I3's half of this finding: two controls, two names.
  await expect(sidebar.getByRole("button", { name: "Close search" })).toHaveCount(1);
  await expect(sidebar.getByRole("button", { name: "Clear search" })).toHaveCount(1);
  await shot(page, `${theme}-31-sidebar-search`);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(explorerPane).toBeVisible();

  /* ---- 32: the collapsed spine carries NO words (B4) ------------------ */

  await sidebar.getByRole("button", { name: "Collapse Studio sidebar" }).click();
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
  // POLLED, because collapsing is a choreography, not a swap: the column keeps
  // its frozen expanded width while its wide content fades, and only then does
  // the rail layout apply (`useCollapseChoreography`). The contract is where it
  // SETTLES; reading the box on the first frame reads the slide.
  await expect
    .poll(async () => (await sidebar.boundingBox())?.width ?? 0, { timeout: 5_000 })
    .toBeLessThanOrEqual(72);
  // THE B4 ASSERTION, measured rather than inspected: no descendant of the rail
  // paints text, and nothing in it is wider than the spine. The old rail failed
  // both - "Pro" and a chevron sat in a box wider than the column.
  const spineText = (await sidebar.innerText()).trim();
  expect(spineText, "the collapsed rail is painting words").toBe("");
  const overflow = await sidebar.evaluate((rail) => {
    const box = rail.getBoundingClientRect();
    return Array.from(rail.querySelectorAll("*")).filter((node) => {
      const child = node.getBoundingClientRect();
      return child.width > 0 && child.right > box.right + 1;
    }).length;
  });
  expect(overflow, "content is bleeding out of the 56px spine").toBe(0);
  await shot(page, `${theme}-32-sidebar-collapsed`);

  await sidebar.getByRole("button", { name: "Expand Studio sidebar" }).click();

  /* ---- 33: the auto-collapse threshold, at the seam ------------------- */

  // Rule 08 asks for a layout threshold at the seam and on both sides. The pure
  // comparison is unit-tested (`shell-columns.test.ts`); what a browser adds is
  // that the SHELL actually applies it.
  await page.setViewportSize({ width: 1025, height: 900 });
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
  await page.setViewportSize({ width: 1023, height: 900 });
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
  await page.setViewportSize({ width: 1000, height: 900 });
  await shot(page, `${theme}-33-narrow-1000px`);

  testInfo.annotations.push({
    type: "ux2-shots",
    description:
      SHOTS_DIR === "" ? `assertions only (${theme})` : `${SHOTS_DIR} (${theme})`,
  });
});

/* ===================== UX-5: the Studio keyboard table ===================== */

/**
 * The shortcuts, driven from a REAL keyboard against the real shell.
 *
 * Why this belongs in a browser at all, when `keybindings.test.ts` already
 * proves the table and `useStudioKeybindings.test.tsx` proves the dispatch:
 * neither can see a `keydown` travel from the operating system through
 * Chromium's own handling of that chord to the document listener. `Ctrl+P` is
 * the browser's print dialog and `Ctrl+B` is a rich-text command; a shortcut
 * that resolves perfectly in jsdom and is eaten by the browser in the product
 * is exactly the class of defect only this pass catches.
 *
 * PLATFORM: this runs the Ctrl chords, because the runner is Linux or Windows.
 * The Cmd half of the table has no reachable runner in this repo, and the
 * report names that gap rather than pretending a Linux pass covered macOS.
 *
 * Only the intents with a wired owner are exercised, which is the same list the
 * watermark advertises (`studioBoundIntents`). An intent whose owner has not
 * published its function yet does nothing BY DESIGN, and asserting that a key
 * does nothing would freeze that gap into a contract.
 */
test("UX-5 keyboard: the table reaches its owners, and a dialog suspends it", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(
    !reached,
    "this spec reaches the shell through the diagnostic setup tour, which is " +
      "baked in at build time: rebuild with `VITE_VEX_SETUP_TOUR=1 pnpm --dir " +
      "vex-app build` and rerun",
  );

  const shell = page.locator('[data-vex-screen="appShell"]');
  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();

  /* ---- 40: Ctrl+B toggles the rail, and toggles it back --------------- */

  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
  await shot(page, "40-keyboard-rail-collapsed");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");

  /* ---- 41: Ctrl+Shift+N opens the creator ----------------------------- */

  await page.keyboard.press("Control+Shift+N");
  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();
  await shot(page, "41-keyboard-new-project");

  /* ---- 42: every binding is suspended while that dialog is open ------- */

  // The rail must not move under an open decision. The keystroke is NOT
  // swallowed - the dialog's own handlers still see it - Studio simply takes
  // no shortcut while something is pending.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
  await shot(page, "42-keyboard-suspended-by-dialog");

  await page.keyboard.press("Escape");
  await expect(creator).toHaveCount(0);
  // And the suspension lifts with the dialog.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");

  /* ---- 43: Ctrl+Shift+A is the way back to Agent mode ----------------- */

  // The finding this closes (I9): before it, the ONLY route out of Studio was
  // the welcome screen's capsule, so a user standing in a project had no way
  // back without first closing what they were looking at.
  await page.keyboard.press("Control+Shift+A");
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "agent");
  await shot(page, "43-keyboard-back-to-agent");

  testInfo.annotations.push({
    type: "ux5-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});
