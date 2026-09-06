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

import fs from "node:fs";
import path from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import sharp from "sharp";
import type { VexDatabaseFixture, test as vexTest } from "./fixtures/vex-app-with-database.js";
import { expect } from "./fixtures/vex-app-with-database.js";
import { enterStudio, TOUR_SKIP_REASON } from "./fixtures/studio-shell.js";

/* ===================== THE GLAZE, measured on the built app ==================
 *
 * The BOOK cards wear the glass CARD tier (glass.css; owner decision
 * 2026-09-04: the Settings glaze on every plain card). jsdom paints no
 * backdrop-filter, so the three claims the tier makes are provable only here,
 * in the same shape studio-terminal-glass.spec.ts proves them for the pane:
 *
 *  - INSIDE A RAIL THE RAIL BLURS, THE CARD IS A PLATE. The rail's computed
 *    backdrop-filter carries the blur; every card's resolves to `none` (the
 *    nesting guard in glass.css), and the card's background is translucent.
 *  - STANDING ALONE THE CARD BLURS FOR ITSELF. The welcome Portfolio stack has
 *    no rail under it, and its cards (the same component) keep their filter.
 *  - LEGIBILITY. Every ink token the cards use is measured against the card
 *    AS PAINTED, at the pixel closest to the ink (the worst case), with the
 *    card's own text hidden for the read so the plate is what is sampled.
 *    Primary ink must clear 7:1 in both themes; every other token is recorded
 *    (secondary and tertiary ink do not reach 7:1 on ANY celeris surface,
 *    a pure white one included - that is a text-token fact, not a glaze one,
 *    and the numbers here are what a token retune would be judged against).
 */

/** The ink tokens the BOOK cards paint text with (grep of book/**). */
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
  readonly plateMean: Rgb;
  readonly inks: readonly InkContrast[];
}

interface SurfaceGlaze {
  readonly theme: string;
  readonly host: "studio-rail" | "welcome-stack";
  readonly hostBackdropFilter: string;
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
): Promise<{ readonly backdropFilter: string; readonly backgroundColor: string; readonly inks: Record<string, string> }> {
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
    plateMean,
    inks,
  };
}

