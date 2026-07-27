/**
 * AgentScanScreen — the full-history activity ledger.
 *
 * Pins:
 *   - the filter bar DRIVES the query input: each control projects onto the
 *     `agentScanFiltersSchema` shape, empty selections are omitted entirely
 *     (never sent as a "match nothing" empty array), and active filters are
 *     visibly pinned with a working Clear;
 *   - VIRTUALIZATION: a large multi-page fixture keeps the rendered row count
 *     BOUNDED, before and after scrolling — an unbounded feed must never
 *     retain a DOM node per fetched row;
 *   - pagination: Load more fires fetchNextPage and appended pages' rows join
 *     the feed;
 *   - the states matrix fails CLOSED: a timed-out page renders the try-again
 *     note and NEVER the empty state, and an empty result while filters are
 *     active says so instead of claiming there is no history;
 *   - a row expands to its audit detail (legs with main-resolved explorer
 *     links, Vex fee, failure code/reason, last tracking check).
 *
 * `useAgentScanInfinite` is mocked — this suite owns the screen, not the query
 * wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type {
  AgentScanDto,
  AgentScanEntry,
} from "@shared/schemas/agent-scan-feed.js";
import type { Result } from "@shared/ipc/result.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));
vi.mock("@hugeicons/core-free-icons", () => ({
  Cancel01Icon: "Cancel01Icon",
  ArrowUpRight01Icon: "ArrowUpRight01Icon",
}));

const mockUseAgentScanInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useAgentScanInfinite: mockUseAgentScanInfinite,
}));

const { AgentScanScreen } = await import("../AgentScanScreen.js");

// Real geometry. jsdom reports zero for every measurement, and a zero-height
// scroll viewport makes the virtualizer render NOTHING at all (virtual-core
// nulls the range when `outerSize === 0`), so the windowing would be untested
// rather than tested. The two stubs mirror what the library actually reads:
//   - the SCROLL viewport through `offsetHeight`/`offsetWidth` (`getRect`),
//   - each ROW through `getBoundingClientRect` (`measureElement`).
const ROW_PX = 48;
const VIEWPORT_PX = 480;

let rectSpy: ReturnType<typeof vi.spyOn> | null = null;
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight",
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth",
);

function entry(overrides: Partial<AgentScanEntry> & { readonly id: string }): AgentScanEntry {
  return {
    createdAt: "2026-07-20T10:21:00+00:00",
    activityKind: "swap",
    eventRole: "swap",
    status: "confirmed",
    protocol: "kyberswap",
    chainId: 8453,
    chainFamily: "eip155",
    chainSlug: "base",
    fromChain: null,
    toChain: null,
    input: {
      address: "0x1111111111111111111111111111111111111111",
      symbol: "USDC",
      displaySymbol: "USDC",
      decimals: 6,
      amountHuman: "50",
      amountRaw: "50000000",
      executedAmountHuman: "50",
      executedAmountRaw: "50000000",
      displayAmount: "50",
      usdEst: "50.00",
    },
    output: {
      address: "0x2222222222222222222222222222222222222222",
      symbol: "WETH",
      displaySymbol: "WETH",
      decimals: 18,
      amountHuman: "0.02",
      amountRaw: "20000000000000000",
      executedAmountHuman: "0.02",
      executedAmountRaw: "20000000000000000",
      displayAmount: "0.02",
      usdEst: "49.80",
    },
    amountBasis: null,
    vexFee: null,
    usdFeeEst: null,
    failureCode: null,
    failureReason: null,
    txHash: "0xabc",
    explorerUrl: "https://basescan.org/tx/0xabc",
    providerOrderId: null,
    legs: [],
    lastCheckedAt: null,
    ...overrides,
  };
}

function availablePage(
  entries: readonly AgentScanEntry[],
  options?: { readonly hasMore?: boolean },
): Result<AgentScanDto> {
  return {
    ok: true,
    data: {
      status: "available",
      entries: [...entries],
      nextCursor:
        options?.hasMore === true
          ? { createdAt: "2026-07-20T10:21:00.000000Z", sourceId: "1" }
          : null,
      hasMore: options?.hasMore === true,
    },
  };
}

const mockFetchNextPage = vi.fn();

function mockQuery(
  pages: readonly Result<AgentScanDto>[],
  options?: {
    readonly isLoading?: boolean;
    readonly isError?: boolean;
    readonly hasNextPage?: boolean;
    readonly isFetchingNextPage?: boolean;
  },
): void {
  mockUseAgentScanInfinite.mockReturnValue({
    isLoading: options?.isLoading ?? false,
    isError: options?.isError ?? false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: options?.hasNextPage ?? false,
    isFetchingNextPage: options?.isFetchingNextPage ?? false,
    fetchNextPage: mockFetchNextPage,
  });
}

function mountScreen(): void {
  render(<AgentScanScreen origin={null} onClose={() => undefined} />);
}

/** The filters argument the screen most recently handed the hook. */
function lastFilters(): unknown {
  const calls = mockUseAgentScanInfinite.mock.calls;
  return calls[calls.length - 1]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => VIEWPORT_PX,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 800,
  });
  rectSpy = vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockReturnValue({
      width: 800,
      height: ROW_PX,
      top: 0,
      left: 0,
      right: 800,
      bottom: ROW_PX,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
  rectSpy?.mockRestore();
  if (originalOffsetHeight !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
  }
  if (originalOffsetWidth !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  }
  cleanup();
});

