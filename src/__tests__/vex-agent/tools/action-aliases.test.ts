/**
 * Action-named READ-ONLY alias handlers (Stage 8a).
 *
 * Asserts each alias resolves the correct TARGET protocol toolId and the
 * EXACT translated params, by mocking `executeProtocolTool` to capture its
 * arguments (the underlying protocol runtime is exercised elsewhere). Covers:
 *
 *   - swap_quote family router: EVM → kyberswap.swap.quote, "solana" →
 *     solana.swap.quote, ambiguous chain → clear failure (no dispatch).
 *   - swap_quote EVM token guard: a bare symbol is rejected (no dispatch) — EVM
 *     tokens must be a contract address or native; symbols resolve via token_find.
 *   - token_check / bridge_quote pass-through translation.
 *   - bridge_status: orders.get with an id, orders.list without.
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

describe("swap_quote — family router", () => {
  // EVM token addresses (the quote path is now strict: address-or-native only).
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

  it("EVM chain dispatches kyberswap.swap.quote with amount→amountIn (native + address)", async () => {
    const result = await handleSwapQuote(
      { chain: "base", tokenIn: "ETH", tokenOut: USDC, amount: "1.5", slippageBps: 50 },
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
    await handleSwapQuote({ chain: "arb", tokenIn: "ETH", tokenOut: USDC, amount: "1" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params.chain).toBe("arbitrum");
    expect(params.amountIn).toBe("1");
    expect(params).not.toHaveProperty("slippageBps");
  });

  it("rejects a bare EVM symbol — clear fail, no dispatch (symbol must be resolved with token_find)", async () => {
    const result = await handleSwapQuote(
      { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amount: "1" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("EVM tokens must be a contract address");
    expect(result.output).toContain("token_find");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("accepts the native sentinel address and native keyword on the EVM path", async () => {
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    await handleSwapQuote({ chain: "base", tokenIn: NATIVE, tokenOut: "native", amount: "1" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params.tokenIn).toBe(NATIVE);
    expect(params.tokenOut).toBe("native");
  });

  it('chain "solana" dispatches solana.swap.quote with tokenIn→inputToken and numeric amount', async () => {
    await handleSwapQuote(
      { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amount: "2.0", slippageBps: 30 },
      CTX,
    );
    const { toolId, params } = lastCall();
    expect(toolId).toBe("solana.swap.quote");
    expect(params).toEqual({
      inputToken: "SOL",
      outputToken: "USDC",
      amount: 2,
      slippageBps: 30,
    });
    // Solana manifest types amount as number — the alias must coerce.
    expect(typeof params.amount).toBe("number");
  });

  it("ambiguous/unknown chain fails clearly and does NOT dispatch", async () => {
    const result = await handleSwapQuote(
      { chain: "not-a-chain", tokenIn: "A", tokenOut: "B", amount: "1" },
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

  it("rejects a non-numeric Solana amount (no dispatch)", async () => {
    const result = await handleSwapQuote(
      { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amount: "abc" },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("positive number");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap_quote — Robinhood Chain 4663 routes to KyberSwap primary, Uniswap fallback", () => {
  const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";
  const VEX = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b";

  it("chain 'robinhood' → kyberswap.swap.quote (KyberSwap now aggregates 4663; Uniswap is the fallback)", async () => {
    await handleSwapQuote({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amount: "1.5" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params).toEqual({ chain: "robinhood", tokenIn: VIRTUAL, tokenOut: VEX, amountIn: "1.5" });
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
  });

  it("a chain with NO venue (neither kyber nor uniswap) → clean error, NO dispatch", async () => {
    const result = await handleSwapQuote({ chain: "narnia", tokenIn: VIRTUAL, tokenOut: VEX, amount: "1" }, CTX);
    expect(result.success).toBe(false);
    expect(result.output).toContain("swap family");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap_quote — runtime Kyber→Uniswap QUOTE fallback (LOCKED #3)", () => {
  // Base is KyberSwap-primary AND has a verified Uniswap deployment → eligible.
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const WETH = "0x4200000000000000000000000000000000000006";

  it("kyber TRANSPORT failure + Uniswap deployment present → uniswap.swap.quote returned", async () => {
    executeProtocolTool
      .mockResolvedValueOnce({ success: false, output: "kyberswap.swap.quote failed (timeout): upstream timed out" })
      .mockResolvedValueOnce({ success: true, output: "uniswap-ok", data: { chainId: 8453 } });

    const result = await handleSwapQuote({ chain: "base", tokenIn: WETH, tokenOut: USDC, amount: "1" }, CTX);

    expect(executeProtocolTool).toHaveBeenCalledTimes(2);
    // First attempt = KyberSwap primary; fallback = Uniswap with the base key.
    expect((executeProtocolTool.mock.calls[0]![0] as { toolId: string }).toolId).toBe("kyberswap.swap.quote");
    const fb = executeProtocolTool.mock.calls[1]![0] as { toolId: string; params: Record<string, unknown> };
    expect(fb.toolId).toBe("uniswap.swap.quote");
    expect(fb.params).toEqual({ chain: "base", tokenIn: WETH, tokenOut: USDC, amountIn: "1" });
    expect(result.output).toBe("uniswap-ok"); // the Uniswap quote is what the agent sees
  });

  it("kyber no-route (provider_error) + Uniswap deployment → falls back", async () => {
    executeProtocolTool
      .mockResolvedValueOnce({ success: false, output: "kyberswap.swap.quote failed (provider_error): no route found" })
      .mockResolvedValueOnce({ success: true, output: "uniswap-ok" });
    await handleSwapQuote({ chain: "base", tokenIn: WETH, tokenOut: USDC, amount: "1" }, CTX);
    expect(executeProtocolTool).toHaveBeenCalledTimes(2);
    expect((executeProtocolTool.mock.calls[1]![0] as { toolId: string }).toolId).toBe("uniswap.swap.quote");
  });

  it("kyber SUCCESS with a honeypot/safety verdict → NO fallback (block stands)", async () => {
    executeProtocolTool.mockResolvedValueOnce({
      success: true,
      output: "kyber-ok",
      data: { chainId: 8453, safety: { tokenIn: { isHoneypot: true, isFOT: false, tax: 0 } } },
    });
    const result = await handleSwapQuote({ chain: "base", tokenIn: WETH, tokenOut: USDC, amount: "1" }, CTX);
    // A successful quote is never re-routed — the KyberSwap safety verdict stands.
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    expect((executeProtocolTool.mock.calls[0]![0] as { toolId: string }).toolId).toBe("kyberswap.swap.quote");
    expect(result.output).toBe("kyber-ok");
  });

  it("kyber failure + NO Uniswap deployment on the chain → clean KyberSwap error, NO fallback", async () => {
    // Avalanche is KyberSwap-supported but has no verified Uniswap deployment.
    executeProtocolTool.mockResolvedValueOnce({ success: false, output: "kyberswap.swap.quote failed (timeout): upstream timed out" });
    const result = await handleSwapQuote({ chain: "avalanche", tokenIn: WETH, tokenOut: USDC, amount: "1" }, CTX);
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.output).toContain("failed (timeout)");
  });

  it("kyber failure with a NON-eligible category (auth) → NO fallback", async () => {
    executeProtocolTool.mockResolvedValueOnce({ success: false, output: "kyberswap.swap.quote failed (auth): forbidden" });
    const result = await handleSwapQuote({ chain: "base", tokenIn: WETH, tokenOut: USDC, amount: "1" }, CTX);
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
  });
});

describe("token_check — pass-through to kyberswap.tokens.check", () => {
  it("forwards chain + address verbatim", async () => {
    await handleTokenCheck({ chain: "ethereum", address: "0xabc" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("kyberswap.tokens.check");
    expect(params).toEqual({ chain: "ethereum", address: "0xabc" });
  });

  it("rejects missing address (no dispatch)", async () => {
    const result = await handleTokenCheck({ chain: "ethereum" }, CTX);
    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("bridge_status — orders.get (id) vs orders.list (no id)", () => {
  it("with orderId routes to khalani.orders.get", async () => {
    await handleBridgeStatus({ orderId: "order_abc123" }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.orders.get");
    expect(params).toEqual({ orderId: "order_abc123" });
  });

  it("without orderId routes to khalani.orders.list and forwards provided filters", async () => {
    await handleBridgeStatus({ wallet: "solana", limit: 20 }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.orders.list");
    expect(params).toEqual({ wallet: "solana", limit: 20 });
  });

  it("orderId takes precedence — list filters are ignored when an id is present", async () => {
    await handleBridgeStatus({ orderId: "order_x", wallet: "solana", limit: 5 }, CTX);
    const { toolId, params } = lastCall();
    expect(toolId).toBe("khalani.orders.get");
    expect(params).toEqual({ orderId: "order_x" });
  });
});

describe("bridge_quote — pass-through to khalani.quote.get", () => {
  it("forwards required + provided optional params", async () => {
    await handleBridgeQuote(
      {
        fromChain: "ethereum",
        fromToken: "0xfrom",
        toChain: "solana",
        toToken: "mintTo",
        amount: "1000000",
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
      amount: "1000000",
      tradeType: "EXACT_INPUT",
    });
  });

  it("omits optional params that were not supplied", async () => {
    await handleBridgeQuote(
      { fromChain: "1", fromToken: "0xa", toChain: "8453", toToken: "0xb", amount: "5" },
      CTX,
    );
    const { params } = lastCall();
    expect(params).toEqual({
      fromChain: "1",
      fromToken: "0xa",
      toChain: "8453",
      toToken: "0xb",
      amount: "5",
    });
    expect(params).not.toHaveProperty("tradeType");
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
        amount: "1000000",
        referrer: "0x" + "ef".repeat(20), // Khalani-only — must be dropped
        slippageBps: "50", // Relay-only — must pass through
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
      amount: "1000000",
      slippageBps: "50",
    });
    expect(params).not.toHaveProperty("referrer");
  });

  it("fromChain '4663' → relay.quote.get (either side local routes to Relay)", async () => {
    await handleBridgeQuote(
      { fromChain: "4663", fromToken: VIRTUAL, toChain: "base", toToken: BASE_USDC, amount: "1000000" },
      CTX,
    );
    expect(lastCall().toolId).toBe("relay.quote.get");
  });
});
