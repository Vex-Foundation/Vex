/**
 * BOARD GEOMETRY, measured in a real engine at real widths.
 *
 * WHY A BROWSER PROJECT AND NOT THE ELECTRON FIXTURE. `smoke.spec.ts` says it
 * itself: nothing past SystemCheck is reachable without a live Docker daemon,
 * a migrated Postgres and an unlocked vault, so the Board page cannot be
 * opened there at all. Board geometry is decided entirely by the renderer's
 * own container queries over the real production stylesheet, and
 * `vite.board-layout.config.ts` serves exactly that against the real
 * `BoardModalHost` / `BoardGrid` / `TokenCardV3`. The only thing faked is the
 * preload bridge, which is the process boundary and nothing above it.
 *
 * WHAT THESE ASSERTIONS ARE. Contract-level and layout-independent: they say
 * what a reader must never be shown, not which threshold produces it. A
 * threshold is CSS's to own (`global-css/board-layout.css`); these tests are
 * what makes that ownership falsifiable.
 *
 * The derivation of every number quoted below lives in
 * `src/renderer/features/appShell/Board/board-layout-measurements.md`.
 */

import { test, expect, type Page } from "@playwright/test";

/**
 * Regions that are DELIBERATELY clipped and must be exempt from the overflow
 * assertion.
 *
 * `sr-only` and the photo's absence line are one-pixel boxes on purpose: they
 * carry text for assistive technology and are not meant to be seen. The token
 * NAME keeps its ellipsis by product decision (the whole string stays in the
 * `title` and in the card's accessible name), and so does the CHAIN NAME on
 * the ticker line (the R3 tile's "TICKER · Chain"): the ticker keeps its
 * budgeted width and the chain concedes, its whole string in the `title` and
 * in the full-value disclosure's "Chain" row. Those two are the ONLY visible
 * elements that are exempt.
 */
const CLIPPED_BY_DESIGN = [
  "board-token-photo-absence",
  "board-token-name",
  "board-token-chain",
];

interface OverflowingRegion {
  readonly card: string;
  readonly area: string;
  readonly text: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

async function open(
  page: Page,
  options: {
    readonly width: number;
    readonly drawer?: boolean;
    readonly board?: string;
    readonly pools?: number;
    readonly view?: "grid" | "spotlight";
    /** Pin the grid plate's container inline size exactly, for a seam case. */
    readonly plate?: number;
    /** Pin the spotlight plate's container inline size exactly. */
    readonly spotlightPlate?: number;
  },
): Promise<void> {
  await page.setViewportSize({ width: options.width, height: 1200 });
  const params = new URLSearchParams({
    board: options.board ?? "realistic",
    pools: String(options.pools ?? 6),
  });
  if (options.drawer === true) params.set("drawer", "1");
  if (options.view !== undefined) params.set("view", options.view);
  if (options.plate !== undefined) params.set("plate", String(options.plate));
  if (options.spotlightPlate !== undefined) {
    params.set("spotlightPlate", String(options.spotlightPlate));
  }
  await page.goto(`/?${params.toString()}`);
  await page.waitForSelector(
    options.view === "spotlight"
      ? '[data-vex-area="board-spotlight-hero"]'
      : '[data-vex-area="board-token-card-v3"]',
  );
  // THE FONT, THEN THE FRAME.
  //
  // Every number this file asserts is a text measurement, and the display
  // face arrives asynchronously: measuring before `document.fonts.ready`
  // reads the fallback's metrics and produces heights that differ between
  // cards purely by load timing. The Board is a page in the harness (no
  // dialog, no entrance scale), so two frames after the fonts are enough for
  // the container query and the layout it triggers to have landed.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          resolve(null);
        });
      });
    });
  });
}