/** Every glass card in a host, named by its region label. */
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
  const cards: CardGlaze[] = [];
  const sections = host.locator(".vex-glass-card");
  const count = await sections.count();
  expect(count, `${kind} has no cards to measure`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const card = sections.nth(index);
    // A card scrolled out of the rail's viewport photographs nothing.
    await card.scrollIntoViewIfNeeded();
    const name = ((await card.getAttribute("aria-label")) ?? `card-${String(index)}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-");
    const shotPath =
      shotsDir === "" ? null : path.join(shotsDir, `${theme}-glaze-${kind}-${name}.png`);
    cards.push(await measureCard(page, card, name, shotPath));
  }
  return { theme, host: kind, hostBackdropFilter, cards };
}

/** The two claims the tier makes wherever it is painted, and the ink floor. */
function expectGlazed(surface: SurfaceGlaze): void {
  for (const card of surface.cards) {
    const label = `${surface.theme} ${surface.host} ${card.name}`;
    // Translucent: an rgba() with an alpha below 1, never the opaque token.
    const alpha = /rgba\([^)]*,\s*([\d.]+)\)$/.exec(card.backgroundColor)?.[1];
    expect(Number(alpha ?? "1"), `${label} background alpha`).toBeLessThan(1);
    if (surface.host === "studio-rail") {
      // THE RAIL BLURS, THE CARD IS A PLATE (glass.css law 2, as painted).
      expect(surface.hostBackdropFilter, `${label} rail filter`).toContain("blur(");
      expect(card.backdropFilter, `${label} card filter`).toBe("none");
    } else {
      // Standing alone, the same card blurs for itself.
      expect(card.backdropFilter, `${label} card filter`).toContain("blur(");
    }
    const primary = card.inks.find((ink) => ink.token === "text-ink-primary");
    expect(primary?.worst ?? 0, `${label} primary ink worst-pixel contrast`).toBeGreaterThanOrEqual(7);
  }
}

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

    // PORTFOLIO ONLY (owner decision 2026-09-04: "in Vex Studio's right
    // sidebar we show only Portfolio; Board disappears"). The project rail
    // mounts no tab strip and no board surface; the stack is seated directly.
    // The session rail's toggle is untouched (BookPanel-board-tab.test.tsx).
    await expect(book.getByRole("tab")).toHaveCount(0);
    await expect(book.getByRole("tablist")).toHaveCount(0);
    await expect(book.locator('[data-vex-area="active-board"]')).toHaveCount(0);
    await expect(
      book.locator('[data-vex-area="book-instruments"][data-vex-rail-scope="project"]'),
    ).toBeVisible();

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
    // POLLED for the same reason as the width: once the rail layout applies,
    // the rail controls ENTER the spine from a 49px offset (`vex-rail-in`,
    // shell.css) over the base duration, so a read taken on the frame the
    // width settled can catch a control still sliding in. The contract is
    // the resting frame.
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
        { message: "content is bleeding out of the 56px spine", timeout: 5_000 },
      )
      .toBe(0);
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

    /* ---- 34: THE GLAZE, as painted, in both themes ---------------------- */

    // Back to the walk's viewport; the auto-collapse above was a temporary
    // constraint, so the sidebar's stored preference returns with the width.
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(sidebar).toHaveAttribute("data-vex-sidebar-open", "true");
    if ((await book.getAttribute("data-vex-book-open")) === "false") {
      await book.getByRole("button", { name: "Expand the BOOK panel" }).click();
    }
    await expect(book.getByRole("region", { name: "Position", exact: true })).toBeVisible();
    const other: "chronos" | "celeris" = theme === "chronos" ? "celeris" : "chronos";
    const surfaces: SurfaceGlaze[] = [];

    // The card stagger must have settled before a plate is photographed.
    const settled = async (): Promise<void> => {
      await page.waitForTimeout(900);
    };

    await settled();
    await shot(page, `${theme}-34-studio-rail-glaze`);
    surfaces.push(await measureSurface(page, book, "studio-rail", theme, shotsDir));

    // The same cards standing alone: the Agent welcome's Portfolio stack.
    const modes = page.getByRole("radiogroup", { name: "Runtime mode" });
    await modes.getByRole("radio", { name: "Agent" }).click();
    const welcome = page.locator('[data-vex-area="welcome-portfolio"]');
    // The aside reserves no width while its tab is closed, so the tab is
    // opened before anything in it is expected on screen.
    const openTab = page.getByRole("button", { name: "Open the Portfolio tab" });
    await expect(openTab.or(page.getByRole("button", { name: "Collapse the Portfolio tab" }))).toBeVisible();
    if ((await openTab.count()) > 0) await openTab.click();
    await expect(welcome.getByRole("region", { name: "Wallets", exact: true })).toBeVisible();
    await settled();
    await shot(page, `${theme}-35-welcome-stack-glaze`);
    surfaces.push(await measureSurface(page, welcome, "welcome-stack", theme, shotsDir));

    // The OTHER theme: the same class, the same measurement.
    await pickTheme(page, other);
    await expect(welcome.getByRole("region", { name: "Wallets", exact: true })).toBeVisible();
    await settled();
    await shot(page, `${other}-35-welcome-stack-glaze`);
    surfaces.push(await measureSurface(page, welcome, "welcome-stack", other, shotsDir));

    await page.getByRole("radiogroup", { name: "Runtime mode" })
      .getByRole("radio", { name: "Studio" })
      .click();
    if ((await book.count()) === 0) {
      await sidebar.getByRole("button", { name: new RegExp(projectName) }).first().click();
    }
    await expect(book).toBeVisible();
    if ((await book.getAttribute("data-vex-book-open")) === "false") {
      await book.getByRole("button", { name: "Expand the BOOK panel" }).click();
    }
    await expect(book.getByRole("region", { name: "Position", exact: true })).toBeVisible();
    await settled();
    await shot(page, `${other}-34-studio-rail-glaze`);
    surfaces.push(await measureSurface(page, book, "studio-rail", other, shotsDir));

    if (shotsDir !== "") {
      fs.writeFileSync(
        path.join(shotsDir, `glaze-${theme}-run.json`),
        JSON.stringify({ capturedAt: new Date().toISOString(), surfaces }, null, 2),
      );
    }
    testInfo.annotations.push({ type: "glaze-measurements", description: JSON.stringify(surfaces) });
    // Unpiped, so the numbers are in the run's own output as well.
    console.log(`[glaze] ${JSON.stringify(surfaces)}`);
    for (const surface of surfaces) expectGlazed(surface);

    testInfo.annotations.push({
      type: "ux2-shots",
      description:
        shotsDir === "" ? `assertions only (${theme})` : `${shotsDir} (${theme})`,
    });
  });
}
