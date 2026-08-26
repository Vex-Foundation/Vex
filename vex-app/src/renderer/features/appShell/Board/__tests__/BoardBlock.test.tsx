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
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { BOARD_STALE_AFTER_MS, boardSpecV1Schema } from "@vex-lib/board/index.js";
import { BoardBlock } from "../BoardBlock.js";
import { boardSpec, candle, hydratedRow, FIXTURE_FETCHED_AT } from "./boardFixture.js";

type ChartRecord = {
  removed: boolean;
  options: Record<string, unknown>;
  seriesOptions: Record<string, unknown>;
  priceLineTitles: unknown[];
  markers: unknown[];
  fitContentCalls: number;
};

const chartInstances: ChartRecord[] = [];

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

/**
 * The board icon bridge, faked at the WINDOW boundary rather than by mocking
 * the hook. That keeps the real query hook, the real key, the real enabled/
 * disabled decision and the real "is there a picture" projection in the test,
 * so what is stubbed is exactly the process boundary and nothing above it.
 *
 * The default answers `absent`, which is the ORDINARY case on a real board
 * (roughly half of pools carry no artwork) and therefore the right default for
 * a fixture: every card wears its monogram unless a test says otherwise.
 */
const readBoardIcon = vi.fn();

/** A 1x1 PNG, as a `data:` URL of the shape the IPC contract admits. */
const ICON_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

beforeEach(() => {
  chartInstances.length = 0;
  readBoardIcon.mockReset();
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "absent", reason: "not_found" } },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    // `boardLive` is answered but never used by these cases: the toggle is OFF
    // on every mount, so this suite still tests the SNAPSHOT board. Its live
    // behaviour is covered in `BoardLiveToggle.test.tsx`, and the capability
    // reported here is the honest one for a build with no site bridge.
    value: {
      boardIcons: { read: readBoardIcon },
      boardLive: {
        capability: () =>
          Promise.resolve({
            ok: true,
            data: { supported: false, detail: "no site bridge in this test" },
          }),
        subscribe: () => Promise.reject(new Error("not subscribed in this suite")),
        unsubscribe: () => Promise.resolve({ ok: true, data: { outcome: "unknown" } }),
        onLeaseEvent: () => () => undefined,
      },
    },
  });
  vi.useFakeTimers();
  // Freeze the staleness clock: a board is a snapshot and these assertions
  // are about which side of the freshness window it sits on.
  vi.setSystemTime(FIXTURE_FETCHED_AT + 1_000);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

/**
 * A board inside a real QueryClient. The token cards fetch their own logos
 * through TanStack Query, so a provider is part of the composition under test
 * rather than scaffolding; `retry: false` keeps a stubbed refusal from turning
 * into a retry loop inside a fake-timer test.
 */
function withQuery(ui: ReactNode): ReactNode {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, ui);
}

function renderBoard(spec = boardSpec()): HTMLElement {
  const { container } = render(withQuery(createElement(BoardBlock, { spec })));
  return container;
}

/** The `[data-vex-area="..."]` element the assertion is about, or a named failure. */
function boardArea(container: HTMLElement, area: string): HTMLElement {
  const el = container.querySelector(`[data-vex-area="${area}"]`);
  if (el === null) throw new Error(`board area "${area}" not found`);
  return el as HTMLElement;
}

function attributionAnchor(container: HTMLElement): HTMLElement {
  const el = container.querySelector(
    '[data-vex-area="board-chart-attribution"] a',
  );
  if (el === null) throw new Error("board chart attribution anchor not found");
  return el as HTMLElement;
}

function annotationLegend(container: HTMLElement): HTMLElement {
  const el = container.querySelector('[aria-label="Chart annotations"]');
  if (el === null) throw new Error("chart annotation legend not found");
  return el as HTMLElement;
}

function tokenCardAt(cards: NodeListOf<Element>, index: number): Element {
  const card = cards[index];
  if (card === undefined) throw new Error(`board token card ${index} missing`);
  return card;
}

/**
 * Open the chart's "Data notes" disclosure and return the region.
 *
 * The full caveat sentences are no longer in the always-visible caption: the
 * status line keeps the resolution and the bar count, and everything that
 * describes what the chart is NOT sits one keystroke away in this region. The
 * sentences are unchanged in substance and complete in the DOM once opened,
 * which is what these assertions check.
 */
