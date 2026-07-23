/**
 * inspectTransactions handler + agent_scan router `transactions` dispatch — Stage 9.
 *
 * Pins:
 *   - the router passes addresses + context.sessionId + the parsed params
 *     (productType/namespace/txHash/cursor/limit) to the repo
 *   - a malformed cursor → bounded fail("Invalid cursor"), no crash, no leak,
 *     repo NOT called
 *   - the shaped result: view, count, failuresScope, transactions, nextCursor,
 *     hasMore
 *   - sessionId is threaded through (so the repo can omit/keep the failure half)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetTransactions = vi.fn();
const mockResolveSet = vi.fn().mockReturnValue({ evm: "0xEVM", solana: "SOL", all: ["0xEVM", "SOL"] });

vi.mock("@vex-agent/db/repos/transactions.js", () => ({
  getTransactions: (...a: unknown[]) => mockGetTransactions(...a),
}));

// Real cursor codec — we want the REAL decode to reject the malformed cursor.
vi.mock("../../../../vex-agent/tools/internal/wallet/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../../../../vex-agent/tools/internal/wallet/resolve.js")>(
    "../../../../vex-agent/tools/internal/wallet/resolve.js",
  );
  // portfolio-inspect resolves the READ-scoped wallet set (setup exception) via
  // resolveSelectedAddressSetForRead; mock BOTH names so the set the handler
  // actually calls is the one under test (and stays robust to either path).
  return {
    ...actual,
    resolveSelectedAddressSet: (...a: unknown[]) => mockResolveSet(...a),
    resolveSelectedAddressSetForRead: (...a: unknown[]) => mockResolveSet(...a),
  };
});

const { handleAgentScan } = await import("../../../../vex-agent/tools/internal/portfolio-inspect.js");
const { inspectTransactions } = await import("../../../../vex-agent/tools/internal/inspect-views/transactions.js");
const { encodeCursor } = await import("../../../../vex-agent/db/repos/transactions-cursor.js");
import { makeTestContext } from "../_test-context.js";

const ctx = makeTestContext({ sessionId: "sess-123" });

const EMPTY_RESULT = { items: [], nextCursor: null, hasMore: false, failuresScope: "session" as const };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetTransactions.mockResolvedValue(EMPTY_RESULT);
  mockResolveSet.mockReturnValue({ evm: "0xEVM", solana: "SOL", all: ["0xEVM", "SOL"] });
});

describe("agent_scan router → transactions dispatch", () => {
  it("passes the wallet set + context.sessionId + parsed params to the repo", async () => {
    await handleAgentScan(
      { view: "transactions", namespace: "solana", productType: "spot", txHash: "0xDEAD", limit: 5 },
      ctx,
    );
    expect(mockGetTransactions).toHaveBeenCalledWith({
      addresses: ["0xEVM", "SOL"],
      sessionId: "sess-123",
      productType: "spot",
      namespace: "solana",
      txHash: "0xDEAD",
      cursor: null,
      limit: 5,
    });
  });

  it("threads a valid cursor through (decoded) to the repo", async () => {
    const cursor = encodeCursor({ cursorTs: "2026-06-04T10:00:00.123456Z", sourceRank: 1, id: 9 });
    await handleAgentScan({ view: "transactions", cursor }, ctx);
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { cursorTs: "2026-06-04T10:00:00.123456Z", sourceRank: 1, id: 9 },
        limit: 20,
      }),
    );
  });

  it("malformed cursor → bounded fail, repo NOT called, no leak", async () => {
    const r = await handleAgentScan({ view: "transactions", cursor: "totally-garbage" }, ctx);
    expect(r.success).toBe(false);
    expect(r.output).toBe("Invalid cursor");
    expect(r.output).not.toContain("garbage");
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });

  it("shapes the success result envelope", async () => {
    mockGetTransactions.mockResolvedValueOnce({
      items: [{ source: "success", id: 1, namespace: "solana", productType: "spot", txHash: "0xabc", createdAt: "2026-06-04T10:00:00.000000Z" }],
      nextCursor: "CURSOR2",
      hasMore: true,
      failuresScope: "session",
    });
    const r = await handleAgentScan({ view: "transactions" }, ctx);
    expect(r.success).toBe(true);
    expect(r.data!.view).toBe("transactions");
    expect(r.data!.count).toBe(1);
    expect(r.data!.failuresScope).toBe("session");
    expect(r.data!.nextCursor).toBe("CURSOR2");
    expect(r.data!.hasMore).toBe(true);
    expect((r.data!.transactions as unknown[])).toHaveLength(1);
  });

  it("an empty selected wallet set still scopes the repo call to []", async () => {
    mockResolveSet.mockReturnValueOnce({ evm: null, solana: null, all: [] });
    await handleAgentScan({ view: "transactions" }, ctx);
    expect(mockGetTransactions).toHaveBeenCalledWith(expect.objectContaining({ addresses: [] }));
  });
});

describe("inspectTransactions handler (direct)", () => {
  it("passes a null sessionId straight through (success-only feed)", async () => {
    await inspectTransactions(["0xEVM"], null, { limit: 10 });
    expect(mockGetTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ addresses: ["0xEVM"], sessionId: null, limit: 10 }),
    );
  });

  it("defaults limit to 20 when omitted", async () => {
    await inspectTransactions(["0xEVM"], "s1", {});
    expect(mockGetTransactions).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("malformed cursor → bounded fail without calling the repo", async () => {
    const r = await inspectTransactions(["0xEVM"], "s1", { cursor: "!!!bad!!!" });
    expect(r.success).toBe(false);
    expect(r.output).toBe("Invalid cursor");
    expect(mockGetTransactions).not.toHaveBeenCalled();
  });
});

describe("inspectTransactions bridge output (Codex FIX-ROUND-1 finding 13)", () => {
  const bridgeRow = {
    source: "agent_activity",
    id: 40,
    namespace: "khalani",
    productType: "bridge",
    chain: "arbitrum",
    chainId: 42161,
    protocol: "khalani",
    status: "pending",
    inputToken: "USDC",
    inputAmount: "2",
    outputToken: "USDC",
    outputAmount: "1.99",
    amountBasis: "estimated",
    valueUsd: 2,
    fromChainId: 8453,
    fromChainSlug: "base",
    toChainId: 42161,
    toChainSlug: "arbitrum",
    chainFamily: "eip155",
    providerOrderId: "ord_1",
    legs: [
      { eventIndex: 0, role: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", txHash: "0xdeposit", status: "confirmed", failureCode: null },
      { eventIndex: 1, role: "bridge_fill_expected", chainId: 42161, chainSlug: "arbitrum", chainFamily: "eip155", txHash: null, status: "pending", failureCode: null },
      { eventIndex: 2, role: "bridge_refund", chainId: 8453, chainSlug: "base", chainFamily: "eip155", txHash: "0xrefund", status: "confirmed", failureCode: null },
    ],
    txHash: null,
    createdAt: "2026-07-22T10:00:00.000000Z",
  };

  function mockBridge(): void {
    mockGetTransactions.mockResolvedValueOnce({
      items: [bridgeRow],
      nextCursor: null,
      hasMore: false,
      failuresScope: "session",
    });
  }

  it("summarizes origin→destination + estimate-marked amount + venue + status", async () => {
    mockBridge();
    const r = await inspectTransactions(["0xEVM"], "s1", {});
    const tx = (r.data!.transactions as Array<{ summary: string }>)[0]!;
    // Route endpoints, venue, and status all lead the compact line.
    expect(tx.summary).toContain("base → arbitrum");
    expect(tx.summary).toContain("via khalani");
    expect(tx.summary).toContain("pending");
    // The quoted amount is explicitly marked (R14) — never a bare executed
    // quantity for a not-yet-verified bridge fill.
    expect(tx.summary).toContain("~2 USDC");
    expect(tx.summary).toContain("est.");
  });

  it("derives _explorerRefs from EVERY leg (deposit + refund), not only the top-level fill hash", async () => {
    mockBridge();
    const r = await inspectTransactions(["0xEVM"], "s1", {});
    const refs = r.data!._explorerRefs as Array<{ chain: string; txRef: string }>;
    // Deposit and refund legs each yield a ref keyed by their OWN chain; the
    // still-pending (hashless) fill leg contributes none — never a half link.
    expect(refs).toContainEqual({ chain: "base", txRef: "0xdeposit" });
    expect(refs).toContainEqual({ chain: "base", txRef: "0xrefund" });
    expect(refs).toHaveLength(2);
  });
});