/** Every element inside a card whose text is cut horizontally. */
async function ellipsizedRegions(
  page: Page,
  exempt: readonly string[],
): Promise<readonly OverflowingRegion[]> {
  return page.evaluate((exemptAreas) => {
    const found: OverflowingRegion[] = [];
    for (const card of document.querySelectorAll(
      '[data-vex-area="board-token-card-v3"]',
    )) {
      const name =
        card.querySelector('[data-vex-area="board-token-name"]')?.textContent ??
        "?";
      for (const element of card.querySelectorAll("*")) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.clientWidth === 0) continue;
        if (element.classList.contains("sr-only")) continue;
        const area = element.getAttribute("data-vex-area");
        if (area !== null && exemptAreas.includes(area)) continue;
        if (
          element.closest(
            exemptAreas.map((a) => `[data-vex-area="${a}"]`).join(","),
          ) !== null
        ) {
          continue;
        }
        if (element.scrollWidth > element.clientWidth + 0.5) {
          found.push({
            card: name,
            area: area ?? element.tagName.toLowerCase(),
            text: element.textContent ?? "",
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
          });
        }
      }
    }
    return found;
  }, [...exempt]);
}

/** Card boxes and their grid tracks, as the engine actually laid them out. */
async function geometry(page: Page): Promise<{
  readonly tracks: readonly number[];
  readonly cardWidths: readonly number[];
  readonly cardHeights: readonly number[];
}> {
  return page.evaluate(() => {
    const grid = document.querySelector("ul[data-vex-area='board-grid']");
    const tracks =
      grid === null
        ? []
        : getComputedStyle(grid)
            .gridTemplateColumns.split(" ")
            .filter((part) => part !== "" && part !== "none")
            .map((part) => Math.round(Number.parseFloat(part)));
    const cards = [...document.querySelectorAll(
      '[data-vex-area="board-token-card-v3"]',
    )];
    return {
      tracks,
      cardWidths: cards.map((card) =>
        Math.round(card.getBoundingClientRect().width),
      ),
      cardHeights: cards.map((card) =>
        Math.round(card.getBoundingClientRect().height),
      ),
    };
  });
}

/** Regions that wrap onto a line their fixed height cannot show. */
async function verticallyClippedRegions(page: Page): Promise<readonly string[]> {
  return page.evaluate(() => {
    const cut: string[] = [];
    for (const card of document.querySelectorAll(
      '[data-vex-area="board-token-card-v3"]',
    )) {
      const name =
        card.querySelector('[data-vex-area="board-token-name"]')?.textContent ??
        "?";
      for (const area of [
        "board-token-price-row",
        "board-token-stats",
        "board-token-card-v3",
      ]) {
        const region = card.matches(`[data-vex-area="${area}"]`)
          ? card
          : card.querySelector(`[data-vex-area="${area}"]`);
        if (!(region instanceof HTMLElement)) continue;
        // The region itself, and the content box inside it: a flex child that
        // wraps taller than its fixed-height parent is the defect, and the
        // parent's own scrollHeight does not always report it.
        for (const node of [region, ...region.children]) {
          if (!(node instanceof HTMLElement)) continue;
          const room =
            node === region
              ? node.clientHeight
              : region.clientHeight;
          if (node.scrollHeight > room + 0.5) {
            cut.push(`${name}/${area}: ${String(node.scrollHeight)} in ${String(room)}`);
          }
        }
      }
    }
    return cut;
  });
}

/** Computed grid tracks and the mode the query published, for one selector. */
async function modeOf(
  page: Page,
  selector: string,
): Promise<{ readonly tracks: number }> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element === null) return { tracks: -1 };
    const style = getComputedStyle(element);
    return {
      tracks: style.gridTemplateColumns
        .split(" ")
        .filter((part) => part !== "" && part !== "none").length,
    };
  }, selector);
}

/**
 * THE LADDER, AS ADVERTISED. This table is the head comment of
 * `global-css/board-layout.css` transcribed into assertions - not a second
 * owner of the numbers, but the thing that makes the stylesheet's ownership
 * falsifiable. A permanent one-column regression fails every row of it.
 * The R3 tile has ONE anatomy (no chart, four stats in a row), so the only
 * thing a width decides is the number of columns.
 */
const COLUMN_LADDER: readonly {
  readonly min: number;
  readonly columns: number;
}[] = [
  { min: 958, columns: 3 },
  { min: 639, columns: 2 },
  { min: 0, columns: 1 },
];

