/**
 * `agent_scan view=transactions` — native-leg labelling in the agent's own
 * history.
 *
 * Live defect (2026-07-26): Kyber native legs were stored as
 * `token_out_symbol = 'NATIVE'`, and the history line rendered
 * `1 USDC → 0.0004 NATIVE`, so an agent reading its own history could not tell
 * which asset it received.
 *
 * The annotation is applied HERE, at projection, rather than being stored:
 *   - it repairs rows already written (the live rows from tonight included);
 *   - the stored column stays a ticker-shaped value, which is what vex-app's
 *     `sanitizeTokenSymbol` allowlist requires;
 *   - nothing that matches on a symbol sees a changed stored value.
 *
 * The feed is multi-venue, so the projection must be an exact no-op for every
 * row that is not the native sentinel.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTransactions = vi.fn();

vi.mock("@vex-agent/db/repos/transactions.js", () => ({
  getTransactions: (...a: unknown[]) => mockGetTransactions(...a),
}));

const { inspectTransactions } = await import(
  "../../../../vex-agent/tools/internal/inspect-views/transactions.js"
);

import type { TransactionRow } from "../../../../vex-agent/db/repos/transactions.js";

function row(overrides: Partial<TransactionRow>): TransactionRow {
  return {
    source: "agent_activity",
    id: 1,
    namespace: "kyberswap",
    productType: "spot",
    protocol: "kyberswap",
    chain: "base",
    chainId: 8453,
    status: "confirmed",
    amountBasis: "executed",
    ...overrides,
  } as TransactionRow;
}

async function summaryOf(item: TransactionRow): Promise<string> {
  mockGetTransactions.mockResolvedValue({
    items: [item],
    nextCursor: null,
    hasMore: false,
    failuresScope: "session" as const,
  });
  const result = await inspectTransactions(["0xEVM"], "sess-1", {});
  const data = result.data as { transactions: Array<{ summary: string }> };
  return data.transactions[0].summary;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("transactions history — native leg annotation", () => {
  it("annotates a native OUTPUT leg with the chain's real symbol", async () => {
    const summary = await summaryOf(
      row({
        inputAmount: "1",
        inputToken: "USDC",
        outputAmount: "0.0004",
        outputToken: "NATIVE",
        chainId: 8453,
      }),
    );
    expect(summary).toContain("0.0004 NATIVE (ETH)");
    expect(summary).toContain("1 USDC");
  });

  it("annotates a native INPUT leg too", async () => {
    const summary = await summaryOf(
      row({
        inputAmount: "0.0004",
        inputToken: "NATIVE",
        outputAmount: "1",
        outputToken: "USDC",
        chainId: 8453,
      }),
    );
    expect(summary).toContain("0.0004 NATIVE (ETH)");
  });

  it("uses the chain's OWN native symbol, never ETH everywhere", async () => {
    const summary = await summaryOf(
      row({
        chain: "bsc",
        chainId: 56,
        inputAmount: "1",
        inputToken: "USDC",
        outputAmount: "0.002",
        outputToken: "NATIVE",
      }),
    );
    expect(summary).toContain("0.002 NATIVE (BNB)");
    expect(summary).not.toContain("NATIVE (ETH)");
  });

  it("repairs a row written BEFORE this change (stored value is bare NATIVE)", async () => {
    // The retroactive-repair property: nothing about the stored row changed,
    // only how it is projected.
    const summary = await summaryOf(
      row({ chainId: 4663, chain: "robinhood", inputAmount: "0.11145", inputToken: "NATIVE" }),
    );
    expect(summary).toContain("0.11145 NATIVE (ETH)");
  });

  it("leaves the row bare NATIVE when the chain id cannot be resolved", async () => {
    const summary = await summaryOf(
      row({ chainId: 1337, chain: "1337", inputAmount: "1", inputToken: "NATIVE" }),
    );
    expect(summary).toContain("1 NATIVE ");
    expect(summary).not.toContain("NATIVE (");
  });

  it("leaves the row bare NATIVE when the row carries no chain id at all", async () => {
    const summary = await summaryOf(
      row({ chainId: null, chain: null, inputAmount: "1", inputToken: "NATIVE" }),
    );
    expect(summary).not.toContain("NATIVE (");
  });

  it("does not touch ordinary tickers on any venue", async () => {
    const summary = await summaryOf(
      row({
        namespace: "uniswap",
        protocol: "uniswap",
        chainId: 137,
        chain: "polygon",
        inputAmount: "1",
        inputToken: "POL",
        outputAmount: "0.5",
        outputToken: "USDC",
      }),
    );
    expect(summary).toContain("1 POL → 0.5 USDC");
  });

  it("does not touch the address fallback the query COALESCEs in", async () => {
    const address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const summary = await summaryOf(
      row({ inputAmount: "1", inputToken: address, chainId: 8453 }),
    );
    expect(summary).toContain(`1 ${address}`);
  });

  it("keeps the estimated marker around an annotated native leg", async () => {
    const summary = await summaryOf(
      row({
        amountBasis: "estimated",
        inputAmount: "1",
        inputToken: "USDC",
        outputAmount: "0.0004",
        outputToken: "NATIVE",
        chainId: 8453,
      }),
    );
    expect(summary).toContain("~0.0004 NATIVE (ETH) est.");
  });

  it("annotates a bridge row's legs from their OWN chain ids", async () => {
    const summary = await summaryOf(
      row({
        productType: "bridge",
        namespace: "relay",
        protocol: "relay",
        chainId: 4663,
        fromChainId: 4663,
        toChainId: 8453,
        fromChainSlug: "robinhood",
        toChainSlug: "base",
        amountBasis: "executed",
        inputAmount: "0.009455",
        inputToken: "NATIVE",
        outputAmount: "0.009431",
        outputToken: "NATIVE",
      }),
    );
    expect(summary).toContain("0.009455 NATIVE (ETH)");
    expect(summary).toContain("0.009431 NATIVE (ETH)");
  });

  it("labels each bridge leg with ITS OWN native asset, never the row's chain", async () => {
    // Base → BSC moves ETH out and BNB in. Annotating both legs from a single
    // `chainId` would print "NATIVE (ETH)" on the BNB side — a confident wrong
    // label, which is the one outcome worse than the bare sentinel.
    const summary = await summaryOf(
      row({
        productType: "bridge",
        namespace: "relay",
        protocol: "relay",
        chainId: 8453,
        fromChainId: 8453,
        toChainId: 56,
        fromChainSlug: "base",
        toChainSlug: "bsc",
        amountBasis: "executed",
        inputAmount: "1",
        inputToken: "NATIVE",
        outputAmount: "2",
        outputToken: "NATIVE",
      }),
    );
    expect(summary).toContain("1 NATIVE (ETH)");
    expect(summary).toContain("2 NATIVE (BNB)");
  });

  it("leaves bridge legs bare when the row carries no per-leg chain ids", async () => {
    // Falling back to the row's own `chainId` would guess the destination
    // asset from the source chain. Degrade instead.
    const summary = await summaryOf(
      row({
        productType: "bridge",
        namespace: "relay",
        protocol: "relay",
        chainId: 8453,
        fromChainId: null,
        toChainId: null,
        amountBasis: "executed",
        inputAmount: "1",
        inputToken: "NATIVE",
        outputAmount: "2",
        outputToken: "NATIVE",
      }),
    );
    // Asserted on the leg text specifically — the bridge line's own
    // `(route)` parenthetical would satisfy a looser "no NATIVE (" check.
    expect(summary).toContain("1 NATIVE → 2 NATIVE");
    expect(summary).not.toContain("NATIVE (ETH)");
    expect(summary).not.toContain("NATIVE (BNB)");
  });
});
