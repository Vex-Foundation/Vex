/**
 * MOVES ledger — stamp + leg-amount grammar (split out of MovesBlock.test.tsx,
 * F1, over the 500-line cap):
 *
 *   - rows badge their CANONICAL activity vocabulary (`activityKind` /
 *     `eventRole`) through the shared `ActivityBadge`; the venue left the
 *     stamp text and became a protocol mark. The retired `productType`/
 *     `tradeSide` SPOT taxonomy has ZERO renderer consumers,
 *   - leg amounts render ONLY for dotted-decimal strings (compact ≤6
 *     significant digits); raw base-unit integers (legacy wei/lamports) and
 *     nulls render nothing,
 *   - an agent_activity row's server-resolved amount is trusted verbatim
 *     (whole numbers render exactly like dotted ones); a legacy
 *     (`source: "success"`) row still hides a whole-number amount,
 *   - an ESTIMATED bridge amount is marked with `~` and an "est." tag; an
 *     EXECUTED bridge amount renders bare; a STALE pending bridge surfaces a
 *     "Tracking delayed" row tooltip, a freshly-checked one does not.
 *
 * Symbol/logo grammar lives in the sibling MovesBlock.test.tsx; row-status/
 * explorer-link/pagination behavior lives in MovesBlock-row-status.test.tsx.
 *
 * `useMoves` is mocked — this suite owns the block's display rules, not the
 * query wiring.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { MoveItem } from "@shared/schemas/portfolio-moves.js";

const mockUseMoves = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/api/portfolio.js", () => ({
  useMoves: mockUseMoves,
}));

const { MovesBlock } = await import("../book/MovesBlock.js");

const SESSION = "00000000-0000-4000-8000-00000000eeee";

function move(overrides: Partial<MoveItem> & { readonly id: string }): MoveItem {
  return {
    source: "success",
    tradeSide: null,
    productType: null,
    venue: null,
    inputToken: null,
    inputTokenSymbol: null,
    inputTokenLocalSymbol: null,
    inputAmount: null,
    outputToken: null,
    outputTokenSymbol: null,
    outputTokenLocalSymbol: null,
    outputAmount: null,
    valueUsd: null,
    captureStatus: "executed",
    status: null,
    failureCode: null,
    instrumentKey: null,
    chain: "solana",
    txRef: null,
    walletAddress: null,
    fromChain: null,
    toChain: null,
    providerOrderId: null,
    amountBasis: null,
    legs: [],
    lastCheckedAt: null,
    createdAt: "2026-07-02T10:21:00+00:00",
    ...overrides,
  };
}

function mockMoves(data: readonly MoveItem[]): void {
  mockUseMoves.mockReturnValue({
    isLoading: false,
    data: { ok: true, data },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MovesBlock ledger display — activity badges + amounts", () => {
  it("badges each row with its CANONICAL activity kind", () => {
    mockMoves([
      move({ id: "1", activityKind: "swap" }),
      move({ id: "2", activityKind: "bridge" }),
      move({ id: "3", activityKind: "lend" }),
      move({ id: "4", activityKind: "prediction" }),
      move({ id: "5", activityKind: "wrap" }),
      move({ id: "6", activityKind: "transfer" }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("SWAP")).not.toBeNull();
    expect(screen.getByText("BRIDGE")).not.toBeNull();
    expect(screen.getByText("LEND")).not.toBeNull();
    expect(screen.getByText("PREDICT")).not.toBeNull();
    expect(screen.getByText("WRAP")).not.toBeNull();
    expect(screen.getByText("TRANSFER")).not.toBeNull();
  });

  it("renders the event role as the badge's second segment", () => {
    mockMoves([
      move({ id: "1", activityKind: "lend", eventRole: "lend_withdraw" }),
      move({ id: "2", activityKind: "prediction", eventRole: "predict_claim" }),
      move({ id: "3", activityKind: "bridge", eventRole: "bridge_fee" }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("LEND·WITHDRAW")).not.toBeNull();
    expect(screen.getByText("PREDICT·CLAIM")).not.toBeNull();
    expect(screen.getByText("BRIDGE·FEE")).not.toBeNull();
  });

  it("moves the venue OUT of the stamp text and into a protocol mark", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        activityKind: "bridge",
        eventRole: "bridge_fill_expected",
        venue: "relay",
      }),
      move({
        id: "2",
        source: "agent_activity",
        activityKind: "swap",
        eventRole: "swap",
        venue: "kyberswap",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    // The badge says WHAT happened…
    expect(screen.getByText("BRIDGE·FILL")).not.toBeNull();
    expect(screen.getByText("SWAP")).not.toBeNull();
    // …and the venue-qualified stamp text is gone for good.
    expect(screen.queryByText("BRIDGE·RELAY")).toBeNull();
    expect(screen.queryByText("SWAP·KYBERSWAP")).toBeNull();
    // …while the mark says WHO executed it, from the bundled same-origin
    // artwork — never a remote logo URL.
    const kyber = container.querySelector('img[src="/protocols/kyberswap.svg"]');
    expect(kyber?.getAttribute("title")).toBe("KyberSwap");
    const relay = container.querySelector('img[src="/protocols/relay.png"]');
    expect(relay?.getAttribute("title")).toBe("Relay");
  });

  it("badges a LEGACY row from its server-derived kind, and stays neutral when it has none", () => {
    mockMoves([
      // A legacy product this build has no canonical name for.
      move({ id: "1", activityKind: "activity" }),
      // A row from a build older than the vocabulary rollout: no kind at all.
      move({ id: "2", activityKind: null }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    // Both degrade to the neutral label — never blank, never a fake SWAP.
    expect(screen.getAllByText("ACTIVITY")).toHaveLength(2);
  });

  it("renders an UNKNOWN engine kind neutrally rather than blanking the row", () => {
    mockMoves([move({ id: "1", activityKind: "perps", eventRole: "perps_open" })]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("PERPS·PERPS_OPEN")).not.toBeNull();
  });

  it("renders dotted-decimal amounts on the legs (≤6 significant digits) and hides raw/null amounts", () => {
    mockMoves([
      move({
        id: "1",
        activityKind: "bridge",
        venue: "relay",
        inputToken: "ETH",
        inputAmount: "0.001714",
        outputToken: "ETH",
        outputAmount: "0.001693900188686176",
      }),
      // Legacy raw base-unit integer (wei) + null → both legs stay amount-less.
      move({
        id: "2",
        inputToken: "wif",
        inputAmount: "1714000000000000",
        outputToken: "sol",
        outputAmount: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("0.001714 ETH")).not.toBeNull();
    // Compacted to 6 significant digits.
    expect(screen.getByText("0.0016939 ETH")).not.toBeNull();
    // Raw wei never prints; the legacy legs render exactly as before.
    expect(screen.queryByText(/1714000000000000/)).toBeNull();
    expect(screen.getByText("WIF")).not.toBeNull();
    expect(screen.getByText("SOL")).not.toBeNull();
  });

  it("renders a whole-number amount (no decimal point) for an agent_activity row — trusted verbatim (Codex final review C27)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        status: "confirmed",
        inputToken: "USDC",
        inputAmount: "50",
        outputToken: "WETH",
        outputAmount: "0.02",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    // Server-resolved main-process amounts are trusted verbatim for an
    // agent_activity row — a whole number renders exactly like a dotted one.
    expect(screen.getByText("50 USDC")).not.toBeNull();
    expect(screen.getByText("0.02 WETH")).not.toBeNull();
  });

  it("still hides a whole-number amount for a LEGACY (source: 'success') row — the dot requirement stays for untrusted sources", () => {
    mockMoves([
      move({
        id: "1",
        source: "success",
        inputToken: "usdc",
        inputAmount: "50",
        outputToken: "weth",
        outputAmount: null,
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("USDC")).not.toBeNull();
    expect(screen.queryByText(/50 USDC/)).toBeNull();
  });

  // ── bridge estimate labeling (R14) + tracking delay (R12) ───────────────

  it("marks an ESTIMATED bridge amount with ~ and an 'est.' tag (R14 — never a bare executed quantity)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        activityKind: "bridge",
        venue: "relay",
        status: "pending",
        amountBasis: "estimated",
        inputToken: "USDC",
        inputAmount: "2",
        outputToken: "USDC",
        outputAmount: "1.99",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("~2 USDC")).not.toBeNull();
    expect(screen.getByText("~1.99 USDC")).not.toBeNull();
    expect(screen.getByText("est.")).not.toBeNull();
  });

  it("renders an EXECUTED bridge amount bare — settled truth carries no estimate marker", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        activityKind: "bridge",
        venue: "khalani",
        status: "confirmed",
        amountBasis: "executed",
        inputToken: "USDC",
        inputAmount: "2",
        outputToken: "USDC",
        outputAmount: "1.988",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText("2 USDC")).not.toBeNull();
    expect(screen.getByText("1.988 USDC")).not.toBeNull();
    expect(screen.queryByText("est.")).toBeNull();
  });

  it("surfaces a 'tracking delayed' row tooltip for a STALE pending bridge (R12)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        activityKind: "bridge",
        venue: "relay",
        status: "pending",
        // Last successful sweep check is long past → tracking is delayed.
        lastCheckedAt: "2020-01-01T00:00:00+00:00",
        createdAt: "2020-01-01T00:00:00+00:00",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const row = container.querySelector("li");
    expect(row?.getAttribute("title")).toContain("Tracking delayed");
  });

  it("does NOT flag a freshly-checked pending bridge as delayed (no tooltip)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        activityKind: "bridge",
        venue: "relay",
        status: "pending",
        lastCheckedAt: new Date().toISOString(),
        createdAt: "2020-01-01T00:00:00+00:00",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const row = container.querySelector("li");
    // No failureCode, no delay, no instrumentKey → no title at all.
    expect(row?.getAttribute("title")).toBeNull();
  });
});
