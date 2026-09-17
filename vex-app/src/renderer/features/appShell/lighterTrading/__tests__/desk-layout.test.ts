import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIGHTER_DESK,
  DEFAULT_LIGHTER_LAYOUT,
  LIGHTER_BOOK_COLUMN_MIN,
  LIGHTER_BOOK_MIN,
  LIGHTER_BOTTOM_MIN,
  LIGHTER_MAIN_MIN_HEIGHT,
  LIGHTER_TICKET_MIN,
  LIGHTER_TRADES_MIN,
  coerceLighterDesk,
  coerceLighterLayout,
  resolveLighterLayout,
} from "../desk-preferences.js";

describe("resolveLighterLayout", () => {
  it("scales the columns, the trades panel and the dock with the desk", () => {
    const small = resolveLighterLayout(DEFAULT_LIGHTER_LAYOUT, { width: 1100, height: 900 });
    const large = resolveLighterLayout(DEFAULT_LIGHTER_LAYOUT, { width: 1600, height: 1200 });
    expect(small.bookWidth).toBe(Math.round(1100 * DEFAULT_LIGHTER_LAYOUT.bookShare));
    expect(large.bookWidth).toBe(Math.round(1600 * DEFAULT_LIGHTER_LAYOUT.bookShare));
    expect(small.ticketWidth).toBe(Math.round(1100 * DEFAULT_LIGHTER_LAYOUT.ticketShare));
    expect(large.ticketWidth).toBe(Math.round(1600 * DEFAULT_LIGHTER_LAYOUT.ticketShare));
    expect(small.bottomHeight).toBe(Math.round(900 * DEFAULT_LIGHTER_LAYOUT.bottomShare));
    expect(large.bottomHeight).toBe(Math.round(1200 * DEFAULT_LIGHTER_LAYOUT.bottomShare));
    // The trades share is of the book column: the desk less the seam and the dock.
    expect(small.tradesHeight).toBe(Math.round((900 - 1 - small.bottomHeight) * DEFAULT_LIGHTER_LAYOUT.tradesShare));
    expect(small.dockSqueezed).toBe(false);
  });

  it("keeps the pixel floors and the share ceilings", () => {
    const narrow = resolveLighterLayout({ ...DEFAULT_LIGHTER_LAYOUT, bookShare: 0.1 }, { width: 800, height: 900 });
    expect(narrow.bookWidth).toBe(LIGHTER_BOOK_COLUMN_MIN);
    // Beside a floored book, the ticket column is what the chart minimum leaves, but never under its floor.
    expect(narrow.ticketMax).toBe(LIGHTER_TICKET_MIN);
    expect(narrow.ticketWidth).toBe(LIGHTER_TICKET_MIN);
    const wide = resolveLighterLayout({ ...DEFAULT_LIGHTER_LAYOUT, bookShare: 0.9, ticketShare: 0.9 }, { width: 2000, height: 900 });
    expect(wide.bookMax).toBe(1000);
    expect(wide.bookWidth).toBe(1000);
    // The ticket takes the rest, leaving the chart its minimum.
    expect(wide.ticketMax).toBe(2000 - 2 - 360 - 1000);
    expect(wide.ticketWidth).toBe(wide.ticketMax);
    const unmeasured = resolveLighterLayout(DEFAULT_LIGHTER_LAYOUT, { width: 0, height: 0 });
    expect(unmeasured).toMatchObject({
      bookWidth: LIGHTER_BOOK_COLUMN_MIN,
      ticketWidth: LIGHTER_TICKET_MIN,
      tradesHeight: LIGHTER_TRADES_MIN,
      bottomHeight: LIGHTER_BOTTOM_MIN,
      dockSqueezed: false,
    });
  });

  it("keeps three columns on a narrow desk and lets the chart give", () => {
    const tight = resolveLighterLayout(DEFAULT_LIGHTER_LAYOUT, { width: 700, height: 900 });
    expect(tight.bookWidth).toBe(LIGHTER_BOOK_COLUMN_MIN);
    expect(tight.ticketWidth).toBe(LIGHTER_TICKET_MIN);
    expect(700 - 2 - tight.bookWidth - tight.ticketWidth).toBeLessThan(360);
  });

  it("bounds the trades panel by the book floor and follows a dragged share", () => {
    const height = 800;
    const roomy = resolveLighterLayout(DEFAULT_LIGHTER_LAYOUT, { width: 1200, height });
    expect(roomy.bottomHeight).toBe(160);
    // 800 - 1 - 160 leaves a 639 column; trades stop at 70% of it or a minimum book plus the seam.
    expect(roomy.tradesMax).toBe(Math.round(639 * 0.7));
    expect(roomy.tradesHeight).toBe(Math.round(639 * DEFAULT_LIGHTER_LAYOUT.tradesShare));
    const tall = resolveLighterLayout({ ...DEFAULT_LIGHTER_LAYOUT, tradesShare: 0.9 }, { width: 1200, height });
    expect(tall.tradesHeight).toBe(tall.tradesMax);
    const big = resolveLighterLayout({ ...DEFAULT_LIGHTER_LAYOUT, bottomShare: 0.9 }, { width: 1200, height });
    expect(big.bottomHeight).toBe(big.bottomMax);
    expect(big.bottomMax).toBe(Math.round(height * 0.6));
    expect(big.tradesMax).toBe(height - 1 - big.bottomHeight - 1 - LIGHTER_BOOK_MIN);
    expect(big.tradesHeight).toBe(LIGHTER_TRADES_MIN);
  });

  it("folds the dock only when a minimum book, trades panel and dock do not fit", () => {
    const fits = resolveLighterLayout({ ...DEFAULT_LIGHTER_LAYOUT, bottomShare: 0.9 }, { width: 1200, height: LIGHTER_MAIN_MIN_HEIGHT + 1 + LIGHTER_BOTTOM_MIN });
    expect(fits.dockSqueezed).toBe(false);
    expect(fits.bottomMax).toBe(LIGHTER_BOTTOM_MIN);
    const short = resolveLighterLayout(DEFAULT_LIGHTER_LAYOUT, { width: 1200, height: 380 });
    expect(short.dockSqueezed).toBe(true);
    // Folded, the column is measured against the dock's bar.
    expect(short.tradesMax).toBe(380 - 1 - 32 - 1 - LIGHTER_BOOK_MIN);
    expect(short.tradesHeight).toBe(LIGHTER_TRADES_MIN);
  });
});

