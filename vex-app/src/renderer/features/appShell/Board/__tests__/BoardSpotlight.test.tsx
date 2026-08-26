/**
 * THE SPOTLIGHT SURFACE - every element of the owner's second mockup, every
 * designed state of those elements, and the cuts that stop its feeds.
 *
 * THREE SUBJECTS, and they are different kinds of claim:
 *
 *  1. PRESENCE. Each element of the mockup, and each SPOTLIGHT+ section, is
 *     asserted by its `data-vex-area` and by the words it carries. A section
 *     that quietly stopped rendering would pass a layout review and fail here.
 *  2. HONEST STATES. Pending is not unavailable, an unverified lock share is
 *     words rather than a number, an empty narrative list is a sentence rather
 *     than a hole, and "updated now" is reachable ONLY from a landed fetch.
 *  3. LIFECYCLE. Leaving the spotlight, losing the lease and unmounting all
 *     stop the polls, and the teardown registry returns to its baseline. The
 *     registry count is the leak test: a channel that forgot to unregister
 *     leaves a disposer behind whether or not its timer still fires.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { BoardDetailsBundle } from "@shared/schemas/board-details.js";
import { BoardSpotlight } from "../BoardSpotlight.js";
import {
  BOARD_FILTER_NONE,
  countBoardSurfaceTeardowns,
  useBoardSurfaceStore,
} from "../board-surface-store.js";
import { boardKeyOf, boardRefOf, type BoardRef } from "../board-surface-contracts.js";
import { useBoardLiveOverlayStore } from "../board-live-overlay.js";
import { boardSpec, hydratedRow, FIXTURE_FETCHED_AT } from "./boardFixture.js";

/* ------------------------------------------------------------------ */
/* Bridge doubles                                                      */
/* ------------------------------------------------------------------ */

const readDetails = vi.fn();
const readTopTraders = vi.fn();
const readMomentum = vi.fn();
const readOtherPools = vi.fn();
const readContext = vi.fn();
const readTapePoll = vi.fn();
const readBoardIcon = vi.fn();

function detailsBundle(
  overrides: Partial<BoardDetailsBundle> = {},
): BoardDetailsBundle {
  return {
    subject: { chain: "base", pairAddress: "0xaaa111" },
    baseTokenAddress: "0xtoken",
    baseTokenSymbol: "PEPE",
    holders: { count: 982, source: "goplus", shareUnit: "fraction" },
    liquidityLocks: {
      lockedPct: { raw: "99.99", normalizedPct: 99.99, unit: "percent" },
      rows: [{ tag: "Burned", share: { raw: "99.99", normalizedPct: 99.99, unit: "percent" } }],
    },
    safety: {
      coverage: { state: "complete", presentBlocks: ["security"], absentBlocks: [] },
      goplus: null,
      quickintel: null,
      tokenAuthority: null,
      conflicts: [],
    },
    auditedTokenCheck: {
      auditedTokenAddress: "0xtoken",
      auditedTokenSymbol: "PEPE",
      addressesAgree: true,
      symbolsAgree: true,
      mismatch: false,
    },
    providerWindow: { cacheMaxAgeSeconds: 60, cacheAgeSeconds: 1 },
    fetchedAtMs: FIXTURE_FETCHED_AT,
    expiresAtMs: FIXTURE_FETCHED_AT + 60_000,
    metaIds: [],
    ...overrides,
  };
}

function okDetails(bundle = detailsBundle()) {
  return {
    ok: true as const,
    data: {
      subject: bundle.subject,
      outcome: { kind: "details" as const, bundle },
    },
  };
}

const SUBJECT = { chain: "base", pairAddress: "0xaaa111" };

function okTraders(rows: unknown[] = []) {
  return {
    ok: true as const,
    data: {
      subject: SUBJECT,
      outcome: {
        kind: "traders" as const,
        rows,
        rowsAvailable: rows.length,
        lookbackDays: 30,
        windowLabel: "30-day pair-local cash flow",
        semanticsNote:
          "One pool only. Transfers and other venues are invisible to the venue.",
        fetchedAtMs: FIXTURE_FETCHED_AT,
      },
    },
  };
}

function momentumRow(window: "m5" | "h1" | "h6" | "h24", hours: number) {
  return {
    window,
    hours,
    volumeUsd: 1000 * hours,
    volumeBuyUsd: 600 * hours,
    volumeSellUsd: 400 * hours,
    buys: 60,
    sells: 40,
    priceChangePct: 5,
    volumeUsdPerHour: 1000,
    tradesPerHour: 100,
    buySharePct: 60,
  };
}

