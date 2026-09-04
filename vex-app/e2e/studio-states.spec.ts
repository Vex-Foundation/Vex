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

import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect, type VexDatabaseFixture } from "./fixtures/vex-app-with-database.js";
import { APP_DIR, relaunchApp } from "./fixtures/electron-app.js";
import { enterStudio, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";

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

/**
 * The directory a just-created project got, FOUND rather than derived: the slug
 * is main's to mint, so a walk that recomputed it would assert against its own
 * copy of that rule instead of against the folder the app actually made.
 *
 * HARD, never a skip. A walk that has already driven the creator to its report
 * and closed it is past every declared prerequisite of this file, so an absent
 * directory is the product failing to write one - the exact defect this file
 * exists to catch. It used to `test.skip` here, which turned a failed creation
 * into a green run; `bridge_unavailable` (no built `vex-mcp`) is named in the
 * message because it is the one environment cause, and it is a cause the run
 * must fail on rather than skip past.
 */
async function projectDirectory(
  projectsRoot: string,
  stamp: string,
): Promise<string> {
  const find = (): string | undefined =>
    fs
      .readdirSync(projectsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((name) => name.includes(stamp));
  await expect
    .poll(() => find() !== undefined, {
      timeout: 60_000,
      message:
        `no project directory containing ${stamp} under ${projectsRoot}; the ` +
        "installer writes nothing when it cannot find the bridge binary its " +
        "configs point at, so this walk needs a built `vex-mcp` " +
        "(`pnpm --dir vex-app run build:bridge:dev`)",
    })
    .toBe(true);
  const slug = find();
  if (slug === undefined) throw new Error("unreachable: the poll above proved a slug exists");
  return path.join(projectsRoot, slug);
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
  test.skip(!reached, TOUR_SKIP_REASON);

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
  // This profile holds no wallet, so the creator shows the empty fieldset and
  // never the picker. The picker's own rule (nothing pre-selected, and the
  // "No wallet selected" sentence while wallets exist to pick; live test
  // 2026-09-03, A7) is proven in `projects/__tests__/ProjectCreator.test.tsx`
  // and `ProjectSettingsDialog.test.tsx`; a browser proof needs a seeded
  // wallet, which this spec's fixture does not have.
  await expect(creator.locator('[data-vex-project-wallets="empty"]')).toBeVisible();
  await expect(creator.locator('[data-vex-project-wallets="picker"]')).toHaveCount(0);
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

  /* ---- 09b: a save's report is not covered by the idle sentence -------- */

  // The live test (2026-09-03, A4) caught "Nothing has changed yet." standing
  // above a fresh "What Vex did" report. The sentence is the IDLE state alone:
  // no unsaved edit and no answer to a Save on screen. Grant, acknowledge,
  // save, and the report must stand without it; then hand the grant back so
  // the states after this one see the Restricted project they were written
  // against, which is a second save and a second report to check.
  await settings.locator("[data-vex-consent-acknowledge]").check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(settings.getByRole("heading", { name: "What Vex did" })).toBeVisible();
  await expect(settings.getByText("Nothing has changed yet")).toHaveCount(0);
  await shot(page, "09b-project-settings-saved");
  await settings.getByText("Restricted", { exact: true }).click();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(settings.getByRole("heading", { name: "What Vex did" })).toBeVisible();
  await expect(settings.getByText("Nothing has changed yet")).toHaveCount(0);
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
  // THE SCREEN IS GONE, not merely covered. `ShellScreen` renders the Settings
  // surface as a `role="dialog"` fixed over the shell and its host animates it
  // OUT (~0.3s), so "the app shell is visible" was true the whole time Settings
  // was still on top of it - and every click the section below makes would have
  // landed on the screen instead of the shell. The count assertion waits for
  // the exit rather than racing it.
  await expect(page.locator('[data-vex-area="shell-screen"]')).toHaveCount(0);
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
  test.skip(!reached, TOUR_SKIP_REASON);

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

  await centre.getByRole("button", { name: "Shell for the next terminal" }).first().click();
  const listbox = page.getByRole("listbox", { name: "Shell for the next terminal" });
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
  test.skip(!reached, TOUR_SKIP_REASON);

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
  // The way back is a real control here, not a sentence about one: the
  // Agent | Studio capsule itself, under the wordmark (owner decree
  // 2026-09-04). It has exactly one home per page, so the rail header mounts
  // none while this welcome is on screen; the stand-in button is gone.
  await expect(welcome.getByRole("radiogroup", { name: "Runtime mode" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Runtime mode" })).toHaveCount(1);
  await expect(welcome.getByRole("button", { name: "Back to Agent mode" })).toHaveCount(0);
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
  test.skip(!reached, TOUR_SKIP_REASON);

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
  // cause added on the wire reached the surface: the nine causes plus loading,
  // read-failed, running, at-capacity, starting and locked.
  expect(count).toBeGreaterThanOrEqual(15);

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
  test.skip(!reached, TOUR_SKIP_REASON);

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();

  /* ---- 01: the welcome rail, and the way back to Agent ---------------- */

  // With no project open the capsule is the WELCOME's, under its wordmark, and
  // the rail header mounts none (owner decree 2026-09-04; one radiogroup per
  // page). Its rail half is asserted below, once a project is open.
  await expect(
    sidebar.getByRole("radiogroup", { name: "Runtime mode" }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[data-vex-area="studio-welcome"]')
      .getByRole("radiogroup", { name: "Runtime mode" }),
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

  // I9's rail half: once a project is open the welcome is gone and the capsule
  // is IN the rail, so Studio is never a one-way door; still exactly one.
  await expect(
    sidebar.getByRole("radiogroup", { name: "Runtime mode" }),
  ).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Runtime mode" })).toHaveCount(1);

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
  //
  // HARD, never a guard. The create path writes `.vex/` into every project and
  // nothing in `DEFAULT_FILE_EXCLUDE_DIRS` hides it, so a collapsed folder row
  // is a fact about the tree this walk just opened. The `if` here meant a tree
  // that listed no directory at all photographed an unexpanded state and passed.
  const collapsedFolder = sidebar.getByRole("treeitem", { expanded: false }).first();
  await expect(collapsedFolder).toBeVisible({ timeout: 60_000 });
  const folderName = (await collapsedFolder.innerText()).trim();
  await collapsedFolder.click();
  const openFolder = sidebar
    .getByRole("treeitem", { name: folderName, exact: false })
    .first();
  await expect(openFolder).toHaveAttribute("aria-expanded", "true");
  await openFolder.hover();
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

  // THE PARITY CONTRACT (owner screenshots, 2026-09-04): the project rail IS
  // the agent session rail. Each card is the shared `PortfolioCard` region,
  // named by its eyebrow, in the agent rail's order.
  const railCards = book.locator('[data-vex-book-section]');
  await expect(railCards).toHaveCount(6);
  await expect(railCards.nth(0)).toHaveAttribute("data-vex-book-section", "position");
  await expect(railCards.nth(1)).toHaveAttribute("data-vex-book-section", "wallets");
  await expect(railCards.nth(2)).toHaveAttribute("data-vex-book-section", "balances");
  await expect(railCards.nth(3)).toHaveAttribute("data-vex-book-section", "activity");
  await expect(railCards.nth(4)).toHaveAttribute("data-vex-book-section", "project");
  await expect(railCards.nth(5)).toHaveAttribute("data-vex-book-section", "trench");
  await expect(book.getByRole("region", { name: "Position", exact: true })).toBeVisible();
  await expect(book.getByRole("region", { name: "Wallets", exact: true })).toBeVisible();

  // BALANCES carries the same door the agent rail has. The register a fresh
  // project can show is either its holdings with "View all assets" under
  // them, or the PROJECT empty sentence; it is never the session's or the
  // global one, and the door is never hidden behind a project scope.
  const balances = book.getByRole("region", { name: "Balances", exact: true });
  await expect(balances).toBeVisible();
  await expect(
    balances.getByText(/View all assets|No balances in this project's wallets yet/),
  ).toBeVisible();
  await expect(balances.getByText(/this session's wallets/)).toHaveCount(0);

  // ACTIVITY carries "View all activity" unconditionally (the owner's
  // screenshot was cropped under the card; the door is there).
  const activity = book.getByRole("region", { name: "Activity", exact: true });
  await expect(activity).toBeVisible();
  await expect(
    activity.getByRole("button", { name: "View all activity" }),
  ).toBeVisible();

  // PROJECT is the SESSION card's counterpart: the same rows, and the one row
  // a project has that a session does not - its path, ending in the folder
  // main actually created.
  const projectCard = book.getByRole("region", { name: "Project", exact: true });
  await expect(projectCard).toBeVisible();
  await expect(projectCard.getByText("Mode", { exact: true })).toBeVisible();
  await expect(projectCard.getByText("Studio", { exact: true })).toBeVisible();
  await expect(projectCard.getByText("Access", { exact: true })).toBeVisible();
  await expect(projectCard.getByText(/^(Full|Restricted)$/)).toBeVisible();
  await expect(projectCard.getByText("Started", { exact: true })).toBeVisible();
  await expect(projectCard.getByText("Path", { exact: true })).toBeVisible();
  await expect(projectCard.getByTitle(new RegExp(`${projectName}$`))).toBeVisible();

  // LAUNCHPAD browses the same global locker, and says where a launch is
  // signed from instead of offering one a project cannot attribute.
  const launchpad = book.getByRole("region", { name: "Launchpad", exact: true });
  await expect(launchpad).toBeVisible();
  await expect(launchpad.getByRole("button", { name: "Add image" })).toBeVisible();
  await expect(launchpad.locator('[data-vex-area="launchpad-browse-note"]')).toBeVisible();
  await expect(launchpad.getByRole("button", { name: /Launch/ })).toHaveCount(0);
  await shot(page, `${theme}-30-workspace-right-rail`);

  // The Board tab is the shared chrome; its project content is the honest
  // empty state (a board is composed in an Agent chat), with the one way
  // there. Photographed, then put back: `bookTab` is a persisted preference
  // and the steps below expect the Portfolio stack.
  await book.getByRole("tab", { name: "Board" }).click();
  const projectBoard = book.locator(
    '[data-vex-area="active-board"][data-state="empty"][data-scope="project"]',
  );
  await expect(projectBoard).toBeVisible();
  await expect(
    projectBoard.getByRole("button", { name: "Switch to Agent" }),
  ).toBeVisible();
  await shot(page, `${theme}-30b-workspace-right-rail-board`);
  await book.getByRole("tab", { name: "Portfolio" }).click();
  await expect(book.getByRole("region", { name: "Position", exact: true })).toBeVisible();

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
 * The Cmd half of the table has no reachable runner in this repo - and it is
 * now the half that DIFFERS, since four rows follow VS Code's own `mac:`
 * overrides rather than substituting Cmd for Ctrl. The report names that gap
 * rather than pretending a Linux pass covered macOS.
 *
 * Only the intents with a wired owner are exercised, which is the same list the
 * watermark advertises (`studioBoundIntents`). `Toggle terminal panel` is the
 * one row that stays unbound - Studio has no panel to fold away - and asserting
 * that its key does nothing would freeze that gap into a contract.
 *
 * `VEX_UX_THEME` picks the theme, as in the UX-1 section: the watermark state
 * below is a rendered surface and is captured in both.
 */
test("UX-5 keyboard: the table reaches its owners, and a dialog suspends it", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);

  const shell = page.locator('[data-vex-screen="appShell"]');
  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(sidebar).toBeVisible();

  /* ---- 40: Ctrl+B toggles the rail, and toggles it back --------------- */

  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
  await shot(page, `${theme}-40-keyboard-rail-collapsed`);
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");

  /* ---- 41: Ctrl+Shift+N opens the creator ----------------------------- */

  await page.keyboard.press("Control+Shift+N");
  const creator = page.getByRole("dialog", { name: "New project" });
  await expect(creator).toBeVisible();
  await shot(page, `${theme}-41-keyboard-new-project`);

  /* ---- 42: every binding is suspended while that dialog is open ------- */

  // The rail must not move under an open decision. The keystroke is NOT
  // swallowed - the dialog's own handlers still see it - Studio simply takes
  // no shortcut while something is pending.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
  await shot(page, `${theme}-42-keyboard-suspended-by-dialog`);

  await page.keyboard.press("Escape");
  await expect(creator).toHaveCount(0);
  // And the suspension lifts with the dialog.
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
  await page.keyboard.press("Control+b");
  await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");

  /* ---- 43: Ctrl+Shift+A switches Agent and Studio -------------------- */

  // The finding this closes (I9): before it, the ONLY route out of Studio was
  // the welcome screen's capsule, so a user standing in a project had no way
  // back without first closing what they were looking at.
  await page.keyboard.press("Control+Shift+A");
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "agent");
  await shot(page, `${theme}-43-keyboard-back-to-agent`);

  /* ---- a project, for the chords that need a workspace ---------------- */

  // Back into Studio the way the user came in, then a real project: every
  // remaining chord's owner is a MOUNTED workspace, and the welcome screen has
  // none. That is not a limitation of the test - it is the contract the hook's
  // "bound is not the same as answerable" rule states, and step 44 below proves
  // the other half of it.
  await page
    .getByRole("radiogroup", { name: "Runtime mode" })
    .getByRole("radio", { name: "Studio" })
    .click();
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");

  const projectName = `vex-ux5-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const project = page.getByRole("dialog", { name: "New project" });
  await project.getByLabel("Name").fill(projectName);
  await project.locator('[data-vex-agent="claude-code"]').click();
  await project.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();
  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const tabs = centre.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs.getByRole("tab").first()).toBeVisible({ timeout: 60_000 });

  /* ---- 44: the workspace chords, through a real keyboard -------------- */

  // The workspace has to HOLD focus for the tab chords to apply, exactly as the
  // table's `when` says: they are the workspace's and its two panels', not the
  // rail's. Clicking the strip is how a user gets there.
  await tabs.getByRole("tab").first().click();

  await page.keyboard.press("Control+Shift+`");
  await expect(tabs.getByRole("tab", { name: /Terminal 2/ })).toBeVisible({
    timeout: 60_000,
  });
  await page.keyboard.press("Control+Shift+`");
  await expect(tabs.getByRole("tab")).toHaveCount(3, { timeout: 60_000 });
  await shot(page, `${theme}-44-keyboard-three-terminals`);

  // Ctrl+Tab walks the strip and WRAPS: the third terminal is selected, so one
  // step forward lands on the first.
  await expect(tabs.getByRole("tab", { name: /Terminal 3/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Control+Tab");
  await expect(tabs.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("Control+Shift+Tab");
  await expect(tabs.getByRole("tab", { name: /Terminal 3/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  /* ---- N2: exactly one control in the centre is called "New terminal" - */

  // An accessible name is matched by SUBSTRING by every tool that looks a
  // control up by one, so this counts NAME COLLISIONS and not just duplicate
  // labels. It measured 2 with one project open, in both themes on both walks
  // of the after-audit, while the source had a single
  // `aria-label="New terminal"`: the shell picker's own name contained it.
  await expect(centre.getByRole("button", { name: "New terminal" })).toHaveCount(1);

  /* ---- 44b: the same chords, with the caret INSIDE the shell ---------- */

  // THE DEFECT THIS SECTION USED TO WALK PAST (I-3). Every chord above is
  // pressed with focus on the tab strip, and from there they all worked; with
  // the caret in xterm's textarea, `Ctrl+Tab`, `Ctrl+Shift+Tab` and `Ctrl+W`
  // did nothing at all, because xterm encoded them for the pty before any
  // document listener saw them. That is the one state a user actually spends
  // their time in, so it is now the one this section proves.
  //
  // THE CARET IS RE-TAKEN BEFORE EACH CHORD, and not because the chord loses
  // it: switching tabs hides the old pane, and focus on an element inside a
  // `display: none` subtree falls to the document body. Re-focusing is what a
  // user's own next click does; it is not a workaround for the chord.
  //
  // AND IT IS ASSERTED EVERY TIME, not only the first. Without that, a focus
  // that silently did nothing would leave the chord being pressed at the body
  // - which is the state the section already passed in before this block
  // existed - so the assertions that follow would prove nothing new. The
  // caret's position is the whole subject here, so it is measured before each
  // keystroke rather than assumed to have survived the last one.
  const terminalInput = (): Locator =>
    centre
      .locator('[role="tabpanel"]:not([hidden])')
      .locator('textarea[aria-label="Terminal input"]')
      .first();

  await terminalInput().focus();
  await expect(terminalInput()).toBeFocused();

  // Ctrl+Tab wraps from the third terminal to the first, from inside the shell.
  await page.keyboard.press("Control+Tab");
  await expect(tabs.getByRole("tab", { name: /Terminal 1/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await terminalInput().focus();
  await expect(terminalInput()).toBeFocused();
  await page.keyboard.press("Control+Shift+Tab");
  await expect(tabs.getByRole("tab", { name: /Terminal 3/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  // Ctrl+W closes the tab the caret is in. That the keystroke did not ALSO
  // reach the shell as `0x17` (erase word) is proven where the bytes are
  // visible - `XtermHost.test.tsx` asserts the bridge received nothing - since
  // an empty prompt looks identical either way.
  await terminalInput().focus();
  await expect(terminalInput()).toBeFocused();
  await page.keyboard.press("Control+w");
  await expect(tabs.getByRole("tab")).toHaveCount(2, { timeout: 60_000 });

  // And the new-terminal chord LANDS THE CARET in the shell it opened. Before
  // this it created the terminal and left focus on the body, so the chord a
  // user pressed twice in a row worked once.
  await terminalInput().focus();
  await expect(terminalInput()).toBeFocused();
  await page.keyboard.press("Control+Shift+`");
  await expect(tabs.getByRole("tab")).toHaveCount(3, { timeout: 60_000 });
  await expect(terminalInput()).toBeFocused({ timeout: 60_000 });
  await shot(page, `${theme}-44b-keyboard-inside-terminal`);

  // Ctrl+Shift+E hands focus to the project tree, which is a `role="tree"` and
  // the explorer pane's ONE tab stop.
  await page.keyboard.press("Control+Shift+E");
  await expect(sidebar.getByRole("tree", { name: "Project files" })).toBeFocused();
  await shot(page, `${theme}-45-keyboard-explorer-focused`);

  // Ctrl+P opens the rail's one search and puts the caret in it. NEVER a
  // toggle: a second press must leave the user in the field.
  await page.keyboard.press("Control+p");
  const search = sidebar.getByRole("combobox", { name: "Search projects and files" });
  await expect(search).toBeFocused();
  await page.keyboard.press("Control+p");
  await expect(search).toBeFocused();
  await shot(page, `${theme}-46-keyboard-go-to-file`);
  await page.keyboard.press("Escape");

  /* ---- 29: every tab closed by Ctrl+W, and the watermark -------------- */

  await tabs.getByRole("tab").first().click();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if ((await tabs.getByRole("tab").count()) === 0) break;
    await page.keyboard.press("Control+w");
  }
  await expect(tabs.getByRole("tab")).toHaveCount(0, { timeout: 60_000 });

  // THE WATERMARK NOW CARRIES KEYS, and it carries exactly the ones an owner
  // answers. A row with an empty key column would mean the rows never reached
  // the surface; a `Toggle terminal panel` row would mean the watermark is
  // advertising the one intent nothing is wired to.
  const watermark = centre.locator("[data-vex-empty-watermark]");
  await expect(watermark).toBeVisible();
  const terms = await watermark.locator("dt").allTextContents();
  const keys = await watermark.locator("dd").allTextContents();
  expect(terms).toContain("New terminal");
  expect(terms).toContain("Close tab");
  expect(terms).not.toContain("Toggle terminal panel");
  expect(keys.filter((value) => value.trim() === "")).toHaveLength(0);
  expect(keys).toContain("Ctrl+W");
  await shot(page, `${theme}-29-empty-workspace`);

  testInfo.annotations.push({
    type: "ux5-shots",
    description: SHOTS_DIR === "" ? `assertions only (${theme})` : `${SHOTS_DIR} (${theme})`,
  });
});

/**
 * TAB-1: PREVIEW TABS, in a real strip.
 *
 * WHY THIS IS A BROWSER ASSERTION. The model's rules are proven as a table in
 * `workspace/__tests__/preview-tabs.test.ts` and the strip's rendering in
 * `terminal/__tests__/TerminalTabs.preview.test.tsx`. What neither can prove is
 * the thing this walk is for: that a user CLICKING FILES IN THE TREE ends up
 * with the tabs the design promises, through the real explorer, the real intent
 * channel, the real controller and the real strip.
 *
 * ## The gesture is applied by the coordinator, so this section detects it
 *
 * TAB-1 does not own `explorer/**`. The single-click-previews and
 * double-click-pins wiring is two lines in `ExplorerTree.tsx` that the
 * coordinator applies (they are named in the TAB-1 report), and until they land
 * the tree opens every file PINNED - which is the mode default and a real
 * contract of its own. So this walk asserts what is true either way, then
 * branches: with the gesture wired it proves REPLACEMENT and PROMOTION; without
 * it, it proves the default did not change and says so in an annotation rather
 * than passing silently on a state nobody checked.
 */
test("TAB-1 preview tabs: one preview per workspace, and how a tab is kept", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(sidebar).toBeVisible();

  /* ---- a project with files in it ------------------------------------- */

  const projectName = `vex-tab1-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();
  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const tabs = centre.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs.getByRole("tab").first()).toBeVisible({ timeout: 60_000 });

  // FILE rows only: a directory row carries `aria-expanded` and a click on one
  // toggles it instead of opening anything.
  const fileRows = sidebar.locator('[role="treeitem"]:not([aria-expanded])');
  await expect(fileRows.first()).toBeVisible({ timeout: 60_000 });
  // HARD, never a skip. A freshly created Claude Code project's root holds the
  // installer's own artifacts - `.mcp.json`, `AGENTS.md`, `CLAUDE.md` - so
  // three file rows is a fact about what the create path WRITES, not a
  // precondition of this machine. Skipping on it turned a project the
  // installer failed to furnish into a green run.
  await expect
    .poll(() => fileRows.count(), {
      timeout: 60_000,
      message: "a created project's root holds fewer than the three files this walk opens",
    })
    .toBeGreaterThanOrEqual(3);

  const terminalTabs = await tabs.getByRole("tab").count();
  const fileTabCount = async (): Promise<number> =>
    (await tabs.getByRole("tab").count()) - terminalTabs;

  /* ---- the first file, and what the second one does to it -------------- */

  await fileRows.nth(0).click();
  await expect.poll(fileTabCount).toBe(1);
  await shot(page, "tab1-01-first-file-open");

  // The second file's own tab is what proves the click LANDED, whichever mode
  // the tree used - a bare count would race the open and read the pre-click
  // state as a settled one.
  const secondName = (await fileRows.nth(1).innerText()).trim();
  await fileRows.nth(1).click();
  await expect(
    tabs.getByRole("tab", { name: secondName, exact: false }),
  ).toBeVisible({ timeout: 60_000 });
  const wired = (await fileTabCount()) === 1;

  if (!wired) {
    // The gesture is not applied yet. What IS proven here is the default the
    // whole change rests on: a tree click still opens a KEPT tab, so adding the
    // mode changed no existing route.
    await expect.poll(fileTabCount).toBe(2);
    await expect(tabs.locator("span.italic")).toHaveCount(0);
    await shot(page, "tab1-02-pinned-default-gesture-not-wired");
    testInfo.annotations.push({
      type: "tab1",
      description:
        "the explorer preview gesture is not applied in this build, so this run "
        + "proved the pinned default only; rerun once ExplorerTree passes "
        + '"preview" on single click and "pinned" on double click',
    });
    return;
  }

  /* ---- REPLACEMENT: one preview, in the position it replaced ----------- */

  await expect.poll(fileTabCount).toBe(1);
  // Italic is the preview signal, and the accessible name carries the word.
  await expect(tabs.locator("span.italic")).toHaveCount(1);
  await shot(page, "tab1-02-preview-replaced");

  /* ---- PROMOTION: a double click keeps the tab -------------------------- */

  await fileRows.nth(1).dblclick();
  await expect(tabs.locator("span.italic")).toHaveCount(0);
  await expect.poll(fileTabCount).toBe(1);
  await shot(page, "tab1-03-preview-kept");

  /* ---- and now a third file opens BESIDE it ---------------------------- */

  await fileRows.nth(2).click();
  await expect.poll(fileTabCount).toBe(2);
  await expect(tabs.locator("span.italic")).toHaveCount(1);
  await shot(page, "tab1-04-kept-plus-preview");

  testInfo.annotations.push({
    type: "tab1-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});

/* ============ IDX-1: go to file, over a project-wide name index ============ */

/**
 * THE ONE THING VITEST CANNOT PROVE about this surface: that a file the
 * explorer has NEVER LISTED is reachable from the rail's search.
 *
 * Every unit test around the index feeds it a path list or a temp tree of its
 * own. What none of them can establish is the whole chain in one piece - main
 * walks the real project directory, mints a node token for a file no renderer
 * has ever seen, the rail merges that answer into its file group, and Enter
 * opens it through the same intent a tree row uses. So this walk writes a file
 * into a folder it then deliberately leaves collapsed, and asserts the tree
 * does not have it before asserting the search does.
 */
test("IDX-1 search: a file the explorer never loaded is found and opened", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(sidebar).toBeVisible();

  /* ---- a project, and a file buried where nothing will expand ---------- */

  const stamp = Date.now().toString(36);
  const projectName = `vex-idx1-${stamp}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();

  const projectDir = await projectDirectory(vexDb.stack.projectsRoot, stamp);

  // THREE LEVELS DOWN. The explorer lists one directory at a time and only when
  // a human expands it, so nothing in this run will have listed this folder.
  const targetName = `idx1-buried-${stamp}.ts`;
  const buriedDir = path.join(projectDir, "deep", "nested", "folder");
  fs.mkdirSync(buriedDir, { recursive: true });
  fs.writeFileSync(path.join(buriedDir, targetName), "export const buried = 1;\n");

  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const explorerPane = sidebar.locator('[data-vex-rail-pane="explorer"]');
  await expect(explorerPane).toBeVisible();
  const tabs = centre.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs.getByRole("tab").first()).toBeVisible({ timeout: 60_000 });
  await expect(sidebar.locator('[role="treeitem"]').first()).toBeVisible({
    timeout: 60_000,
  });

  // THE PRECONDITION, asserted rather than assumed: the tree does not have this
  // file. Without this line the search assertion below would still pass if the
  // explorer had somehow loaded the whole project, and would prove nothing
  // about the index at all.
  await expect(sidebar.getByRole("treeitem", { name: new RegExp(targetName) })).toHaveCount(
    0,
  );
  await shot(page, "idx1-01-tree-without-the-file");

  /* ---- the search finds it anyway -------------------------------------- */

  await sidebar.getByRole("button", { name: "Search projects and files" }).click();
  const field = sidebar.getByRole("combobox", {
    name: "Search projects and files",
  });
  await field.fill(`idx1-buried-${stamp}`);

  // POLLED with a real timeout, and NOT by typing again: the first query of a
  // session answers "building" while main walks the project, and the rail
  // re-issues the same query on a bounded schedule until the walk settles
  // (`use-rail-file-index.ts`). The row therefore arrives on a later ANSWER,
  // with the needle untouched - which is the promise the "Results will fill
  // in." line makes. That is the surface's contract, not a flake.
  const option = sidebar.getByRole("option", { name: new RegExp(targetName) });
  await expect(option).toBeVisible({ timeout: 60_000 });
  // The row shows WHERE it is, which is what makes two files of one name
  // distinguishable.
  await expect(option).toContainText("deep/nested/folder");
  await shot(page, "idx1-02-search-found-unloaded-file");

  /* ---- and Enter opens it, through the ordinary open intent ------------- */

  const before = await tabs.getByRole("tab").count();
  await page.keyboard.press("Enter");
  await expect(
    tabs.getByRole("tab", { name: new RegExp(targetName) }),
  ).toBeVisible({ timeout: 60_000 });
  expect(await tabs.getByRole("tab").count()).toBe(before + 1);
  // The search put itself away, as it does for a project hit.
  await expect(explorerPane).toBeVisible();
  await shot(page, "idx1-03-file-opened-from-search");

  testInfo.annotations.push({
    type: "idx1-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});

/**
 * EXP-1 explorer actions: the create, the rename, the managed-artifact refusal
 * and the delete, end to end through the real IPC surface and the real
 * filesystem.
 *
 * WHAT THIS PROVES THAT THE UNIT SUITES CANNOT. Every layer below has its own
 * test - the mutations against a real temporary directory, the boundary with a
 * faked domain, the model and the session with a scripted bridge, the name box
 * and the confirmation as components - and all of them are green while the
 * wiring between them is wrong. This walk is the only place where a keystroke
 * in a renderer becomes bytes on disk and back, and it VERIFIES THE WORLD at
 * each step: it reads the project directory with `fs` rather than trusting the
 * row the tree drew.
 */
test("EXP-1 explorer actions: create, rename and delete a file from the tree", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  await expect(sidebar).toBeVisible();

  /* ---- a project to act in --------------------------------------------- */

  const stamp = Date.now().toString(36);
  const projectName = `vex-exp1-${stamp}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();

  const projectDir = await projectDirectory(vexDb.stack.projectsRoot, stamp);

  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const explorerPane = sidebar.locator('[data-vex-rail-pane="explorer"]');
  await expect(explorerPane).toBeVisible();
  const tree = sidebar.getByRole("tree", { name: "Project files" });
  await expect(tree).toBeVisible({ timeout: 60_000 });
  await expect(sidebar.locator('[role="treeitem"]').first()).toBeVisible({
    timeout: 60_000,
  });
  await shot(page, "exp1-00-explorer-ready");

  /* ---- CREATE: the row context menu opens a name box in the tree -------- */

  // THE CONTEXT MENU, not the header buttons. The sidebar now passes
  // `onCreateFile`/`onCreateFolder` to `ExplorerHeader`, so both routes exist;
  // the menu is the one this walk takes because it is the one a right click AND
  // the Menu key both reach, so it covers the surface a pointer and a keyboard
  // share.
  //
  // The row it is opened FROM is deliberately `CLAUDE.md`, a FILE: a directory
  // takes the new entry, a file gives it to its parent, so this creates at the
  // project ROOT. It also has to be a file here, because a fresh project's root
  // contains nothing but Vex's own managed artifacts - `.vex/`, `.mcp.json`,
  // `AGENTS.md`, `CLAUDE.md` - and creating INSIDE `.vex/` is refused by name.
  const created = `exp1-notes-${stamp}.md`;
  await tree
    .getByRole("treeitem", { name: "CLAUDE.md" })
    .first()
    .click({ button: "right" });
  // The menu is portaled to the document, not nested in the tree: a
  // `role="tree"` may contain only tree items.
  await page.getByRole("menuitem", { name: "New file" }).click();

  // The box is a ROW, not a dialog: it is inside the tree, on the tree's own
  // indent grid, beside the names it must not collide with.
  const nameBox = tree.getByRole("textbox");
  await expect(nameBox).toBeFocused();
  await shot(page, "exp1-01-name-box-open");

  // LIVE VALIDATION, before anything is sent: a separator is refused in the row
  // rather than creating intermediate directories.
  await nameBox.fill("a/b.txt");
  await expect(tree.getByRole("alert")).toContainText("slash");
  await shot(page, "exp1-02-name-refused-inline");

  await nameBox.fill(created);
  await expect(tree.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Enter");

  // THE WORLD, not the row: the file is on disk, in the project's own folder.
  await expect
    .poll(() => fs.existsSync(path.join(projectDir, created)), { timeout: 60_000 })
    .toBe(true);
  const createdRow = tree.getByRole("treeitem", { name: created });
  await expect(createdRow).toBeVisible({ timeout: 60_000 });
  await shot(page, "exp1-03-file-created");

  /* ---- HEADER CREATE: where the SELECTION points, not the root --------- */

  // THE DEFECT THIS CLOSES (live test 2026-09-03, I-4). The pane header's New
  // file and New folder created at the PROJECT ROOT whatever the tree had
  // selected, so a user who clicked a folder and pressed New file got the file
  // beside that folder while the row menu put it inside. The two routes now
  // read one rule (`ExplorerSession.createParentId`), and this is the only
  // place where the answer is checked against the DISK rather than a stub.
  //
  // A folder of this walk's own making, because a fresh project's root holds
  // nothing but Vex's managed artifacts and creating inside `.vex/` is refused
  // by name.
  const folder = `exp1-dir-${stamp}`;
  const headerNewFile = explorerPane.getByRole("button", { name: "New file" });
  const headerNewFolder = explorerPane.getByRole("button", { name: "New folder" });

  // The selection here is the file the create above left behind, and a FILE
  // gives its new sibling to its parent: the root.
  await headerNewFolder.click();
  await tree.getByRole("textbox").fill(folder);
  await page.keyboard.press("Enter");
  await expect
    .poll(() => fs.existsSync(path.join(projectDir, folder)), { timeout: 60_000 })
    .toBe(true);

  // Now SELECT that folder, which is the state the defect was measured in.
  const folderRow = tree.getByRole("treeitem", { name: folder }).first();
  await expect(folderRow).toBeVisible({ timeout: 60_000 });
  await folderRow.click();
  await expect(folderRow).toHaveAttribute("aria-selected", "true");
  await shot(page, "exp1-03b-folder-selected");

  const inner = `exp1-inner-${stamp}.ts`;
  await headerNewFile.click();
  await tree.getByRole("textbox").fill(inner);
  await page.keyboard.press("Enter");

  // THE WORLD: inside the selected folder ...
  await expect
    .poll(() => fs.existsSync(path.join(projectDir, folder, inner)), { timeout: 60_000 })
    .toBe(true);
  // ... and NOT beside it, which is where it used to land.
  expect(fs.existsSync(path.join(projectDir, inner))).toBe(false);
  await shot(page, "exp1-03c-created-in-selected-folder");

  /* ---- RENAME: F2 on the focused row, committed with Enter -------------- */

  // RENAMED THROUGH THE MENU, not by clicking the row first: a click on a file
  // row OPENS it, and a tab for the pre-rename name would confound the open
  // assertion below with a tab this step created.
  const renamed = `exp1-renamed-${stamp}.md`;
  await createdRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename" }).click();

  const renameBox = tree.getByRole("textbox");
  await expect(renameBox).toBeFocused();
  // Seeded with the current name, so a rename is an EDIT rather than a retype.
  await expect(renameBox).toHaveValue(created);
  await shot(page, "exp1-04-rename-box-seeded");

  await renameBox.fill(renamed);
  await page.keyboard.press("Enter");

  await expect
    .poll(() => fs.existsSync(path.join(projectDir, renamed)), { timeout: 60_000 })
    .toBe(true);
  // The old name is GONE from the disk, which is what makes this a rename and
  // not a copy.
  expect(fs.existsSync(path.join(projectDir, created))).toBe(false);
  const renamedRow = tree.getByRole("treeitem", { name: renamed });
  await expect(renamedRow).toBeVisible({ timeout: 60_000 });
  await shot(page, "exp1-05-file-renamed");

  /* ---- OPEN: deliberately NOT asserted here ---------------------------- */

  // Opening is not this stage's surface. A click on a file row publishes a
  // file-open INTENT (`workspace/file-open-intent.ts`) and the workspace
  // controller decides what a tab is - preview or pinned, deduped on path,
  // repaired after a close. That owner is being changed in this same tree by
  // the preview-tabs work, and its own spec ("TAB-1 preview tabs") is where the
  // tab contract belongs. Asserting it from here would make this walk red for a
  // neighbour's in-flight change and would duplicate a contract that already
  // has an owner and a test.
  //
  // The bytes are still written, because the delete below has to remove a file
  // with contents rather than an empty one.
  fs.writeFileSync(path.join(projectDir, renamed), "# exp1\n");

  /* ---- FOCUS: a single click OPENS, and leaves the caret in the tree ---- */

  // THE DEFECT THIS GUARDS (live test 2026-09-03, I-5). A single click on a
  // file row opens the preview, and the surface that mounted for it left
  // `document.activeElement` on `body`: F2, Delete and Shift+F10 then did
  // nothing at all until the user pressed Ctrl+Shift+E to get back into the
  // tree. VS Code's split is the rule (`listService.ts:717-733`): a POINTER
  // open preserves focus in the explorer, a double click and Enter hand it to
  // the editor.
  //
  // WHAT THIS IS NOT: the reproducer. Measured on this build with the tree's
  // focus repair deliberately reverted, `document.activeElement` stayed on the
  // tree for the two seconds after the click, so the steal the live pass saw
  // does not arise from this walk's own state and this section stays green
  // without the repair. The reproducer is `ExplorerTree.test.tsx` ("keeps focus
  // in the tree when a preview open drops it"), which blurs the way the built
  // surface did and IS red without it. This is the assembled guard: whatever
  // owner steals focus next, a real click through a real viewer has to leave
  // the write keys working.
  await renamedRow.click();
  // THE OPEN HAS LANDED before focus is read: the tab is the workspace's own
  // acknowledgement that the file reached it, so this asserts focus after the
  // surface mounted rather than in the gap before it.
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(centre.getByRole("tab", { name: new RegExp(renamed) })).toBeVisible({
    timeout: 60_000,
  });
  await expect(tree).toBeFocused({ timeout: 60_000 });

  // aria-selected FOLLOWS THE KEYBOARD, and the open file keeps a marker of its
  // own. Before this, the attribute marked the open file, so a user arrowing
  // down the tree heard one row announced however far they moved - which is
  // also why End looked like it did nothing (A-1): the keystroke always reached
  // `moveFocus:last`, and what the tree showed and announced did not move.
  await expect(renamedRow).toHaveAttribute("aria-selected", "true");
  await expect(renamedRow).toHaveAttribute("data-vex-explorer-open", "true");

  await page.keyboard.press("End");
  const lastRow = tree.locator('[role="treeitem"]').last();
  await expect(lastRow).toHaveAttribute("aria-selected", "true");
  await expect(tree.locator('[role="treeitem"][aria-selected="true"]')).toHaveCount(1);
  // The open file is still marked as open, and no longer as selected.
  await expect(renamedRow).toHaveAttribute("data-vex-explorer-open", "true");
  await shot(page, "exp1-06-focus-stays-in-tree");

  // AND THE FOCUS IS THE USEFUL KIND: the write keys work from it, which is
  // exactly what the live pass found broken. F2 opens the name box on the row
  // the keyboard is on, with no click in between.
  await renamedRow.click();
  await page.keyboard.press("F2");
  const focusRenameBox = tree.getByRole("textbox");
  await expect(focusRenameBox).toBeFocused({ timeout: 60_000 });
  await expect(focusRenameBox).toHaveValue(renamed);
  await page.keyboard.press("Escape");
  await expect(tree.getByRole("textbox")).toHaveCount(0);

  /* ---- VEX-MANAGED: the installer's own file refuses to be renamed ------ */

  // The refusal that protects durable provenance. `AGENTS.md` is written by the
  // installer, so a tree that let the user rename it would leave a provenance
  // row pointing at a path that no longer exists.
  //
  // THE ROW IS THERE, and that is asserted rather than guarded. `AGENTS.md` is
  // written by the create path this walk just drove (the same file
  // `studio-project-journey.spec.ts` asserts as a `current` artifact), and the
  // walk already clicks `CLAUDE.md` unguarded a few steps above. An
  // `if (count > 0)` here meant an installer that wrote no `AGENTS.md`, or a
  // tree that failed to list it, silently skipped the ONE refusal that protects
  // durable provenance - and reported green.
  const agents = tree.getByRole("treeitem", { name: "AGENTS.md" });
  await expect(agents).toHaveCount(1, { timeout: 60_000 });
  await agents.click();
  await page.keyboard.press("F2");
  await tree.getByRole("textbox").fill(`not-agents-${stamp}.md`);
  await page.keyboard.press("Enter");
  // The reason lands ON THE ROW, beside the name that caused it, and the file
  // is still exactly where the installer put it.
  await expect(tree.getByRole("alert")).toContainText("Repair", { timeout: 60_000 });
  expect(fs.existsSync(path.join(projectDir, "AGENTS.md"))).toBe(true);
  await shot(page, "exp1-07-managed-refusal");
  await page.keyboard.press("Escape");

  /* ---- DELETE: through the confirmation, and only through it ------------ */

  await renamedRow.click();
  await page.keyboard.press("Delete");

  const confirm = page.getByRole("dialog", { name: "Delete from this project" });
  await expect(confirm).toBeVisible();
  // THE CONSENT GRAMMAR the user actually reads: what, where it goes, and
  // whether it can be undone.
  const consent = confirm.locator('[data-vex-consent="delete-file"]');
  await expect(consent).toContainText(renamed);
  await expect(consent).toContainText("trash");
  // The safer choice has focus (rule 08), so Enter cannot delete by reflex.
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await shot(page, "exp1-08-delete-confirmation");

  // CANCEL FIRST: the file must survive a confirmation the user backed out of.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  expect(fs.existsSync(path.join(projectDir, renamed))).toBe(true);

  await renamedRow.click();
  await page.keyboard.press("Delete");
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: /Move to trash|Delete permanently/ }).click();

  // THE WORLD AGAIN: the entry is out of the project directory.
  await expect
    .poll(() => fs.existsSync(path.join(projectDir, renamed)), { timeout: 60_000 })
    .toBe(false);
  await expect(tree.getByRole("treeitem", { name: renamed })).toHaveCount(0, {
    timeout: 60_000,
  });
  await shot(page, "exp1-09-file-deleted");

  testInfo.annotations.push({
    type: "exp1-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});

/**
 * HL-1 viewer: the per-line highlight budget, REPORTED rather than hidden.
 *
 * vscode-textmate stops colouring a line once it has spent
 * `LINE_TIME_BUDGET_MS` on it and hands back what it has, so the line keeps
 * every byte and loses its colours after that point. Before the viewer said so,
 * a row that was half coloured and half grey looked like a highlighter that had
 * simply got it wrong. Every unit test around that sentence feeds the copy
 * function a number; what NONE of them can establish is that a real file, read
 * through the real IPC surface and tokenized in the real worker at the REAL
 * budget, reaches the chip at all.
 *
 * ## The fixture is a MEASUREMENT, not a guess
 *
 * Two bounds have to hold at once, and they pull in opposite directions:
 *
 *  - `VIEWER_MAX_TOKENIZE_LINE_LENGTH` is 20,000. A line at or above it is
 *    emitted PLAIN and counted as a long line, so a megabyte-long line reaches
 *    the OTHER sentence and never this one;
 *  - `FILE_READ_MAX_BYTES` is 2 MiB, above which the read is refused outright.
 *
 * So the line must cost more than half a second in under 20,000 characters,
 * which no cheap construction does: the escape-heavy line the tokenizer suite
 * uses costs about 0.5 ms per KB (18,801 characters measured at 4 to 29 ms),
 * a hundred times too little. What DOES is the TypeScript grammar's arrow
 * function lookahead over unclosed parentheses, whose cost is quadratic in
 * their number. Measured on this machine through the real tokenizer at
 * `lineTimeBudgetMs: 0` (three warm runs each):
 *
 *   3,011 chars -> 680, 475, 524 ms
 *   6,011 chars -> 2222, 1911, 1882 ms
 *   9,011 chars -> 4346, 4599, 4329 ms
 *
 * 9,000 parentheses is therefore about 8.7x the 500 ms budget with a quadratic
 * margin under it, well inside both bounds, and at the real budget it is
 * reported as exactly one abandoned line (`budgetExceededLines: [2]`) while
 * costing the worker the budget itself - 504, 501, 501 ms - rather than the
 * four seconds it would take to finish. A slower CI box only widens the margin.
 *
 * Generated here rather than committed, for the same reason IDX-1 writes its
 * own buried file: a fixture that has to be measured is a fixture whose
 * construction belongs beside the numbers that justify it.
 */
test("HL-1 viewer: a line that outruns the highlight budget is reported, not hidden", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  const theme = process.env.VEX_UX_THEME === "celeris" ? "celeris" : "chronos";
  await pickTheme(page, theme);

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(sidebar).toBeVisible();

  /* ---- a project, and one file the highlighter cannot finish ----------- */

  const stamp = Date.now().toString(36);
  const projectName = `vex-hl1-${stamp}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();

  const projectDir = await projectDirectory(vexDb.stack.projectsRoot, stamp);

  // Line 2 is the expensive one, and the lines around it are there so the chip
  // has a line NUMBER to name that is not the whole file.
  const fixtureName = "hl1-long-line.ts";
  const expensiveLine = `const deep = ${"(".repeat(9_000)}1`;
  fs.writeFileSync(
    path.join(projectDir, fixtureName),
    ["// HL-1: the line below outruns the per-line highlight budget.", expensiveLine, ""].join(
      "\n",
    ),
  );

  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const explorerPane = sidebar.locator('[data-vex-rail-pane="explorer"]');
  await expect(explorerPane).toBeVisible();
  const tabs = centre.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs.getByRole("tab").first()).toBeVisible({ timeout: 60_000 });

  /* ---- open it, and read what the viewer says about it ----------------- */

  await sidebar
    .getByRole("treeitem", { name: fixtureName })
    .first()
    .click();
  await expect(tabs.getByRole("tab", { name: new RegExp(fixtureName) })).toBeVisible({
    timeout: 60_000,
  });

  // WHICH lines, and how many. The worker spends the budget on the line before
  // it can report it, so this waits rather than assuming the first paint says
  // anything.
  const chip = page.getByTestId("file-viewer-chip");
  await expect(chip).toContainText("ran out of highlighting time", { timeout: 60_000 });
  await expect(chip).toContainText("line 2");
  // And the quieter half: what the budget IS, and that nothing was cut.
  await expect(page.getByTestId("file-viewer-secondary-note")).toContainText(
    "half a second",
  );
  await shot(page, `${theme}-24-viewer-partly-highlighted`);

  testInfo.annotations.push({
    type: "hl1-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});

/* ====== RESTORE-1/RESTORE-2: the last location comes back, and focus lands ==== */

/**
 * THE RELAUNCH SECTION, and the only one in this file that quits the app.
 *
 * ## Why nothing short of a second process proves this
 *
 * Everything here is a claim about DISK. `runtimeMode` and `activeProjectId`
 * are persisted (uiStore v17), the open FILE TABS are persisted (v18), and the
 * terminal layout has always been. A single-launch spec can prove that each
 * writer wrote - and every one of those writes was already green while the
 * live test measured the product doing the opposite: a project left open with
 * four terminals and `.mcp.json` came back to the Agent welcome, and reopening
 * it restored the terminals without the file. Only a second boot reading the
 * same profile can tell a persisted value from a value that was merely written.
 *
 * VS Code's smoke suite is built on exactly this instrument
 * (`test/automation/src/application.ts:85`, `restart`: stop, start again on the
 * same user data dir) and its `data-loss.test.ts` is where "verifies opened
 * editors are restored" lives. `relaunchApp` is that instrument for this app.
 *
 * ## The three relaunches, and why they are one test
 *
 * Each `vexDb` fixture starts its own Postgres container and migrates a fresh
 * schema, so three tests would be three containers and three migrations to
 * prove three facts about one profile. They run in one test, in the order the
 * profile allows: everything comes back, then a file deleted between sessions
 * is counted, then an invented project id fails closed. The numbering in the
 * comments follows the brief's legs, not the wall clock.
 *
 * ## The second boot's door
 *
 * The app boots to its own setup machine, and this spec's sanctioned way past
 * it is the diagnostic tour that `VITE_VEX_SETUP_TOUR=1` bakes in - the same
 * door `enterStudio` uses on the first boot. What must NOT be repeated is the
 * runtime-mode click: the whole claim is that Studio is where the user left it,
 * so a section that clicked "Studio" again after the relaunch would prove
 * nothing at all.
 */
test("RESTORE-1 restore: the last location comes back, and focus lands", async ({
  vexDb,
}: {
  vexDb: VexDatabaseFixture;
}, testInfo: TestInfo) => {
  // Three boots, three shutdowns and a project create. The fixture's own
  // container work is budgeted separately.
  test.setTimeout(900_000);
  let page = vexDb.shell;
  const reached = await enterStudio(page);
  test.skip(!reached, TOUR_SKIP_REASON);

  /**
   * The second boot's door: the tour, and NOTHING ELSE.
   *
   * No runtime-mode click and no project click, so every assertion after it is
   * about what the app restored rather than about what the test just did.
   */
  const reEnterShell = async (relaunchedPage: Page): Promise<void> => {
    await relaunchedPage.waitForLoadState("domcontentloaded");
    await relaunchedPage.setViewportSize({ width: 1440, height: 900 });
    await expect(
      relaunchedPage.locator('[data-vex-screen="systemCheck"]'),
    ).toBeVisible({ timeout: 120_000 });
    // THE DOOR MUST NOT KEEP THE FOCUS, and the moment it is handed back
    // matters more than the fact.
    //
    // The real second boot ends at the unlock screen, whose password field is
    // REMOVED when the vault opens, so the app resumes with NOBODY holding
    // focus - the one state `studioFocusPermission` (VS Code's
    // `EditorPart.shouldRestoreFocus`) allows a surface to claim. The
    // diagnostic tour is a button that stays on screen and keeps focus, and the
    // workspace's landing is ARMED ONCE and gives up the first time it finds
    // focus owned by somebody else. Blurring after the click is therefore too
    // late: measured, it left `document.activeElement` on the body with the
    // arming already spent, which is the product behaving correctly and the
    // test measuring its own door.
    //
    // So the button hands the focus back IN ITS OWN `focus` HANDLER, before the
    // click that follows it has changed a single React state - which reproduces
    // the unlock's hand-off exactly. It opens nothing and selects nothing.
    const tour = relaunchedPage.locator("[data-vex-setup-tour]");
    await expect(tour).toBeVisible();
    const door = tour.getByRole("button", { name: "appShell", exact: true });
    await door.evaluate((element: HTMLElement) => {
      element.addEventListener(
        "focus",
        () => {
          element.blur();
        },
        { once: true },
      );
    });
    await door.click();
    await expect(
      relaunchedPage.locator('[data-vex-screen="appShell"]'),
    ).toBeVisible();
  };

  const activeElementLabel = (target: Page): Promise<string> =>
    target.evaluate(() => {
      const active = document.activeElement;
      if (active === null) return "none";
      if (active === document.body) return "BODY";
      const label =
        active.getAttribute("aria-label") ?? (active.textContent ?? "").trim();
      return `${active.tagName.toLowerCase()}:${label}`;
    });

  /* ---- 1: a project, its first terminal, and a file tab ---------------- */

  const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
  const centre = page.locator('[data-vex-area="studio-center"]');
  await expect(sidebar).toBeVisible();

  const projectName = `vex-restore-${Date.now().toString(36)}`;
  await sidebar.getByRole("button", { name: "New project" }).click();
  const creator = page.getByRole("dialog", { name: "New project" });
  await creator.getByLabel("Name").fill(projectName);
  await creator.locator('[data-vex-agent="claude-code"]').click();
  await creator.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("button", { name: /Done|Close/ }).first().click();
  await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();

  const tabs = centre.getByRole("tablist", { name: "Studio terminals and files" });
  await expect(tabs.getByRole("tab").first()).toBeVisible({ timeout: 120_000 });
  // RUNNING, not merely present: a tab appears the moment the model gains it,
  // and a restore comparison against a shell that never started proves nothing.
  await expect(tabs.getByRole("tab", { name: /Running/ }).first()).toBeVisible({
    timeout: 120_000,
  });
  const terminalTabCount = await tabs.getByRole("tab").count();

  // THE PROJECT ID, taken from the workspace the centre mounted. Every later
  // assertion about "this project's workspace" and the negative leg's invented
  // id are about this value.
  const workspace = centre.locator("[data-vex-studio-workspace]").first();
  const projectId = await workspace.getAttribute("data-vex-studio-workspace");
  expect(projectId).not.toBeNull();

  /* ---- 2: focus landed IN THE SHELL, not on the body ------------------- */

  // The measured defect RESTORE-1 closed: opening a project left
  // `document.activeElement` on `document.body`, so a keyboard user tabbed from
  // the top of the window to reach the terminal that had just been opened for
  // them. Asserted BEFORE the file is opened, because clicking a tree row is
  // itself a focus move and would answer a different question.
  await expect
    .poll(() => activeElementLabel(page), { timeout: 60_000 })
    .toBe("textarea:Terminal input");
  await shot(page, "restore2-01-project-open-focus-in-terminal");

  /* ---- 1b: a file tab, opened from the explorer ------------------------ */

  const fileRows = sidebar.locator('[role="treeitem"]:not([aria-expanded])');
  await expect(fileRows.first()).toBeVisible({ timeout: 120_000 });
  const openedFileName = (await fileRows.first().innerText()).trim();
  await fileRows.first().click();
  const fileTab = tabs.getByRole("tab", { name: new RegExp(escapeForRegExp(openedFileName)) });
  await expect(fileTab).toBeVisible({ timeout: 60_000 });
  await shot(page, "restore2-02-file-tab-open");

  /* ---- 3: out to Agent mode and back, by keyboard and by the capsule --- */

  const shell = page.locator('[data-vex-screen="appShell"]');
  await page.keyboard.press("Control+Shift+A");
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "agent");
  // AND FOCUS WENT WITH IT. A mode switch that left focus on the body is the
  // same defect as the open, one surface along.
  await expect
    .poll(() => activeElementLabel(page), { timeout: 30_000 })
    .toBe("textarea:Session draft");
  await shot(page, "restore2-03-agent-mode-focus-in-draft");

  await page
    .getByRole("radiogroup", { name: "Runtime mode" })
    .getByRole("radio", { name: "Studio" })
    .click();
  await expect(shell).toHaveAttribute("data-vex-runtime-mode", "studio");
  await expect(fileTab).toBeVisible({ timeout: 60_000 });

  /* ---- 4: the relaunch, and what comes back with no further gesture ---- */

  let relaunched = await relaunchApp(vexDb.app, vexDb.stack.configDir, testInfo, {
    args: [APP_DIR],
    env: vexDb.stack.env,
  });
  try {
    page = relaunched.shell;
    await reEnterShell(page);

    const restoredShell = page.locator('[data-vex-screen="appShell"]');
    // THE MODE came back, with no click on the runtime toggle.
    await expect(restoredShell).toHaveAttribute("data-vex-runtime-mode", "studio");
    const restoredCentre = page.locator('[data-vex-area="studio-center"]');
    await expect(restoredCentre).toBeVisible();
    // THE PROJECT came back: its workspace is mounted AND shown. `hidden` is
    // the state a kept-alive but unselected project is in, so "mounted" alone
    // would pass on a workspace nobody can see.
    const restoredWorkspace = restoredCentre.locator(
      `[data-vex-studio-workspace="${projectId ?? ""}"]`,
    );
    await expect(restoredWorkspace).toBeVisible({ timeout: 180_000 });
    await expect(restoredWorkspace).not.toHaveAttribute("hidden", /.*/);
    // And the welcome is NOT what is on screen. Asked by the welcome's own
    // public marker, the same one its focus seam uses: a heading name would be
    // a second, weaker way to name the same surface.
    await expect(
      page.locator('[data-vex-area="studio-welcome"]'),
    ).toHaveCount(0);

    const restoredTabs = restoredCentre.getByRole("tablist", {
      name: "Studio terminals and files",
    });
    // THE FILE TAB IS BACK, by its own title. This is the defect the live test
    // measured and the whole reason file tabs got a home of their own.
    await expect(
      restoredTabs.getByRole("tab", { name: new RegExp(escapeForRegExp(openedFileName)) }),
    ).toBeVisible({ timeout: 180_000 });
    // The terminals came back too, in the same number, so the file tab did not
    // arrive at their expense.
    await expect
      .poll(async () => restoredTabs.getByRole("tab", { name: /Terminal/ }).count(), {
        timeout: 180_000,
      })
      .toBe(terminalTabCount);
    // AND FOCUS LANDED, with no gesture at all since the tour.
    await expect
      .poll(() => activeElementLabel(page), { timeout: 60_000 })
      .toBe("textarea:Terminal input");
    await shot(page, "restore2-04-relaunched-everything-back");

    /* ---- 6: a file deleted BETWEEN the sessions is dropped and counted -- */

    // Deleted from disk, with the app running, exactly as a user deleting it in
    // another program would: the persisted path still names it and main's own
    // walk is what refuses to confirm it.
    const projectDir = path.join(
      vexDb.stack.projectsRoot,
      fs.readdirSync(vexDb.stack.projectsRoot)[0] ?? "",
    );
    const deletedFile = path.join(projectDir, openedFileName);
    expect(fs.existsSync(deletedFile)).toBe(true);

    relaunched = await relaunchApp(relaunched.app, vexDb.stack.configDir, testInfo, {
      args: [APP_DIR],
      env: vexDb.stack.env,
    });
    // Between the two boots, which is when a file goes missing in practice.
    fs.rmSync(deletedFile, { force: true });
    page = relaunched.shell;
    await reEnterShell(page);

    const afterDeleteCentre = page.locator('[data-vex-area="studio-center"]');
    await expect(
      afterDeleteCentre.getByText(/1 file tab could not be restored/),
    ).toBeVisible({ timeout: 180_000 });
    // The tab itself is NOT there: a tab pointing at a token main would refuse
    // is worse than no tab.
    await expect(
      afterDeleteCentre
        .getByRole("tablist", { name: "Studio terminals and files" })
        .getByRole("tab", { name: new RegExp(escapeForRegExp(openedFileName)) }),
    ).toHaveCount(0);
    await shot(page, "restore2-05-dropped-file-tab-counted");

    /* ---- 5: THE NEGATIVE - an invented project id opens nothing --------- */

    const invented = "00000000-0000-4000-8000-000000000000";
    /**
     * A HAND-EDITED `vex-ui`, and then FROZEN.
     *
     * Two facts force this shape. `vex-ui` lives in the window's own
     * localStorage, which is a leveldb inside the Chromium profile and is not
     * writable from Node, so the edit is made through the page - the same
     * untrusted bytes a user with devtools would write, in the same place. And
     * the app WRITES THAT KEY ON THE WAY OUT: the visibility flush persists the
     * workspace's file strip, and zustand's persist rewrites the whole payload
     * from memory when it does, which silently restored the real project id.
     * Measured, not theorised - it is why the first run of this leg found the
     * real workspace after the relaunch.
     *
     * So `setItem` is stubbed out in the same synchronous step as the edit.
     * Nothing this session does afterwards can reach the key, which leaves on
     * disk exactly the bytes a user would have left there, and the next boot
     * reads them.
     */
    await page.evaluate((id: string) => {
      const raw = window.localStorage.getItem("vex-ui");
      if (raw !== null) {
        const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
        if (parsed.state !== undefined) {
          parsed.state["activeProjectId"] = id;
          window.localStorage.setItem("vex-ui", JSON.stringify(parsed));
        }
      }
      window.localStorage.setItem = (): void => undefined;
    }, invented);

    relaunched = await relaunchApp(relaunched.app, vexDb.stack.configDir, testInfo, {
      args: [APP_DIR],
      env: vexDb.stack.env,
    });
    page = relaunched.shell;
    await reEnterShell(page);

    const negativeShell = page.locator('[data-vex-screen="appShell"]');
    // STUDIO IS STILL THE SHELL: the mode survived, which is the half of the
    // last location that was not invalidated.
    await expect(negativeShell).toHaveAttribute("data-vex-runtime-mode", "studio");
    // And the selection FAILED CLOSED: the welcome, with the real project in
    // its recents, and no workspace mounted for the id nobody minted.
    await expect(
      page.locator('[data-vex-area="studio-welcome"]'),
    ).toBeVisible({ timeout: 180_000 });
    await expect(
      page.locator(`[data-vex-studio-workspace="${invented}"]`),
    ).toHaveCount(0);
    // THE REAL PROJECT IS IN THE WELCOME'S OWN RECENTS, not merely somewhere on
    // screen: the rail lists it too, and a page-wide text match would pass on
    // that instead.
    await expect(
      page
        .locator('[data-vex-area="studio-welcome"]')
        .getByText(new RegExp(escapeForRegExp(projectName)))
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    // FOCUS LANDS ON THE WELCOME'S OWN FIRST ACTION, not on the body.
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              document.activeElement?.getAttribute(
                "data-vex-studio-welcome-action",
              ) ?? "none",
          ),
        { timeout: 60_000 },
      )
      .toBe("primary");
    await shot(page, "restore2-06-invented-project-fails-closed");
  } finally {
    // THE RELAUNCHED APP IS THIS TEST'S, not the fixture's: the fixture closes
    // the app it launched and has never heard of this one. `finally`, so a
    // failed assertion above does not strand an Electron behind the worker.
    await relaunched.app.close().catch(() => undefined);
  }

  testInfo.annotations.push({
    type: "restore-shots",
    description: SHOTS_DIR === "" ? "assertions only" : SHOTS_DIR,
  });
});

/**
 * A file or project name inside a `RegExp`, with its metacharacters neutered.
 *
 * The names here come from the project template and from a generated project
 * name (`.mcp.json` among them), and an unescaped `.` in a tab-name pattern
 * matches any character - which is how a walk starts passing against the wrong
 * tab.
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
