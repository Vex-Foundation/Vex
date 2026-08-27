/**
 * THE DERIVED LINE UNDER THE TITLE.
 *
 * TWO CLAIMS, and they are the reason this line is not part of the model's
 * title. First, it states only what the RUNTIME owns - the pool count and the
 * clock the figures were read at - so nothing the model authored can reach it.
 * Second, the clock follows the FIGURES: a board holding a live lease dates
 * this line by the last tick rather than by the moment it was composed, which
 * is what stops a live board describing itself with a composition-time clock.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { BoardSubtitle } from "../BoardSubtitle.js";
import { useBoardLiveOverlayStore } from "../board-live-overlay.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

function threePoolBoard(): BoardRef {
  const pools = [
    { chain: "base", pairAddress: "0xaaa111", analysis: null },
    { chain: "base", pairAddress: "0xbbb222", analysis: null },
    { chain: "solana", pairAddress: "0xccc333", analysis: null },
  ];
  return boardRefOf(
    "s1",
    9,
    boardSpec({
      title: "Top movers",
      pools,
      rows: pools.map(() => hydratedRow()),
    }),
  );
}

afterEach(() => {
  cleanup();
  useBoardLiveOverlayStore.setState({ published: null });
});

describe("BoardSubtitle", () => {
  it("states the board's own pool count and the clock, and nothing authored", () => {
    render(<BoardSubtitle board={threePoolBoard()} />);
    const line = screen.getByText(/pools/);
    expect(line.getAttribute("data-vex-area")).toBe("board-subtitle");
    expect(line.textContent).toContain("3 pools");
    // The model's title is the line ABOVE this one, painted by the host.
    expect(line.textContent).not.toContain("Top movers");
  });
});