function okMomentum() {
  return {
    ok: true as const,
    data: {
      subject: SUBJECT,
      outcome: {
        kind: "momentum" as const,
        rows: [
          momentumRow("m5", 1 / 12),
          momentumRow("h1", 1),
          momentumRow("h6", 6),
          momentumRow("h24", 24),
        ],
        fetchedAtMs: FIXTURE_FETCHED_AT,
      },
    },
  };
}

function okOtherPools(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      subject: SUBJECT,
      outcome: {
        kind: "other-pools" as const,
        pools: [
          {
            chain: "base",
            pairAddress: "0xbbb222",
            dexId: "aerodrome",
            quoteTokenSymbol: "WETH",
            liquidityUsd: 41_000,
            volumeH24Usd: 9_000,
          },
        ],
        poolsSeen: 3,
        providerCapped: false,
        unrelatedRowsDropped: 0,
        withheldByLimit: 0,
        windowNote: "Seen inside a bounded relevance window, not a full census.",
        fetchedAtMs: FIXTURE_FETCHED_AT,
        ...overrides,
      },
    },
  };
}

function okContext(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      subject: SUBJECT,
      outcome: {
        kind: "context" as const,
        boostsActive: 10,
        promotionNote: "Bought visibility is not demand.",
        narratives: [{ id: "n1", name: "AI agents", slug: "ai-agents" }],
        unjoinedMetaIds: [],
        fetchedAtMs: FIXTURE_FETCHED_AT,
        ...overrides,
      },
    },
  };
}

function tapeRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    side: "buy" as const,
    blockNumber: 100,
    timestampMs: Date.UTC(2026, 7, 26, 11, 11, 9),
    volumeUsd: "1234.50",
    amountBase: "1000",
    priceUsd: "0.0000897",
    maker: "0xmaker000000000000000000000000000000000001",
    gapBefore: false,
    ...overrides,
  };
}

function okTape(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    data: {
      subject: SUBJECT,
      outcome: {
        kind: "tape" as const,
        rows: [tapeRow("100:1:0")],
        watermark: 100,
        appended: 1,
        droppedIncompleteIdentity: 0,
        pagesFetched: 1,
        gapBefore: false,
        fetchedAtMs: FIXTURE_FETCHED_AT,
        ...overrides,
      },
    },
  };
}

function unavailable(reason: string) {
  return {
    ok: true as const,
    data: { subject: SUBJECT, outcome: { kind: "unavailable" as const, reason } },
  };
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

function boardRef(analysis: string | null = null): BoardRef {
  return boardRefOf(
    "session-1",
    12,
    boardSpec({
      pools: [{ chain: "base", pairAddress: "0xaaa111", analysis }],
      rows: [hydratedRow({ txns: { buys: 620, sells: 380 } })],
    }),
  );
}

function mountSpotlight(
  board: BoardRef,
  chartSlot?: Parameters<typeof BoardSpotlight>[0]["chartSlot"],
): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }): ReactNode => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(
    <BoardSpotlight board={board} poolIndex={0} chartSlot={chartSlot} />,
    { wrapper },
  );
}

function bindStore(board: BoardRef, overrides: Record<string, unknown> = {}): void {
  useBoardSurfaceStore.setState({
    latestBoard: board,
    pinnedBoard: null,
    modalBoard: board,
    unseenBoardKey: null,
    surfaceKey: boardKeyOf(board),
    view: "spotlight",
    selectedPoolIndex: 0,
    filter: BOARD_FILTER_NONE,
    scrollTop: 0,
    askPanelOpen: false,
    liveRequested: false,
    modalGeneration: 0,
    spotlightGeneration: 0,
    ...overrides,
  });
}

/** Publish the lease overlay the header would publish while live. */
function publishLive(board: BoardRef, fetchedAtMs: number | null): void {
  useBoardLiveOverlayStore.setState({
    published: {
      boardKey: boardKeyOf(board),
      mode: "live-connected",
      rowsByKey: null,
      fetchedAtMs,
      notice: null,
      canToggle: true,
    },
  });
}

/** Let the mounted effects issue their first reads and settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** One scripted promise as the abortable invocation the bridge now returns. */
function abortable<T>(promise: Promise<T>): {
  readonly promise: Promise<T>;
  readonly cancel: () => void;
} {
  return { promise, cancel: vi.fn() };
}

