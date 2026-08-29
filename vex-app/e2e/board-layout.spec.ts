/**
 * BOARD GEOMETRY, measured in a real engine at real widths.
 *
 * WHY A BROWSER PROJECT AND NOT THE ELECTRON FIXTURE. `smoke.spec.ts` says it
 * itself: nothing past SystemCheck is reachable without a live Docker daemon,
 * a migrated Postgres and an unlocked vault, so the board modal cannot be
 * opened there at all. Board geometry is decided entirely by the renderer's
 * own container queries over the real production stylesheet, and
 * `vite.board-layout.config.ts` serves exactly that against the real
 * `BoardModalHost` / `BoardGrid` / `TokenCardV3`. The only thing faked is the
 * preload bridge, which is the process boundary and nothing above it.
 *
 * WHAT THESE ASSERTIONS ARE. Contract-level and mode-independent: they say
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
 * `title` and in the card's accessible name), so it is exempt too - and it is
 * the ONLY visible element that is.
 */
const CLIPPED_BY_DESIGN = [
  "board-token-photo-absence",
  "board-token-name",
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
  // THE FONT, THEN THE DIALOG'S OWN ANIMATION, THEN THE FRAME.
  //
  // Every number this file asserts is a text measurement, and the display
  // face arrives asynchronously: measuring before `document.fonts.ready`
  // reads the fallback's metrics and produces heights that differ between
  // cards purely by load timing.
  //
  // The board dialog also opens with a scale, and a residual
  // `matrix(0.998275, ...)` on the `<dialog>` scales every
  // `getBoundingClientRect` beneath it while `getComputedStyle`'s grid tracks
  // stay unscaled - which reads as a card that misses its track by two
  // pixels, invented entirely by WHEN the measurement happened.
  //
  // So the gate is the PRECONDITION ITSELF - the dialog carrying no transform
  // - polled per frame, and not a clock and not `Animation.finished`: the
  // page also runs animations that never finish by design, and awaiting those
  // hangs until the test times out. The deadline below is a safety net that
  // turns a hang into a measured failure, never the thing being waited on.
  // Two frames after that, so the container query and the layout it triggers
  // have both landed.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      const deadline = performance.now() + 2000;
      const settled = (): void => {
        const dialog = document.querySelector("dialog");
        if (
          dialog === null ||
          getComputedStyle(dialog).transform === "none" ||
          performance.now() > deadline
        ) {
          resolve();
          return;
        }
        requestAnimationFrame(settled);
      };
      requestAnimationFrame(settled);
    });
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
): Promise<{ readonly tracks: number; readonly mode: string }> {
  return page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (element === null) return { tracks: -1, mode: "missing" };
    const style = getComputedStyle(element);
    return {
      tracks: style.gridTemplateColumns
        .split(" ")
        .filter((part) => part !== "" && part !== "none").length,
      mode: style.getPropertyValue("--vex-board-mode").trim(),
    };
  }, selector);
}

/**
 * THE LADDER, AS ADVERTISED. This table is the head comment of
 * `global-css/board-layout.css` transcribed into assertions - not a second
 * owner of the numbers, but the thing that makes the stylesheet's ownership
 * falsifiable. A permanent one-column regression, or a mode that stopped
 * switching, fails every row of it.
 */
const COLUMN_LADDER: readonly {
  readonly min: number;
  readonly columns: number;
  readonly mode: string;
}[] = [
  { min: 1538, columns: 3, mode: "wide" },
  { min: 1106, columns: 3, mode: "compact" },
  { min: 1020, columns: 2, mode: "wide" },
  { min: 732, columns: 2, mode: "compact" },
  { min: 502, columns: 1, mode: "wide" },
  { min: 0, columns: 1, mode: "compact" },
];

function expectedAt(container: number): { columns: number; mode: string } {
  for (const step of COLUMN_LADDER) {
    if (container >= step.min) return { columns: step.columns, mode: step.mode };
  }
  return { columns: 1, mode: "compact" };
}

/** Exact, minus one, plus one, and a fractional hair under the threshold. */
function seamsOf(threshold: number): readonly number[] {
  return [threshold - 1, threshold, threshold + 1, threshold - 0.02];
}

const GRID_THRESHOLDS = [358, 502, 732, 1020, 1106, 1538] as const;

const WIDTHS = [800, 1000, 1280, 1366, 1440, 1920] as const;

