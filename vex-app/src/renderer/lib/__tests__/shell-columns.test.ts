/**
 * The spread's column solver (docs/design/V10-SPREAD.md section 2), pinned at
 * the spec's own widths (1440, 1280, 1276, 1000), at both seams (1276 and
 * 1316) one pixel on each side, and through the concession chain.
 */

import { describe, expect, it } from "vitest";
import {
  BOOK_COLLAPSED,
  BOOK_DEFAULT,
  BOOK_FULL_MIN,
  BOOK_MAX,
  BOOK_MIN,
  CENTER_MIN,
  GUTTER_SM_WIDTH,
  GUTTER_WIDTH,
  PAGE_MIN,
  RAIL_COLLAPSED,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SPINE_WIDTH,
  SPREAD_MIN,
  bookDragMax,
  clampWidth,
  computeShellColumns,
  isBookResizable,
  isSpreadNarrow,
  pageDragMax,
  type ShellLayoutInput,
} from "../shell-columns.js";

/** The agent spread with the page and the BOOK open at their defaults. */
function agent(viewport: number, overrides: Partial<ShellLayoutInput> = {}) {
  return computeShellColumns({
    viewport,
    mode: "agent",
    sidebar: SIDEBAR_DEFAULT,
    book: BOOK_DEFAULT,
    ...overrides,
  });
}

/** Every track adds back up to the window. */
function total(cols: ReturnType<typeof computeShellColumns>): number {
  return cols.page + cols.gutter + cols.center + cols.book;
}

