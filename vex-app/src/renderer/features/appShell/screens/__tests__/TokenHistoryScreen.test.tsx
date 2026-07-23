/**
 * TokenHistoryScreen — the per-token Vex-recorded activity screen (eye
 * trigger on Balances / All-assets rows).
 *
 * Pins (screen-states matrix from the harness plan):
 *   - `shellRoute: tokenHistory` mounts through ShellScreens as a modal
 *     dialog named "<display name> history" with the header identity cluster
 *     (name + chain) and the honest "Vex-recorded activity" disclosure —
 *     and NO serif H1 (the chrome's `header` slot replaces it);
 *   - available entries render: LABEL from raw `productType` (fallback:
 *     the entry `kind`), `in → out` legs with policy-gated symbols, a
 *     HUMAN-provenance quantity printed while an UNKNOWN-provenance one
 *     keeps the em dash (never a blind wei-scale format), a USD primary
 *     figure + unit price, venue/chain meta, and an explorer link BUILT
 *     from `{chainId, ref}` via shared/explorer-links (chainId 0 / unknown
 *     chain → NO link);
 *   - the USD primary figure carries `usdProvenance` (Codex final review
 *     round 2 finding 7 / contract C35): `"estimated"` renders with an
 *     explicit `~ … est.` marker, `"recorded"` renders bare — never a
 *     bare-execution-USD read on a quote-time estimate;
 *   - status "unavailable" (query timeout) renders the calm try-again note
 *     and NEVER the empty-history copy;
 *   - empty available history renders the quiet "No Vex-recorded history"
 *     invitation;
 *   - an `agent_activity`-sourced swap entry's pending/failed status renders
 *     a status chip (Agent Scan §4.7); `null`/`"confirmed"` renders none;
 *   - Load more appears on hasNextPage, fires fetchNextPage, and appended
 *     pages' entries render;
 *   - Escape/close returns to `returnTo`: "shell" → none, "assets" → the
 *     assets route remounted with a NULL origin (no stale morph rect).
 *
 * `useTokenHistoryInfinite` is mocked — this suite owns display rules, not
 * query wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  TokenHistoryDto,
  TokenHistoryEntry,
} from "@shared/schemas/token-history.js";
import type { Result } from "@shared/ipc/result.js";
import { useUiStore, type ShellRoute } from "../../../../stores/uiStore.js";

vi.mock("@hugeicons/react", () => ({
  HugeiconsIcon: () => null,
}));
vi.mock("@hugeicons/core-free-icons", () => ({
  Cancel01Icon: "Cancel01Icon",
  ViewIcon: "ViewIcon",
  ArrowUpRight01Icon: "ArrowUpRight01Icon",
  ArrowDataTransferHorizontalIcon: "ArrowDataTransferHorizontalIcon",
  BridgeIcon: "BridgeIcon",
  CoinsSwapIcon: "CoinsSwapIcon",
}));

vi.mock("@thesvg/react", () => ({
  Bitcoin: () => null,
  Bnb: () => null,
  BnbChain: () => null,
  Chainlink: () => null,
  Circle: () => null,
  DaiStablecoin: () => null,
  Ethereum: () => null,
  Optimism: () => null,
  Polygon: () => null,
  Robinhood: () => null,
  Solana: () => null,
  Tether: () => null,
  Usdc: () => null,
}));

// Sibling screens pull heavy registers; only the token-history branch is
// under test (the assets-return route pin asserts STORE state, not the
// remounted assets dialog — AssetsScreen.test owns that side).
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
// Phase 2b: SettingsScreen hosts the wizard step forms — a heavy module
// graph this suite's partial mocks do not cover. Own suite covers it.
vi.mock("../SettingsScreen.js", () => ({ SettingsScreen: () => null }));
vi.mock("../AssetsScreen.js", () => ({ AssetsScreen: () => null }));

const mockUseTokenHistoryInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useTokenHistoryInfinite: mockUseTokenHistoryInfinite,
}));

const { ShellScreens } = await import("../ShellScreens.js");

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TX_HASH = "0xabc123def456";

const ROUTE_TOKEN = {
  chainId: 8453,
  tokenAddress: USDC_BASE,
  symbol: "USDC",
  tokenName: "USD Coin",
} as const;

function tokenHistoryRoute(returnTo: "shell" | "assets"): ShellRoute {
  return {
    kind: "tokenHistory",
    origin: null,
    token: ROUTE_TOKEN,
    returnTo,
  };
}

function swapEntry(
  overrides: Partial<Extract<TokenHistoryEntry, { kind: "swap" }>> & {
    readonly id: string;
  },
): TokenHistoryEntry {
  return {
    kind: "swap",
    createdAt: "2026-07-01T10:21:00+00:00",
    chain: "base",
    venue: "kyberswap",
    tradeSide: "buy",
    productType: "spot_swap",
    input: {
      token: "0x1111111111111111111111111111111111111111",
      symbol: "TOKA",
      localSymbol: null,
      amount: { value: "1.5", unitProvenance: "human" },
      valueUsd: { value: "25.00", usdProvenance: "recorded" },
    },
    output: {
      token: USDC_BASE,
      symbol: "TOKB",
      localSymbol: null,
      amount: { value: "25100000", unitProvenance: "unknown" },
      valueUsd: { value: "25.10", usdProvenance: "recorded" },
    },
    unitPriceUsd: "0.52",
    captureStatus: "executed",
    status: null,
    failureCode: null,
    txRefs: [{ chainId: 8453, ref: TX_HASH }],
    ...overrides,
  };
}

function availablePage(
  entries: readonly TokenHistoryEntry[],
  options?: {
    readonly hasMore?: boolean;
  },
): Result<TokenHistoryDto> {
  return {
    ok: true,
    data: {
      status: "available",
      entries: [...entries],
      nextCursor:
        options?.hasMore === true
          ? { createdAt: "2026-07-01T10:21:00.000000Z", sourceRank: 1, sourceId: "1" }
          : null,
      hasMore: options?.hasMore === true,
    },
  };
}

const mockFetchNextPage = vi.fn();

function mockQuery(
  pages: readonly Result<TokenHistoryDto>[],
  options?: {
    readonly isLoading?: boolean;
    readonly hasNextPage?: boolean;
    readonly isFetchingNextPage?: boolean;
  },
): void {
  mockUseTokenHistoryInfinite.mockReturnValue({
    isLoading: options?.isLoading ?? false,
    isError: false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: options?.hasNextPage ?? false,
    isFetchingNextPage: options?.isFetchingNextPage ?? false,
    fetchNextPage: mockFetchNextPage,
  });
}

function mountScreen(returnTo: "shell" | "assets" = "shell"): void {
  useUiStore.setState({ shellRoute: tokenHistoryRoute(returnTo) });
  render(<ShellScreens />);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  useUiStore.setState({ shellRoute: { kind: "none" } });
});

afterEach(() => {
  cleanup();
});

describe("TokenHistoryScreen — chrome and disclosure", () => {
  it("mounts as the '<name> history' dialog with the identity cluster, the scope disclosure, and NO serif H1", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();

    const dialog = screen.getByRole("dialog", { name: "USD Coin history" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    // Identity cluster: display name + chain.
    expect(screen.getByText("USD Coin")).not.toBeNull();
    expect(screen.getByText("(Base)")).not.toBeNull();
    // Honest scope disclosure — this is Vex-recorded activity, not a chain scan.
    expect(screen.getByText(/Vex-recorded activity/)).not.toBeNull();
    expect(screen.getByText(/not locally known/)).not.toBeNull();
    // Serif NOWHERE on this screen: the chrome's serif H1 is replaced by the
    // header slot (the h1 element itself is absent).
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    // Close key still named by the title.
    expect(
      screen.getByRole("button", { name: "Close USD Coin history" }),
    ).not.toBeNull();
    // The hook received the EXACT route identity (never symbol/name).
    expect(mockUseTokenHistoryInfinite).toHaveBeenCalledWith({
      chainId: 8453,
      tokenAddress: USDC_BASE,
    });
  });

  it("routes back to `returnTo` on Escape: 'shell' closes to none", () => {
    mockQuery([availablePage([])]);
    mountScreen("shell");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({ kind: "none" });
  });

  it("routes back to `returnTo` on Escape: 'assets' remounts the assets route with a NULL origin", () => {
    mockQuery([availablePage([])]);
    mountScreen("assets");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().shellRoute).toEqual({
      kind: "assets",
      origin: null,
    });
  });
});

describe("TokenHistoryScreen — entries", () => {
  it("renders a swap row: productType label + side, legs with human quantity vs unknown-provenance em dash, USD @ unit price, venue meta, and the BUILT explorer href", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();

    // LABEL from the raw productType (uppercased) + the buy side.
    expect(screen.getByText("SPOT_SWAP · BUY")).not.toBeNull();
    // Human-provenance input quantity prints; unknown-provenance output
    // quantity keeps the em dash — never a blind base-unit format.
    expect(screen.getByText(/1\.5 TOKA/)).not.toBeNull();
    expect(screen.getByText(/— TOKB/)).not.toBeNull();
    expect(screen.queryByText(/25100000/)).toBeNull();
    // USD primary (output leads, "recorded" provenance renders bare) + unit price.
    expect(screen.getByText(/\$25\.10/)).not.toBeNull();
    expect(screen.getByText(/@ \$0\.5200/)).not.toBeNull();
    // Venue + chain meta line.
    expect(screen.getByText(/KYBERSWAP · base/)).not.toBeNull();
    // Explorer link: URL BUILT from {chainId: 8453, ref} through the shared
    // chain map — never a raw DB URL.
    const link = screen.getByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(link.getAttribute("href")).toBe(
      `https://basescan.org/tx/${TX_HASH}`,
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("falls back to the entry kind as the label when productType is null, and renders no link for unresolved chainId 0", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-2",
          productType: null,
          tradeSide: null,
          txRefs: [{ chainId: 0, ref: "0xdeadbeef" }],
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("SWAP")).not.toBeNull();
    // chainId 0 is the DB layer's "could not resolve" sentinel → NO link.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders a transfer row: TRANSFER label, human amount → truncated recipient, status meta", () => {
    mockQuery([
      availablePage([
        {
          kind: "transfer",
          id: "t-1",
          createdAt: "2026-06-20T08:00:00+00:00",
          chain: "base",
          toAddress: "0x9999888877776666555544443333222211110000",
          amount: { value: "0.25", unitProvenance: "human" },
          token: USDC_BASE,
          status: "executed",
          txRefs: [],
        },
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("TRANSFER")).not.toBeNull();
    expect(screen.getByText("0.25")).not.toBeNull();
    // Recipient address renders truncated (canonical shortener), full on title.
    expect(screen.getByText("0x9999…0000")).not.toBeNull();
    expect(screen.getByText(/base · executed/)).not.toBeNull();
  });

  it("renders a bridge row with the origin → destination chain meta", () => {
    mockQuery([
      availablePage([
        {
          kind: "bridge",
          id: "b-1",
          createdAt: "2026-06-21T08:00:00+00:00",
          originChain: "base",
          destinationChain: "arbitrum",
          venue: "relay",
          input: {
            token: null,
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "1.0", unitProvenance: "human" },
            valueUsd: { value: "10.00", usdProvenance: "recorded" },
          },
          output: {
            token: null,
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: null, unitProvenance: "unknown" },
            valueUsd: { value: null, usdProvenance: "recorded" },
          },
          captureStatus: "executed",
          txRefs: [],
          status: null,
          failureCode: null,
          providerOrderId: null,
          amountBasis: null,
          legs: [],
          lastCheckedAt: null,
        },
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("BRIDGE")).not.toBeNull();
    expect(screen.getByText(/RELAY · base → arbitrum/)).not.toBeNull();
    // No output value → input USD is the fallback primary.
    expect(screen.getByText(/\$10\.00/)).not.toBeNull();
  });

  function bridgeEntry(
    overrides: Partial<Extract<TokenHistoryEntry, { kind: "bridge" }>> & { readonly id: string },
  ): TokenHistoryEntry {
    return {
      kind: "bridge",
      createdAt: "2026-07-20T08:00:00+00:00",
      originChain: "base",
      destinationChain: "arbitrum",
      venue: "khalani",
      input: {
        token: null,
        symbol: "USDC",
        localSymbol: null,
        amount: { value: "2.0", unitProvenance: "human" },
        valueUsd: { value: "2.00", usdProvenance: "estimated" },
      },
      output: {
        token: null,
        symbol: "USDC",
        localSymbol: null,
        amount: { value: "2.0", unitProvenance: "human" },
        valueUsd: { value: "2.00", usdProvenance: "estimated" },
      },
      captureStatus: null,
      txRefs: [],
      status: null,
      failureCode: null,
      providerOrderId: "ord_1",
      amountBasis: "estimated",
      legs: [],
      // Freshly checked by default so a pending bridge reads "settling"; the
      // tracking-delay test overrides this with a long-past timestamp.
      lastCheckedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("renders a PENDING bridge with the 'settling' chip (tracked, NOT a failure)", () => {
    mockQuery([availablePage([bridgeEntry({ id: "b-p", status: "pending" })])]);
    mountScreen();
    expect(screen.getByText("settling")).not.toBeNull();
    // A pending bridge is not a failure — no destructive 'failed' chip.
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("marks an ESTIMATED bridge amount with ~ and an 'est.' tag (R14 — quoted amount never reads as executed)", () => {
    mockQuery([availablePage([bridgeEntry({ id: "b-est", status: "pending" })])]);
    mountScreen();
    // Both legs (input + output) carry the ~ estimate prefix; a single trailing
    // "est." marker labels the row's quoted amounts. The amount cell is the
    // `truncate` span whose text is "<amount> <symbol-fallback>" (the fixture's
    // token=null renders the "?" display fallback), so match by element.
    const estCells = screen.getAllByText((_, el) =>
      el instanceof HTMLElement && el.classList.contains("truncate")
      && /^~2\b/.test(el.textContent?.trim() ?? ""));
    expect(estCells.length).toBe(2);
    expect(screen.getByText("est.")).not.toBeNull();
  });

  it("renders an EXECUTED bridge amount bare — settled truth carries no estimate marker", () => {
    mockQuery([
      availablePage([
        bridgeEntry({
          id: "b-exec",
          status: "confirmed",
          amountBasis: "executed",
        }),
      ]),
    ]);
    mountScreen();
    const bareCells = screen.getAllByText((_, el) =>
      el instanceof HTMLElement && el.classList.contains("truncate")
      && /^2\b/.test(el.textContent?.trim() ?? ""));
    expect(bareCells.length).toBe(2);
    expect(screen.queryByText(/~2/)).toBeNull();
    expect(screen.queryByText("est.")).toBeNull();
  });

  it("reads 'tracking delayed' for a pending bridge whose sweep check is stale (R12), not the reassuring 'settling'", () => {
    mockQuery([
      availablePage([
        bridgeEntry({
          id: "b-delay",
          status: "pending",
          lastCheckedAt: "2020-01-01T00:00:00+00:00",
        }),
      ]),
    ]);
    mountScreen();
    const chip = screen.getByText("tracking delayed");
    expect(chip.getAttribute("title")).toContain("Tracking delayed");
    expect(screen.queryByText("settling")).toBeNull();
  });

  it("renders a REFUNDED bridge as 'refunded' (money returned ≠ success, distinct from 'failed')", () => {
    mockQuery([
      availablePage([bridgeEntry({ id: "b-r", status: "failed", failureCode: "bridge_refunded", amountBasis: null })]),
    ]);
    mountScreen();
    expect(screen.getByText("refunded")).not.toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
  });

  it("renders a non-refund failed bridge as 'failed'", () => {
    mockQuery([
      availablePage([bridgeEntry({ id: "b-f", status: "failed", failureCode: "bridge_failed", amountBasis: null })]),
    ]);
    mountScreen();
    expect(screen.getByText("failed")).not.toBeNull();
    expect(screen.queryByText("refunded")).toBeNull();
  });

  it("legs are collapsed by default and expand on click, listing each leg with an explorer link", () => {
    mockQuery([
      availablePage([
        bridgeEntry({
          id: "b-legs",
          status: "confirmed",
          legs: [
            { role: "bridge_deposit", chainId: 8453, chainFamily: "eip155", txHash: "0xdep", status: "confirmed", failureCode: null },
            { role: "bridge_fill_expected", chainId: 42161, chainFamily: "eip155", txHash: "0xfill", status: "confirmed", failureCode: null },
          ],
        }),
      ]),
    ]);
    mountScreen();
    // Collapsed: leg role labels not yet shown.
    expect(screen.queryByText("DEPOSIT")).toBeNull();
    const toggle = screen.getByText(/Show 2 legs/);
    fireEvent.click(toggle);
    expect(screen.getByText("DEPOSIT")).not.toBeNull();
    expect(screen.getByText("FILL")).not.toBeNull();
    // Each hashed leg exposes a curated-allowlist explorer link (never a raw URL).
    expect(screen.getAllByLabelText(/Open .* leg on block explorer/).length).toBe(2);
  });
});

describe("TokenHistoryScreen — states matrix", () => {
  it("status 'unavailable' renders the calm try-again note and NEVER the empty-history copy", () => {
    mockQuery([
      { ok: true, data: { status: "unavailable", reason: "query_timeout" } },
    ]);
    mountScreen();

    expect(
      screen.getByText(/History is unavailable right now — try again shortly/),
    ).not.toBeNull();
    expect(screen.queryByText(/No Vex-recorded history/)).toBeNull();
  });

  it("empty available history renders the quiet invitation (and no unavailable note)", () => {
    mockQuery([availablePage([])]);
    mountScreen();

    expect(
      screen.getByText(/No Vex-recorded history for this token yet/),
    ).not.toBeNull();
    expect(screen.queryByText(/unavailable right now/)).toBeNull();
  });

  it("a failed Result renders the warn state, not empty history", () => {
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

    expect(
      screen.getByText(/Couldn't load this token's history/),
    ).not.toBeNull();
    expect(screen.queryByText(/No Vex-recorded history/)).toBeNull();
  });
});

describe("TokenHistoryScreen — agent_activity swap status chip (Agent Scan §4.7)", () => {
  it("renders a PENDING chip for a pending agent_activity swap entry", () => {
    mockQuery([
      availablePage([swapEntry({ id: "a-1", status: "pending", failureCode: null })]),
    ]);
    mountScreen();
    expect(screen.getByText("pending")).not.toBeNull();
  });

  it("renders a FAILED chip with the failureCode as its tooltip", () => {
    mockQuery([
      availablePage([
        swapEntry({ id: "a-1", status: "failed", failureCode: "slippage" }),
      ]),
    ]);
    mountScreen();
    const chip = screen.getByText("failed");
    expect(chip.getAttribute("title")).toBe("slippage");
  });

  it("renders NO status chip for a confirmed or null-status swap entry (the quiet default)", () => {
    mockQuery([
      availablePage([swapEntry({ id: "a-1", status: "confirmed", failureCode: null })]),
    ]);
    mountScreen();
    expect(screen.queryByText("pending")).toBeNull();
    expect(screen.queryByText("failed")).toBeNull();
    expect(screen.queryByText("confirmed")).toBeNull();
  });
});

describe("TokenHistoryScreen — agent_activity amount honesty (Codex final review C20/C27)", () => {
  it("renders a whole-number human amount (no decimal point) for a confirmed agent_activity leg", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          status: "confirmed",
          failureCode: null,
          tradeSide: null,
          input: {
            token: "0x1111111111111111111111111111111111111111",
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "50", unitProvenance: "human" },
            valueUsd: { value: "50.00", usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    // A main-process-resolved executed amount with no fractional part (e.g.
    // `formatUnits(50_000_000n, 6)` → "50") must still render — the
    // decimal-point heuristic never applies once `unitProvenance` already
    // proves the value human (contract C27).
    expect(screen.getByText(/50 TOKA/)).not.toBeNull();
  });

  it("renders the em dash for an unknown-provenance leg even when a value string is present (a status the mapper could not resolve, e.g. a failed row)", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          status: "failed",
          failureCode: "slippage",
          input: {
            token: "0x1111111111111111111111111111111111111111",
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "50", unitProvenance: "unknown" },
            valueUsd: { value: null, usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText(/— TOKA/)).not.toBeNull();
    expect(screen.queryByText(/50 TOKA/)).toBeNull();
  });
});

describe("TokenHistoryScreen — USD estimate provenance (Codex final review round 2 C35)", () => {
  it("renders an agent_activity-sourced (estimated) valueUsd with an explicit ~... est. marker, never bare execution USD", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          status: "confirmed",
          failureCode: null,
          output: {
            token: USDC_BASE,
            symbol: "TOKB",
            localSymbol: null,
            amount: { value: "25100000", unitProvenance: "unknown" },
            valueUsd: { value: "25.10", usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.getByText(/~\$25\.10 est\./)).not.toBeNull();
  });

  it("keeps a recorded (legacy proj_activity) valueUsd bare, with no est. marker", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();
    expect(screen.getByText(/\$25\.10/)).not.toBeNull();
    expect(screen.queryByText(/est\./)).toBeNull();
  });

  it("omits the USD figure entirely when neither leg has a value, regardless of provenance (never a fabricated $0.00)", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-1",
          unitPriceUsd: null,
          input: {
            token: "0x1111111111111111111111111111111111111111",
            symbol: "TOKA",
            localSymbol: null,
            amount: { value: "1.5", unitProvenance: "human" },
            valueUsd: { value: null, usdProvenance: "estimated" },
          },
          output: {
            token: USDC_BASE,
            symbol: "TOKB",
            localSymbol: null,
            amount: { value: "25100000", unitProvenance: "unknown" },
            valueUsd: { value: null, usdProvenance: "estimated" },
          },
        }),
      ]),
    ]);
    mountScreen();
    expect(screen.queryByText(/\$/)).toBeNull();
  });
});

describe("TokenHistoryScreen — pagination", () => {
  it("shows Load more on hasNextPage, fires fetchNextPage, and renders appended pages' entries", () => {
    mockQuery(
      [
        availablePage([swapEntry({ id: "a-1" })], { hasMore: true }),
        availablePage([
          swapEntry({
            id: "a-2",
            productType: "older_swap",
            tradeSide: "sell",
          }),
        ]),
      ],
      { hasNextPage: true },
    );
    mountScreen();

    // Both pages' entries render (flattened append).
    expect(screen.getByText("SPOT_SWAP · BUY")).not.toBeNull();
    expect(screen.getByText("OLDER_SWAP · SELL")).not.toBeNull();

    const loadMore = screen.getByRole("button", { name: "Load more" });
    fireEvent.click(loadMore);
    expect(mockFetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("hides Load more when the feed is exhausted and disables it mid-fetch", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    cleanup();

    mockQuery(
      [availablePage([swapEntry({ id: "a-1" })], { hasMore: true })],
      { hasNextPage: true, isFetchingNextPage: true },
    );
    mountScreen();
    const busy = screen.getByRole("button", { name: "Loading…" });
    expect(busy.hasAttribute("disabled")).toBe(true);
  });
});