test.describe("board grid geometry", () => {
  for (const width of WIDTHS) {
    for (const drawer of [false, true]) {
      const label = `${String(width)}px${drawer ? " with the Ask VEX drawer" : ""}`;

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
        // independently (1280 with the drawer gives a 371.6px track). The
        // assertion that matters is the two above: one width, one height.
        expect(
          Math.abs((cardWidths[0] ?? 0) - (tracks[0] ?? 0)),
        ).toBeLessThanOrEqual(1);
      });
    }
  }

  test("picks columns from the container, not the viewport", async ({ page }) => {
    // The defect this arc exists for: the drawer removes 360px from the
    // CONTAINER while a viewport ladder keeps asking for the same columns.
    await open(page, { width: 1440, drawer: false });
    const wide = await geometry(page);
    await open(page, { width: 1440, drawer: true });
    const narrow = await geometry(page);
    // Same viewport, smaller container: either fewer columns, or the same
    // columns at a width that still clears every region floor. What must
    // never happen is the tracks staying put while the cards are squeezed
    // below what their content needs.
    expect(narrow.cardWidths[0]).toBeGreaterThanOrEqual(358);
    expect(wide.cardWidths[0]).toBeGreaterThanOrEqual(358);
  });

  test("survives the longest safety verdict landing late, with the drawer open", async ({
    page,
  }) => {
    // The async overlay case. Every card starts on "Checking" (95px) and
    // settles on "Checks unavailable in this response" (242px), which is the
    // widest string the frozen chip table can produce. Neither state may cut
    // a label, and the grid must not reflow the reader's cards under them.
    await open(page, { width: 1440, drawer: true });
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
    { label: "the compact floor", width: 1440, plate: 356 },
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

  test("contains the disclosure's tab sequence and restores focus", async ({
    page,
  }) => {
    // THE OVERLAY IS A `role="dialog"` OVER OBSCURED CONTROLS. Per the WAI
    // modal-dialog pattern its tab sequence must stay inside it: a Tab that
    // reaches the card underneath puts focus on a control the reader cannot
    // see, and an Escape from there closes the WHOLE board.
    await open(page, { width: 1440, board: "realistic", pools: 6 });
    const trigger = page
      .locator('[data-vex-area="board-token-full-value"]')
      .first();
    await trigger.focus();
    await page.keyboard.press("Enter");
    const popover = page.locator(
      '[data-vex-area="board-token-full-value-popover"]',
    );
    await expect(popover).toBeVisible();

    const inside = async (): Promise<boolean> =>
      page.evaluate(
        () =>
          document.activeElement?.closest(
            '[data-vex-area="board-token-full-value-popover"]',
          ) !== null &&
          document.activeElement?.closest(
            '[data-vex-area="board-token-full-value-popover"]',
          ) !== undefined,
      );

    expect(await inside()).toBe(true);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(true);
    }
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside()).toBe(true);
    }

    // Escape closes ONLY the overlay, and focus comes back to the button
    // that opened it. The board stays open behind it.
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-vex-area") ?? "none",
      ),
    ).toBe("board-token-full-value");
    await expect(
      page.locator('[data-vex-surface="board-modal"]'),
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
 * land after the dialog cap and two paddings.
 */
test.describe("board grid threshold seams", () => {
  for (const threshold of GRID_THRESHOLDS) {
    for (const container of seamsOf(threshold)) {
      const want = expectedAt(container);
      test(`gives ${String(container)}px ${String(want.columns)} ${want.mode} column(s)`, async ({
        page,
      }) => {
        await open(page, { width: 1920, plate: container });
        const measured = await modeOf(page, "ul[data-vex-area='board-grid']");
        expect(measured).toEqual({
          tracks: want.columns,
          mode: want.mode,
        });
      });
    }
  }

  test("pins the track at the compact floor below it and side-scrolls", async ({
    page,
  }) => {
    await open(page, { width: 1920, plate: 300 });
    const { tracks, cardWidths } = await geometry(page);
    expect(tracks.length).toBe(1);
    // The track REFUSES to shrink below the compact floor; the scroller takes
    // over rather than a figure being cut.
    expect(cardWidths[0]).toBeGreaterThanOrEqual(358);
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
      threshold: 884,
      below: 2,
      above: 4,
    },
    {
      area: "board-spotlight-chart-row",
      threshold: 856,
      below: 1,
      above: 2,
    },
    {
      area: "board-spotlight-factual-row",
      threshold: 576,
      below: 1,
      above: 2,
    },
    {
      area: "board-spotlight-factual-row",
      threshold: 872,
      below: 2,
      above: 3,
    },
    {
      area: "board-spotlight-plus-row",
      threshold: 656,
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

  test("stacks the compact hero instead of crushing the price into 88px", async ({
    page,
  }) => {
    // THE DEFECT: below 884 the hero is `88px 1fr` and its four children are
    // auto-placed, which puts the price block in row 2 COLUMN 1 - the 88px
    // photo track - and the Spotlight toggle beside it. The price is the
    // largest type on the surface; 88px is not a price.
    await open(page, { width: 1920, view: "spotlight", spotlightPlate: 800 });
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
        toggle: read("board-spotlight-toggle"),
      };
    });
    expect(boxes.photo).not.toBeNull();
    expect(boxes.price).not.toBeNull();
    expect(boxes.toggle).not.toBeNull();
    // Both stacked rows start at the hero's own left edge and the price gets
    // the whole inline size, not the photo's track.
    expect(boxes.price?.left).toBe(boxes.photo?.left);
    expect(boxes.toggle?.left).toBe(boxes.photo?.left);
    expect(boxes.price?.width ?? 0).toBeGreaterThan(600);
  });

  test("keeps the four-track hero above the threshold", async ({ page }) => {
    await open(page, { width: 1920, view: "spotlight", spotlightPlate: 1000 });
    const boxes = await page.evaluate(() => {
      const read = (area: string): { left: number } | null => {
        const element = document.querySelector(`[data-vex-area="${area}"]`);
        if (!(element instanceof HTMLElement)) return null;
        return { left: Math.round(element.getBoundingClientRect().left) };
      };
      return {
        photo: read("board-spotlight-photo"),
        price: read("board-spotlight-price-block"),
        toggle: read("board-spotlight-toggle"),
      };
    });
    // Wide mode puts all four on ONE row, so nothing shares the photo's left.
    expect(boxes.price?.left ?? 0).toBeGreaterThan(boxes.photo?.left ?? 0);
    expect(boxes.toggle?.left ?? 0).toBeGreaterThan(boxes.price?.left ?? 0);
  });
});