beforeEach(() => {
  useBoardLiveOverlayStore.setState({ published: null });
  for (const fn of [
    readDetails,
    readTopTraders,
    readMomentum,
    readOtherPools,
    readContext,
    readTapePoll,
    readBoardIcon,
  ]) {
    fn.mockReset();
  }
  readDetails.mockResolvedValue(okDetails());
  readTopTraders.mockResolvedValue(okTraders([]));
  readMomentum.mockResolvedValue(okMomentum());
  readOtherPools.mockResolvedValue(okOtherPools());
  readContext.mockResolvedValue(okContext());
  readTapePoll.mockResolvedValue(okTape());
  readBoardIcon.mockResolvedValue({
    ok: true,
    data: { iconId: "abcd1234", icon: { kind: "not_found" } },
  });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      boardIcons: { read: readBoardIcon },
      boardDetails: {
        // The bridge returns an ABORTABLE invocation; the scripted promise is
        // wrapped so every scenario keeps scripting plain outcomes.
        read: (input: unknown) => abortable(readDetails(input)),
        prefetch: vi.fn(),
      },
      // ABORTABLE, exactly like `boardDetails.read` above and for the same
      // reason: a cut must reach main's own provider read, not merely stop
      // this side listening. Wrapped here so every scenario below goes on
      // scripting plain outcomes.
      boardSpotlight: {
        topTraders: (input: unknown) => abortable(readTopTraders(input)),
        momentum: (input: unknown) => abortable(readMomentum(input)),
        otherPools: (input: unknown) => abortable(readOtherPools(input)),
        context: (input: unknown) => abortable(readContext(input)),
        tapePoll: (input: unknown) => abortable(readTapePoll(input)),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

/* ------------------------------------------------------------------ */
/* 1. Every element of the mockup                                      */
/* ------------------------------------------------------------------ */

describe("the mockup's elements", () => {
  it("renders the breadcrumb, the hero and the stat panel", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();

    const back = document.querySelector('[data-vex-area="board-spotlight-back"]');
    expect(back?.textContent).toContain("All tokens");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-pill"]')?.textContent,
    ).toBe("Spotlight");

    expect(
      document.querySelector('[data-vex-area="board-spotlight-photo"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-name"]')?.textContent,
    ).toBe("Pepe the Frog");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-ticker"]')?.textContent,
    ).toBe("PEPE");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-chain"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-price"]')?.textContent,
    ).toContain("0.00000123");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-delta"]')?.textContent,
    ).toContain("113");

    // Five icon rows, in the mockup's order, Holders included.
    const stats = [
      ...document.querySelectorAll('[data-vex-area="board-spotlight-stat"]'),
    ].map((node) => node.getAttribute("data-label"));
    expect(stats).toEqual([
      "Liquidity",
      "24h Volume",
      "Trades",
      "Pair age",
      "Holders",
    ]);
    expect(screen.getByText("982")).toBeTruthy();
  });

  it("renders the three factual sections with their figures", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();

    const buySell = document.querySelector('[data-vex-area="board-spotlight-buysell"]');
    expect(buySell).not.toBeNull();
    expect(
      document
        .querySelector('[data-vex-area="board-spotlight-buysell-bar"]')
        ?.getAttribute("data-buy-pct"),
    ).toBe("62");
    const figures = document.querySelector(
      '[data-vex-area="board-spotlight-buysell-figures"]',
    );
    expect(figures?.textContent).toContain("62%");
    expect(figures?.textContent).toContain("38%");

    expect(
      document.querySelector('[data-vex-area="board-spotlight-lock-value"]')
        ?.textContent,
    ).toBe("Locked 99.99% - Burned");

    expect(
      document.querySelector('[data-vex-area="board-spotlight-safety"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-vex-area="board-status-chip"]')).not.toBeNull();
  });

  it("renders the Spotlight control as a PRESSED button that returns to the grid", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const toggle = document.querySelector('[data-vex-area="board-spotlight-toggle"]');
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("aria-pressed")).toBe("true");
    expect(toggle?.querySelector("svg")).not.toBeNull();
    await act(async () => {
      (toggle as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(useBoardSurfaceStore.getState().view).toBe("grid");
  });

  it("links every token to its own DexScreener page, built from the board's slug and pair", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const link = document.querySelector(
      '[data-vex-area="board-spotlight-hero"] [data-vex-area="board-token-dexscreener-link"]',
    );
    expect(link?.getAttribute("href")).toBe("https://dexscreener.com/base/0xaaa111");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says a token has no published image only once the read settled absent", async () => {
    const board = boardRefOf(
      "session-1",
      12,
      boardSpec({
        pools: [{ chain: "base", pairAddress: "0xaaa111", analysis: null }],
        rows: [hydratedRow({ iconId: "abcd1234" })],
      }),
    );
    bindStore(board);
    readBoardIcon.mockReturnValue(new Promise(() => undefined));
    mountSpotlight(board);
    await settle();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-photo"]')?.getAttribute("data-state"),
    ).toBe("loading");
    expect(document.querySelector('[data-vex-area="board-spotlight-no-image"]')).toBeNull();

    cleanup();
    readBoardIcon.mockResolvedValue({
      ok: true,
      data: { iconId: "abcd1234", icon: { kind: "not_found" } },
    });
    mountSpotlight(board);
    await settle();
    await waitFor(() => {
      expect(
        document.querySelector('[data-vex-area="board-spotlight-photo"]')?.getAttribute("data-state"),
      ).toBe("monogram");
    });
    expect(
      document.querySelector('[data-vex-area="board-spotlight-no-image"]')?.textContent,
    ).toBe("No image published on DexScreener yet");
    // ONE letter, the provider's own treatment.
    expect(
      document.querySelector('[data-vex-area="board-spotlight-photo"]')?.textContent,
    ).toBe("P");
  });

  it("renders the provider's description whole under the identity, and nothing when absent", async () => {
    const long = "A".repeat(900) + "\nsecond paragraph";
    const board = boardRefOf(
      "session-1",
      12,
      boardSpec({
        pools: [{ chain: "base", pairAddress: "0xaaa111", analysis: null }],
        rows: [hydratedRow({ description: long })],
      }),
    );
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const description = document.querySelector('[data-vex-area="board-spotlight-description"]');
    expect(description?.textContent).toBe(long);
    expect(description?.className).toContain("whitespace-pre-line");
    expect(description?.className).not.toContain("truncate");

    cleanup();
    mountSpotlight(boardRef());
    await settle();
    expect(document.querySelector('[data-vex-area="board-spotlight-description"]')).toBeNull();
  });

  it("puts every section icon in a bare slot, never on a filled disc", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const icons = [
      ...document.querySelectorAll('[data-vex-area="board-spotlight-section-icon"]'),
    ];
    expect(icons.length).toBeGreaterThanOrEqual(8);
    for (const icon of icons) {
      expect(icon.className).not.toMatch(/rounded-full|border|bg-/);
      expect(icon.parentElement?.className).not.toContain("rounded-full");
    }
  });

  it("draws no bordered child inside any section body", async () => {
    readTopTraders.mockResolvedValue(
      okTraders([
        {
          maker: "0xwallet1",
          label: null,
          buys: 12,
          sells: 3,
          boughtUsd: 41_000,
          soldUsd: 12_000,
          netCashFlowUsd: -29_000,
          providerRank: 1,
        },
      ]),
    );
    const board = boardRef("One observation");
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const sections = [
      ...document.querySelectorAll('[data-vex-area="board-spotlight"] section[data-vex-area]'),
    ];
    expect(sections.length).toBeGreaterThanOrEqual(8);
    for (const section of sections) {
      // The body is everything after the header row. A hairline (`border-b`,
      // `border-l`, `divide-`) is allowed; a boxed child (`rounded-*` with a
      // `border` or a fill) is the card-in-card this layout forbids.
      const body = [...section.children].slice(1);
      for (const child of body) {
        for (const node of [child, ...child.querySelectorAll("*")]) {
          const cls = node.className;
          if (typeof cls !== "string") continue;
          const boxed = /\brounded-(?:lg|xl|2xl)\b/.test(cls) && /\bborder\b/.test(cls);
          expect(boxed, `${section.getAttribute("data-vex-area") ?? ""}: ${cls}`).toBe(false);
        }
      }
    }
  });

  it("mounts the chart into its slot, and says so honestly when there is none", async () => {
    const board = boardRef();
    bindStore(board);
    const seen: unknown[] = [];
    const Chart: NonNullable<Parameters<typeof BoardSpotlight>[0]["chartSlot"]> = (props) => {
      seen.push(props);
      return <div data-vex-area="test-chart" />;
    };
    mountSpotlight(board, Chart);
    await settle();
    expect(document.querySelector('[data-vex-area="test-chart"]')).not.toBeNull();
    expect(seen[0]).toMatchObject({
      subject: { chain: "base", pairAddress: "0xaaa111" },
      live: false,
    });

    cleanup();
    mountSpotlight(board);
    await settle();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-chart-absent"]')
        ?.textContent,
    ).toContain("No chart source");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Freshness, and where "updated now" may come from                 */
/* ------------------------------------------------------------------ */

describe("the freshness line", () => {
  it("prints the absolute UTC clock while the board is a snapshot", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const line = document.querySelector('[data-vex-area="board-spotlight-freshness"]');
    expect(line?.getAttribute("data-live")).toBe("false");
    expect(line?.textContent).toMatch(/^as of \d{2}:\d{2} UTC$/);
  });

  it("says 'updated now' only once a live fetch has actually landed", async () => {
    const board = boardRef();
    bindStore(board);
    // The lease is connected but no tick has landed yet: the toggle is not
    // evidence of freshness, so the surface still shows the absolute clock.
    publishLive(board, null);
    mountSpotlight(board);
    await settle();
    expect(
      document
        .querySelector('[data-vex-area="board-spotlight-freshness"]')
        ?.getAttribute("data-live"),
    ).toBe("false");

    await act(async () => {
      publishLive(board, FIXTURE_FETCHED_AT);
      await Promise.resolve();
    });
    const line = document.querySelector('[data-vex-area="board-spotlight-freshness"]');
    expect(line?.getAttribute("data-live")).toBe("true");
    expect(line?.textContent).toContain("updated now");
  });
});