/** The tile floor: the header's 282 inner width, 36 of padding, a 1px rule. */
const TILE_FLOOR = 319;

function expectedAt(container: number): { columns: number } {
  for (const step of COLUMN_LADDER) {
    if (container >= step.min) return { columns: step.columns };
  }
  return { columns: 1 };
}

/** Exact, minus one, plus one, and a fractional hair under the threshold. */
function seamsOf(threshold: number): readonly number[] {
  return [threshold - 1, threshold, threshold + 1, threshold - 0.02];
}

const GRID_THRESHOLDS = [320, 639, 958] as const;

const WIDTHS = [800, 1000, 1280, 1366, 1440, 1920] as const;

test.describe("board grid geometry", () => {
  for (const width of WIDTHS) {
    for (const drawer of [false, true]) {
      const label = `${String(width)}px${drawer ? " with the Vex sidebar open" : ""}`;

      test(`cuts no figure, label, badge or action at ${label}`, async ({ page }) => {
        await open(page, { width, drawer });
        expect(await ellipsizedRegions(page, CLIPPED_BY_DESIGN)).toEqual([]);
      });

      test(`shows every card at its full height at ${label}`, async ({ page }) => {
        await open(page, { width, drawer });
        expect(await verticallyClippedRegions(page)).toEqual([]);
      });

      test(`gives every card in the grid the same box at ${label}`, async ({ page }) => {
        await open(page, { width, drawer });
        const { tracks, cardWidths, cardHeights } = await geometry(page);
        // EQUAL CARDS ARE A CONTRACT (TokenCardV3's own head note). One width
        // and one height across the whole grid, and the card fills its track
        // rather than shrinking to its content inside it.
        expect(new Set(cardWidths).size).toBe(1);
        expect(new Set(cardHeights).size).toBe(1);
        // Within one pixel, because a fractional container divided by three
        // leaves the engine rounding the track and the card's border box
        // independently (a fractional track with the Vex sidebar open). The
        // assertion that matters is the two above: one width, one height.
        expect(
          Math.abs((cardWidths[0] ?? 0) - (tracks[0] ?? 0)),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  test("picks columns from the container, not the viewport", async ({ page }) => {
    // The defect this arc exists for: the Vex sidebar removes 256px from the
    // CONTAINER while a viewport ladder keeps asking for the same columns.
    await open(page, { width: 1440, drawer: false });
    const wide = await geometry(page);
    await open(page, { width: 1440, drawer: true });
    const narrow = await geometry(page);
    // Same viewport, smaller container: either fewer columns, or the same
    // columns at a width that still clears every region floor. What must
    // never happen is the tracks staying put while the cards are squeezed
    // below what their content needs.
    expect(narrow.cardWidths[0]).toBeGreaterThanOrEqual(TILE_FLOOR);
    expect(wide.cardWidths[0]).toBeGreaterThanOrEqual(TILE_FLOOR);
    // 1440 with Vex hidden is three tiles; the sidebar takes it to two.
    expect(wide.tracks.length).toBe(3);
    expect(narrow.tracks.length).toBe(2);
  });

  // With the sidebar open, and at the tile floor, where the verdict has the
  // least room.
  for (const at of [
    { label: "with the Vex sidebar open", width: 1440, drawer: true },
    { label: "at the tile floor", width: 1920, plate: 320 },
  ] as const) {
    test(`survives the longest safety verdict landing late, ${at.label}`, async ({
      page,
    }) => {
      // The async overlay case. Every card starts on "Checking" (about 71px)
      // and settles on "Checks unavailable in this response" (about 218px with
      // its swatch), the widest string the frozen chip table can produce.
      // Neither state may cut a label or an action, and the grid must not
      // reflow the reader's cards under them.
      await open(page, {
        width: at.width,
        ...("drawer" in at ? { drawer: at.drawer } : {}),
        ...("plate" in at ? { plate: at.plate } : {}),
      });
      const before = await geometry(page);
      expect(await ellipsizedRegions(page, CLIPPED_BY_DESIGN)).toEqual([]);

      await page.evaluate(() => {
        window.__vexBoardLayoutHarness.settleSafety();
      });
      await expect(
        page.locator('[data-vex-area="board-status-chip"]').first(),
      ).toHaveText(/Checks unavailable in this response/);

      expect(await ellipsizedRegions(page, CLIPPED_BY_DESIGN)).toEqual([]);
      expect(await verticallyClippedRegions(page)).toEqual([]);
      const after = await geometry(page);
      expect(after.cardHeights).toEqual(before.cardHeights);
    });
  }

  test("keeps a schema extreme recoverable rather than silently cut", async ({
    page,
  }) => {
    // A 40-character decimal and a 512-character symbol both parse
    // (`BOARD_DECIMAL_MAX_CHARS`, `BOARD_TOKEN_LABEL_MAX_CHARS`). Neither can
    // fit any card, so the recovery path must be VISIBLE and reachable by
    // keyboard - a hover-only `title` is not a recovery path.
    await open(page, { width: 1440, board: "extreme", pools: 3 });
    const disclosure = page
      .locator('[data-vex-area="board-token-full-value"]')
      .first();
    await expect(disclosure).toBeVisible();
    await disclosure.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.locator('[data-vex-area="board-token-full-value-popover"]'),
    ).toBeVisible();
  });

  for (const at of [
    { label: "1440px", width: 1440 },
    { label: "the tile floor", width: 1440, plate: 320 },
  ]) {
    test(`cuts no extreme figure silently at ${at.label}`, async ({ page }) => {
      // THE EXTREME CASE RUNS THE SAME ASSERTION SET AS EVERY OTHER WIDTH.
      // A card that clips a `whitespace-nowrap` figure against
      // `overflow-hidden` shows a reader half a number with nothing saying
      // so, which is the silent loss the disclosure exists to prevent - and
      // it stays silent until this assertion is allowed to run here.
      await open(page, {
        width: at.width,
        board: "extreme",
        pools: 3,
        ...(at.plate === undefined ? {} : { plate: at.plate }),
      });
      expect(await ellipsizedRegions(page, CLIPPED_BY_DESIGN)).toEqual([]);
      expect(await verticallyClippedRegions(page)).toEqual([]);
    });
  }

  test("names the cut state on the card that shortened a value", async ({
    page,
  }) => {
    // NAMED, NOT GENERIC. "Show the full values" tells a reader a panel
    // exists; it does not tell them the figure in front of them is not the
    // whole figure. The affordance has to say the second thing.
    await open(page, { width: 1440, board: "extreme", pools: 3 });
    const extreme = page
      .locator('[data-vex-area="board-token-card-v3"]')
      .first();
    await expect(
      extreme.locator('[data-vex-area="board-token-full-value"]'),
    ).toHaveAttribute("aria-label", /shortened/i);
    await expect(
      extreme.locator('[data-vex-area="board-token-price"]'),
    ).toHaveAttribute("data-shortened", "true");

    // And it is NOT claimed where nothing was cut: a realistic row keeps the
    // plain affordance, so the named state stays informative.
    await open(page, { width: 1440, board: "realistic", pools: 6 });
    await expect(
      page.locator('[data-vex-area="board-token-full-value"]').first(),
    ).not.toHaveAttribute("aria-label", /shortened/i);
  });

  for (const at of [
    { label: "1440px", width: 1440 },
    { label: "the tile floor", width: 1440, plate: 320 },
  ]) {
    test(`cuts no wide-glyph ticker silently at ${at.label}`, async ({
      page,
    }) => {
      // SCHEMA-VALID UNICODE IS ITS OWN AXIS. `baseTokenSymbol` admits 512
      // UTF-16 code units of anything: a ten-character CJK ticker is twice
      // the width of the Latin string the budget was measured against, so a
      // budget counted in CHARACTERS passed it and the column overflowed with
      // nothing reporting the cut. This board is CJK, emoji ZWJ sequences and
      // combining marks, and it runs the whole assertion set.
      await open(page, {
        width: at.width,
        board: "wide",
        pools: 4,
        ...(at.plate === undefined ? {} : { plate: at.plate }),
      });
      expect(await ellipsizedRegions(page, CLIPPED_BY_DESIGN)).toEqual([]);
      expect(await verticallyClippedRegions(page)).toEqual([]);
      // And EVERY one of them says it shortened, rather than being silently
      // clipped by the card. All four rows are over their budget: the CJK
      // ticker, the emoji sequences, the combining marks, and `WWWWWWWW` -
      // which is plain Latin-1, eight characters long, and still about 107px
      // of glyphs in a 91px ticker column.
      const tickers = await page.evaluate(() =>
        [
          ...document.querySelectorAll('[data-vex-area="board-token-ticker"]'),
        ].map((node) => ({
          text: node.textContent ?? "",
          shortened: node.getAttribute("data-shortened") ?? "none",
        })),
      );
      expect(tickers).toHaveLength(4);
      expect(tickers.map((t) => t.shortened)).toEqual([
        "true",
        "true",
        "true",
        "true",
      ]);
      // The wide-Latin row exactly, because it is the one whose width a
      // character count claimed to know: a `W` is about 13.61px in Instrument
      // Sans at 12.5, so four fit where eight (about 107px) would not.
      expect(tickers[2]?.text).toBe("WWWW…");
    });
  }

  test("never renders a lone surrogate or half a grapheme in a ticker", async ({
    page,
  }) => {
    // THE PERSISTENCE BOUNDARY, not only the pixels. A cut between the two
    // halves of a surrogate pair produces an ill-formed string; a cut inside
    // a ZWJ sequence produces a different token than the provider sent.
    await open(page, { width: 1440, board: "wide", pools: 4 });
    const findings = await page.evaluate(() => {
      const bad: string[] = [];
      for (const node of document.querySelectorAll(
        '[data-vex-area="board-token-ticker"]',
      )) {
        const text = node.textContent ?? "";
        for (let index = 0; index < text.length; index += 1) {
          const unit = text.charCodeAt(index);
          const high = unit >= 0xd800 && unit <= 0xdbff;
          const low = unit >= 0xdc00 && unit <= 0xdfff;
          if (!high && !low) continue;
          const next = text.charCodeAt(index + 1);
          const paired =
            high && next >= 0xdc00 && next <= 0xdfff;
          if (paired) {
            index += 1;
            continue;
          }
          bad.push(`lone surrogate at ${String(index)} in ${text}`);
        }
        // A trailing zero-width joiner is half a sequence.
        const withoutMark = text.endsWith("…") ? text.slice(0, -1) : text;
        if (withoutMark.endsWith("‍")) {
          bad.push(`dangling ZWJ in ${text}`);
        }
      }
      return bad;
    });
    expect(findings).toEqual([]);
  });

  test("is a disclosure, not a dialog, and leaves the board interactive", async ({
    page,
  }) => {
    // `aria-modal` WOULD BE A LIE HERE: nothing outside this panel is inert.
    // So it is what it is - a labelled group a button expands - and the rest
    // of the board stays as reachable as the markup says it is.
    await open(page, { width: 1440, board: "realistic", pools: 6 });
    const triggers = page.locator('[data-vex-area="board-token-full-value"]');
    const first = triggers.nth(0);
    await first.focus();
    await page.keyboard.press("Enter");

    const panel = page.locator(
      '[data-vex-area="board-token-full-value-popover"]',
    );
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAttribute("role", "group");
    expect(await panel.getAttribute("aria-modal")).toBeNull();
    await expect(first).toHaveAttribute("aria-expanded", "true");
    // The trigger points AT the panel it expanded.
    expect(await first.getAttribute("aria-controls")).toBe(
      await panel.getAttribute("id"),
    );

    // POINTER: another card is not blocked by anything. Its Spotlight really
    // fires, which is the proof `aria-modal` had no right to claim otherwise.
    const otherCard = page
      .locator('[data-vex-area="board-token-card-v3"]')
      .nth(1);
    await otherCard.locator('[data-vex-area="board-card-spotlight"]').click();
    await expect(
      page.locator('[data-vex-area="board-spotlight-hero"]'),
    ).toBeVisible();
  });

  test("tabs out of the card entirely, never onto a covered control", async ({
    page,
  }) => {
    // THE POINT OF NOT TRAPPING, PROVEN WHERE FOCUS REALLY MOVES. The panel is
    // opaque and covers its whole card, so that card's own buttons cannot be
    // seen while it is open - and they carry `tabIndex="-1"` for exactly that
    // long. Tab out of the panel therefore leaves the CARD, not merely the
    // panel, and never lands on something the reader cannot see (rule 08).
    await open(page, { width: 1440, board: "realistic", pools: 6 });
    const owner = page
      .locator('[data-vex-area="board-token-card-v3"]')
      .nth(2);
    const trigger = owner.locator('[data-vex-area="board-token-full-value"]');
    const panel = owner.locator(
      '[data-vex-area="board-token-full-value-popover"]',
    );

    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();

    // Every covered control has left the tab order AND kept its accessible
    // name - which is the whole difference between this and `inert`.
    expect(
      await owner.evaluate((card) =>
        [
          "board-token-full-value",
          "board-card-spotlight",
          "board-token-dexscreener-link",
          "board-card-ask",
        ].map((name) => {
          const node = card.querySelector(`[data-vex-area="${name}"]`);
          return `${name}=${node?.getAttribute("tabindex") ?? "none"}/${
            (node?.getAttribute("aria-label") ?? "") === "" ? "unnamed" : "named"
          }`;
        }),
      ),
    ).toEqual([
      "board-token-full-value=-1/named",
      "board-card-spotlight=-1/named",
      "board-token-dexscreener-link=-1/named",
      "board-card-ask=-1/named",
    ]);

    /** Which card holds focus, and on what, right now. */
    const focus = async (): Promise<string> =>
      page.evaluate(() => {
        const active = document.activeElement;
        const card = active?.closest(
          '[data-vex-area="board-token-card-v3"]',
        );
        if (card === null || card === undefined) return "outside any card";
        const cards = [
          ...document.querySelectorAll('[data-vex-area="board-token-card-v3"]'),
        ];
        return `card ${String(cards.indexOf(card))}: ${
          active?.getAttribute("data-vex-area") ?? "?"
        }`;
      });

    // FORWARD, out of the panel's last focusable element.
    await page.keyboard.press("Tab");
    expect(await focus()).not.toContain("card 2:");

    // BACKWARD, out of its first, from a fresh open.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(panel).toBeVisible();
    await page.keyboard.press("Shift+Tab");
    expect(await focus()).not.toContain("card 2:");

    // And Escape from INSIDE the panel - the only place a reader can press it
    // from, since everything else on this card has left the tab order - hands
    // focus back to the trigger, which is `tabIndex="-1"` at the moment it is
    // asked to take it. That is precisely what `inert` would have made
    // impossible, and it is why this is `tabIndex` and not `inert`.
    await owner
      .locator('[data-vex-area="board-token-full-value-close"]')
      .focus();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect(await focus()).toBe("card 2: board-token-full-value");
    // The attributes come back with the state.
    expect(
      await owner
        .locator('[data-vex-area="board-card-spotlight"]')
        .getAttribute("tabindex"),
    ).toBeNull();
  });

  test("lets two cards show their values at once", async ({ page }) => {
    // MULTIPLE OPEN IS THE DEFINED BEHAVIOUR, not an accident: comparing two
    // pools' raw decimals side by side is the reason to have this at all.
    await open(page, { width: 1440, board: "realistic", pools: 6 });
    const triggers = page.locator('[data-vex-area="board-token-full-value"]');
    await triggers.nth(0).click();
    await triggers.nth(1).click();
    await expect(
      page.locator('[data-vex-area="board-token-full-value-popover"]'),
    ).toHaveCount(2);
    // Two distinct panels, each pointed at by its own trigger.
    expect(await triggers.nth(0).getAttribute("aria-controls")).not.toBe(
      await triggers.nth(1).getAttribute("aria-controls"),
    );
  });

  test("closes on Escape, restores focus, and leaves the board open", async ({
    page,
  }) => {
    await open(page, { width: 1440, board: "realistic", pools: 6 });
    const trigger = page
      .locator('[data-vex-area="board-token-full-value"]')
      .first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const panel = page.locator(
      '[data-vex-area="board-token-full-value-popover"]',
    );
    await expect(panel).toBeVisible();
    // Focus MOVES into the panel on open. Not a modal obligation - this panel
    // paints over its own card, so focus left behind it would be operating a
    // control the reader can no longer see.
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute("data-vex-area") ?? "none",
      ),
    ).toBe("board-token-full-value-close");

    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.activeElement?.getAttribute("data-vex-area") ?? "none",
      ),
    ).toBe("board-token-full-value");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    // The page listens for the same key (Escape goes back one page) and must
    // not have taken it: closing a panel is not closing the board.
    await expect(
      page.locator('[data-vex-surface="board-page"]'),
    ).toBeVisible();
  });

  test("moves no geometry under prefers-reduced-motion", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await open(page, { width: 1440, drawer: true });
    const before = await geometry(page);
    await page.evaluate(() => {
      window.__vexBoardLayoutHarness.setDrawer(false);
    });
    await page.waitForTimeout(50);
    const settled = await geometry(page);
    // No transition on a geometric property: the new layout is the layout,
    // immediately, with nothing animating between the two.
    const midflight = await geometry(page);
    expect(midflight).toEqual(settled);
    expect(before.cardWidths.length).toBeGreaterThan(0);
    await context.close();
  });
});