describe("the contract geometry", () => {
  it("states the spec's widths", () => {
    expect([PAGE_MIN, SPINE_WIDTH, GUTTER_WIDTH, GUTTER_SM_WIDTH]).toEqual([300, 56, 36, 22]);
    expect([CENTER_MIN, BOOK_DEFAULT, BOOK_MIN, BOOK_MAX, BOOK_COLLAPSED]).toEqual([
      640, 340, 300, 520, 48,
    ]);
    expect([SPREAD_MIN, BOOK_FULL_MIN]).toEqual([1276, 1316]);
    expect([SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, RAIL_COLLAPSED]).toEqual([240, 240, 420, 56]);
  });

  it("clamps into a range and rounds", () => {
    expect(clampWidth(280.4, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(280);
    expect(clampWidth(100, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(SIDEBAR_MIN);
    expect(clampWidth(9999, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(SIDEBAR_MAX);
  });
});

describe("the agent spread at the spec's widths", () => {
  it("1440: page 300, gutter 36, centre 764, BOOK 340", () => {
    expect(agent(1440)).toEqual({ page: 300, gutter: 36, rail: 0, center: 764, book: 340 });
  });

  it("1280: the BOOK holds its 300 floor, centre 644", () => {
    expect(agent(1280)).toEqual({ page: 300, gutter: 36, rail: 0, center: 644, book: 300 });
  });

  it("1276: the narrowest spread, centre exactly 640", () => {
    expect(agent(1276)).toEqual({ page: 300, gutter: 36, rail: 0, center: 640, book: 300 });
  });

  it("1000: the page closes to the spine, the gutter folds, centre 644", () => {
    // Under the spread the shell hands in a closed page (0).
    expect(agent(1000, { sidebar: 0 })).toEqual({
      page: 56,
      gutter: 0,
      rail: 0,
      center: 644,
      book: 300,
    });
  });

  it("never lets the centre under its floor from 1000 up, in any agent state", () => {
    for (let viewport = 1000; viewport <= 2560; viewport += 7) {
      const narrow = isSpreadNarrow(viewport);
      for (const book of [0, BOOK_MIN, BOOK_DEFAULT, BOOK_MAX]) {
        for (const sidebar of narrow ? [0] : [0, SIDEBAR_DEFAULT, SIDEBAR_MAX]) {
          const cols = agent(viewport, { sidebar, book });
          expect(cols.center, `${String(viewport)} ${String(sidebar)} ${String(book)}`)
            .toBeGreaterThanOrEqual(CENTER_MIN);
          expect(total(cols)).toBe(viewport);
        }
      }
    }
  });
});

describe("the seams", () => {
  it("the spread starts at exactly 1276", () => {
    expect(isSpreadNarrow(SPREAD_MIN - 1)).toBe(true);
    expect(isSpreadNarrow(SPREAD_MIN)).toBe(false);
    expect(isSpreadNarrow(SPREAD_MIN + 1)).toBe(false);
    // The gutter folds on the narrow side only.
    expect(agent(SPREAD_MIN - 1, { sidebar: 0 }).gutter).toBe(0);
    expect(agent(SPREAD_MIN).gutter).toBe(GUTTER_WIDTH);
  });

  it("the BOOK takes its preference from exactly 1316", () => {
    expect(isBookResizable(BOOK_FULL_MIN - 1, "agent")).toBe(false);
    expect(isBookResizable(BOOK_FULL_MIN, "agent")).toBe(true);
    expect(agent(BOOK_FULL_MIN - 1).book).toBe(BOOK_MIN);
    expect(agent(BOOK_FULL_MIN).book).toBe(BOOK_DEFAULT);
    expect(agent(BOOK_FULL_MIN).center).toBe(CENTER_MIN);
    // Lighter's chat rail is free at every width.
    expect(isBookResizable(1000, "lighter")).toBe(true);
  });
});

describe("the left page", () => {
  it("reads any preference under its spec width as 300", () => {
    expect(agent(1600, { sidebar: SIDEBAR_MIN }).page).toBe(PAGE_MIN);
    expect(agent(1600, { sidebar: 280 }).page).toBe(PAGE_MIN);
  });

  it("widens with a drag preference while the centre keeps its floor", () => {
    expect(agent(1600, { sidebar: 380 })).toEqual({
      page: 380,
      gutter: 36,
      rail: 0,
      center: 844,
      book: 340,
    });
    expect(agent(1600, { sidebar: 9999 }).page).toBe(SIDEBAR_MAX);
  });

  it("a closed page is the spine beside the small gutter", () => {
    expect(agent(1440, { sidebar: 0 })).toEqual({
      page: 56,
      gutter: 22,
      rail: 0,
      center: 1440 - 56 - 22 - 340,
      book: 340,
    });
  });

  it("the narrow override's re-expanded page closes the BOOK instead of the centre", () => {
    // 1000 - 300 - 0 = 700 leaves 60 for a BOOK, under its floor: it closes.
    expect(agent(1000)).toEqual({ page: 300, gutter: 0, rail: 0, center: 652, book: 48 });
  });
});

describe("the concession chain", () => {
  it("step 1: a widened page gives its extra back before the BOOK shrinks", () => {
    // 1440 with a 420 page: 1440 - 420 - 36 - 340 = 644, fits.
    expect(agent(1440, { sidebar: 420 }).page).toBe(420);
    // 1400: the page gives back 4 and the BOOK keeps its preference.
    expect(agent(1400, { sidebar: 420, book: 340 })).toEqual({
      page: 384,
      gutter: 36,
      rail: 0,
      center: 640,
      book: 340,
    });
  });

  it("step 2: then the BOOK shrinks toward its floor", () => {
    expect(agent(1400, { book: BOOK_MAX })).toEqual({
      page: 300,
      gutter: 36,
      rail: 0,
      center: 640,
      book: 424,
    });
  });

  it("step 3: then the BOOK closes to its spine (derived), and the centre absorbs the rest", () => {
    const cols = computeShellColumns({ viewport: 900, mode: "agent", sidebar: 0, book: BOOK_DEFAULT });
    expect(cols).toEqual({ page: 56, gutter: 0, rail: 0, center: 900 - 56 - 48, book: 48 });
  });

  it("a closed BOOK keeps its spine, or nothing where the caller says so", () => {
    expect(agent(1440, { book: 0 }).book).toBe(BOOK_COLLAPSED);
    expect(agent(1440, { book: 0, closedBook: 0 }).book).toBe(0);
    expect(agent(1440, { book: 0, closedBook: 0 }).center).toBe(1440 - 300 - 36);
  });

  it("re-clamps a stale BOOK preference before solving", () => {
    expect(agent(1920, { book: 1 }).book).toBe(BOOK_MIN);
    expect(agent(1920, { book: 9999 }).book).toBe(BOOK_MAX);
  });
});

describe("Studio", () => {
  const studio = (viewport: number, sidebar: number, book = BOOK_DEFAULT) =>
    computeShellColumns({ viewport, mode: "studio", sidebar, book });

  it("always uses the spine, with the project rail carved out of the centre", () => {
    expect(studio(1440, SIDEBAR_DEFAULT)).toEqual({
      page: 56,
      gutter: 22,
      rail: 240,
      center: 1440 - 56 - 22 - 340,
      book: 340,
    });
  });

  it("a closed rail is its icon spine", () => {
    expect(studio(1440, 0).rail).toBe(RAIL_COLLAPSED);
  });

  it("at 1000 keeps the BOOK at its floor with the rail inside a 644 centre", () => {
    expect(studio(1000, 0)).toEqual({ page: 56, gutter: 0, rail: 56, center: 644, book: 300 });
  });
});

describe("Lighter", () => {
  it("always uses the spine and sizes its chat rail from its own share", () => {
    expect(
      computeShellColumns({ viewport: 1440, mode: "lighter", sidebar: 280, book: 400 }),
    ).toEqual({ page: 56, gutter: 22, rail: 0, center: 1440 - 56 - 22 - 400, book: 400 });
  });

  it("Zen hands the chart the window", () => {
    expect(
      computeShellColumns({
        viewport: 1440,
        mode: "lighter",
        sidebar: 0,
        book: 0,
        closedBook: 0,
        zen: true,
      }),
    ).toEqual({ page: 0, gutter: 0, rail: 0, center: 1440, book: 0 });
  });
});

describe("drag ranges", () => {
  it("the page may widen only into room the centre does not need", () => {
    expect(pageDragMax(agent(1400), 1400)).toBe(1400 - 36 - 340 - 640);
    expect(pageDragMax(agent(1920), 1920)).toBe(SIDEBAR_MAX);
    // 1276: no room at all, so the shell mounts no page handle.
    expect(pageDragMax(agent(1276), 1276)).toBeLessThanOrEqual(PAGE_MIN);
  });

  it("the BOOK counts an open page at its floor, because the page concedes first", () => {
    expect(bookDragMax(agent(1440, { sidebar: 420 }), 1440)).toBe(1440 - 300 - 36 - 640);
    expect(bookDragMax(agent(1920), 1920)).toBe(BOOK_MAX);
  });
});