describe("AgentScanScreen — filters drive the query input", () => {
  it("starts with NO constraints — an empty selection is omitted, never sent as an empty array", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    expect(lastFilters()).toEqual({});
  });

  it("projects each control onto the filter contract", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    fireEvent.click(screen.getByRole("button", { name: "lend" }));
    expect(lastFilters()).toEqual({ kinds: ["lend"] });

    fireEvent.click(screen.getByRole("button", { name: "bridge" }));
    expect(lastFilters()).toEqual({ kinds: ["lend", "bridge"] });

    fireEvent.click(screen.getByRole("button", { name: "failed" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
    });

    fireEvent.click(screen.getByRole("button", { name: "KyberSwap" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
      protocols: ["kyberswap"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Solana" }));
    expect(lastFilters()).toEqual({
      kinds: ["lend", "bridge"],
      statuses: ["failed"],
      protocols: ["kyberswap"],
      chainFamily: "solana",
    });
  });

  it("offers ONLY protocols that actually write the feed — never an always-empty option", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    // The executors that write `agent_activity` today.
    for (const label of ["KyberSwap", "Uniswap", "Jupiter", "Khalani", "Relay"]) {
      expect(screen.getByRole("button", { name: label })).not.toBeNull();
    }
    // Polymarket is deleted from the product, DexScreener only reads market
    // data, and Pendle still captures into the LEGACY table — filtering on any
    // of them could only ever return an empty feed, which on an audit surface
    // reads as "the agent never did this".
    for (const label of ["Polymarket", "DexScreener", "Pendle"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("toggles a selected value back off", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();
    const swap = screen.getByRole("button", { name: "swap" });
    fireEvent.click(swap);
    expect(lastFilters()).toEqual({ kinds: ["swap"] });
    fireEvent.click(swap);
    expect(lastFilters()).toEqual({});
  });

  it("PINS the active filters with a count and clears them all", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    fireEvent.click(screen.getByRole("button", { name: "wrap" }));
    fireEvent.click(screen.getByRole("button", { name: "pending" }));
    expect(screen.getByText("2 filters active")).not.toBeNull();
    // The pressed state reaches assistive tech, not just the paint.
    expect(
      screen.getByRole("button", { name: "wrap" }).getAttribute("aria-pressed"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(lastFilters()).toEqual({});
    expect(screen.queryByText(/filters active/)).toBeNull();
  });
});

describe("AgentScanScreen — virtualization", () => {
  /** 3 pages × 100 rows, all on distinct days so dividers are in the mix too. */
  function largeFeed(): readonly Result<AgentScanDto>[] {
    const page = (offset: number): Result<AgentScanDto> =>
      availablePage(
        Array.from({ length: 100 }, (_, index) => {
          const n = offset + index;
          const day = String((n % 27) + 1).padStart(2, "0");
          return entry({
            id: `e-${n}`,
            createdAt: `2026-07-${day}T10:21:00+00:00`,
          });
        }),
        { hasMore: true },
      );
    return [page(0), page(100), page(200)];
  }

  it("keeps the rendered row count BOUNDED for a large multi-page feed, and after scrolling", () => {
    mockQuery(largeFeed(), { hasNextPage: false });
    mountScreen();

    const list = screen.getByRole("list", { name: "Activity" });
    const renderedBefore = within(list).getAllByRole("listitem").length;

    // 300 entries plus their day dividers are in the data…
    expect(renderedBefore).toBeGreaterThan(0);
    // …but only a window of them is ever in the DOM. A viewport of
    // VIEWPORT_PX / ROW_PX rows plus overscan on both sides is the bound; the
    // fixture is an order of magnitude larger.
    expect(renderedBefore).toBeLessThan(40);
    // The bound is real, not an artifact of a short fixture.
    expect(renderedBefore).toBeLessThan(300 / 4);

    const scroller = list.parentElement;
    expect(scroller).not.toBeNull();
    if (scroller !== null) {
      scroller.scrollTop = 4000;
      fireEvent.scroll(scroller);
    }

    const renderedAfter = within(list).getAllByRole("listitem").length;
    expect(renderedAfter).toBeGreaterThan(0);
    expect(renderedAfter).toBeLessThan(40);
  });

  it("sizes the list to the FULL feed even though only a window is mounted", () => {
    mockQuery(largeFeed());
    mountScreen();
    const list = screen.getByRole("list", { name: "Activity" });
    // The spacer reserves height for every row, so the scrollbar tells the
    // truth about how much history there is.
    const height = Number.parseInt(list.style.height, 10);
    expect(height).toBeGreaterThan(300 * ROW_PX * 0.5);
  });
});

describe("AgentScanScreen — states matrix", () => {
  it("renders a timed-out page as the calm try-again note, NEVER as empty history", () => {
    mockQuery([{ ok: true, data: { status: "unavailable", reason: "query_timeout" } }]);
    mountScreen();
    expect(
      screen.getByText(/Activity is unavailable right now — try again shortly/),
    ).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/)).toBeNull();
  });

  it("distinguishes a FILTERED-empty feed from an empty history", () => {
    mockQuery([availablePage([])]);
    mountScreen();
    expect(screen.getByText(/No activity recorded yet/)).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "lend" }));
    expect(screen.getByText("No activity matches these filters.")).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/)).toBeNull();
  });

  it("renders a failed Result as the warn state, not empty history", () => {
    mockQuery([
      {
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "portfolio",
          message: "boom",
          retryable: false,
          userActionable: false,
          redacted: true,
          correlationId: "11111111-1111-4111-8111-111111111111",
        },
      },
    ]);
    mountScreen();
    expect(screen.getByText("Couldn't load activity.")).not.toBeNull();
    expect(screen.queryByText(/No activity recorded yet/)).toBeNull();
  });
});