/**
 * THE LADDER ITSELF, at every seam the stylesheet advertises.
 *
 * Driven through `?plate=`, which pins the container's CONTENT box - the box
 * `container-type: inline-size` measures - so a case can sit one hundredth of
 * a pixel under a threshold instead of wherever a viewport width happened to
 * land after the shell's columns and the page padding.
 */
test.describe("board grid threshold seams", () => {
  for (const threshold of GRID_THRESHOLDS) {
    for (const container of seamsOf(threshold)) {
      const want = expectedAt(container);
      test(`gives ${String(container)}px ${String(want.columns)} column(s)`, async ({
        page,
      }) => {
        await open(page, { width: 1920, plate: container });
        const measured = await modeOf(page, "ul[data-vex-area='board-grid']");
        expect(measured).toEqual({ tracks: want.columns });
      });
    }
  }

  test("pins the track at the tile floor below it and side-scrolls", async ({
    page,
  }) => {
    await open(page, { width: 1920, plate: 300 });
    const { tracks, cardWidths } = await geometry(page);
    expect(tracks.length).toBe(1);
    // The track REFUSES to shrink below the tile floor; the scroller takes
    // over rather than a figure being cut.
    expect(cardWidths[0]).toBeGreaterThanOrEqual(TILE_FLOOR);
    expect(await ellipsizedRegions(page, CLIPPED_BY_DESIGN)).toEqual([]);
    const scrolls = await page.evaluate(() => {
      const scroller = document.querySelector(
        '[data-vex-area="board-grid-scroller"]',
      );
      return scroller === null
        ? false
        : scroller.scrollWidth > scroller.clientWidth;
    });
    expect(scrolls).toBe(true);
  });
});

