/**
 * Indexify handler behaviour — projections, refusals, and the money-path
 * preflights. The provider is mocked at the CLIENT seam (the same seam the
 * pools/trench suites use), so the readers, projections, preflights and reply
 * envelopes are the code under test and the network is not.
 *
 * The money-path assertions all exist for the same reason: on a custodial
 * venue the POST is the commit, so everything that can be refused must be
 * refused BEFORE it, by name, and an ambiguous transport failure after it must
 * be reported as UNKNOWN — a blind retry can double-trade.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { INDEXIFY_HANDLERS } from "@vex-agent/tools/protocols/indexify/handlers.js";

/** Look a handler up or fail loudly — the registry is typed as a partial map. */
function invoke(toolId: keyof typeof INDEXIFY_HANDLERS) {
  const fn = INDEXIFY_HANDLERS[toolId];
  if (!fn) throw new Error(`missing handler ${String(toolId)}`);
  return fn;
}
import { getIndexifyClient, IndexifyClient } from "@tools/indexify/client.js";
import type { IndexifyStack } from "@tools/indexify/types.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { VexError, ErrorCodes } from "../../../../../errors.js";
import { makeProtocolContext } from "../../_test-context.js";

const CTX: ProtocolExecutionContext = makeProtocolContext();

function stack(overrides: Partial<IndexifyStack> = {}): IndexifyStack {
  return {
    id: 4139,
    stack_name: "Solana Top 5 DeFi Index",
    slug: "solana-top-5-defi-index",
    description: "Top DeFi protocols",
    category: "low_risk_long",
    creator_fee: 0.5,
    price: 0.65,
    weighted_market_cap: 680_989_445,
    change1D: 0.0005,
    change1W: 0.2,
    changeAll: -0.35,
    tvl: 2.55,
    is_company_stack: false,
    is_verified: true,
    archived: false,
    is_closed: false,
    time_p: 1_763_250_847,
    current_allocation_version: 1,
    token_weights: ["60", "40"],
    tokens: [
      { address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", name: "Jupiter", price: 0.21 },
      { address: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "JitoSOL", name: "Jito Staked SOL", price: 250 },
    ],
    user: { username: "bluebrave21374" },
    ...overrides,
  };
}

function client(): IndexifyClient {
  return getIndexifyClient();
}

afterEach(() => vi.restoreAllMocks());

// ── discovery ──────────────────────────────────────────────────────

describe("indexify.stacks", () => {
  it("projects fat provider rows to compact ones — no token objects survive", async () => {
    vi.spyOn(client(), "listStacks").mockResolvedValue([stack()]);
    const result = await invoke("indexify.stacks")({ feed: "trending" }, CTX);
    expect(result.success).toBe(true);
    const row = (result.data as { stacks: Record<string, unknown>[] }).stacks[0];
    expect(row.stackId).toBe(4139);
    expect(row.topTokenSymbols).toEqual(["JUP", "JitoSOL"]);
    expect(row.creator).toBe("bluebrave21374");
    expect(row).not.toHaveProperty("tokens");
    expect(JSON.stringify(result.data).length).toBeLessThan(1_000);
  });

  it("refuses sort on the trending feed by name instead of ignoring it", async () => {
    const spy = vi.spyOn(client(), "listStacks");
    const result = await invoke("indexify.stacks")({ feed: "trending", sort: "change1D" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("provider's own ranking");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("indexify.search", () => {
  it("says names are not unique whenever more than one row matches", async () => {
    vi.spyOn(client(), "searchStacks").mockResolvedValue([
      { stack_name: "Doge Basket", stack_id: 1, slug: "doge-basket", description_truncated: null },
      { stack_name: "Doge Basket 2", stack_id: 2, slug: "doge-basket-2", description_truncated: null },
    ]);
    const result = await invoke("indexify.search")({ query: "doge" }, CTX);
    expect(result.success).toBe(true);
    expect((result.data as { note?: string }).note).toContain("NOT unique");
  });
});

describe("indexify.stack", () => {
  it("joins weights to tokens as allocations and carries the web link", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "stackInvestors").mockResolvedValue(12);
    const result = await invoke("indexify.stack")({ slug: "solana-top-5-defi-index" }, CTX);
    expect(result.success).toBe(true);
    const detail = (result.data as { stack: Record<string, unknown> }).stack;
    expect(detail.url).toBe("https://app.indexify.finance/stacks/solana-top-5-defi-index");
    expect(detail.allocations).toEqual([
      expect.objectContaining({ symbol: "JUP", weightPercent: 60 }),
      expect.objectContaining({ symbol: "JitoSOL", weightPercent: 40 }),
    ]);
    expect((result.data as { investorCount: number }).investorCount).toBe(12);
  });

  it("a failed investor-count side read never takes the detail down", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "stackInvestors").mockRejectedValue(new Error("boom"));
    const result = await invoke("indexify.stack")({ stackId: 4139 }, CTX);
    expect(result.success).toBe(true);
    expect((result.data as { investorCount: number | null }).investorCount).toBeNull();
  });
});

// ── trade_execute preflights (everything refusable is refused BEFORE the commit) ──

describe("indexify.trade_execute", () => {
  it("refuses a direction/amount mismatch by name — never resolves it silently", async () => {
    const swap = vi.spyOn(client(), "swap");
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "sell", amountIn: "10" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("sellPercent");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses to buy a closed stack", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack({ is_closed: true }));
    const swap = vi.spyOn(client(), "swap");
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "buy", amountIn: "10" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("closed");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses a buy below the venue minimum, naming the minimum", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "minBuy").mockResolvedValue(5);
    vi.spyOn(client(), "portfolio").mockResolvedValue({
      usdcBalance: 100, usdcReserved: 0, totalBalanceUsdc: "100", walletAddress: "DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL",
    });
    const swap = vi.spyOn(client(), "swap");
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "buy", amountIn: "2" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("minimum buy of $5");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses a buy the balance cannot fund, naming balance and deposit address", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "minBuy").mockResolvedValue(5);
    vi.spyOn(client(), "portfolio").mockResolvedValue({
      usdcBalance: 3, usdcReserved: 2, totalBalanceUsdc: "5", walletAddress: "DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL",
    });
    const swap = vi.spyOn(client(), "swap");
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "buy", amountIn: "10" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("Insufficient Indexify balance");
    expect(result.output).toContain("DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL");
    expect(swap).not.toHaveBeenCalled();
  });

  it("refuses a sell with no position to sell", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "stackHoldings").mockResolvedValue({
      stack_id: 4139, total_usdc: 0, total_invested: 0, total_cost_basis: 0, amounts: [], pnl: {},
    });
    const swap = vi.spyOn(client(), "swap");
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "sell", sellPercent: 50 },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("no position to sell");
    expect(swap).not.toHaveBeenCalled();
  });

  it("a successful buy answers TRUTHFUL-PENDING with the order id, never a confirmation", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "minBuy").mockResolvedValue(5);
    vi.spyOn(client(), "portfolio").mockResolvedValue({
      usdcBalance: 100, usdcReserved: 0, totalBalanceUsdc: "100", walletAddress: "DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL",
    });
    vi.spyOn(client(), "swap").mockResolvedValue({ order_id: "ord123" });
    vi.spyOn(client(), "orderDetails").mockResolvedValue({
      order: { order_id: "ord123", status: "PENDING" }, transactions: [], transaction_count: 0,
    });
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "buy", amountIn: "10" },
      CTX,
    );
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.orderId).toBe("ord123");
    expect(data.settlement).toContain("TRUTHFUL-PENDING");
    expect(data.settlement).toContain("Do NOT retry");
  });

  it("a transport failure AT the commit reports UNKNOWN and forbids a blind retry", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "minBuy").mockResolvedValue(5);
    vi.spyOn(client(), "portfolio").mockResolvedValue({
      usdcBalance: 100, usdcReserved: 0, totalBalanceUsdc: "100", walletAddress: "DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL",
    });
    vi.spyOn(client(), "swap").mockRejectedValue(
      new VexError(ErrorCodes.INDEXIFY_TIMEOUT, "Indexify request timed out or was aborted", "Indexify did not answer in time."),
    );
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "buy", amountIn: "10" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("UNKNOWN");
    expect(result.output).toContain("double-trade");
  });

  it("a venue refusal at the commit says nothing was traded, with the venue's own reason", async () => {
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack());
    vi.spyOn(client(), "minBuy").mockResolvedValue(5);
    vi.spyOn(client(), "portfolio").mockResolvedValue({
      usdcBalance: 100, usdcReserved: 0, totalBalanceUsdc: "100", walletAddress: "DTqyUBe8RoJsS7SKVcvC6YJnEhWgBkzmo49VUwgkz5hL",
    });
    vi.spyOn(client(), "swap").mockRejectedValue(
      new VexError(ErrorCodes.INDEXIFY_INVALID_REQUEST, "Indexify rejected the request (HTTP 400: Insufficient balance)", "Insufficient balance"),
    );
    const result = await invoke("indexify.trade_execute")(
      { stackId: 4139, direction: "buy", amountIn: "10" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("nothing was traded");
  });
});

