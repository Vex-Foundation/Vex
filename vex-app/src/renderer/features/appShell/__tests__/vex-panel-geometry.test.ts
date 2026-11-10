/**
 * Her panel's floor (docs/design/H3-DESKTOP.md section 6.3): how far above the
 * window's foot the chat's composer group starts, so her panel never comes
 * down over the status strip, the bottom row or anything the composer raises
 * over them (a live step, a grown draft, the docked approval band and its
 * reason field).
 */

import { describe, expect, it } from "vitest";
import { panelFloorOf } from "../vex-panel-geometry.js";

describe("panelFloorOf", () => {
  it("is the frame's foot less the top of the composer's dock", () => {
    // 1440 x 900, an idle chat: the strip's top at 795.
    expect(panelFloorOf(900, [{ top: 795, height: 105 }])).toBe(105);
  });

  it("takes whichever part stands higher: the dock or the card's decision dock", () => {
    // A card waits: its reason field and band stand over the hidden composer.
    expect(
      panelFloorOf(900, [
        { top: 795, height: 0 },
        { top: 743, height: 157 },
      ]),
    ).toBe(157);
    expect(
      panelFloorOf(900, [
        { top: 751, height: 149 },
        { top: 828, height: 72 },
      ]),
    ).toBe(149);
  });

  it("ignores a part with no box, and says nothing when no part has one", () => {
    expect(panelFloorOf(900, [{ top: 0, height: 0 }])).toBeNull();
    expect(panelFloorOf(900, [])).toBeNull();
  });

  it("is a whole pixel and never negative", () => {
    expect(panelFloorOf(900.4, [{ top: 795.6, height: 104.8 }])).toBe(105);
    expect(panelFloorOf(900, [{ top: 960, height: 10 }])).toBe(0);
  });
});
