/**
 * TokenHistoryScreen ROWS — the per-entry display rules
 * (`screens/token-history/TokenHistoryRow.tsx` +
 * `token-history-display.ts`), split out of `TokenHistoryScreen.test.tsx` by
 * the same seams as the screen itself (the screen gate keeps chrome, the
 * states matrix, and pagination).
 *
 * Pins:
 *   - swap/bridge/transfer rows render their badge, `in → out` legs with
 *     policy-gated symbols, a HUMAN-provenance quantity while an
 *     UNKNOWN-provenance one keeps the em dash (never a blind wei-scale
 *     format), a USD primary figure + unit price, venue/chain meta, and an
 *     explorer link BUILT from `{chainId, ref}` via shared/explorer-links
 *     (chainId 0 / unknown chain → NO link);
 *   - the USD primary figure carries `usdProvenance` (Codex final review
 *     round 2 finding 7 / contract C35): `"estimated"` renders with an
 *     explicit `~ … est.` marker, `"recorded"` renders bare — never a
 *     bare-execution-USD read on a quote-time estimate;
 *   - an `agent_activity`-sourced swap entry's pending/failed status renders
 *     a status chip (Agent Scan §4.7); `null`/`"confirmed"` renders none;
 *   - bridge lifecycle vocabulary: settling / tracking delayed (R12) /
 *     refunded / failed, and the collapsed-by-default per-leg audit (B8).
 *
 * `useTokenHistoryInfinite` is mocked — this suite owns display rules, not
 * query wiring (the hook's pagination contract is pinned in the api layer).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TokenHistoryDto } from "@shared/schemas/token-history.js";
import type { Result } from "@shared/ipc/result.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import {
  availablePage,
  bridgeEntry,
  swapEntry,
  tokenHistoryRoute,
  TX_HASH,
  USDC_BASE,
} from "./_token-history-fixtures.js";

vi.mock("../../../../components/icons/VexIcon.js", () => ({
  VexIcon: () => null,
}));
vi.mock("../../../../components/icons/icon-glyphs.js", () => ({
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
// under test.
vi.mock("../MemoryScreen.js", () => ({ MemoryScreen: () => null }));
vi.mock("../SessionsScreen.js", () => ({ SessionsScreen: () => null }));
vi.mock("../HowVexWorksScreen.js", () => ({ HowVexWorksScreen: () => null }));
vi.mock("../SettingsScreen.js", () => ({ SettingsScreen: () => null }));
vi.mock("../AssetsScreen.js", () => ({ AssetsScreen: () => null }));
vi.mock("../AgentScanScreen.js", () => ({ AgentScanScreen: () => null }));

const mockUseTokenHistoryInfinite = vi.hoisted(() => vi.fn());
vi.mock("../../../../lib/api/portfolio.js", () => ({
  useTokenHistoryInfinite: mockUseTokenHistoryInfinite,
}));

const { ShellScreens } = await import("../ShellScreens.js");

function mockQuery(pages: readonly Result<TokenHistoryDto>[]): void {
  mockUseTokenHistoryInfinite.mockReturnValue({
    isLoading: false,
    isError: false,
    data: pages.length > 0 ? { pages: [...pages] } : undefined,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  });
}

function mountScreen(): void {
  useUiStore.setState({ shellRoute: tokenHistoryRoute({ kind: "shell" }) });
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

describe("TokenHistoryScreen — entries", () => {
  it("renders a swap row: activity badge, legs with human quantity vs unknown-provenance em dash, USD @ unit price, venue meta, and the BUILT explorer href", () => {
    mockQuery([availablePage([swapEntry({ id: "a-1" })])]);
    mountScreen();

    // The badge speaks the CANONICAL vocabulary. The fixture still carries
    // `productType: "spot_swap"` / `tradeSide: "buy"` — and the old
    // `SPOT_SWAP · BUY` stamp they used to produce must be gone.
    expect(screen.getByText("SWAP")).not.toBeNull();
    expect(screen.queryByText("SPOT_SWAP · BUY")).toBeNull();
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

  it("falls back to the DTO's own kind discriminant on a LEGACY row carrying no canonical vocabulary, and renders no link for unresolved chainId 0", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-2",
          productType: null,
          tradeSide: null,
          activityKind: null,
          eventRole: null,
          txRefs: [{ chainId: 0, ref: "0xdeadbeef" }],
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("SWAP")).not.toBeNull();
    // chainId 0 is the DB layer's "could not resolve" sentinel → NO link.
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("names a Jupiter LEND row by its canonical vocabulary — the exact row the old SPOT taxonomy mislabelled", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-lend",
          venue: "jupiter",
          productType: "lend",
          tradeSide: null,
          activityKind: "lend",
          eventRole: "lend_deposit",
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("LEND·DEPOSIT")).not.toBeNull();
    // It must never read as a spot trade again.
    expect(screen.queryByText("SWAP")).toBeNull();
  });

  it("names a prediction row PREDICT·BUY rather than a swap", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-predict",
          venue: "polymarket",
          productType: "prediction",
          tradeSide: null,
          activityKind: "prediction",
          eventRole: "predict_buy",
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("PREDICT·BUY")).not.toBeNull();
    expect(screen.queryByText("SWAP")).toBeNull();
  });

  it("renders an UNKNOWN engine kind neutrally instead of blanking the row (tolerant reader)", () => {
    mockQuery([
      availablePage([
        swapEntry({
          id: "a-drift",
          activityKind: "perps",
          eventRole: "perps_open",
        }),
      ]),
    ]);
    mountScreen();

    expect(screen.getByText("PERPS·PERPS_OPEN")).not.toBeNull();
    // The row still renders its economics — an unknown kind is not a blank row.
    expect(screen.getByText(/1\.5 TOKA/)).not.toBeNull();
  });

  it("renders a transfer row: TRANSFER badge, human amount → truncated recipient, status meta", () => {
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
        bridgeEntry({
          id: "b-1",
          createdAt: "2026-06-21T08:00:00+00:00",
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
          providerOrderId: null,
          amountBasis: null,
          lastCheckedAt: null,
        }),
      ]),
    ]);
    mountScreen();

    // The canonical bridge row is the LOGICAL fill leg.
    expect(screen.getByText("BRIDGE·FILL")).not.toBeNull();
    expect(screen.getByText(/RELAY · base → arbitrum/)).not.toBeNull();
    // No output value → input USD is the fallback primary.
    expect(screen.getByText(/\$10\.00/)).not.toBeNull();
  });

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