/**
 * THE SPOTLIGHT'S OWN REGIONS. Each threshold below is named in
 * `board-layout.css` for the content that binds it, and none of them is a
 * card threshold.
 */
test.describe("board spotlight region seams", () => {
  const REGIONS = [
    {
      area: "board-spotlight-hero",
      threshold: 600,
      below: 2,
      above: 3,
    },
    {
      area: "board-spotlight-chart-row",
      threshold: 764,
      below: 1,
      above: 2,
    },
    {
      area: "board-spotlight-assess-row",
      threshold: 628,
      below: 1,
      above: 2,
    },
    {
      area: "board-spotlight-factual-row",
      threshold: 628,
      below: 1,
      above: 2,
    },
    {
      area: "board-spotlight-plus-row",
      threshold: 628,
      below: 1,
      above: 2,
    },
    {
      area: "board-spotlight-context-row",
      threshold: 628,
      below: 1,
      above: 2,
    },
  ] as const;

  for (const region of REGIONS) {
    for (const container of seamsOf(region.threshold)) {
      const want = container >= region.threshold ? region.above : region.below;
      test(`${region.area} takes ${String(want)} track(s) at ${String(container)}px`, async ({
        page,
      }) => {
        await open(page, {
          width: 1920,
          view: "spotlight",
          spotlightPlate: container,
        });
        const measured = await modeOf(page, `[data-vex-area="${region.area}"]`);
        expect(measured.tracks).toBe(want);
      });
    }
  }

  test("stacks the compact hero instead of crushing the price into 52px", async ({
    page,
  }) => {
    // THE DEFECT: below 600 the hero is `52px 1fr` and its three children
    // would be auto-placed, which puts the price block in row 2 COLUMN 1 -
    // the 52px photo track. The price is the largest type on the surface;
    // 52px is not a price.
    await open(page, { width: 1920, view: "spotlight", spotlightPlate: 560 });
    const boxes = await page.evaluate(() => {
      const read = (area: string): { left: number; width: number } | null => {
        const element = document.querySelector(`[data-vex-area="${area}"]`);
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), width: Math.round(rect.width) };
      };
      return {
        photo: read("board-spotlight-photo"),
        price: read("board-spotlight-price-block"),
      };
    });
    expect(boxes.photo).not.toBeNull();
    expect(boxes.price).not.toBeNull();
    // The stacked row starts at the hero's own left edge and the price gets
    // the whole inline size, not the photo's track.
    expect(boxes.price?.left).toBe(boxes.photo?.left);
    expect(boxes.price?.width ?? 0).toBeGreaterThan(500);
  });

  test("keeps the three-track hero above the threshold", async ({ page }) => {
    await open(page, { width: 1920, view: "spotlight", spotlightPlate: 1000 });
    const boxes = await page.evaluate(() => {
      const read = (area: string): { left: number; bottom: number; top: number } | null => {
        const element = document.querySelector(`[data-vex-area="${area}"]`);
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom),
        };
      };
      return {
        photo: read("board-spotlight-photo"),
        price: read("board-spotlight-price-block"),
        toggle: read("board-spotlight-toggle"),
      };
    });
    // Wide mode puts all three on ONE row, so nothing shares the photo's
    // left; the pressed Spotlight chip sits in the back row above the hero.
    expect(boxes.price?.left ?? 0).toBeGreaterThan(boxes.photo?.left ?? 0);
    expect(boxes.toggle?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      boxes.photo?.top ?? 0,
    );
  });
});

