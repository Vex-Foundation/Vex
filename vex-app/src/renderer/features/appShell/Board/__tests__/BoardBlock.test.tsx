/**
 * BOARD RENDER CONTRACT.
 *
 * What these tests protect, in order of how much a defect would cost:
 *
 *  - the fixture really is a valid `BoardSpecV1` (parsed through the schema),
 *    so every render assertion below is made against the real contract;
 *  - the three card states each resolve to a VISIBLE card, and a pool with a
 *    degraded row is never silently dropped;
 *  - staleness reaches assistive tech as WORDS, not only as a dimmed pixel;
 *  - annotation labels are DOM text, not canvas paint;
 *  - the chart instance is created only while the disclosure is open, which is
 *    the whole no-flicker gate.
 *
 * `lightweight-charts` is mocked: the module is ESM-only and paints to a real
 * canvas, which jsdom does not have. Mocking it lets these tests assert the
 * LIFECYCLE (created once, removed on collapse, options closed) without
 * asserting a single pixel. The data-path behavior of the adapter is proven
 * separately in `boardChartFeed.test.ts` against a fake series.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { boardSpecV1Schema } from "@vex-lib/board/index.js";
import { BoardBlock } from "../BoardBlock.js";
import { boardSpec, candle, hydratedRow, FIXTURE_FETCHED_AT } from "./boardFixture.js";

const chartInstances: {
  removed: boolean;
  options: Record<string, unknown>;
  seriesOptions: Record<string, unknown>;
  priceLineTitles: unknown[];
  markers: unknown[];
  fitContentCalls: number;
}[] = [];

vi.mock("lightweight-charts", () => {
  const CandlestickSeries = { type: "Candlestick" };
  return {
    CandlestickSeries,
    createChart: (_el: HTMLElement, options: Record<string, unknown>) => {
      const record = {
        removed: false,
        options,
        seriesOptions: {} as Record<string, unknown>,
        priceLineTitles: [] as unknown[],
        markers: [] as unknown[],
        fitContentCalls: 0,
      };
      chartInstances.push(record);
      const series = {
        setData: () => {},
        update: () => {},
        applyOptions: () => {},
        attachPrimitive: () => {},
        detachPrimitive: () => {},
        priceToCoordinate: () => 10,
        createPriceLine: (o: { title?: unknown }) => {
          record.priceLineTitles.push(o.title);
          return o;
        },
        removePriceLine: () => {},
      };
      return {
        addSeries: (_def: unknown, seriesOptions: Record<string, unknown>) => {
          record.seriesOptions = seriesOptions;
          return series;
        },
        applyOptions: () => {},
        timeScale: () => ({
          fitContent: () => {
            record.fitContentCalls += 1;
          },
        }),
        remove: () => {
          record.removed = true;
        },
      };
    },
    createSeriesMarkers: () => ({
      setMarkers: (m: unknown[]) => {
        chartInstances.at(-1)?.markers.push(...m);
      },
      detach: () => {},
    }),
  };
});

beforeEach(() => {
  chartInstances.length = 0;
  vi.useFakeTimers();
  // Freeze the staleness clock: a board is a snapshot and these assertions
  // are about which side of the freshness window it sits on.
  vi.setSystemTime(FIXTURE_FETCHED_AT + 1_000);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function renderBoard(spec = boardSpec()): HTMLElement {
  const { container } = render(createElement(BoardBlock, { spec }));
  return container;
}

describe("board fixture parity", () => {
  it("the default fixture is a spec the canonical schema accepts", () => {
    const parsed = boardSpecV1Schema.safeParse(boardSpec());
    expect(parsed.success).toBe(true);
  });

  it("a fixture with a chart and annotations is also accepted", () => {
    const parsed = boardSpecV1Schema.safeParse(
      boardSpec({
        annotations: [
          { kind: "level", price: "0.0000013", label: "resistance" },
          {
            kind: "zone",
            priceFrom: "0.0000011",
            priceTo: "0.0000012",
            label: "accumulation",
          },
          { kind: "marker", atMs: FIXTURE_FETCHED_AT, label: "listing" },
        ],
      }),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("BoardBlock states", () => {
  it("renders a priced card in the data state", () => {
    renderBoard();
    const card = screen.getByRole("article");
    expect(card.getAttribute("data-state")).toBe("data");
    expect(card.textContent).toContain("PEPE");
  });

  it("renders a card in the partial state when the row has no price", () => {
    renderBoard(boardSpec({ rows: [hydratedRow({ priceUsd: null })] }));
    expect(screen.getByRole("article").getAttribute("data-state")).toBe(
      "partial",
    );
  });

  it("still renders a card for a pool whose hydration row is missing", () => {
    // Deliberately outside the schema invariant (rows.length === pools.length):
    // this drives the defensive branch that keeps the agent's board honest if
    // the invariant were ever weakened.
    const container = renderBoard(
      boardSpec({
        pools: [
          { chain: "base", pairAddress: "0xaaa111" },
          { chain: "base", pairAddress: "0xbbb222" },
        ],
        rows: [hydratedRow()],
      }),
    );
    const cards = container.querySelectorAll('[data-vex-area="board-token-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[1]!.getAttribute("data-state")).toBe("unhydrated");
    expect(cards[1]!.textContent).toContain("No market data for this pool.");
  });

  it("never renders a fabricated zero for a missing figure", () => {
    const container = renderBoard(
      boardSpec({
        rows: [
          hydratedRow({
            priceUsd: null,
            liquidityUsd: null,
            volumeH24Usd: null,
            txns: { buys: null, sells: null },
          }),
        ],
      }),
    );
    const card = container.querySelector('[data-vex-area="board-token-card"]')!;
    expect(card.textContent).not.toContain("$0.00");
    expect(card.textContent).toContain("-");
  });

  it("shows the whole decimal string in the title while displaying a short figure", () => {
    const container = renderBoard(
      boardSpec({
        rows: [hydratedRow({ priceUsd: "0.00000000000012345678" })],
      }),
    );
    const priced = [...container.querySelectorAll("span")].find(
      (el) => el.getAttribute("title") === "0.00000000000012345678",
    );
    expect(priced).toBeDefined();
  });
});

describe("BoardBlock staleness", () => {
  it("is fresh inside the window and says nothing about delay", () => {
    const container = renderBoard();
    expect(
      container
        .querySelector('[data-vex-area="board-block"]')!
        .getAttribute("data-stale"),
    ).toBe("false");
    expect(screen.getByRole("article").getAttribute("aria-label")).not.toContain(
      "delayed",
    );
  });

  it("states the delay in the accessible name once the window has passed", () => {
    vi.setSystemTime(FIXTURE_FETCHED_AT + 4 * 3_600_000);
    const container = renderBoard();
    const block = container.querySelector('[data-vex-area="board-block"]')!;
    expect(block.getAttribute("data-stale")).toBe("true");
    expect(block.getAttribute("aria-label")).toContain("market data delayed");
    expect(screen.getByRole("article").getAttribute("aria-label")).toContain(
      "market data delayed",
    );
    expect(
      container.querySelector('[data-vex-area="board-stale-marker"]'),
    ).not.toBeNull();
  });

  it("keeps the analysis clock and the market-data clock as separate lines", () => {
    const container = renderBoard();
    const clocks = container.querySelector('[data-vex-area="board-clocks"]')!;
    expect(clocks.textContent).toContain("Analysis");
    expect(clocks.textContent).toContain("Market data");
  });
});

describe("BoardBlock notes", () => {
  it("renders every note as plain text, preserving newlines", () => {
    const container = renderBoard({
      ...boardSpec(),
      notes: ["first\nsecond", "third"],
    });
    const notes = container.querySelector('[data-vex-area="board-notes"]')!;
    expect(notes.getAttribute("data-count")).toBe("2");
    expect(notes.textContent).toContain("first\nsecond");
  });

  it("does not interpret markup in a note", () => {
    const container = renderBoard({
      ...boardSpec(),
      notes: ["<b>not bold</b>"],
    });
    const notes = container.querySelector('[data-vex-area="board-notes"]')!;
    expect(notes.querySelector("b")).toBeNull();
    expect(notes.textContent).toContain("<b>not bold</b>");
  });

  it("renders nothing when there are no notes", () => {
    const container = renderBoard();
    expect(container.querySelector('[data-vex-area="board-notes"]')).toBeNull();
  });
});

describe("BoardBlock chart disclosure", () => {
  const withChart = () =>
    boardSpec({
      annotations: [
        { kind: "level", price: "0.0000013", label: "resistance" },
        {
          kind: "zone",
          priceFrom: "0.0000011",
          priceTo: "0.0000012",
          label: "accumulation",
        },
        { kind: "marker", atMs: FIXTURE_FETCHED_AT, label: "listing" },
      ],
    });

  it("creates NO chart instance while the region is collapsed", () => {
    renderBoard(withChart());
    expect(chartInstances).toHaveLength(0);
  });

  it("creates exactly one chart instance when the region opens", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(chartInstances).toHaveLength(1);
    expect(chartInstances[0]!.removed).toBe(false);
  });

  it("removes the chart when the region collapses again", () => {
    renderBoard(withChart());
    const trigger = screen.getByRole("button", { name: "Show chart" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(chartInstances[0]!.removed).toBe(true);
  });

  it("removes the chart on unmount", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    cleanup();
    expect(chartInstances[0]!.removed).toBe(true);
  });

  it("disables the library's own attribution anchor and renders owned credit", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    const layout = chartInstances[0]!.options["layout"] as {
      attributionLogo: boolean;
    };
    expect(layout.attributionLogo).toBe(false);
    const credit = container.querySelector(
      '[data-vex-area="board-chart-attribution"] a',
    )!;
    expect(credit.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("sets a custom price format so a sub-cent price is not rendered as 0.00", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    const priceFormat = chartInstances[0]!.seriesOptions["priceFormat"] as {
      type: string;
    };
    expect(priceFormat.type).toBe("custom");
  });

  it("fits the viewport exactly once for the subject, not per render", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(chartInstances[0]!.fitContentCalls).toBe(1);
  });

  it("draws price lines with NO library-drawn title", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(chartInstances[0]!.priceLineTitles).toStrictEqual([""]);
  });

  it("gives markers no text, so no agent-authored string reaches the canvas", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    for (const marker of chartInstances[0]!.markers) {
      expect(marker).not.toHaveProperty("text");
    }
  });

  it("lists every annotation label as DOM text with its coordinate", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    const legend = container.querySelector(
      '[data-vex-area="board-chart-annotations"]',
    )!;
    expect(legend.getAttribute("aria-label")).toBe("Chart annotations");
    expect(legend.textContent).toContain("resistance");
    expect(legend.textContent).toContain("accumulation");
    expect(legend.textContent).toContain("listing");
    expect(legend.textContent).toContain("0.0000011 to 0.0000012");
    expect(legend.querySelectorAll("li")).toHaveLength(3);
  });

  it("names the forming bar and the resolution in the caveats", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    const caveats = container.querySelector(
      '[data-vex-area="board-chart-caveats"]',
    )!;
    expect(caveats.textContent).toContain("1h");
    expect(caveats.textContent).toContain("3 bars");
    expect(caveats.textContent).toContain("newest bar still forming");
  });

  it("reports the provider's own bound when the series was truncated", () => {
    const container = renderBoard(
      boardSpec({ truncated: true, annotations: [] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(
      container.querySelector('[data-vex-area="board-chart-caveats"]')!
        .textContent,
    ).toContain("provider bounded the range");
  });

  it("keeps the trigger and the region wired for assistive tech", () => {
    const container = renderBoard(withChart());
    const trigger = screen.getByRole("button", { name: "Show chart" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const regionId = trigger.getAttribute("aria-controls")!;
    // `useId` emits colons, which are not valid in a bare CSS id selector and
    // jsdom has no `CSS.escape`; the attribute selector is exact either way.
    expect(
      container.querySelector(`[id="${regionId}"]`),
    ).not.toBeNull();
    fireEvent.click(trigger);
    expect(
      screen.getByRole("button", { name: "Hide chart" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  it("renders no disclosure at all when the board carries no chart", () => {
    renderBoard(boardSpec());
    expect(screen.queryByRole("button", { name: "Show chart" })).toBeNull();
  });

  it("names the chart, with its delay, for a screen reader", () => {
    vi.setSystemTime(FIXTURE_FETCHED_AT + 4 * 3_600_000);
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    const figure = screen.getByRole("img");
    expect(figure.getAttribute("aria-label")).toContain("0xaaa111");
    expect(figure.getAttribute("aria-label")).toContain("market data delayed");
  });
});

describe("BoardBlock chart degradation", () => {
  it("creates NO chart and states the gap when the series is empty", () => {
    const container = renderBoard(boardSpec({ bars: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(chartInstances).toHaveLength(0);
    const empty = container.querySelector('[data-vex-area="board-chart-empty"]')!;
    expect(empty.textContent).toContain("No candles for this pool at 1h.");
  });

  it("still lists the agent's annotation labels when there is no series to draw", () => {
    const container = renderBoard(
      boardSpec({
        bars: [],
        annotations: [{ kind: "level", price: "0.0000013", label: "resistance" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(
      container.querySelector('[data-vex-area="board-chart-annotations"]')!
        .textContent,
    ).toContain("resistance");
  });
});

describe("BoardBlock chart budget reporting", () => {
  it("says how many older bars the display window left out", () => {
    const bars = Array.from({ length: 205 }, (_, i) =>
      candle(FIXTURE_FETCHED_AT - (205 - i) * 3_600_000),
    );
    const container = renderBoard(boardSpec({ bars }));
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(
      container.querySelector('[data-vex-area="board-chart-caveats"]')!
        .textContent,
    ).toContain("5 older bars");
  });
});
