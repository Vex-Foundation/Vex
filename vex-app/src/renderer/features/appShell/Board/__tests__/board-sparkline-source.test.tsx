/**
 * THE SPARKLINE SEAM - one batch in, one line per card out, in pool order.
 *
 * ORDER IS THE DEFECT WORTH TESTING. A hydration that returned its entries in
 * any other order, or that a consumer paired by position after a reorder,
 * would draw one token's price history on another token's card - a mistake
 * that looks like data rather than like a bug. So the cases below scramble the
 * answer deliberately and assert the lines still land on the right pools.
 *
 * ABSENCE IS PER POOL, and the three families stay apart: bars drawn, a
 * settled "no line for this pool", and a pool that was never reached before
 * the board-wide deadline expired - which stays PENDING, because nothing is
 * known about a pool nobody asked about.
 *
 * CANCELLATION IS PROVEN THROUGH THE BRIDGE. The hook consumes the query's
 * `AbortSignal`, so closing the board has to reach `cancel()`, which is what
 * fires main's `ctx.signal` and stops the queue admitting the pools behind the
 * reads already in flight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { boardSparklineHydrateResultSchema } from "@shared/schemas/board-sparkline.js";
import type { BoardSparklineOutcome } from "@shared/schemas/board-sparkline.js";
import {
  BOARD_SPARKLINE_RESOLUTION,
  boardSparklineDataFrom,
  useBoardSparklines,
} from "../board-sparkline-source.js";
import { boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { boardSpec, hydratedRow } from "./boardFixture.js";

const NOW = 1_756_000_000_000;
const hydrate = vi.fn();

function series(closes: readonly string[]): BoardSparklineOutcome {
  return {
    kind: "series",
    series: {
      bars: closes.map((close, index) => ({
        tMs: NOW - (closes.length - index) * 900_000,
        o: close,
        h: close,
        l: close,
        c: close,
      })),
      lastBarPartial: false,
      coveredRange: {
        fromMs: NOW - closes.length * 900_000,
        toMs: NOW,
      },
      resolution: BOARD_SPARKLINE_RESOLUTION,
      truncated: false,
    },
  };
}

function threePoolBoard(): BoardRef {
  const pools = [
    { chain: "base", pairAddress: "0xaaa111", analysis: null },
    { chain: "base", pairAddress: "0xbbb222", analysis: null },
    { chain: "base", pairAddress: "0xccc333", analysis: null },
  ];
  return boardRefOf(
    "s1",
    9,
    boardSpec({ pools, rows: pools.map(() => hydratedRow()) }),
  );
}

/**
 * Answer the whole board, with the entries deliberately REVERSED.
 *
 * The wire contract promises request order AND a key on every entry; keying is
 * what protects the card, and a reversed answer is the cheapest way to prove
 * the consumer is not silently relying on position.
 */
function answerReversed(
  outcomeFor: (pairAddress: string) => BoardSparklineOutcome,
): ReturnType<typeof vi.fn> {
  const cancel = vi.fn();
  hydrate.mockImplementation(
    (input: {
      pools: { chain: string; pairAddress: string }[];
      resolution: string;
    }) => ({
      promise: Promise.resolve({
        ok: true,
        data: {
          entries: [...input.pools].reverse().map((subject) => ({
            key: `${subject.chain}:${subject.pairAddress}`.toLowerCase(),
            subject,
            outcome: outcomeFor(subject.pairAddress),
          })),
          deadlineHit: false,
        },
      }),
      cancel,
    }),
  );
  return cancel;
}

/** Reports the seam's output as text, one status per pool, in order. */
function Probe({ board }: { readonly board: BoardRef }): JSX.Element {
  const lines = useBoardSparklines(board.spec);
  return (
    <p data-testid="lines">
      {lines
        .map((line) =>
          line.status === "bars"
            ? `bars:${line.bars.map((bar) => bar.c ?? "-").join("/")}`
            : line.status,
        )
        .join(",")}
    </p>
  );
}

function wrap(node: ReactNode): JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  hydrate.mockReset();
  answerReversed(() => series(["1", "2"]));
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { boardSparkline: { hydrate } },
  });
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

