/**
 * THE CARD SPARKLINE - its states, and the two ways a naive implementation
 * lies.
 *
 * LIE ONE: THE FLAT SERIES. Mapping min..max onto the full height draws a
 * constant series as a full-height zigzag of floating-point noise, which is
 * the most misleading picture a price glyph can paint. `flat` is therefore
 * its own state with its own geometry (a level line at mid-height), not a
 * guard against dividing by zero that happens to look right.
 *
 * LIE TWO: THE BRIDGED GAP. Joining across bars the provider had no close for
 * draws a confident straight interpolation the data never contained. A run of
 * nulls SPLITS the line, and the gap stays empty.
 *
 * The geometry is asserted through `sparklineState`, the pure function every
 * one of the component's states is decided by; the render tests cover only
 * what JSX adds - which element appears, and the document-global `<defs>` id
 * hazard that eight cards on one board would otherwise trip over.
 */

import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import {
  BoardSparkline,
  sparklineState,
  type BoardSparklineBar,
} from "../BoardSparkline.js";

afterEach(cleanup);

function bars(closes: readonly (string | null)[]): readonly BoardSparklineBar[] {
  return closes.map((c, index) => ({ tMs: 1_700_000_000_000 + index * 60_000, c }));
}

describe("sparklineState", () => {
  it("reports pending and unavailable as themselves", () => {
    expect(sparklineState({ status: "pending" }).kind).toBe("pending");
    expect(sparklineState({ status: "unavailable" }).kind).toBe("unavailable");
  });

  it("treats an empty bar list as unavailable, not as an empty chart", () => {
    expect(sparklineState({ status: "bars", bars: [] }).kind).toBe("unavailable");
  });

  it("treats an ALL-NULL series as unavailable", () => {
    // The provider answered and reported no close for any bar. Drawing a line
    // through nothing would invent a price history.
    const state = sparklineState({
      status: "bars",
      bars: bars([null, null, null]),
    });
    expect(state.kind).toBe("unavailable");
  });

  it("draws a FLAT series level, never as autoscaled noise", () => {
    const state = sparklineState({
      status: "bars",
      bars: bars(["0.0001", "0.0001", "0.0001"]),
    });
    expect(state.kind).toBe("flat");
    if (state.kind === "pending" || state.kind === "unavailable") throw new Error("unreachable");
    const ys = state.segments.flatMap((segment) =>
      segment.points.map(([, y]) => y),
    );
    expect(new Set(ys).size).toBe(1);
    expect(ys[0]).toBe(17);
  });

  it("draws ONE point as a single coordinate at mid-height", () => {
    const state = sparklineState({ status: "bars", bars: bars(["0.5"]) });
    // One bar cannot have a range, so it is flat by definition.
    expect(state.kind).toBe("flat");
    if (state.kind === "pending" || state.kind === "unavailable") throw new Error("unreachable");
    expect(state.segments).toHaveLength(1);
    expect(state.segments[0]?.points).toEqual([[60, 17]]);
  });

  it("SPLITS the line at a gap instead of bridging it", () => {
    const state = sparklineState({
      status: "bars",
      bars: bars(["1", "2", null, null, "3", "4"]),
    });
    expect(state.kind).toBe("series");
    if (state.kind === "pending" || state.kind === "unavailable") throw new Error("unreachable");
    expect(state.segments).toHaveLength(2);
    expect(state.segments[0]?.points).toHaveLength(2);
    expect(state.segments[1]?.points).toHaveLength(2);
    // X is the bar INDEX, so the gap is a HOLE at the position it occupied -
    // the surviving bars keep their places rather than closing ranks.
    expect(state.segments[1]?.points[0]?.[0]).toBeCloseTo(96, 5);
  });

  it("keeps a lone priced bar between gaps as its own one-point segment", () => {
    const state = sparklineState({
      status: "bars",
      bars: bars([null, "1", null, "5", null]),
    });
    if (state.kind === "pending" || state.kind === "unavailable") throw new Error("unreachable");
    expect(state.segments.map((segment) => segment.points.length)).toEqual([1, 1]);
  });

  it("maps the extremes to the padded top and bottom of the viewBox", () => {
    const state = sparklineState({ status: "bars", bars: bars(["1", "2"]) });
    if (state.kind === "pending" || state.kind === "unavailable") throw new Error("unreachable");
    const points = state.segments[0]?.points ?? [];
    expect(points[0]?.[1]).toBe(31);
    expect(points[1]?.[1]).toBe(3);
  });
});

describe("BoardSparkline", () => {
  it("draws a shimmer while bars are pending, and no polyline", () => {
    const { container } = render(
      <BoardSparkline data={{ status: "pending" }} trend="up" />,
    );
    const node = container.querySelector('[data-vex-area="board-sparkline"]');
    expect(node?.getAttribute("data-state")).toBe("pending");
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("KEEPS ITS PLACE when no bars will land, drawing a baseline", () => {
    // The price row has a fixed geometry: rendering nothing here would leave a
    // hole that reads as a layout bug rather than as an absence of data.
    const { container } = render(
      <BoardSparkline data={{ status: "unavailable" }} trend="flat" />,
    );
    expect(
      container.querySelector('[data-vex-area="board-sparkline-baseline"]'),
    ).not.toBeNull();
  });

  it("draws a line and its area for an ordinary series", () => {
    const { container } = render(
      <BoardSparkline
        data={{ status: "bars", bars: bars(["1", "3", "2", "5"]) }}
        trend="up"
      />,
    );
    expect(container.querySelector("polyline")).not.toBeNull();
    expect(
      container.querySelector('[data-vex-area="board-sparkline-area"]'),
    ).not.toBeNull();
  });

  it("draws a DOT for a one-point segment, which a polyline cannot show", () => {
    const { container } = render(
      <BoardSparkline data={{ status: "bars", bars: bars(["1"]) }} trend="up" />,
    );
    expect(
      container.querySelector('[data-vex-area="board-sparkline-point"]'),
    ).not.toBeNull();
    expect(container.querySelector("polyline")).toBeNull();
  });

  it("gives every instance a DISTINCT gradient id", () => {
    // An SVG `<defs>` id is DOCUMENT-global. With a hardcoded id, eight cards
    // on one board would all resolve their area fill to whichever card
    // rendered last - a real defect, invisible in a single-card test.
    const { container } = render(
      <>
        <BoardSparkline
          data={{ status: "bars", bars: bars(["1", "2"]) }}
          trend="up"
        />
        <BoardSparkline
          data={{ status: "bars", bars: bars(["2", "1"]) }}
          trend="down"
        />
      </>,
    );
    const ids = [...container.querySelectorAll("linearGradient")].map((node) =>
      node.getAttribute("id"),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      // A colon is legal in an id attribute but not in a bare `url(#...)`
      // fragment, so React's own separator must not survive into it.
      expect(id).not.toContain(":");
    }
  });

  it("is decorative: no accessible name, because the card already has one", () => {
    const { container } = render(
      <BoardSparkline
        data={{ status: "bars", bars: bars(["1", "2"]) }}
        trend="up"
      />,
    );
    const node = container.querySelector('[data-vex-area="board-sparkline"]');
    expect(node?.getAttribute("aria-hidden")).toBe("true");
  });
});