function openDataNotes(container: HTMLElement): HTMLElement {
  const trigger = container.querySelector(
    '[data-vex-area="board-chart-notes-trigger"]',
  );
  if (trigger === null) throw new Error("chart data-notes trigger not found");
  fireEvent.click(trigger);
  return boardArea(container, "board-chart-notes");
}

function chartAt(index: number): ChartRecord {
  const chart = chartInstances[index];
  if (chart === undefined) throw new Error(`chart instance ${index} missing`);
  return chart;
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
    expect(tokenCardAt(cards, 1).getAttribute("data-state")).toBe("unhydrated");
    expect(tokenCardAt(cards, 1).textContent).toContain(
      "No market data for this pool.",
    );
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
    const card = boardArea(container, "board-token-card");
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
      boardArea(container, "board-block")
        .getAttribute("data-stale"),
    ).toBe("false");
    expect(screen.getByRole("article").getAttribute("aria-label")).not.toContain(
      "delayed",
    );
  });

  it("states the delay in the accessible name once the window has passed", () => {
    vi.setSystemTime(FIXTURE_FETCHED_AT + 4 * 3_600_000);
    const container = renderBoard();
    const block = boardArea(container, "board-block");
    expect(block.getAttribute("data-stale")).toBe("true");
    expect(block.getAttribute("aria-label")).toContain("market data delayed");
    expect(screen.getByRole("article").getAttribute("aria-label")).toContain(
      "market data delayed",
    );
    expect(
      container.querySelector('[data-vex-area="board-stale-marker"]'),
    ).not.toBeNull();
  });

  it("crosses from fresh to stale while it stays mounted, without a ticking clock", async () => {
    // The defect this pins: a board appended to an OPEN chat mounted fresh and
    // never gained "Snapshot, not live", because the freshness clock was read
    // once per mount. Nobody remounts a transcript row to age it.
    vi.setSystemTime(FIXTURE_FETCHED_AT + 1_000);
    const container = renderBoard();
    const block = boardArea(container, "board-block");
    expect(block.getAttribute("data-stale")).toBe("false");

    // One step over the boundary, and only one: the surface changes exactly
    // once, at `marketDataFetchedAt + staleAfterMs`.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BOARD_STALE_AFTER_MS);
    });

    expect(block.getAttribute("data-stale")).toBe("true");
    expect(block.getAttribute("aria-label")).toContain("market data delayed");
    expect(
      container.querySelector('[data-vex-area="board-stale-note"]')?.textContent,
    ).toContain("Snapshot, not live");
    // No countdown: nothing else is pending once the boundary has passed.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules nothing at all for a board that is already stale", () => {
    vi.setSystemTime(FIXTURE_FETCHED_AT + 4 * 3_600_000);
    renderBoard();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears its freshness timeout on unmount", () => {
    vi.setSystemTime(FIXTURE_FETCHED_AT + 1_000);
    const { unmount } = render(
      withQuery(createElement(BoardBlock, { spec: boardSpec() })),
    );
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    // Unmounting a query observer schedules its own zero-delay garbage
    // collection, so flush that one turn before counting. The board's freshness
    // timeout is aimed a minute out and would survive this advance, which is
    // what keeps the assertion strict: a leaked board timer still reads as 1.
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the analysis clock and the market-data clock as separate lines", () => {
    const container = renderBoard();
    const clocks = boardArea(container, "board-clocks");
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
    const notes = boardArea(container, "board-notes");
    expect(notes.getAttribute("data-count")).toBe("2");
    expect(notes.textContent).toContain("first\nsecond");
  });

  it("does not interpret markup in a note", () => {
    const container = renderBoard({
      ...boardSpec(),
      notes: ["<b>not bold</b>"],
    });
    const notes = boardArea(container, "board-notes");
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
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(chartInstances).toHaveLength(1);
    expect(chartAt(0).removed).toBe(false);
  });

  it("removes the chart when the region collapses again", () => {
    renderBoard(withChart());
    const trigger = screen.getByRole("button", { name: "Chart" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(chartAt(0).removed).toBe(true);
  });

  it("removes the chart on unmount", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    cleanup();
    expect(chartAt(0).removed).toBe(true);
  });

  it("disables the library's own attribution anchor and renders owned credit", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const layout = chartAt(0).options["layout"] as {
      attributionLogo: boolean;
    };
    expect(layout.attributionLogo).toBe(false);
    const credit = attributionAnchor(container);
    expect(credit.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("sets a custom price format so a sub-cent price is not rendered as 0.00", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const priceFormat = chartAt(0).seriesOptions["priceFormat"] as {
      type: string;
    };
    expect(priceFormat.type).toBe("custom");
  });

  it("gives the price format a FINITE POSITIVE minMove, never 0", () => {
    // `minMove: 0` makes the library's base Infinity, which zeroes the
    // degenerate-range extension and renders a flat series as a blank scale.
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const priceFormat = chartAt(0).seriesOptions["priceFormat"] as {
      minMove: number;
    };
    expect(Number.isFinite(priceFormat.minMove)).toBe(true);
    expect(priceFormat.minMove).toBeGreaterThan(0);
    // Derived from the fixture's own 8-decimal prices, not a fixed 0.01.
    expect(priceFormat.minMove).toBe(1e-8);
  });

  it("keeps a FLAT sub-cent series on a non-blank render path", () => {
    // The illiquid pool that did not move all window: every bar identical at
    // 1e-13. This is the case `minMove: 0` rendered blank.
    const flat = boardSpec({
      bars: [1, 2, 3].map((i) =>
        candle(FIXTURE_FETCHED_AT - i * 3_600_000, "0.0000000000001"),
      ),
    });
    renderBoard(flat);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));

    const priceFormat = chartAt(0).seriesOptions["priceFormat"] as {
      minMove: number;
      formatter: (value: number) => string;
    };
    expect(priceFormat.minMove).toBe(1e-13);
    // The autoscale input on the library's degenerate-range branch: the range
    // it would widen a single-point series by is a real interval, not zero.
    expect(5 * priceFormat.minMove).toBeGreaterThan(0);
    expect(Number.isFinite(1 / priceFormat.minMove)).toBe(true);
    // And the axis label for that price is not "0.00".
    expect(priceFormat.formatter(1e-13)).not.toBe("0.00");
  });

  it("discloses bars whose open or close sat outside the reported high/low", () => {
    // A measured provider row: bucket 1784037600000 printed openUsd
    // 0.000002874 against highUsd 0.000002871 (382 of 999 hourly bars showed
    // this). The chart draws wicks spanning all four values and SAYS so.
    const container = renderBoard(
      boardSpec({
        bars: [
          {
            tMs: FIXTURE_FETCHED_AT - 3_600_000,
            o: "0.000002874",
            h: "0.000002871",
            l: "0.000002800",
            c: "0.000002850",
          },
          candle(FIXTURE_FETCHED_AT, "0.000002860"),
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(openDataNotes(container).textContent).toContain(
      "1 bar has an open or close outside the high and low the provider reported for the same bar",
    );
  });

  it("says nothing about divergence when every bar is coherent", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    // A coherent series has nothing to disclose on this axis. Asserted on the
    // whole figure, so the sentence is absent whether or not the region is
    // open - and the trigger's own count would have named it if it existed.
    expect(
      boardArea(container, "board-chart-caveats").textContent,
    ).not.toContain("outside the high and low the provider reported");
  });

  it("omits a marker that matches no candle and names it in the legend", () => {
    // The library SNAPS an unmatched marker onto a neighbouring bar, which
    // turns the agent's claim about one moment into a claim about a bar it
    // never looked at. Unmatched markers are therefore not drawn, and the
    // legend says which one and why.
    const offGrid = FIXTURE_FETCHED_AT - 1_800_000;
    const container = renderBoard(
      boardSpec({
        annotations: [
          { kind: "marker", atMs: FIXTURE_FETCHED_AT, label: "on a bar" },
          { kind: "marker", atMs: offGrid, label: "between bars" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));

    // One marker drawn, and it is the one that landed on a bar.
    expect(chartAt(0).markers).toHaveLength(1);
    const drawnMarker = chartAt(0).markers[0];
    if (drawnMarker === undefined) throw new Error("drawn chart marker missing");
    expect((drawnMarker as { time: number }).time).toBe(
      Math.floor(FIXTURE_FETCHED_AT / 1000),
    );

    // Nothing is lost: both labels are still readable, and the omitted one
    // carries the reason in words.
    const legend = annotationLegend(container);
    expect(legend.textContent).toContain("on a bar");
    expect(legend.textContent).toContain("between bars");
    expect(
      boardArea(container, "board-annotation-note")
        .textContent,
    ).toBe(`marker at ${new Date(offGrid).toISOString()} matches no candle`);
  });

  it("recolors existing levels, zones and markers when the theme flips", async () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const before = chartAt(0).priceLineTitles.length;
    const markersBefore = chartAt(0).markers.length;
    expect(before).toBeGreaterThan(0);

    await act(async () => {
      document.documentElement.setAttribute("data-vex-theme", "light");
      // MutationObserver callbacks land on a microtask.
      await Promise.resolve();
    });

    // The annotation owner re-ran against the new palette: the geometry it
    // owns was rebuilt rather than left painted in the old theme's accent.
    expect(chartAt(0).priceLineTitles.length).toBeGreaterThan(before);
    expect(chartAt(0).markers.length).toBeGreaterThan(markersBefore);
    expect(chartAt(0).removed).toBe(false);
    expect(container.querySelector('[data-vex-area="board-chart"]')).not.toBeNull();
    document.documentElement.removeAttribute("data-vex-theme");
  });

  it("draws a marker that lands exactly on a candle, with no note", () => {
    const container = renderBoard(
      boardSpec({
        annotations: [
          { kind: "marker", atMs: FIXTURE_FETCHED_AT, label: "listing" },
        ],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(chartAt(0).markers).toHaveLength(1);
    expect(
      container.querySelector('[data-vex-area="board-annotation-note"]'),
    ).toBeNull();
  });

  it("fits the viewport exactly once for the subject, not per render", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(chartAt(0).fitContentCalls).toBe(1);
  });

  it("draws price lines with NO library-drawn title", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(chartAt(0).priceLineTitles).toStrictEqual([""]);
  });

  it("gives markers no text, so no agent-authored string reaches the canvas", () => {
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    for (const marker of chartAt(0).markers) {
      expect(marker).not.toHaveProperty("text");
    }
  });

  it("lists every annotation label as DOM text with its coordinate", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const legend = boardArea(container, "board-chart-annotations");
    expect(legend.getAttribute("aria-label")).toBe("Chart annotations");
    expect(legend.textContent).toContain("resistance");
    expect(legend.textContent).toContain("accumulation");
    expect(legend.textContent).toContain("listing");
    expect(legend.textContent).toContain("0.0000011 to 0.0000012");
    expect(legend.querySelectorAll("li")).toHaveLength(3);
  });

  it("names the forming bar and the resolution in the caveats", () => {
    const container = renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    // The two facts that describe what the chart IS stay on the always-visible
    // status line; the sentence about what it is NOT sits in the disclosure.
    const caveats = boardArea(container, "board-chart-caveats");
    expect(caveats.textContent).toContain("1h");
    expect(caveats.textContent).toContain("3 bars");
    expect(openDataNotes(container).textContent).toContain(
      "The newest bar is still forming, so its close is the price at the moment of the read, not the bar's final close.",
    );
  });

  it("reports the provider's own bound when the series was truncated", () => {
    const container = renderBoard(
      boardSpec({ truncated: true, annotations: [] }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(openDataNotes(container).textContent).toContain(
      "The provider bounded the range it returned, so history older than the first bar exists but was not sent.",
    );
  });

  it("keeps the trigger and the region wired for assistive tech", () => {
    const container = renderBoard(withChart());
    const trigger = screen.getByRole("button", { name: "Chart" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const regionId = trigger.getAttribute("aria-controls");
    if (regionId === null) throw new Error("chart trigger has no aria-controls");
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
    expect(screen.queryByRole("button", { name: "Chart" })).toBeNull();
  });

  it("names the chart, with its delay, for a screen reader", () => {
    vi.setSystemTime(FIXTURE_FETCHED_AT + 4 * 3_600_000);
    renderBoard(withChart());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const figure = screen.getByRole("img");
    expect(figure.getAttribute("aria-label")).toContain("0xaaa111");
    expect(figure.getAttribute("aria-label")).toContain("market data delayed");
  });
});

describe("BoardBlock chart degradation", () => {
  it("creates NO chart and states the gap when the series is empty", () => {
    const container = renderBoard(boardSpec({ bars: [] }));
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(chartInstances).toHaveLength(0);
    const empty = boardArea(container, "board-chart-empty");
    expect(empty.textContent).toContain("No candles for this pool at 1h.");
  });

  it("still lists the agent's annotation labels when there is no series to draw", () => {
    const container = renderBoard(
      boardSpec({
        bars: [],
        annotations: [{ kind: "level", price: "0.0000013", label: "resistance" }],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(
      boardArea(container, "board-chart-annotations")
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
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(openDataNotes(container).textContent).toContain(
      "5 older bars exist beyond the 200-bar display window and are not drawn.",
    );
  });
});

/**
 * THE CHART IS ANCHORED TO THE CARD IT IS ABOUT.
 *
 * A board's chart describes ONE pool (`chart.poolIndex`). Rendered as a
 * detached footer under the whole grid it left the reader to work out which
 * card it belonged to, and on an eight-pool board that is a real question. So
 * the owning card carries the trigger and the panel opens inside that card's
 * own grid cell.
 *
 * The list semantics are part of the contract, not a detail: the grid must
 * still have exactly one item per pool, because the accessible name states the
 * count. An extra full-width `<li>` for the panel would have made that count a
 * lie, which is why the cell widens instead.
 */
describe("BoardBlock chart anchoring", () => {
  function twoPoolBoardChartingTheSecond() {
    return boardSpec({
      pools: [
        { chain: "base", pairAddress: "0xaaa111" },
        { chain: "base", pairAddress: "0xbbb222" },
      ],
      rows: [
        hydratedRow({ baseTokenSymbol: "PEPE" }),
        hydratedRow({ baseTokenSymbol: "BRETT" }),
      ],
      chart: { poolIndex: 1, resolution: "1h" },
    });
  }

  it("puts the one trigger on the card whose pool the chart is about", () => {
    const container = renderBoard(twoPoolBoardChartingTheSecond());
    const cards = container.querySelectorAll('[data-vex-area="board-token-card"]');
    expect(cards).toHaveLength(2);
    expect(tokenCardAt(cards, 0).getAttribute("data-has-chart")).toBe("false");
    expect(tokenCardAt(cards, 1).getAttribute("data-has-chart")).toBe("true");
    // Exactly one, so a reader is never offered two ways into one chart.
    expect(
      container.querySelectorAll('[data-vex-area="board-chart-trigger"]'),
    ).toHaveLength(1);
    expect(tokenCardAt(cards, 1).querySelector('[data-vex-area="board-chart-trigger"]'))
      .not.toBeNull();
  });

  it("renders the chart inside the owning card's own grid cell", () => {
    const container = renderBoard(twoPoolBoardChartingTheSecond());
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    const host = boardArea(container, "board-chart-host");
    // The host cell is the SECOND list item, and the figure lives inside it.
    const items = container.querySelectorAll(
      '[data-vex-area="board-token-grid"] > li',
    );
    expect(items).toHaveLength(2);
    expect(items[1]).toBe(host);
    expect(host.querySelector('[data-vex-area="board-chart-caveats"]')).not.toBeNull();
  });

  it("keeps one list item per pool whether the chart is open or closed", () => {
    // The accessible name states the pool count, so the count must stay true.
    const container = renderBoard(twoPoolBoardChartingTheSecond());
    const grid = boardArea(container, "board-token-grid");
    expect(grid.getAttribute("aria-label")).toBe("2 pools on this board");
    expect(grid.querySelectorAll(":scope > li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(grid.getAttribute("aria-label")).toBe("2 pools on this board");
    expect(grid.querySelectorAll(":scope > li")).toHaveLength(2);
  });

  it("spans the host cell across the grid only while the chart is open", () => {
    const container = renderBoard(twoPoolBoardChartingTheSecond());
    const host = boardArea(container, "board-chart-host");
    expect(host.getAttribute("data-chart-open")).toBe("false");
    expect(host.className).not.toContain("sm:col-span-2");
    fireEvent.click(screen.getByRole("button", { name: "Chart" }));
    expect(host.getAttribute("data-chart-open")).toBe("true");
    expect(host.className).toContain("sm:col-span-2");
  });

  it("keeps the trigger and its region wired to each other on the card", () => {
    const container = renderBoard(twoPoolBoardChartingTheSecond());
    const trigger = boardArea(container, "board-chart-trigger");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const regionId = trigger.getAttribute("aria-controls");
    expect(regionId).not.toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    // Same element, still the trigger: opening must not move focus or replace
    // the control the reader just operated.
    expect(document.getElementById(regionId ?? "")).not.toBeNull();
  });

  it("gives a board with no chart no trigger and no host cell", () => {
    const container = renderBoard(boardSpec());
    expect(container.querySelector('[data-vex-area="board-chart-trigger"]')).toBeNull();
    expect(container.querySelector('[data-vex-area="board-chart-host"]')).toBeNull();
    expect(
      screen.getByRole("article").getAttribute("data-has-chart"),
    ).toBe("false");
  });
});

/**
 * THE TOKEN LOGO, whose absent state is the ordinary one.
 *
 * Around half of the pools a board can carry have no profile artwork, so the
 * monogram is not an error surface - it is what most cards wear. These tests
 * pin both states and, more importantly, pin that a card with no handle never
 * asks main for anything: a disabled query is the difference between a quiet
 * board and one IPC round trip per gap.
 */
describe("BoardBlock token logo", () => {
  it("draws the monogram from the symbol when the row carries no handle", async () => {
    const container = renderBoard();
    const logo = boardArea(container, "board-token-logo");
    expect(logo.getAttribute("data-state")).toBe("monogram");
    expect(logo.textContent).toBe("PE");
    // Nothing was asked of main: there is no handle to ask about.
    expect(readBoardIcon).not.toHaveBeenCalled();
  });

  it("draws the fetched image when the row carries a handle", async () => {
    readBoardIcon.mockResolvedValue({
      ok: true,
      data: { iconId: "abcd1234", icon: { kind: "image", dataUrl: ICON_DATA_URL } },
    });
    const container = renderBoard(
      boardSpec({ rows: [hydratedRow({ iconId: "abcd1234" })] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const logo = boardArea(container, "board-token-logo");
    expect(logo.getAttribute("data-state")).toBe("image");
    expect(logo.getAttribute("src")).toBe(ICON_DATA_URL);
    expect(readBoardIcon).toHaveBeenCalledWith({ iconId: "abcd1234" });
  });

  it("falls back to the monogram when main reports the icon absent", async () => {
    const container = renderBoard(
      boardSpec({ rows: [hydratedRow({ iconId: "abcd1234" })] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const logo = boardArea(container, "board-token-logo");
    expect(logo.getAttribute("data-state")).toBe("monogram");
    expect(logo.textContent).toBe("PE");
  });

  it("falls back to the monogram when the channel itself refuses", async () => {
    // A failed Result is a boundary failure, not a statement about the token.
    // The card still shows the token; it simply has no picture.
    readBoardIcon.mockResolvedValue({
      ok: false,
      error: { code: "validation.invalid_input", domain: "images" },
    });
    const container = renderBoard(
      boardSpec({ rows: [hydratedRow({ iconId: "abcd1234" })] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boardArea(container, "board-token-logo").getAttribute("data-state")).toBe(
      "monogram",
    );
  });

  it("keeps the logo out of the accessible name, which the symbol already carries", async () => {
    readBoardIcon.mockResolvedValue({
      ok: true,
      data: { iconId: "abcd1234", icon: { kind: "image", dataUrl: ICON_DATA_URL } },
    });
    const container = renderBoard(
      boardSpec({ rows: [hydratedRow({ iconId: "abcd1234" })] }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const logo = boardArea(container, "board-token-logo");
    // Decorative beside the visible ticker: announcing both reads the token
    // twice, and "image" on its own tells a screen-reader user nothing.
    expect(logo.getAttribute("aria-hidden")).toBe("true");
    expect(logo.getAttribute("alt")).toBe("");
    expect(screen.getByRole("article").getAttribute("aria-label")).toContain("PEPE");
  });

  it("uses a neutral mark rather than a letter it does not have", () => {
    const container = renderBoard(
      boardSpec({ rows: [hydratedRow({ baseTokenSymbol: null })] }),
    );
    expect(boardArea(container, "board-token-logo").textContent).toBe("?");
  });
});
