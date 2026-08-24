/**
 * Action-named READ-ONLY alias handlers (Stage 8a; Agent Scan plan §11.2
 * rewired SwapQuote — FIX-SPINE round 1 corrected this file for the
 * `amount`→`amountIn` rename, the removed silent Kyber→Uniswap fallback, and
 * the new `.strict()` schemas, none of which were fixed when round 1 first
 * made those changes).
 *
 * Asserts each alias resolves the correct TARGET protocol toolId and the
 * EXACT translated params, by mocking `executeProtocolTool` to capture its
 * arguments (the underlying protocol runtime is exercised elsewhere). Covers:
 *
 *   - SwapQuote family router: EVM → kyberswap.swap.quote ONLY (no venue
 *     fallback — plan §11.2), "solana" → solana.swap.quote, ambiguous chain →
 *     clear failure (no dispatch).
 *   - SwapQuote EVM token guard: a bare symbol is rejected (no dispatch) — EVM
 *     tokens must be a contract address or native; symbols resolve via TokenFind.
 *   - TokenCheck / BridgeQuote pass-through translation.
 *   - BridgeStatus: orders.get with an id, orders.list without, and a by-name
 *     rejection when the two modes are mixed (W2d).
 *
 * `resolveChainSlug` is NOT mocked — the router's real EVM/Solana decision is
 * under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the (toolId, params) every alias dispatches. The handlers import
// `executeProtocolTool` from "../protocols/runtime.js"; mocking that module
// here intercepts the call and lets us assert the translated request.
// `vi.hoisted` is required because the `vi.mock` factory is hoisted above
// regular top-level declarations.
const { executeProtocolTool } = vi.hoisted(() => ({
  executeProtocolTool: vi.fn(async () => ({ success: true, output: "ok" })),
}));

vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool,
}));

import {
  handleSwapQuote,
  handleTokenCheck,
  handleBridgeStatus,
  handleBridgeQuote,
} from "@vex-agent/tools/internal/action-aliases.js";
import { ACTION_ALIAS_TOOLS } from "@vex-agent/tools/registry/action-aliases.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

// Minimal context — the aliases only forward the execution-context slice
// `protocolContext()` projects; the rest is never read by these handlers.
const CTX = {
  sessionPermission: "restricted",
  approved: false,
  sessionId: "sess-1",
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
} as unknown as InternalToolContext;

function lastCall(): { toolId: string; params: Record<string, unknown> } {
  const call = executeProtocolTool.mock.calls.at(-1);
  if (!call) throw new Error("executeProtocolTool was not called");
  const request = call[0] as { toolId: string; params: Record<string, unknown> };
  return { toolId: request.toolId, params: request.params };
}

beforeEach(() => {
  executeProtocolTool.mockClear();
});

describe("SwapQuote — family router", () => {
  // EVM token addresses (the quote path is now strict: address-or-native only).
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("EVM chain dispatches kyberswap.swap.quote with amountIn passed through", async () => {
    const result = await handleSwapQuote(
      { chain: "base", tokenIn: "ETH", tokenOut: USDC, amountIn: "1.5", slippageBps: 50 },
      CTX,
    );
    expect(result.success).toBe(true);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params).toEqual({
      chain: "base",
      tokenIn: "ETH",
      tokenOut: USDC,
      amountIn: "1.5",
      slippageBps: 50,
    });
  });

  it("EVM alias chain is normalized to the canonical slug (arb → arbitrum)", async () => {
    await handleSwapQuote({ chain: "arb", tokenIn: "ETH", tokenOut: USDC, amountIn: "1" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params.chain).toBe("arbitrum");
    expect(params.amountIn).toBe("1");
    expect(params).not.toHaveProperty("slippageBps");
  });

  it("rejects a bare EVM symbol — clear fail, no dispatch (symbol must be resolved with TokenFind)", async () => {
    const result = await handleSwapQuote(
      { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "1" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("EVM tokens must be a contract address");
    expect(result.output).toContain("TokenFind");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("accepts the native sentinel address and native keyword on the EVM path", async () => {
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    await handleSwapQuote({ chain: "base", tokenIn: NATIVE, tokenOut: "native", amountIn: "1" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params.tokenIn).toBe(NATIVE);
    expect(params.tokenOut).toBe("native");
  });

  it('chain "solana" dispatches solana.swap.quote with the SAME keys (W5a — no translation left)', async () => {
    await handleSwapQuote(
      { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "2.0", slippageBps: 30 },
      CTX,
    );
    const { toolId, params } = lastCall();
    expect(toolId).toBe("solana.swap.quote");
    expect(params).toEqual({
      tokenIn: "SOL",
      tokenOut: "USDC",
      amountIn: "2.0",
      slippageBps: 30,
    });
    // The decimal string travels VERBATIM — the alias no longer round-trips a
    // trade amount through `Number()` on its way to the Jupiter lane.
    expect(typeof params.amountIn).toBe("string");
  });

  it("ambiguous/unknown chain fails clearly and does NOT dispatch", async () => {
    const result = await handleSwapQuote(
      { chain: "not-a-chain", tokenIn: "A", tokenOut: "B", amountIn: "1" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("swap family");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("rejects missing required args at the boundary (no dispatch)", async () => {
    const result = await handleSwapQuote({ chain: "base", tokenIn: "ETH" }, CTX);
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  // W5a moved the amount check to ONE owner. The alias no longer parses the
  // amount at all (it would have to guess the mint's decimals to do it
  // faithfully); `solana.swap.quote`'s own conversion rejects a non-decimal
  // spelling by name, with the mint's decimals in hand.
  it("passes a malformed Solana amount through to the tool that owns the rejection", async () => {
    await handleSwapQuote(
      { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "abc" },
      CTX,
    );
    expect(lastCall().params).toMatchObject({ amountIn: "abc" });
  });

  it("REJECTS the legacy 'amount' field — .strict() schema, no silent fallback to amountIn (FIX-SPINE finding 14/C4)", async () => {
    const result = await handleSwapQuote(
      { chain: "base", tokenIn: "ETH", tokenOut: USDC, amount: "1.5" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("SwapQuote — Robinhood Chain 4663 is KyberSwap-supported (plan §11.2 — EVM is ALWAYS KyberSwap, no fallback)", () => {
  const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
  const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";

  it("chain 'robinhood' → kyberswap.swap.quote (KyberSwap aggregates 4663)", async () => {
    await handleSwapQuote({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params).toEqual({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" });
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("a chain with NO venue (neither kyber nor uniswap) → clean error, NO dispatch", async () => {
    const result = await handleSwapQuote({ chain: "narnia", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("swap family");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("SwapQuote — NO runtime Kyber→Uniswap fallback (plan §11.2/§4.2 removed it; Agent Scan hidden pair replaces it)", () => {
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const WETH = "0x4200000000000000000000000000000000000006";

  it("kyber TRANSPORT failure on a KyberSwap-supported chain → the Kyber failure is returned VERBATIM, NO second call", async () => {
    executeProtocolTool.mockResolvedValueOnce({
      success: false,
      output: "kyberswap.swap.quote failed (timeout): upstream timed out",
    });
    const result = await handleSwapQuote({ chain: "base", tokenIn: WETH, tokenOut: USDC, amountIn: "1" }, CTX);
    // The old silent Kyber→Uniswap fallback is REMOVED — exactly one call,
    // and the model sees the raw Kyber failure (its own text may point it at
    // SwapQuoteUniswap once W2a's handler reveals it — that reveal call is
    // W2a's, not this alias's, for an in-band Kyber API failure).
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    expect((executeProtocolTool.mock.calls[0]![0] as { toolId: string }).toolId).toBe("kyberswap.swap.quote");
    expect(result.success).toBe(false);
    expect(result.output).toContain("failed (timeout)");
  });

  it("kyber SUCCESS with a honeypot/safety verdict passes straight through", async () => {
    executeProtocolTool.mockResolvedValueOnce({
      success: true,
      output: "kyber-ok",
      data: { chainId: 8453, safety: { tokenIn: { isHoneypot: true, isFOT: false, tax: 0 } } },
    });
    const result = await handleSwapQuote({ chain: "base", tokenIn: WETH, tokenOut: USDC, amountIn: "1" }, CTX);
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    expect((executeProtocolTool.mock.calls[0]![0] as { toolId: string }).toolId).toBe("kyberswap.swap.quote");
    expect(result.output).toBe("kyber-ok");
  });

});

describe("TokenCheck — pass-through to kyberswap.tokens.check", () => {
  it("forwards chain + tokenAddress verbatim", async () => {
    await handleTokenCheck({ chain: "ethereum", tokenAddress: "0xabc" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.tokens.check");
    expect(params).toEqual({ chain: "ethereum", tokenAddress: "0xabc" });
  });

  it("rejects missing tokenAddress (no dispatch)", async () => {
    const result = await handleTokenCheck({ chain: "ethereum" }, CTX);
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("BridgeStatus — orders.get (id) vs orders.list (no id)", () => {
  it("with orderId routes to khalani.orders.get", async () => {
    await handleBridgeStatus({ orderId: "order_abc123" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.orders.get");
    expect(params).toEqual({ orderId: "order_abc123" });
  });

  it("without orderId routes to khalani.orders.list and forwards provided filters", async () => {
    await handleBridgeStatus({ walletFamily: "solana", limit: 20 }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.orders.list");
    expect(params).toEqual({ walletFamily: "solana", limit: 20 });
  });

  // D15: the two retired spellings are rewritten BEFORE the schema parse, so the
  // target sees only the canonical keys. `BridgeStatusArgs` strips undeclared
  // keys, which is why the rewrite cannot live after it: `address` would have
  // vanished and the call would have listed the WRONG wallet's orders silently.
  it("rewrites the retired `address` / `wallet` spellings before the schema parse", async () => {
    await handleBridgeStatus({ address: "0xabc", wallet: "eip155", limit: 3 }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.orders.list");
    expect(params).toEqual({ walletAddress: "0xabc", walletFamily: "eip155", limit: 3 });
  });

  it("refuses BY NAME when a retired spelling and its canonical key both arrive", async () => {
    const result = await handleBridgeStatus({ wallet: "eip155", walletFamily: "solana" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain('"wallet"');
    expect(result.output).toContain('"walletFamily"');
    expect(result.output).toContain("Vex will not guess which one you meant");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  // W2d: orderId no longer "takes precedence" — the combination is REJECTED BY
  // NAME. Silently forwarding orderId discarded every list filter the agent
  // also supplied, and the agent had no way to learn they were never applied
  // (SPEC §2.4 item 22).
  it("rejects orderId combined with list filters, naming what would be discarded", async () => {
    const result = await handleBridgeStatus({ orderId: "order_x", walletFamily: "solana", limit: 5 }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("BridgeStatus takes EITHER orderId (one order) OR the list filters");
    expect(result.output).toContain("walletFamily, limit");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("refuses `address` together with `walletAddress` before the schema parse", async () => {
    const result = await handleBridgeStatus({ address: "0xabc", walletAddress: "0xdef" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain('"address"');
    expect(result.output).toContain('"walletAddress"');
    expect(result.output).toContain("Vex will not guess which one you meant");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("treats orderId plus a RETIRED list key as the same mode conflict, on the canonical name", async () => {
    // The rewrite runs before conflict detection, so the conflict is detected
    // and reported in the canonical vocabulary, never missed because the
    // retired spelling is absent from the list-only set.
    const result = await handleBridgeStatus({ orderId: "order_x", wallet: "solana" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("BridgeStatus takes EITHER orderId (one order) OR the list filters");
    expect(result.output).toContain("walletFamily");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("advertises canonical keys only: the schema has no retired property and teaches no retired spelling", () => {
    const bridgeStatus = ACTION_ALIAS_TOOLS.find((tool) => tool.name === "BridgeStatus");
    if (!bridgeStatus) throw new Error("BridgeStatus is not registered in ACTION_ALIAS_TOOLS");
    const properties = bridgeStatus.parameters["properties"];
    if (typeof properties !== "object" || properties === null) throw new Error("BridgeStatus has no properties");
    const keys = Object.keys(properties);
    expect(keys).toContain("walletAddress");
    expect(keys).toContain("walletFamily");
    expect(keys).not.toContain("address");
    expect(keys).not.toContain("wallet");
    // D15: the model-visible schema advertises the canonical key alone; a
    // retired spelling named in a description would teach it back.
    const descriptions = JSON.stringify(properties) + bridgeStatus.description;
    expect(descriptions).not.toMatch(/former key|retired|rewritten to/i);
  });
});

describe("BridgeQuote — pass-through to khalani.quote.get", () => {
  it("forwards required + provided optional params", async () => {
    await handleBridgeQuote(
      {
        fromChain: "ethereum",
        fromToken: "0xfrom",
        toChain: "solana",
        toToken: "mintTo",
        amountRaw: "1000000",
        tradeType: "EXACT_INPUT",
      },
      CTX,
    );
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.quote.get");
    expect(params).toEqual({
      fromChain: "ethereum",
      fromToken: "0xfrom",
      toChain: "solana",
      toToken: "mintTo",
      amountRaw: "1000000",
      tradeType: "EXACT_INPUT",
    });
  });

  it("omits optional params that were not supplied", async () => {
    await handleBridgeQuote(
      { fromChain: "1", fromToken: "0xa", toChain: "8453", toToken: "0xb", amountRaw: "5" },
      CTX,
    );
    const { params } = lastCall();
    expect(params).toEqual({
      fromChain: "1",
      fromToken: "0xa",
      toChain: "8453",
      toToken: "0xb",
      amountRaw: "5",
    });
    expect(params).not.toHaveProperty("tradeType");
  });

  it("REJECTS slippageBps BY NAME on a Khalani route (never silently dropped)", async () => {
    // Khalani exposes no slippage tolerance; accepting the param told the agent
    // it had bought price protection it did not have.
    const result = await handleBridgeQuote(
      { fromChain: "1", fromToken: "0xa", toChain: "8453", toToken: "0xb", amountRaw: "5", slippageBps: 100 },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("slippageBps");
    expect(result.output).toMatch(/NO slippage protection applies/);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("rejects missing required params (no dispatch)", async () => {
    const result = await handleBridgeQuote({ fromChain: "1" }, CTX);
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  // ── Robinhood Chain 4663 routes to Relay, never Khalani (LOCKED #3) ──
  const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
  const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  it("toChain 'robinhood' → relay.quote.get (NOT khalani), Khalani-only fields dropped", async () => {
    await handleBridgeQuote(
      {
        fromChain: "base",
        fromToken: BASE_USDC,
        toChain: "robinhood",
        toToken: VIRTUAL,
        amountRaw: "1000000",
        filler: "native-filler", // Khalani-only — must be dropped
        slippageBps: 50, // Relay-only — must pass through
      },
      CTX,
    );
    const { toolId, params } = lastCall();
    expect(toolId).toBe("relay.quote.get");
    expect(toolId).not.toContain("khalani");
    expect(params).toEqual({
      fromChain: "base",
      fromToken: BASE_USDC,
      toChain: "robinhood",
      toToken: VIRTUAL,
      amountRaw: "1000000",
      slippageBps: 50,
    });
    expect(params).not.toHaveProperty("filler");
  });

  it("REJECTS a model-supplied referrer / referrerFeeBps BY NAME (NOT dropped, NOT dispatched)", async () => {
    // `BridgeQuoteArgs` is not `.strict()`, so without an explicit guard Zod
    // would silently strip these and dispatch a clean-looking quote. A recorded
    // fee-bearing QUOTE is what the prequote gate would later bind a fee-bearing
    // EXECUTE against, so the quote side must refuse just as loudly.
    for (const bad of [
      { referrer: "0x" + "ef".repeat(20) },
      { referrerFeeBps: "9999" },
    ]) {
      executeProtocolTool.mockClear();
      const result = await handleBridgeQuote(
        {
          fromChain: "ethereum",
          fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          toChain: "base",
          toToken: BASE_USDC,
          amountRaw: "1000000",
          ...bad,
        },
        CTX,
      );
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/^BridgeQuote:/);
      expect(result.output).toMatch(/referrer/);
      expect(result.output).toContain("not an accepted parameter");
      expect(executeProtocolTool).not.toHaveBeenCalled();
    }
  });

  it("fromChain '4663' → relay.quote.get (either side local routes to Relay)", async () => {
    await handleBridgeQuote(
      { fromChain: "4663", fromToken: VIRTUAL, toChain: "base", toToken: BASE_USDC, amountRaw: "1000000" },
      CTX,
    );
    expect(lastCall().toolId).toBe("relay.quote.get");
  });
});
