/**
 * UX-2: the rail and the explorer, registered into `studio-states.spec.ts`.
 *
 * THIS IS NOT A SPEC FILE. It has no `.spec.ts` suffix, so Playwright never
 * discovers it on its own; `studio-states.spec.ts` imports
 * `registerRailParityScenarios` and calls it, and the scenario is attributed
 * to that spec at load time. The discovered path, the project's `testMatch`
 * and every grep a CI job runs stay exactly what they were.
 *
 * WHY A REGISTRATION FUNCTION and not a second spec: the walk shares the
 * screenshot pass (`shot`) and the theme picker (`pickTheme`) with the other
 * sections, and those stay owned by the spec that defines the capture
 * contract. They are handed in rather than duplicated, so a capture pass
 * photographs every section under one rule.
 *
 * Owned by the rail lane. The section's own reasoning is on the scenario.
 */

import type { Page, TestInfo } from "@playwright/test";
import type { VexDatabaseFixture, test as vexTest } from "./fixtures/vex-app-with-database.js";
import { expect } from "./fixtures/vex-app-with-database.js";
import { enterStudio, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";

/** The walk helpers the owning spec defines and lends to this section. */
export interface RailParityWalk {
  /** Photograph a state, if this run is a capture pass; a no-op otherwise. */
  readonly shot: (page: Page, name: string) => Promise<void>;
  /** Switch the app to one explicit theme, so a capture names what it shows. */
  readonly pickTheme: (page: Page, theme: "chronos" | "celeris") => Promise<void>;
  /** Where a capture pass writes; empty means assert, photograph nothing. */
  readonly shotsDir: string;
}

export function registerRailParityScenarios(
  test: typeof vexTest,
  { shot, pickTheme, shotsDir }: RailParityWalk,
): void {
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

    // LAUNCHPAD is BROWSE-ONLY on a project rail (the fixed decision): it sees
    // the same global locker, says where a launch is signed from, and offers
    // no upload, no delete and no launch a project cannot attribute.
    const launchpad = book.getByRole("region", { name: "Launchpad", exact: true });
    await expect(launchpad).toBeVisible();
    await expect(launchpad.locator('[data-vex-area="launchpad-browse-note"]')).toBeVisible();
    await expect(launchpad.getByRole("button", { name: "Add image" })).toHaveCount(0);
    await expect(launchpad.getByRole("button", { name: /^Remove / })).toHaveCount(0);
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
        shotsDir === "" ? `assertions only (${theme})` : `${shotsDir} (${theme})`,
    });
  });
}