/* ------------------------------------------------------------------ */
/* 3. The lock's designed states                                       */
/* ------------------------------------------------------------------ */

describe("liquidity lock states", () => {
  it("prints words, and no bar, for an unverified share", async () => {
    readDetails.mockResolvedValue(
      okDetails(
        detailsBundle({
          liquidityLocks: {
            lockedPct: { raw: "0.89", normalizedPct: 89, unit: "unverified" },
            rows: [],
          },
        }),
      ),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const value = document.querySelector('[data-vex-area="board-spotlight-lock-value"]');
    expect(value?.textContent).toBe("n/a - unverified");
    expect(value?.getAttribute("data-state")).toBe("unverified");
    expect(document.querySelector('[data-vex-area="board-spotlight-lock-bar"]')).toBeNull();
  });

  it("keeps the card and names the absence on a chain with no lock index", async () => {
    readDetails.mockResolvedValue(
      okDetails(detailsBundle({ liquidityLocks: null })),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-lock"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-lock-value"]')
        ?.textContent,
    ).toBe("No lock index on this chain");
  });

  it("shows the pending register rather than a dash while the read is in flight", () => {
    readDetails.mockReturnValue(new Promise(() => undefined));
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    expect(
      document
        .querySelector('[data-vex-area="board-spotlight-lock-value"]')
        ?.getAttribute("data-state"),
    ).toBe("pending");
  });
});