// ── order_resolve ──────────────────────────────────────────────────

describe("indexify.order_resolve", () => {
  it("refuses a resolution the venue does not currently offer, naming what it does", async () => {
    vi.spyOn(client(), "partialDetails").mockResolvedValue({
      order_id: "ord1",
      successful_tokens: [],
      failed_tokens: [],
      available_actions: { acknowledge: true, retry: false, sell_all: true },
    });
    const retry = vi.spyOn(client(), "retryOrder");
    const result = await invoke("indexify.order_resolve")({ orderId: "ord1", action: "retry" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain('does not currently offer "retry"');
    expect(result.output).toContain("acknowledge, sell_all");
    expect(retry).not.toHaveBeenCalled();
  });

  it("a retry answers with the NEW order id as TRUTHFUL-PENDING", async () => {
    vi.spyOn(client(), "partialDetails").mockResolvedValue({
      order_id: "ord1",
      successful_tokens: [],
      failed_tokens: [{}],
      available_actions: { acknowledge: true, retry: true, sell_all: true },
    });
    vi.spyOn(client(), "retryOrder").mockResolvedValue({ order_id: "ord2", retry_attempt: 1 });
    const result = await invoke("indexify.order_resolve")({ orderId: "ord1", action: "retry" }, CTX);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.newOrderId).toBe("ord2");
    expect(data.parentOrderId).toBe("ord1");
  });
});

// ── stack_create ───────────────────────────────────────────────────

describe("indexify.stack_create", () => {
  const VALID = {
    name: "Vex Agent Index",
    description: "A demo basket.",
    category: "medium_risk_long",
    allocations: {
      JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 60,
      J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 40,
    },
  };

  it("refuses weights that do not sum to exactly 100, naming the sum", async () => {
    const create = vi.spyOn(client(), "createStack");
    const result = await invoke("indexify.stack_create")(
      { ...VALID, allocations: { JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 60 } },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("sum to exactly 100");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a non-integer weight and a non-Solana mint by name", async () => {
    const fractional = await invoke("indexify.stack_create")(
      { ...VALID, allocations: { JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 60.5, J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 39.5 } },
      CTX,
    );
    expect(fractional.success).toBe(false);
    expect(fractional.output).toContain("INTEGER percent");

    const badMint = await invoke("indexify.stack_create")(
      { ...VALID, allocations: { "0xdeadbeef": 100 } },
      CTX,
    );
    expect(badMint.success).toBe(false);
    expect(badMint.output).toContain("not a Solana mint address");
  });

  it("refuses a taken name using the venue's own check, creating nothing", async () => {
    vi.spyOn(client(), "checkStackName").mockResolvedValue("TAKEN");
    vi.spyOn(client(), "tradability").mockResolvedValue({ found: true, tradingEnabled: true, archived: false, symbol: null });
    vi.spyOn(client(), "checkStackDescription").mockResolvedValue("OK");
    vi.spyOn(client(), "creatorFeeBounds").mockResolvedValue({ min: 0, max: 0.5, default: 0.5 });
    const create = vi.spyOn(client(), "createStack");
    const result = await invoke("indexify.stack_create")(VALID, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("already taken");
    expect(create).not.toHaveBeenCalled();
  });

  it("pins the creator fee to the venue's own default — never a caller value (fee-params doctrine)", async () => {
    vi.spyOn(client(), "checkStackName").mockResolvedValue("OK");
    vi.spyOn(client(), "checkStackDescription").mockResolvedValue("OK");
    vi.spyOn(client(), "creatorFeeBounds").mockResolvedValue({ min: 0, max: 0.5, default: 0.25 });
    vi.spyOn(client(), "tradability").mockResolvedValue({ found: true, tradingEnabled: true, archived: false, symbol: null });
    const create = vi.spyOn(client(), "createStack").mockResolvedValue({ success: true, stack_id: 1 });
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack({ id: 1, slug: "x" }));
    await invoke("indexify.stack_create")(VALID, CTX);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ creatorFee: 0.25 }));
  });

  it("a successful creation answers with the id, slug and public web link", async () => {
    vi.spyOn(client(), "checkStackName").mockResolvedValue("OK");
    vi.spyOn(client(), "checkStackDescription").mockResolvedValue("OK");
    vi.spyOn(client(), "creatorFeeBounds").mockResolvedValue({ min: 0, max: 0.5, default: 0.5 });
    vi.spyOn(client(), "createStack").mockResolvedValue({ success: true, stack_id: 999 });
    vi.spyOn(client(), "tradability").mockResolvedValue({ found: true, tradingEnabled: true, archived: false, symbol: null });
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack({ id: 999, slug: "vex-agent-index" }));
    const result = await invoke("indexify.stack_create")(VALID, CTX);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.stackId).toBe(999);
    expect(data.url).toBe("https://app.indexify.finance/stacks/vex-agent-index");
    expect(data.creatorFeePercent).toBe(0.5);
  });

  it("token preflight: refuses BEFORE the commit, naming EVERY floor-refused mint, not just the first", async () => {
    vi.spyOn(client(), "checkStackName").mockResolvedValue("OK");
    vi.spyOn(client(), "checkStackDescription").mockResolvedValue("OK");
    vi.spyOn(client(), "creatorFeeBounds").mockResolvedValue({ min: 0, max: 0.5, default: 0.5 });
    vi.spyOn(client(), "tradability").mockResolvedValue({ found: false });
    vi.spyOn(client(), "registerToken").mockImplementation(async (mint) => ({
      outcome: "rejected",
      reason: `Token market cap is below minimum threshold of $10,000 (${mint.slice(0, 4)})`,
    }));
    const create = vi.spyOn(client(), "createStack");
    const result = await invoke("indexify.stack_create")(VALID, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("2 of the allocation's tokens");
    expect(result.output).toContain("JUPy");
    expect(result.output).toContain("J1to");
    expect(result.output).toContain("nothing was created");
    expect(create).not.toHaveBeenCalled();
  });

  it("token preflight: unknown mints the venue accepts are registered, re-checked, reported, and the create proceeds", async () => {
    vi.spyOn(client(), "checkStackName").mockResolvedValue("OK");
    vi.spyOn(client(), "checkStackDescription").mockResolvedValue("OK");
    vi.spyOn(client(), "creatorFeeBounds").mockResolvedValue({ min: 0, max: 0.5, default: 0.5 });
    const known = new Set(["J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"]);
    vi.spyOn(client(), "tradability").mockImplementation(async (mint) =>
      known.has(mint) ? { found: true, tradingEnabled: true, archived: false, symbol: null } : { found: false });
    vi.spyOn(client(), "registerToken").mockImplementation(async (mint) => {
      known.add(mint);
      return { outcome: "registered" };
    });
    vi.spyOn(client(), "createStack").mockResolvedValue({ success: true, stack_id: 1001 });
    vi.spyOn(client(), "fetchStack").mockResolvedValue(stack({ id: 1001, slug: "vex-agent-index" }));
    const result = await invoke("indexify.stack_create")(VALID, CTX);
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.registeredTokens).toEqual(["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"]);
  });

  it("token preflight: a registration outage fails the preflight closed — never a mis-read as refusal, nothing created", async () => {
    vi.spyOn(client(), "checkStackName").mockResolvedValue("OK");
    vi.spyOn(client(), "checkStackDescription").mockResolvedValue("OK");
    vi.spyOn(client(), "creatorFeeBounds").mockResolvedValue({ min: 0, max: 0.5, default: 0.5 });
    vi.spyOn(client(), "tradability").mockResolvedValue({ found: false });
    vi.spyOn(client(), "registerToken").mockRejectedValue(
      new VexError(ErrorCodes.INDEXIFY_RATE_LIMITED, "Indexify is rate limiting or briefly unavailable (HTTP 429)"),
    );
    const create = vi.spyOn(client(), "createStack");
    const result = await invoke("indexify.stack_create")(VALID, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("preflight failed");
    expect(create).not.toHaveBeenCalled();
  });
});