describe("the fixture is valid against the wire contract", () => {
  it("parses a whole hydration through its own schema", () => {
    expect(
      boardSparklineHydrateResultSchema.safeParse({
        entries: [
          {
            key: "base:0xaaa111",
            subject: { chain: "base", pairAddress: "0xaaa111" },
            outcome: series(["1", "2"]),
          },
        ],
        deadlineHit: false,
      }).success,
    ).toBe(true);
  });
});

describe("boardSparklineDataFrom", () => {
  it("draws the bars a series carries, closes included", () => {
    expect(boardSparklineDataFrom(series(["1", "2"]))).toEqual({
      status: "bars",
      bars: [
        { tMs: NOW - 1_800_000, c: "1" },
        { tMs: NOW - 900_000, c: "2" },
      ],
    });
  });

  it("nothing asked for is pending, never a settled absence", () => {
    expect(boardSparklineDataFrom(null)).toEqual({ status: "pending" });
  });

  it("a settled absence is a dim baseline: no line WILL land", () => {
    expect(
      boardSparklineDataFrom({ kind: "absent", reason: "no_drawable_bars" }),
    ).toEqual({ status: "unavailable" });
  });

  it("a pool the deadline never reached stays PENDING", () => {
    // Nothing was learned about this pool at all, so a dim baseline would be
    // the card claiming an absence it was never told about.
    expect(
      boardSparklineDataFrom({ kind: "unavailable", reason: "deadline" }),
    ).toEqual({ status: "pending" });
    expect(
      boardSparklineDataFrom({ kind: "unavailable", reason: "transport" }),
    ).toEqual({ status: "unavailable" });
  });
});

describe("useBoardSparklines", () => {
  it("is pending for every pool until the batch lands", () => {
    hydrate.mockReturnValue({ promise: new Promise(() => {}), cancel: vi.fn() });
    render(wrap(<Probe board={threePoolBoard()} />));
    expect(screen.getByTestId("lines").textContent).toBe(
      "pending,pending,pending",
    );
  });

  it("asks ONCE for the whole board, at the board's own resolution", async () => {
    render(wrap(<Probe board={threePoolBoard()} />));
    await waitFor(() => {
      expect(hydrate).toHaveBeenCalledTimes(1);
    });
    expect(hydrate).toHaveBeenCalledWith({
      pools: [
        { chain: "base", pairAddress: "0xaaa111" },
        { chain: "base", pairAddress: "0xbbb222" },
        { chain: "base", pairAddress: "0xccc333" },
      ],
      resolution: BOARD_SPARKLINE_RESOLUTION,
    });
  });

  it("lands each line on its own pool even when the answer is reordered", async () => {
    answerReversed((pairAddress) =>
      pairAddress === "0xaaa111"
        ? series(["1"])
        : pairAddress === "0xbbb222"
          ? series(["2"])
          : series(["3"]),
    );
    render(wrap(<Probe board={threePoolBoard()} />));
    await waitFor(() => {
      expect(screen.getByTestId("lines").textContent).toBe(
        "bars:1,bars:2,bars:3",
      );
    });
  });

  it("gives each pool its OWN absence", async () => {
    answerReversed((pairAddress) =>
      pairAddress === "0xaaa111"
        ? series(["1"])
        : pairAddress === "0xbbb222"
          ? { kind: "absent", reason: "no_drawable_bars" }
          : { kind: "unavailable", reason: "deadline" },
    );
    render(wrap(<Probe board={threePoolBoard()} />));
    await waitFor(() => {
      expect(screen.getByTestId("lines").textContent).toBe(
        "bars:1,unavailable,pending",
      );
    });
  });

  it("does not poll: a drawn line is a snapshot by contract", async () => {
    vi.useFakeTimers();
    try {
      render(wrap(<Probe board={threePoolBoard()} />));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(hydrate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the batch when the surface goes away", async () => {
    const cancel = vi.fn();
    hydrate.mockReturnValue({ promise: new Promise(() => {}), cancel });

    const view = render(wrap(<Probe board={threePoolBoard()} />));
    await waitFor(() => {
      expect(hydrate).toHaveBeenCalledTimes(1);
    });
    expect(cancel).not.toHaveBeenCalled();

    // The modal host unmounts its slot children on every close path.
    view.unmount();

    await waitFor(() => {
      expect(cancel).toHaveBeenCalled();
    });
  });
});