describe("coerceLighterLayout", () => {
  it("accepts shares, drops the two-column desk's fields and clamps to the ceilings", () => {
    expect(coerceLighterLayout({ bookShare: 0.3, ticketShare: 0.45, tradesShare: 0.5, bottomShare: 0.25, bottomCollapsed: true }))
      .toEqual({ bookShare: 0.3, ticketShare: 0.45, tradesShare: 0.5, bottomShare: 0.25, bottomCollapsed: true });
    // A two-column layout's ticket share was a height: only the dock carries over.
    expect(coerceLighterLayout({ panelShare: 0.3, ticketShare: 0.45, bottomShare: 0.25 }))
      .toEqual({ ...DEFAULT_LIGHTER_LAYOUT, bottomShare: 0.25 });
    expect(coerceLighterLayout({ panelWidth: 300, ticketHeight: 400, bottomHeight: 190 })).toEqual(DEFAULT_LIGHTER_LAYOUT);
    expect(coerceLighterLayout({ bookShare: 0.9, ticketShare: "auto", tradesShare: 2, bottomShare: -1 }))
      .toEqual({ bookShare: 0.5, ticketShare: 0.25, tradesShare: 0.7, bottomShare: 0, bottomCollapsed: false });
  });
});

describe("coerceLighterDesk", () => {
  it("turns Don't ask again on only for an explicit true", () => {
    expect(coerceLighterDesk(undefined).skipCloseConfirm).toBe(false);
    expect(coerceLighterDesk({ ...DEFAULT_LIGHTER_DESK, skipCloseConfirm: "true" }).skipCloseConfirm).toBe(false);
    expect(coerceLighterDesk({ ...DEFAULT_LIGHTER_DESK, skipCloseConfirm: 1 }).skipCloseConfirm).toBe(false);
    expect(coerceLighterDesk({ ...DEFAULT_LIGHTER_DESK, skipCloseConfirm: true }).skipCloseConfirm).toBe(true);
  });
});