describe("AgentScanScreen — pagination", () => {
  it("shows Load more on hasNextPage and fires fetchNextPage", () => {
    mockQuery([availablePage([entry({ id: "1" })], { hasMore: true })], {
      hasNextPage: true,
    });
    mountScreen();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(mockFetchNextPage).toHaveBeenCalled();
  });

  it("notes a degraded LATER page instead of wiping the rows already shown", () => {
    mockQuery([
      availablePage([entry({ id: "1" })], { hasMore: true }),
      { ok: true, data: { status: "unavailable", reason: "query_timeout" } },
    ]);
    mountScreen();
    expect(screen.getByText(/Couldn't load more activity right now/)).not.toBeNull();
    // The first page's row survives.
    expect(screen.getByRole("list", { name: "Activity" })).not.toBeNull();
  });
});

describe("AgentScanScreen — rows and audit detail", () => {
  it("renders a row with its badge, legs, quote-time USD marker and main-resolved explorer link", () => {
    mockQuery([availablePage([entry({ id: "1" })])]);
    mountScreen();

    expect(screen.getByText("SWAP")).not.toBeNull();
    expect(screen.getByText(/50 USDC/)).not.toBeNull();
    expect(screen.getByText(/0\.02 WETH/)).not.toBeNull();
    // Every USD figure in this feed is a quote-time estimate — it must say so.
    expect(screen.getByText("~$49.80 est.")).not.toBeNull();
    const link = screen.getByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(link.getAttribute("href")).toBe("https://basescan.org/tx/0xabc");
  });

  it("marks an ESTIMATED bridge amount with ~ and an est. tag", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          activityKind: "bridge",
          eventRole: "bridge_fill_expected",
          amountBasis: "estimated",
          fromChain: { chainId: 8453, slug: "base" },
          toChain: { chainId: 42161, slug: "arbitrum" },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText("BRIDGE·FILL")).not.toBeNull();
    expect(screen.getByText(/~50 USDC/)).not.toBeNull();
    expect(screen.getByText("est.")).not.toBeNull();
    expect(screen.getByText("base → arbitrum")).not.toBeNull();
  });

  it("expands to the audit detail: legs with their own explorer links, Vex fee, and the failure reason", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          activityKind: "bridge",
          eventRole: "bridge_fill_expected",
          status: "failed",
          failureCode: "bridge_failed",
          failureReason: "destination fill reverted",
          vexFee: { tokenSymbol: "USDC", amountHuman: "0.05" },
          usdFeeEst: "0.05",
          providerOrderId: "ord_9",
          legs: [
            {
              role: "bridge_deposit",
              chainId: 8453,
              chainFamily: "eip155",
              chainSlug: "base",
              txHash: "0xdep",
              status: "confirmed",
              failureCode: null,
              explorerUrl: "https://basescan.org/tx/0xdep",
            },
            {
              role: "bridge_fill_expected",
              chainId: 42161,
              chainFamily: "eip155",
              chainSlug: "arbitrum",
              txHash: null,
              status: "failed",
              failureCode: "bridge_failed",
              // Uncurated chain / no hash → main resolved no URL; the leg must
              // still be listed, just not linked.
              explorerUrl: null,
            },
          ],
        }),
      ]),
    ]);
    mountScreen();

    // Collapsed by default.
    expect(screen.queryByText(/destination fill reverted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Show details/ }));

    expect(screen.getByText(/bridge_failed — destination fill reverted/)).not.toBeNull();
    expect(screen.getByText(/0\.05 USDC/)).not.toBeNull();
    expect(screen.getByText("ord_9")).not.toBeNull();
    // Both legs listed; only the one main resolved a URL for is a link.
    expect(screen.getByText("bridge_deposit")).not.toBeNull();
    expect(screen.getAllByText("bridge_fill_expected").length).toBeGreaterThan(0);
    const legLinks = screen.getAllByLabelText(/on block explorer/);
    expect(
      legLinks.filter((el) => el.getAttribute("href")?.includes("0xdep")).length,
    ).toBe(1);
  });

  it("flags a STALE pending row as tracking delayed rather than implying progress", () => {
    mockQuery([
      availablePage([
        entry({
          id: "1",
          status: "pending",
          createdAt: "2020-01-01T00:00:00+00:00",
          lastCheckedAt: "2020-01-01T00:00:00+00:00",
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText("PENDING")).not.toBeNull();
    expect(screen.getByText("tracking delayed")).not.toBeNull();
  });
});
