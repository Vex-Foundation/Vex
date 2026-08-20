import { describe, expect, it } from "vitest";
import {
  BOOK_COLLAPSED,
  BOOK_DEFAULT,
  BOOK_MAX,
  BOOK_MIN,
  CENTER_MIN,
  clampWidth,
  computeShellColumns,
  SIDEBAR_COLLAPSED,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "../shell-columns.js";

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number): number => width;
const closed = (_width: number): number => 0;

describe("clampWidth", () => {
  it("clamps into the range and rounds", () => {
    expect(clampWidth(280.4, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(280);
    expect(clampWidth(100, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(SIDEBAR_MIN);
    expect(clampWidth(9999, SIDEBAR_MIN, SIDEBAR_MAX)).toBe(SIDEBAR_MAX);
  });
});

describe("computeShellColumns", () => {
  it("step 1: everything fits at preferred widths", () => {
    const cols = computeShellColumns(1920, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT));
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, book: 360 });
  });

  it("closed sidebar keeps its compact rail and closed BOOK keeps its spine", () => {
    expect(computeShellColumns(1920, closed(300), closed(360))).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: 1920 - SIDEBAR_COLLAPSED - BOOK_COLLAPSED,
      book: BOOK_COLLAPSED,
    });
  });

  it("preferences beyond the clamp range are clamped before solving", () => {
    const cols = computeShellColumns(1920, open(9999), open(1));
    expect(cols.sidebar).toBe(SIDEBAR_MAX);
    expect(cols.book).toBe(BOOK_MIN);
    expect(computeShellColumns(1920, open(1), open(BOOK_DEFAULT)).sidebar).toBe(
      SIDEBAR_MIN,
    );
    expect(computeShellColumns(1920, open(SIDEBAR_DEFAULT), open(9999)).book).toBe(
      BOOK_MAX,
    );
  });

  it("step 2: BOOK shrinks first, center pinned at its floor", () => {
    // 280 + 360 + 640 = 1280 > 1250; BOOK concedes to 1250-280-640 = 330.
    const cols = computeShellColumns(1250, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT));
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, book: 330 });
  });

  it("boundary: exactly at the step-1/step-2 seam", () => {
    const seam = 300 + 360 + CENTER_MIN;
    expect(computeShellColumns(seam, open(300), open(360))).toEqual({
      sidebar: 300,
      center: CENTER_MIN,
      book: 360,
    });
    // One pixel narrower: BOOK gives exactly that pixel.
    expect(computeShellColumns(seam - 1, open(300), open(360))).toEqual({
      sidebar: 300,
      center: CENTER_MIN,
      book: 359,
    });
  });

  it("step 3: BOOK auto-closes to the spine when its min still starves center - sidebar holds its preference", () => {
    // 280 + 300 + 640 = 1220 > 1210 → BOOK drops to the 48px spine;
    // sidebar untouched: center = 1210 - 280 - 48 = 882.
    const cols = computeShellColumns(1210, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT));
    expect(cols).toEqual({ sidebar: 280, center: 882, book: BOOK_COLLAPSED });
  });

  it("boundary: exactly at the step-2/step-3 seam", () => {
    const seam = 280 + BOOK_MIN + CENTER_MIN;
    expect(computeShellColumns(seam, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT))).toEqual(
      { sidebar: 280, center: CENTER_MIN, book: BOOK_MIN },
    );
    expect(
      computeShellColumns(seam - 1, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT)),
    ).toEqual({
      sidebar: 280,
      center: seam - 1 - 280 - BOOK_COLLAPSED,
      book: BOOK_COLLAPSED,
    });
  });

  it("the sidebar never concedes: center absorbs the deficit below CENTER_MIN", () => {
    // 700 < 280 + 48 + 640: sidebar keeps 280, BOOK its spine, center takes the rest.
    const cols = computeShellColumns(700, open(SIDEBAR_DEFAULT), closed(BOOK_DEFAULT));
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 700 - SIDEBAR_DEFAULT - BOOK_COLLAPSED,
      book: BOOK_COLLAPSED,
    });
  });

  it("sidebar-collapsed narrow window: BOOK concedes then auto-closes", () => {
    const fits = computeShellColumns(
      SIDEBAR_COLLAPSED + BOOK_MIN + CENTER_MIN,
      closed(300),
      open(BOOK_DEFAULT),
    );
    expect(fits).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: CENTER_MIN,
      book: BOOK_MIN,
    });
    const starved = computeShellColumns(
      SIDEBAR_COLLAPSED + BOOK_MIN + CENTER_MIN - 1,
      closed(300),
      open(BOOK_DEFAULT),
    );
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: SIDEBAR_COLLAPSED + BOOK_MIN + CENTER_MIN - 1 - SIDEBAR_COLLAPSED - BOOK_COLLAPSED,
      book: BOOK_COLLAPSED,
    });
  });

  it("tiny viewport: center never goes negative", () => {
    const cols = computeShellColumns(300, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT));
    expect(cols.book).toBe(BOOK_COLLAPSED);
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT);
    expect(cols.center).toBe(0);
  });

  it("recovery is pure: re-widening restores preferred widths untouched", () => {
    const squeezed = computeShellColumns(1100, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT));
    expect(squeezed.book).toBe(BOOK_COLLAPSED);
    const restored = computeShellColumns(1920, open(SIDEBAR_DEFAULT), open(BOOK_DEFAULT));
    expect(restored.book).toBe(BOOK_DEFAULT);
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT);
  });
});