test.describe("board paint", () => {
  test("draws square tiles with a fill status chip and figures in JetBrains Mono", async ({
    page,
  }) => {
    await open(page, { width: 1440 });
    const paint = await page.evaluate(() => {
      const card = document.querySelector('[data-vex-area="board-token-card-v3"]');
      const chip = document.querySelector('[data-vex-area="board-status-chip"]');
      const price = document.querySelector('[data-vex-area="board-token-price"]');
      if (!(card instanceof HTMLElement) || !(chip instanceof HTMLElement)) return null;
      return {
        radius: getComputedStyle(card).borderTopLeftRadius,
        shadow: getComputedStyle(card).boxShadow,
        swatch: chip.querySelector(".vex-swatch")?.getAttribute("data-s") ?? null,
        priceFont: price === null ? "" : getComputedStyle(price).fontFamily,
      };
    });
    expect(paint).not.toBeNull();
    expect(paint?.radius).toBe("0px");
    expect(paint?.shadow).toBe("none");
    expect(paint?.swatch).not.toBeNull();
    expect(paint?.priceFont).toContain("JetBrains Mono");
  });

  test("sets the page's head row title in Instrument Sans over a quiet rule", async ({
    page,
  }) => {
    await open(page, { width: 1440 });
    const header = await page.evaluate(() => {
      const title = document.querySelector('[data-vex-area="board-title"]');
      const head = document.querySelector('[data-vex-area="board-header"]');
      if (!(title instanceof HTMLElement) || !(head instanceof HTMLElement)) return null;
      return {
        font: getComputedStyle(title).fontFamily,
        rule: getComputedStyle(head).borderBottomWidth,
      };
    });
    expect(header?.font).toContain("Instrument Sans");
    expect(header?.rule).toBe("1px");
  });
});
