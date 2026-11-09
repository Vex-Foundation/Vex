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
 * screenshot pass (`shot`) and the one-theme check (`expectTheOneTheme`) with
 * the other sections, and those stay owned by the spec that defines the capture
 * contract. They are handed in rather than duplicated, so a capture pass
 * photographs every section under one rule.
 *
 * Owned by the rail lane. The section's own reasoning is on the scenario.
 */

import fs from "node:fs";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import sharp from "sharp";
import type { VexDatabaseFixture, test as vexTest } from "./fixtures/vex-app-with-database.js";
import { expect } from "./fixtures/vex-app-with-database.js";
import { enterStudio, sizeShellWindow, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";

/* ===================== THE PAPER, measured on the built app ==================
 *
 * Vex's column is paper (`.vex-vs` in vex-sidebar.css; docs/design/
 * R3-MINIMAL.md section 5: one paper per room, no box, no fill, no radius, no
 * shadow, no blur; H3 keeps it: square cells on one ground), and its console's
 * sections (Needs you, This project, AI permission, recent activity) sit on
 * it. The claims are measured in the same shape
 * studio-terminal-surface.spec.ts proves its own for the pane, in Studio, in
 * the app's one theme (dark only since plan row S1-04, docs/design/
 * H3-DESKTOP.md section 4.5):
 *
 *  - THE PAGE IS PAPER. The column paints an opaque ground and blurs nothing
 *    behind it.
 *  - A SECTION IS NOT A PLATE. Its background is fully transparent, and it
 *    carries no backdrop filter, no shadow and no radius.
 *  - LEGIBILITY. Every ink token the sections use is measured against the
 *    section AS PAINTED, at the pixel closest to the ink (the worst case),
 *    with the section's own text hidden for the read so the paper is what is
 *    sampled. Primary ink must clear 7:1; every other token is
 *    recorded (the numbers are what a token retune would be judged against).
 */

/** The ink tokens text is painted with, read inside each section. */
const INK_TOKENS = [
  "text-ink-primary",
  "text-ink-secondary",
  "text-ink-tertiary",
  "text-success",
  "text-warning-label",
] as const;

type Rgb = readonly [number, number, number];

interface InkContrast {
  readonly token: (typeof INK_TOKENS)[number];
  readonly ink: Rgb;
  /** Against the plate's mean pixel. */
  readonly mean: number;
  /** Against the plate pixel closest in luminance to the ink. */
  readonly worst: number;
  readonly worstPixel: Rgb;
}

interface CardGlaze {
  readonly name: string;
  readonly backdropFilter: string;
  readonly backgroundColor: string;
  readonly boxShadow: string;
  readonly borderRadius: string;
  readonly plateMean: Rgb;
  readonly inks: readonly InkContrast[];
}

interface SurfaceGlaze {
  readonly theme: string;
  readonly host: "vex-sidebar";
  readonly hostBackdropFilter: string;
  /** The background of the page the sections sit on (the host's `.vex-vs`). */
  readonly hostPaper: string;
  readonly cards: readonly CardGlaze[];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function parseRgb(css: string): Rgb {
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (match === null) throw new Error(`not an rgb() colour: ${css}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The computed facts of one card and the ink colours its tokens resolve to inside it. */
async function readCardFacts(
  card: Locator,
): Promise<{
  readonly backdropFilter: string;
  readonly backgroundColor: string;
  readonly boxShadow: string;
  readonly borderRadius: string;
  readonly inks: Record<string, string>;
}> {
  return card.evaluate((node, tokens: readonly string[]) => {
    const style = window.getComputedStyle(node);
    const inks: Record<string, string> = {};
    for (const token of tokens) {
      const probe = document.createElement("span");
      probe.className = token;
      node.appendChild(probe);
      inks[token] = window.getComputedStyle(probe).color;
      probe.remove();
    }
    return {
      backdropFilter: style.backdropFilter,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      borderRadius: style.borderTopLeftRadius,
      inks,
    };
  }, INK_TOKENS);
}

/**
 * Photograph the card with its own content hidden, so what the pixels show is
 * the plate as painted over whatever is behind it - the rail and the wall.
 *
 * Hidden through each descendant's OWN inline style (CSSOM), not an injected
 * `<style>` element: the renderer's CSP refuses inline style sheets, so a
 * rule appended to `<head>` never applies and the first probe photographed
 * the text it meant to hide. Every inline value is restored before the
 * function returns, whatever the screenshot does.
 */
async function photographPlate(page: Page, card: Locator): Promise<Buffer> {
  await card.evaluate((node) => {
    for (const child of Array.from(node.querySelectorAll("*"))) {
      if (!(child instanceof HTMLElement || child instanceof SVGElement)) continue;
      child.dataset["vexGlazeProbeVisibility"] = child.style.visibility;
      child.style.visibility = "hidden";
    }
  });
  try {
    // One frame for the hide to paint before the read.
    await page.waitForTimeout(50);
    const box = await card.boundingBox();
    expect(box, "the card has no layout box").not.toBeNull();
    if (box === null) throw new Error("unreachable");
    return await withTourHidden(page, () =>
      page.screenshot({
        clip: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.max(1, Math.round(box.width)),
          height: Math.max(1, Math.round(box.height)),
        },
      }),
    );
  } finally {
    await card.evaluate((node) => {
      for (const child of Array.from(node.querySelectorAll("*"))) {
        if (!(child instanceof HTMLElement || child instanceof SVGElement)) continue;
        child.style.visibility = child.dataset["vexGlazeProbeVisibility"] ?? "";
        delete child.dataset["vexGlazeProbeVisibility"];
      }
    });
  }
}

/** Hide the tour navigator (QA scaffolding, never a shipped surface) for a capture. */
async function withTourHidden<T>(page: Page, run: () => Promise<T>): Promise<T> {
  await page.evaluate(() => {
    const tour = document.querySelector("[data-vex-setup-tour]");
    if (tour instanceof HTMLElement) tour.style.visibility = "hidden";
  });
  try {
    return await run();
  } finally {
    await page.evaluate(() => {
      const tour = document.querySelector("[data-vex-setup-tour]");
      if (tour instanceof HTMLElement) tour.style.visibility = "";
    });
  }
}

async function measureCard(
  page: Page,
  card: Locator,
  name: string,
  shotPath: string | null,
): Promise<CardGlaze> {
  const facts = await readCardFacts(card);
  const png = await photographPlate(page, card);
  if (shotPath !== null) fs.writeFileSync(shotPath, png);
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const samples: Rgb[] = [];
  for (let i = 0; i < pixels; i += 1) {
    const px: Rgb = [
      data[i * info.channels] ?? 0,
      data[i * info.channels + 1] ?? 0,
      data[i * info.channels + 2] ?? 0,
    ];
    sumR += px[0];
    sumG += px[1];
    sumB += px[2];
    samples.push(px);
  }
  const plateMean: Rgb = [
    Math.round(sumR / pixels),
    Math.round(sumG / pixels),
    Math.round(sumB / pixels),
  ];
  const inks = INK_TOKENS.map((token): InkContrast => {
    const ink = parseRgb(facts.inks[token] ?? "");
    const inkLum = relativeLuminance(ink);
    let worstPixel: Rgb = plateMean;
    let worstDistance = Number.POSITIVE_INFINITY;
    for (const px of samples) {
      // The worst case is the plate pixel closest in luminance to the ink.
      const distance = Math.abs(relativeLuminance(px) - inkLum);
      if (distance < worstDistance) {
        worstDistance = distance;
        worstPixel = px;
      }
    }
    return {
      token,
      ink,
      mean: contrastRatio(ink, plateMean),
      worst: contrastRatio(ink, worstPixel),
      worstPixel,
    };
  });
  return {
    name,
    backdropFilter: facts.backdropFilter,
    backgroundColor: facts.backgroundColor,
    boxShadow: facts.boxShadow,
    borderRadius: facts.borderRadius,
    plateMean,
    inks,
  };
}

/** Every section of Vex's column, named by its region label or its area. */
async function measureSurface(
  page: Page,
  host: Locator,
  kind: SurfaceGlaze["host"],
  theme: string,
  shotsDir: string,
): Promise<SurfaceGlaze> {
  const hostBackdropFilter = await host.evaluate(
    (node) => window.getComputedStyle(node).backdropFilter,
  );
  const hostPaper = await host.evaluate((node) => {
    const paper = node.matches(".vex-vs") ? node : node.querySelector(".vex-vs");
    return paper === null ? "" : window.getComputedStyle(paper).backgroundColor;
  });
  const cards: CardGlaze[] = [];
  // The console's sections (H3): Needs you in its top, then This project,
  // AI permission and the recent activity in its rest.
  const sections = host.locator(".vex-console__needs, .vex-console__section");
  const count = await sections.count();
  expect(count, `${kind} has no cards to measure`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const card = sections.nth(index);
    // A card scrolled out of the rail's viewport photographs nothing.
    await card.scrollIntoViewIfNeeded();
    const name = (
      (await card.getAttribute("aria-label")) ??
      (await card.getAttribute("data-vex-area")) ??
      `card-${String(index)}`
    )
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const shotPath =
      shotsDir === "" ? null : path.join(shotsDir, `${theme}-glaze-${kind}-${name}.png`);
    cards.push(await measureCard(page, card, name, shotPath));
  }
  return { theme, host: kind, hostBackdropFilter, hostPaper, cards };
}

/** A computed colour's alpha: 1 for `rgb()`, the fourth channel of `rgba()`. */
function alphaOf(css: string): number {
  const rgba = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(css);
  if (rgba !== null) return Number(rgba[1]);
  return /^rgb\(/.test(css) ? 1 : Number.NaN;
}

/** The claims the paper makes wherever a section is painted, and the ink floor. */
function expectOnPaper(surface: SurfaceGlaze): void {
  const where = `${surface.theme} ${surface.host}`;
  // THE PAGE IS PAPER: an opaque ground, and nothing behind it blurred.
  expect(surface.hostBackdropFilter, `${where} filter`).toBe("none");
  expect(alphaOf(surface.hostPaper), `${where} paper alpha`).toBe(1);
  for (const card of surface.cards) {
    const label = `${where} ${card.name}`;
    // A SECTION IS NOT A PLATE: no fill, no blur, no shadow, square.
    expect(alphaOf(card.backgroundColor), `${label} background alpha`).toBe(0);
    expect(card.backdropFilter, `${label} filter`).toBe("none");
    expect(card.boxShadow, `${label} shadow`).toBe("none");
    expect(card.borderRadius, `${label} radius`).toBe("0px");
    const primary = card.inks.find((ink) => ink.token === "text-ink-primary");
    expect(primary?.worst ?? 0, `${label} primary ink worst-pixel contrast`).toBeGreaterThanOrEqual(7);
  }
}

/** The walk helpers the owning spec defines and lends to this section. */
export interface RailParityWalk {
  /** Photograph a state, if this run is a capture pass; a no-op otherwise. */
  readonly shot: (page: Page, name: string) => Promise<void>;
  /** Assert the app's one theme (dark only, S1-04); there is none to pick. */
  readonly expectTheOneTheme: (page: Page) => Promise<void>;
  /** That theme's name, so a capture names what it shows. */
  readonly theme: string;
  /** Where a capture pass writes; empty means assert, photograph nothing. */
  readonly shotsDir: string;
}

export function registerRailParityScenarios(
  test: typeof vexTest,
  { shot, expectTheOneTheme, theme, shotsDir }: RailParityWalk,
): void {
  /**
   * UX-2: the states the rail findings are argued from (B4, I6, I2, A7, A3).
   *
   * WHY THESE ARE BROWSER ASSERTIONS. Every one of them is about SIZE or about
   * what a real layout puts on screen, which is exactly what jsdom cannot answer:
   *
   *  - B4, the collapsed spine: the vitest suite proves no text NODE renders. It
   *    cannot prove the rail is 76px wide (H3), or that nothing overflows it. Here the
   *    box is measured.
   *  - I6, the explorer pane: "takes the rail's remaining height" is a claim about
   *    resolved pixels. The unit suite can only prove the flex chain is unbroken;
   *    a browser can prove the tree is actually taller than the 256px box it
   *    replaced, and that dragging the seam moves it.
   *  - I2, the search: the grouped results and their bound lines are asserted in
   *    vitest; what is proven here is that they REPLACE the browsing region on a
   *    real rail rather than sitting under it off-screen.
   *
   * The app is dark only, so the walk asserts and captures its one theme.
   */
  test("UX-2 rail and explorer: the spine, the pane, the seam and the search", async ({
    vexDb,
  }: {
    vexDb: VexDatabaseFixture;
  }, testInfo: TestInfo) => {
    test.setTimeout(300_000);
    const page = vexDb.shell;
    // A REAL 1440 x 900 window, not only an emulated viewport, and before
    // `enterStudio` emulates one: the head rows reserve the caption buttons
    // from the window's own title bar area, which an emulated viewport does
    // not move (`sizeShellWindow`).
    await sizeShellWindow(vexDb.app, page, 1440, 900);
    const reached = await enterStudio(page);
    test.skip(!reached, TOUR_SKIP_REASON);

    await expectTheOneTheme(page);

    const sidebar = page.locator('[data-vex-area="studio-sidebar"]');
    await expect(sidebar).toBeVisible();

    /* ---- 01: the welcome rail, and the way back to Agent ---------------- */

    // No capsule anywhere: the Studio sidebar is the left sidebar, and its
    // nav, folded to its Studio row, unfolds the Chat row that is the way
    // back (docs/design/H3-DESKTOP.md section 4.9).
    await expect(page.getByRole("radiogroup", { name: "Runtime mode" })).toHaveCount(0);
    await expect(
      sidebar.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Show every page" }),
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

    // I9's rail half: once a project is open the welcome is gone and the nav
    // stays in the sidebar, so Studio is never a one-way door.
    await expect(
      sidebar.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Show every page" }),
    ).toBeVisible();
    await expect(page.getByRole("radiogroup", { name: "Runtime mode" })).toHaveCount(0);

    // THE I6 ASSERTION, and it is a number on purpose. The pane was a fixed 256px
    // box (`h-64`) inside a scrolling rail. The R3 column puts the nav above
    // the Studio body (docs/design/R3-MINIMAL.md section 4), so at 900px the
    // split holds about 360px once every nav row is drawn: the explorer's
    // default share (0.6) gives it more than the projects pane above it and
    // over 200px, which a fixed box could not do at every window height.
    const paneBox = await explorerPane.boundingBox();
    const projectsBox = await sidebar.locator('[data-vex-rail-pane="projects"]').boundingBox();
    expect(paneBox, "the explorer pane has no layout box").not.toBeNull();
    expect(projectsBox, "the projects pane has no layout box").not.toBeNull();
    expect(paneBox?.height ?? 0).toBeGreaterThan(200);
    expect(paneBox?.height ?? 0).toBeGreaterThan(projectsBox?.height ?? 0);
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

    /* ---- 30: Vex's column, scoped to the PROJECT (A3) ------------------- */

    // H3 (docs/design/H3-DESKTOP.md sections 1.5 and 4.9, the approved Studio
    // plate, S8-06): the column is Vex's console. Its top holds Needs you and
    // the missions row; her section lies over its rest, where This project
    // stands in place of a chat's AI permission: the project's access, its
    // agents, wallet and folder (the path ending in the folder main actually
    // created) and its Project assets key. The recent activity is the
    // project's own, and Open activity opens Agent Scan on the project.
    const vex = page.locator('[data-vex-area="vex-sidebar"]');
    await expect(vex).toHaveAttribute("data-vex-vex-open", "true");
    await expect(vex.locator('[data-vex-area="vex-needs-you"]')).toBeVisible();
    const projectBlock = vex.locator('[data-vex-area="vex-this-project"]');
    await expect(projectBlock).toBeVisible();
    await expect(projectBlock.getByRole("heading", { name: "This project" })).toBeVisible();
    await expect(projectBlock).toHaveAttribute("data-permission", /^(full|restricted)$/);
    await expect(projectBlock.getByText(/^(Full access|Restricted): /)).toBeVisible();
    await expect(projectBlock.getByText("Agents", { exact: true })).toBeVisible();
    await expect(projectBlock.getByText(/^Wallets?$/)).toBeVisible();
    await expect(projectBlock.getByText("Folder", { exact: true })).toBeVisible();
    await expect(projectBlock.getByTitle(new RegExp(`${projectName}$`))).toBeVisible();
    await expect(projectBlock.getByRole("button", { name: "Project assets" })).toBeVisible();
    await expect(
      vex.locator('[data-vex-area="vex-open-activity"][data-vex-activity-scope="project"]'),
    ).toBeVisible();
    // D2 (docs/design/H3-DESKTOP.md section 6): Kimm stands at the column's
    // top as her portrait card, over the console, never over it.
    await expect(vex.locator('[data-vex-area="vex-portrait-card"]')).toBeVisible();

    // NO MONEY IN VEX'S COLUMN: no card, no tab strip, no board surface.
    await expect(vex.locator("[data-vex-portfolio-section]")).toHaveCount(0);
    await expect(vex.getByRole("tab")).toHaveCount(0);
    await expect(vex.locator('[data-vex-area="active-board"]')).toHaveCount(0);
    await shot(page, `${theme}-30-workspace-vex-sidebar`);

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

    // In H3 the frame's header draws the sidebar key over the column
    // (docs/design/H3-DESKTOP.md section 1.3); the rail keeps its own Expand
    // key as the way back.
    await page
      .locator('[data-vex-area="shell-head"]')
      .getByRole("button", { name: "Collapse Studio sidebar" })
      .click();
    await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
    // POLLED, because the grid track slides to the spine over the reveal
    // duration. The contract is where it SETTLES; reading the box on the first
    // frame reads the slide.
    await expect
      .poll(async () => (await sidebar.boundingBox())?.width ?? 0, { timeout: 5_000 })
      .toBeLessThanOrEqual(76);
    // THE B4 ASSERTION, measured rather than inspected: no descendant of the rail
    // paints text, and nothing in it is wider than the spine. The old rail failed
    // both - "Pro" and a chevron sat in a box wider than the column.
    const spineText = (await sidebar.innerText()).trim();
    expect(spineText, "the collapsed rail is painting words").toBe("");
    // POLLED for the same reason as the width: the contract is the resting
    // frame.
    await expect
      .poll(
        () =>
          sidebar.evaluate((rail) => {
            const box = rail.getBoundingClientRect();
            return Array.from(rail.querySelectorAll("*")).filter((node) => {
              const child = node.getBoundingClientRect();
              return child.width > 0 && child.right > box.right + 1;
            }).length;
          }),
        { message: "content is bleeding out of the 76px rail", timeout: 5_000 },
      )
      .toBe(0);
    await shot(page, `${theme}-32-sidebar-collapsed`);

    await sidebar.getByRole("button", { name: "Expand Studio sidebar" }).click();

    /* ---- 33: the auto-collapse threshold, at the seam ------------------- */

    // Rule 08 asks for a layout threshold at the seam and on both sides. The pure
    // comparison is unit-tested (`shell-columns.test.ts`); what a browser adds is
    // that the SHELL actually applies it.
    // The seam is H3's (docs/design/H3-DESKTOP.md sections 1.2 and 4.12): from
    // 1280 up the sidebar keeps its preference, under it the sidebar is the
    // 76 rail.
    await page.setViewportSize({ width: 1281, height: 900 });
    await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
    await page.setViewportSize({ width: 1279, height: 900 });
    await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "false");
    await page.setViewportSize({ width: 1000, height: 900 });
    await shot(page, `${theme}-33-narrow-1000px`);

    /* ---- 34: THE PAPER, as painted, in the one theme --------------------- */

    // Back to the walk's viewport; the auto-collapse above was a temporary
    // constraint, so the sidebar's stored preference returns with the width.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
    await expect(vex).toHaveAttribute("data-vex-vex-open", "true");
    await expect(projectBlock).toBeVisible();
    const surfaces: SurfaceGlaze[] = [];

    // In D2 her portrait card stands above the console and covers none of it
    // (docs/design/H3-DESKTOP.md section 6), so the console's sections are
    // read on the column's ground with her shown: the photograph is of the
    // console at rest.
    await expect(vex).toHaveAttribute("data-vex-vex-open", "true");
    await page.evaluate(() => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement) focused.blur();
    });
    await page.mouse.move(1, 899);
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await shot(page, `${theme}-34-vex-sidebar-paper`);
    surfaces.push(await measureSurface(page, vex, "vex-sidebar", theme, shotsDir));

    if (shotsDir !== "") {
      fs.writeFileSync(
        path.join(shotsDir, `glaze-${theme}-run.json`),
        JSON.stringify({ capturedAt: new Date().toISOString(), surfaces }, null, 2),
      );
    }
    testInfo.annotations.push({ type: "paper-measurements", description: JSON.stringify(surfaces) });
    // Unpiped, so the numbers are in the run's own output as well.
    console.log(`[paper] ${JSON.stringify(surfaces)}`);
    for (const surface of surfaces) expectOnPaper(surface);

    testInfo.annotations.push({
      type: "ux2-shots",
      description:
        shotsDir === "" ? `assertions only (${theme})` : `${shotsDir} (${theme})`,
    });
  });
}