/* ------------------------------------------------------------------ */
/* 4. The assessment                                                   */
/* ------------------------------------------------------------------ */

describe("the model's assessment", () => {
  it("renders every fragment, whole, with the composition clock", async () => {
    const board = boardRef(
      "Price is up on thin liquidity · LP is burned · Holders are concentrated",
    );
    bindStore(board);
    mountSpotlight(board);
    await settle();

    const section = document.querySelector(
      '[data-vex-area="board-spotlight-assessment"]',
    );
    expect(section?.getAttribute("data-state")).toBe("present");
    const fragments = [
      ...document.querySelectorAll(
        '[data-vex-area="board-spotlight-assessment-fragment"]',
      ),
    ].map((node) => node.textContent);
    expect(fragments).toEqual([
      "Price is up on thin liquidity",
      "LP is burned",
      "Holders are concentrated",
    ]);
    expect(section?.textContent).toMatch(/composed \d{2}:\d{2} UTC/);

    // The assessment text occurs EXACTLY ONCE in the spotlight DOM: no lead
    // under the safety chip, no second copy anywhere.
    const whole = document.querySelector('[data-vex-area="board-spotlight"]')?.textContent ?? "";
    expect(whole.split("Price is up on thin liquidity")).toHaveLength(2);
    expect(document.querySelector('[data-vex-area="board-spotlight-safety-lead"]')).toBeNull();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-safety"]')?.textContent,
    ).not.toContain("Price is up");

    // Every fragment at the PRIMARY register, whole, no cap.
    for (const node of document.querySelectorAll(
      '[data-vex-area="board-spotlight-assessment-fragment"]',
    )) {
      expect(node.className).toContain("text-ink-primary");
      expect(node.className).not.toContain("truncate");
    }
    // Ask VEX is the assessment's own header action.
    expect(section?.querySelector('[data-vex-area="board-spotlight-ask"]')).not.toBeNull();
  });

  it("renders a very long assessment whole, with no character cap", async () => {
    const long = "L".repeat(3000);
    const board = boardRef(long);
    bindStore(board);
    mountSpotlight(board);
    await settle();
    expect(
      document.querySelector('[data-vex-area="board-spotlight-assessment-fragment"]')
        ?.textContent,
    ).toBe(long);
  });

  it("places the assessment BEFORE Buy / Sell in DOM order", async () => {
    const board = boardRef("One observation");
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const assessment = document.querySelector('[data-vex-area="board-spotlight-assessment"]');
    const buySell = document.querySelector('[data-vex-area="board-spotlight-buysell"]');
    if (assessment === null || buySell === null) {
      throw new Error("assessment or buy/sell section did not render");
    }
    expect(
      assessment.compareDocumentPosition(buySell) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the section and says so when a board carries no assessment", async () => {
    const board = boardRef(null);
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const section = document.querySelector(
      '[data-vex-area="board-spotlight-assessment"]',
    );
    expect(section?.getAttribute("data-state")).toBe("absent");
    expect(section?.textContent).toContain("No saved analysis");
    // And the safety section says nothing about it: it is facts only.
    expect(
      document.querySelector('[data-vex-area="board-spotlight-safety"]')?.textContent,
    ).not.toContain("No saved analysis");
  });
});

