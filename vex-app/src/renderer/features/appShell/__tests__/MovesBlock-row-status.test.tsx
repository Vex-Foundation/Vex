/**
 * MOVES ledger — row-status, explorer-link, and list-chrome grammar (split
 * out of MovesBlock.test.tsx, F1, over the 500-line cap):
 *
 *   - the status dot is a still color mark (owner decree: no pulsing dots
 *     anywhere) — pending vs. terminal fills differ by color alone, and an
 *     agent_activity row's own status drives the dot color (ignoring the
 *     always-null captureStatus there),
 *   - a failed agent_activity row surfaces its failureCode as the row title,
 *   - rows whose `chain`+`txRef` resolve through `explorerTxUrl` render as
 *     external links (href + target=_blank + rel="noopener noreferrer");
 *     a row with no `txRef` whose `chain`+`walletAddress` resolve through
 *     `explorerAccountUrl` (HyperCore) appends a labelled `View account` link
 *     without turning the row into an anchor; rows that resolve to neither stay
 *     non-interactive (including historical, now-unresolvable hyperliquid rows,
 *     kept as an audit record),
 *   - the 10-row display window, fetched-total count badge, and empty/error
 *     copy hold.
 *
 * Symbol/logo grammar lives in the sibling MovesBlock.test.tsx; stamp/amount
 * grammar lives in MovesBlock-stamps-amounts.test.tsx.
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

describe("MovesBlock ledger display — row status, links, and list chrome", () => {
  it("never pulses the status dot (owner decree: no pulsing dots anywhere)", () => {
    mockMoves([
      move({ id: "1", captureStatus: "open" }),
      move({ id: "2", captureStatus: "executed" }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelectorAll(".vex-pulse-dot")).toHaveLength(0);
  });

  it("shows a pending/failed agent_activity row with its own status-driven dot color, ignoring captureStatus (always null there)", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        status: "pending",
        captureStatus: null,
      }),
      move({
        id: "2",
        source: "agent_activity",
        status: "failed",
        failureCode: "slippage",
        captureStatus: null,
      }),
      move({
        id: "3",
        source: "agent_activity",
        status: "confirmed",
        captureStatus: null,
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const dots = container.querySelectorAll('[aria-hidden].rounded-full');
    expect(dots).toHaveLength(3);
    expect(dots[0]?.className).toContain("bg-[var(--vex-accent)]");
    expect(dots[1]?.className).toContain("bg-[var(--color-destructive)]");
    expect(dots[2]?.className).toContain("bg-[var(--color-success)]");
  });

  it("surfaces a failed agent_activity row's failureCode as the row title tooltip", () => {
    mockMoves([
      move({
        id: "1",
        source: "agent_activity",
        status: "failed",
        failureCode: "slippage",
        instrumentKey: null,
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    const row = container.querySelector("li");
    expect(row?.getAttribute("title")).toBe("slippage");
  });

  it("links a row with a resolvable chain+txRef to its block explorer", () => {
    mockMoves([
      move({ id: "1", chain: "solana", txRef: "5sigSolana" }),
      move({ id: "2", chain: "ethereum", txRef: "0xdeadbeef" }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);

    const links = screen.getAllByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(links).toHaveLength(2);
    expect(links[0]?.getAttribute("href")).toBe(
      "https://explorer.solana.com/tx/5sigSolana",
    );
    expect(links[1]?.getAttribute("href")).toBe(
      "https://etherscan.io/tx/0xdeadbeef",
    );
    // main routes window.open through shell.openExternal — the anchor still
    // pins the safe-open contract for any environment that honours it.
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("links a Robinhood Chain row to its Blockscout explorer", () => {
    mockMoves([move({ id: "1", chain: "robinhood", txRef: "0xrhc123" })]);
    render(<MovesBlock sessionId={SESSION} />);
    const link = screen.getByRole("link", {
      name: "Open transaction on block explorer",
    });
    expect(link.getAttribute("href")).toBe(
      "https://robinhoodchain.blockscout.com/tx/0xrhc123",
    );
  });

  // Hyperliquid was removed (Phase 3); its historical rows stay in the DB as
  // an audit record and must render gracefully with NO explorer links (the
  // account-link map's sole HyperCore entry is gone, and the tx-chain map no
  // longer resolves "hyperliquid").
  it("renders a historical hyperliquid row without any explorer link (audit record)", () => {
    const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
    mockMoves([
      move({
        id: "1",
        chain: "hyperliquid",
        txRef: null,
        walletAddress: WALLET,
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);

    // The row still renders as a plain non-anchored list item…
    const li = container.querySelector("li");
    expect(li?.tagName).toBe("LI");
    expect(li?.getAttribute("href")).toBeNull();
    // …with neither an account link nor a tx link.
    expect(
      screen.queryByRole("link", { name: "Open account on block explorer" }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", {
        name: "Open transaction on block explorer",
      }),
    ).toBeNull();
  });

  it("renders a historical hyperliquid row with a txRef without a tx link (chain no longer resolves)", () => {
    mockMoves([
      move({
        id: "1",
        chain: "hyperliquid",
        txRef: "0xhlHash",
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ]);
    render(<MovesBlock sessionId={SESSION} />);
    expect(
      screen.queryByRole("link", {
        name: "Open transaction on block explorer",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open account on block explorer" }),
    ).toBeNull();
  });

  it("stays fully inert for an unknown chain even with a walletAddress", () => {
    mockMoves([
      move({
        id: "1",
        chain: "unknown-venue",
        txRef: null,
        walletAddress: "0x1234567890abcdef1234567890abcdef12345678",
      }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelector("a")).toBeNull();
  });

  it("keeps rows without a resolvable explorer URL non-interactive", () => {
    mockMoves([
      // No txRef → no link, even on a mapped chain.
      move({ id: "1", chain: "solana", txRef: null }),
      // Unknown chain → no link, even with a txRef.
      move({ id: "2", chain: "unknown-venue", txRef: "0xdeadbeef" }),
    ]);
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("a")).toBeNull();
  });

  it("shows only the 10 newest rows and badges the fetched total", () => {
    mockMoves(
      Array.from({ length: 25 }, (_, i) => move({ id: String(i) })),
    );
    const { container } = render(<MovesBlock sessionId={SESSION} />);
    expect(container.querySelectorAll("li")).toHaveLength(10);
    expect(screen.getByText("25")).not.toBeNull();
  });

  it("keeps the empty and error copy", () => {
    mockMoves([]);
    const { unmount } = render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText(/No moves yet/)).not.toBeNull();
    unmount();

    mockUseMoves.mockReturnValue({
      isLoading: false,
      data: { ok: false, error: { code: "INTERNAL", message: "boom" } },
    });
    render(<MovesBlock sessionId={SESSION} />);
    expect(screen.getByText(/Couldn’t load moves|Couldn't load moves/)).not.toBeNull();
  });
});