/* ------------------------------------------------------------------ */
/* 4b. Safety checks: rows, never prose                                */
/* ------------------------------------------------------------------ */

describe("the safety checks section", () => {
  it("lists every check row with its source and verdict, unanswered ones included", async () => {
    readDetails.mockResolvedValue(
      okDetails(
        detailsBundle({
          safety: {
            coverage: { state: "complete", presentBlocks: ["security"], absentBlocks: [] },
            goplus: null,
            quickintel: {
              contractVerified: true,
              isScam: false,
              isHoneypot: null,
              isProxy: null,
              hiddenOwner: null,
              canMint: null,
              canBlacklist: null,
              canPauseTrading: null,
              hasFeeWarning: null,
              hasExternalContractRisk: null,
              hasGeneralVulnerabilities: null,
              hasObfuscatedAddressRisk: null,
              buyTaxPct: null,
              sellTaxPct: null,
              transferTaxPct: null,
              lpBurnedPct: null,
            },
            tokenAuthority: null,
            conflicts: [],
          },
        }),
      ),
    );
    const board = boardRef("Model prose that must not appear under Safety");
    bindStore(board);
    mountSpotlight(board);
    await settle();

    const rows = [
      ...document.querySelectorAll('[data-vex-area="board-spotlight-safety-row"]'),
    ];
    const summary = rows.map((row) => [
      row.getAttribute("data-check"),
      row.getAttribute("data-verdict"),
      row.getAttribute("data-answered"),
      row.querySelector('[data-vex-area="board-spotlight-safety-source"]')?.textContent,
    ]);
    // The projection's own order (quickintel: isScam before contractVerified),
    // then the required check nobody answered as a row, never an omission.
    expect(summary).toEqual([
      ["isScam", "pass", "true", "quickintel"],
      ["contractVerified", "pass", "true", "quickintel"],
      ["isHoneypot", "unverified", "false", "not answered"],
    ]);
    expect(rows[1]?.textContent).toContain("Contract verified");
    expect(rows[1]?.textContent).toContain("Pass");
    expect(rows[2]?.textContent).toContain("Honeypot");
    expect(rows[2]?.textContent).toContain("Unverified");

    const safety = document.querySelector('[data-vex-area="board-spotlight-safety"]');
    expect(safety?.textContent).not.toContain("Model prose");
    expect(safety?.querySelector('[data-vex-area="board-status-chip"]')).not.toBeNull();
  });

  it("shows the pending register while the details read is in flight", () => {
    readDetails.mockReturnValue(new Promise(() => undefined));
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    expect(
      document
        .querySelector('[data-vex-area="board-spotlight-safety"] [data-state="pending"]'),
    ).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 5. SPOTLIGHT+ sections, and their three states                      */
/* ------------------------------------------------------------------ */

const SECTIONS = [
  "board-spotlight-smart-money",
  "board-spotlight-tape",
  "board-spotlight-momentum",
  "board-spotlight-promotion",
  "board-spotlight-other-pools",
] as const;

describe("the SPOTLIGHT+ sections", () => {
  it("all five are present with their data", async () => {
    readTopTraders.mockResolvedValue(
      okTraders([
        {
          maker: "0xwallet1",
          label: null,
          buys: 12,
          sells: 3,
          boughtUsd: 41_000,
          soldUsd: 12_000,
          netCashFlowUsd: -29_000,
          providerRank: 1,
        },
      ]),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();

    for (const area of SECTIONS) {
      expect(document.querySelector(`[data-vex-area="${area}"]`)).not.toBeNull();
    }

    // Smart money is LABELLED for what it measures, and its caveat is shown.
    const smart = document.querySelector('[data-vex-area="board-spotlight-smart-money"]');
    expect(smart?.textContent).toContain("30-day pair-local cash flow");
    expect(smart?.textContent).toContain("Transfers and other venues are invisible");
    expect(
      document.querySelectorAll('[data-vex-area="board-spotlight-trader"]'),
    ).toHaveLength(1);
    expect(
      document.querySelector('[data-vex-area="board-spotlight-smart-money-window"]')
        ?.textContent,
    ).toBe("30-day pair-local cash flow");

    // Momentum shows all four windows on one axis.
    const windows = [
      ...document.querySelectorAll('[data-vex-area="board-spotlight-momentum-window"]'),
    ].map((node) => node.getAttribute("data-window"));
    expect(windows).toEqual(["m5", "h1", "h6", "h24"]);

    // Promotion reads the pair row's boosts and shows the narrative chip.
    expect(
      document.querySelector('[data-vex-area="board-spotlight-boosts"]')?.textContent,
    ).toBe("10 boosts active");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-narratives"]')
        ?.textContent,
    ).toContain("AI agents");

    // Other pools says "seen", never "all".
    expect(
      document.querySelector('[data-vex-area="board-spotlight-other-pools-count"]')
        ?.textContent,
    ).toBe("3 other pools seen");
  });

  it("smart money renders EVERY ranked row, never a cut of five", async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      maker: `0xwallet${String(index)}`,
      label: null,
      buys: 1,
      sells: 1,
      boughtUsd: 1000 + index,
      soldUsd: 500,
      netCashFlowUsd: 500 + index,
      providerRank: index + 1,
    }));
    readTopTraders.mockResolvedValue(okTraders(rows));
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    expect(
      document.querySelectorAll('[data-vex-area="board-spotlight-trader"]'),
    ).toHaveLength(12);
    const list = document.querySelector('[data-vex-area="board-spotlight-traders"]');
    expect(list?.getAttribute("data-count")).toBe("12");
    // The list scrolls inside a capped surface rather than cutting rows.
    expect(list?.className).toContain("overflow-y-auto");
    expect(list?.className).toContain("max-h-");
  });

  it("every section has a pending state before its read lands", () => {
    for (const fn of [readTopTraders, readMomentum, readOtherPools, readContext, readTapePoll]) {
      fn.mockReturnValue(new Promise(() => undefined));
    }
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    for (const area of SECTIONS) {
      const section = document.querySelector(`[data-vex-area="${area}"]`);
      expect(
        section?.querySelector('[data-state="pending"]'),
        `${area} has no pending state`,
      ).not.toBeNull();
    }
  });

  it("every section keeps its card and names the absence when a read fails", async () => {
    readTopTraders.mockResolvedValue(unavailable("transport"));
    readMomentum.mockResolvedValue(unavailable("provider"));
    readOtherPools.mockResolvedValue(unavailable("busy"));
    readContext.mockResolvedValue(unavailable("not_mounted"));
    // Not `cancelled`: the channel treats a cancel by another caller as a
    // non-result (it keeps the previous read and re-issues once), so the
    // settled absence is what puts a sentence on screen.
    readTapePoll.mockResolvedValue(unavailable("unknown_pair"));
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();

    for (const area of SECTIONS) {
      const section = document.querySelector(`[data-vex-area="${area}"]`);
      const unavailableNode = section?.querySelector('[data-state="unavailable"]');
      expect(unavailableNode, `${area} dropped out of the layout`).not.toBeNull();
      expect(unavailableNode?.textContent?.length ?? 0).toBeGreaterThan(0);
    }
    expect(
      document.querySelector('[data-vex-area="board-spotlight-momentum"]')?.textContent,
    ).toContain("The provider did not answer");
  });

  it("renders an empty narrative list and a not-reported boost count as states", async () => {
    readContext.mockResolvedValue(
      okContext({ boostsActive: null, narratives: [], unjoinedMetaIds: ["m1"] }),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const boosts = document.querySelector('[data-vex-area="board-spotlight-boosts"]');
    expect(boosts?.getAttribute("data-state")).toBe("not-reported");
    expect(boosts?.textContent).toBe("Boosts not reported for this pair");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-narratives"]')
        ?.textContent,
    ).toContain("No narrative is recorded");
  });

  it("states the provider's own bound rather than implying a census", async () => {
    readOtherPools.mockResolvedValue(
      okOtherPools({ providerCapped: true, withheldByLimit: 4 }),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const bounds = document.querySelector(
      '[data-vex-area="board-spotlight-other-pools-bounds"]',
    );
    expect(bounds?.textContent).toContain("window was full");
    expect(bounds?.textContent).toContain("4 seen pools are not listed");
  });
});

/* ------------------------------------------------------------------ */
/* 6. The tape                                                         */
/* ------------------------------------------------------------------ */

describe("the tape", () => {
  it("renders the gap marker and the refusal count rather than hiding either", async () => {
    readTapePoll.mockResolvedValue(
      okTape({
        rows: [tapeRow("100:1:0", { gapBefore: true }), tapeRow("100:2:0")],
        droppedIncompleteIdentity: 2,
        gapBefore: true,
      }),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();

    expect(
      document.querySelector('[data-vex-area="board-spotlight-tape-gap"]')?.textContent,
    ).toContain("could not be read");
    expect(
      document.querySelector('[data-vex-area="board-spotlight-tape-dropped"]')
        ?.textContent,
    ).toContain("2 rows were refused");
  });

  it("prints the whole maker address rather than a cut one", async () => {
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();
    const row = document.querySelector('[data-vex-area="board-spotlight-tape-row"]');
    const maker = within(row as HTMLElement).getByTitle(
      "0xmaker000000000000000000000000000000000001",
    );
    expect(maker.textContent).toBe("0xmaker000000000000000000000000000000000001");
  });

  it("asks main to forget the previous visit's ring on the first poll only", async () => {
    vi.useFakeTimers();
    const board = boardRef();
    bindStore(board);
    publishLive(board, FIXTURE_FETCHED_AT);
    mountSpotlight(board);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readTapePoll.mock.calls[0]?.[0]).toMatchObject({ reset: true });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readTapePoll.mock.calls.length).toBeGreaterThan(1);
    expect(readTapePoll.mock.calls[1]?.[0]).toMatchObject({ reset: false });
  });

  it("freezes the ring while the reader is hovering it, and spends no request", async () => {
    vi.useFakeTimers();
    const board = boardRef();
    bindStore(board);
    publishLive(board, FIXTURE_FETCHED_AT);
    mountSpotlight(board);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const beforeHover = readTapePoll.mock.calls.length;

    const tape = document.querySelector('[data-vex-area="board-spotlight-tape"]')
      ?.parentElement as HTMLElement;
    await act(async () => {
      tape.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(readTapePoll.mock.calls.length).toBe(beforeHover);
    expect(
      document
        .querySelector('[data-vex-area="board-spotlight-tape-state"]')
        ?.getAttribute("data-paused"),
    ).toBe("true");
  });
});

/* ------------------------------------------------------------------ */
/* 7. Lifecycle: the three cuts                                        */
/* ------------------------------------------------------------------ */

describe("the cuts", () => {
  it("polls while live and stops the moment the reader leaves the spotlight", async () => {
    vi.useFakeTimers();
    const board = boardRef();
    bindStore(board, { liveRequested: true });
    publishLive(board, FIXTURE_FETCHED_AT);
    mountSpotlight(board);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    const polled = readTapePoll.mock.calls.length;
    expect(polled).toBeGreaterThan(1);

    await act(async () => {
      useBoardSurfaceStore.getState().setBoardView("grid");
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(readTapePoll.mock.calls.length).toBe(polled);
  });

  it("stops polling when the lease goes away, without unmounting", async () => {
    vi.useFakeTimers();
    const board = boardRef();
    bindStore(board, { liveRequested: true });
    publishLive(board, FIXTURE_FETCHED_AT);
    mountSpotlight(board);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const polled = readTapePoll.mock.calls.length;

    await act(async () => {
      // What the store's own `setBoardLive(false)` produces: the generations
      // are bumped, the registry runs, and the holder publishes a snapshot.
      useBoardSurfaceStore.getState().setBoardLive(false);
      useBoardLiveOverlayStore.setState({ published: null });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(readTapePoll.mock.calls.length).toBe(polled);
    // The surface is still there: a cut feed is not a cleared screen.
    expect(document.querySelector('[data-vex-area="board-spotlight"]')).not.toBeNull();
  });

  it("registers a disposer per channel and returns to baseline on unmount", async () => {
    const board = boardRef();
    bindStore(board);
    const view = mountSpotlight(board);
    await settle();
    expect(countBoardSurfaceTeardowns("spotlight")).toBeGreaterThanOrEqual(6);

    view.unmount();
    expect(countBoardSurfaceTeardowns("spotlight")).toBe(0);
  });

  it("drops an answer that lands after the surface moved on", async () => {
    let settleDetails: ((value: unknown) => void) | null = null;
    readDetails.mockReturnValue(
      new Promise((resolve) => {
        settleDetails = resolve;
      }),
    );
    const board = boardRef();
    bindStore(board);
    mountSpotlight(board);
    await settle();

    await act(async () => {
      useBoardSurfaceStore.getState().setBoardView("grid");
      await Promise.resolve();
    });
    await act(async () => {
      settleDetails?.(okDetails());
      await Promise.resolve();
    });
    // The generation moved, so the late answer was refused: the holders row
    // never leaves its pending register.
    expect(screen.queryByText("982")).toBeNull();
  });
});
