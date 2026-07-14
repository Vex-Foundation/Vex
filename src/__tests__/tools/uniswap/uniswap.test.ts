/**
 * Uniswap substrate unit tests (Wave 2c) — deployment registry, venue router,
 * quote route selection (mocked RPC), calldata builders, allowance allowlist,
 * and the prequote safety-extractor branch.
 *
 * No live RPC: quoting is exercised with a fake `readContract` client; builders
 * are pure and decoded with viem; the extractor is pure over result shapes.
 */

import { describe, it, expect } from "vitest";
import { decodeFunctionData, type Address } from "viem";

import {
  getUniswapDeployment,
  isUniswapChain,
  UNISWAP_KNOWN_SPENDERS,
} from "@tools/uniswap/deployments.js";
import {
  resolveSwapVenues,
  isFallbackEligibleQuoteCategory,
  resolveUniswapFallbackChainKey,
} from "@tools/uniswap/venue-router.js";
import { resolveUniswapChainId } from "@tools/uniswap/chains.js";
import { quoteBestRoute, applySlippage } from "@tools/uniswap/quote.js";
import { buildV2SwapTx, buildV3SwapTx, NATIVE_TOKEN_ADDRESS } from "@tools/uniswap/execute.js";
import { validateUniswapSpender } from "@tools/uniswap/erc20.js";
import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V3_SWAP_ROUTER_02_ABI } from "@tools/uniswap/abis.js";
import type { UniswapRoute, UniswapToken } from "@tools/uniswap/types.js";
import { extractQuote } from "@vex-agent/tools/protocols/prequote/safety/extract.js";

const ROBINHOOD = getUniswapDeployment(4663)!;
const TOKEN_A: Address = "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b"; // VEX
const TOKEN_B: Address = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31"; // VIRTUAL

function tok(address: Address, isNative = false): UniswapToken {
  return { address, symbol: "T", decimals: 18, isNative };
}

// ── Deployment registry + spender allowlist ─────────────────────────────────

describe("uniswap deployment registry", () => {
  it("has the on-chain-verified Robinhood 4663 deployment", () => {
    expect(ROBINHOOD.chainId).toBe(4663);
    expect(ROBINHOOD.v2?.router02.toLowerCase()).toBe("0x89e5db8b5aa49aa85ac63f691524311aeb649eba");
    expect(ROBINHOOD.v3?.swapRouter02.toLowerCase()).toBe("0xcaf681a66d020601342297493863e78c959e5cb2");
    expect(ROBINHOOD.v3?.quoterV2.toLowerCase()).toBe("0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7");
    expect(ROBINHOOD.weth.toLowerCase()).toBe("0x0bd7d308f8e1639fab988df18a8011f41eacad73");
  });

  it("registers the major kyber-overlap chains + not unknown ones", () => {
    for (const id of [1, 8453, 42161, 10, 137, 56]) expect(isUniswapChain(id)).toBe(true);
    expect(isUniswapChain(999999)).toBe(false);
  });

  it("KNOWN_SPENDERS contains every registered router, lowercased", () => {
    expect(UNISWAP_KNOWN_SPENDERS.has(ROBINHOOD.v2!.router02.toLowerCase())).toBe(true);
    expect(UNISWAP_KNOWN_SPENDERS.has(ROBINHOOD.v3!.swapRouter02.toLowerCase())).toBe(true);
    // A stale/uppercase or unknown address is NOT allowlisted.
    expect(UNISWAP_KNOWN_SPENDERS.has("0x000000000000000000000000000000000000dead")).toBe(false);
  });

  it("validateUniswapSpender allows a router, rejects anything else", () => {
    expect(() => validateUniswapSpender(ROBINHOOD.v2!.router02)).not.toThrow();
    expect(() => validateUniswapSpender("0x000000000000000000000000000000000000dEaD")).toThrow(/not a known Uniswap router/);
  });
});

// ── Venue router + chain resolution ─────────────────────────────────────────

describe("swap venue router", () => {
  it("Robinhood Chain resolves to kyber PRIMARY with uniswap fallback (KyberSwap now aggregates 4663)", () => {
    const r = resolveSwapVenues("robinhood");
    expect(r?.primary.venue).toBe("kyberswap");
    expect(r?.options.map((o) => o.venue)).toEqual(["kyberswap", "uniswap"]);
    expect(resolveUniswapChainId("robinhood")).toBe(4663);
    expect(resolveUniswapChainId("4663")).toBe(4663);
  });

  it("a kyber chain keeps kyber PRIMARY with uniswap as a fallback option", () => {
    const r = resolveSwapVenues("base");
    expect(r?.primary.venue).toBe("kyberswap");
    expect(r?.options.map((o) => o.venue)).toEqual(["kyberswap", "uniswap"]);
  });

  it("an unsupported chain resolves to nothing", () => {
    expect(resolveSwapVenues("not-a-chain")).toBeUndefined();
    expect(resolveUniswapChainId("not-a-chain")).toBeUndefined();
  });
});

// ── Runtime Kyber→Uniswap fallback policy (LOCKED #3) ────────────────────────

describe("venue-router runtime fallback policy", () => {
  it("resolveUniswapFallbackChainKey returns the deployment key where Uniswap is verified", () => {
    expect(resolveUniswapFallbackChainKey("base")).toBe("base");
    expect(resolveUniswapFallbackChainKey("robinhood")).toBe("robinhood");
    expect(resolveUniswapFallbackChainKey("4663")).toBe("robinhood");
  });

  it("resolveUniswapFallbackChainKey is undefined where Uniswap has no verified deployment", () => {
    // Avalanche is KyberSwap-supported but absent from the Uniswap registry.
    expect(resolveUniswapFallbackChainKey("avalanche")).toBeUndefined();
    expect(resolveUniswapFallbackChainKey("narnia")).toBeUndefined();
  });

  it("isFallbackEligibleQuoteCategory covers transport/API/route failures only", () => {
    for (const c of ["timeout", "network", "rate_limit", "provider_error"]) {
      expect(isFallbackEligibleQuoteCategory(c)).toBe(true);
    }
    // A safety verdict never fails a quote; auth/unknown/empty are not re-routed.
    for (const c of ["auth", "unknown", ""]) {
      expect(isFallbackEligibleQuoteCategory(c)).toBe(false);
    }
  });
});

// ── Quote route selection (mocked RPC) ──────────────────────────────────────

interface MockCall { functionName: string; args?: readonly unknown[]; address: Address }

function mockClient(handler: (c: MockCall) => unknown) {
  return {
    readContract: async (c: MockCall) => {
      const out = handler(c);
      if (out === undefined) throw new Error("revert");
      return out;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("quoteBestRoute", () => {
  it("picks the highest-output candidate across V2 and V3", async () => {
    // V2 direct → 100; V3 single fee 3000 → 200 (wins); all else reverts.
    const client = mockClient((c) => {
      if (c.functionName === "getAmountsOut") {
        const path = c.args?.[1] as Address[];
        if (path.length === 2) return [1000n, 100n];
        return undefined;
      }
      if (c.functionName === "quoteExactInputSingle") {
        const p = c.args?.[0] as { fee: number };
        if (p.fee === 3000) return [200n, 0n, 0, 50000n];
        return undefined;
      }
      return undefined;
    });
    const best = await quoteBestRoute(client, { deployment: ROBINHOOD, tokenIn: tok(TOKEN_A), tokenOut: tok(TOKEN_B), amountIn: 1000n });
    expect(best?.route.version).toBe("v3");
    expect(best?.route.fees).toEqual([3000]);
    expect(best?.route.amountOut).toBe(200n);
  });

  it("returns null when every candidate reverts (no pool)", async () => {
    const best = await quoteBestRoute(mockClient(() => undefined), {
      deployment: ROBINHOOD, tokenIn: tok(TOKEN_A), tokenOut: tok(TOKEN_B), amountIn: 1000n,
    });
    expect(best).toBeNull();
  });

  it("applySlippage floors the min out", () => {
    expect(applySlippage(1000n, 50)).toBe(995n); // -0.5%
    expect(applySlippage(1000n, 0)).toBe(1000n);
    expect(applySlippage(1000n, 10000)).toBe(0n);
  });
});

// ── Calldata builders (pure) ────────────────────────────────────────────────

const V2_ROUTE: UniswapRoute = { version: "v2", path: [TOKEN_A, TOKEN_B], amountOut: 500n };
const V3_ROUTE: UniswapRoute = { version: "v3", path: [TOKEN_A, TOKEN_B], fees: [3000], amountOut: 500n };
const RECIP: Address = "0x1111111111111111111111111111111111111111";
const DEADLINE = 1_900_000_000n;

describe("V2 calldata builders", () => {
  it("token→token → swapExactTokensForTokensSupportingFeeOnTransferTokens, value 0", () => {
    const tx = buildV2SwapTx({ deployment: ROBINHOOD, route: V2_ROUTE, amountIn: 1000n, minAmountOut: 995n, recipient: RECIP, deadline: DEADLINE, tokenInIsNative: false, tokenOutIsNative: false });
    expect(tx.value).toBe(0n);
    const dec = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: tx.data });
    expect(dec.functionName).toBe("swapExactTokensForTokensSupportingFeeOnTransferTokens");
    expect(dec.args?.[0]).toBe(1000n);
    expect(dec.args?.[1]).toBe(995n);
    expect(dec.args?.[3]).toBe(RECIP);
  });

  it("native input → swapExactETHForTokens with value = amountIn", () => {
    const tx = buildV2SwapTx({ deployment: ROBINHOOD, route: V2_ROUTE, amountIn: 1000n, minAmountOut: 995n, recipient: RECIP, deadline: DEADLINE, tokenInIsNative: true, tokenOutIsNative: false });
    expect(tx.value).toBe(1000n);
    const dec = decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: tx.data });
    expect(dec.functionName).toBe("swapExactETHForTokens");
  });

  it("native output → swapExactTokensForETHSupportingFeeOnTransferTokens, value 0", () => {
    const tx = buildV2SwapTx({ deployment: ROBINHOOD, route: V2_ROUTE, amountIn: 1000n, minAmountOut: 995n, recipient: RECIP, deadline: DEADLINE, tokenInIsNative: false, tokenOutIsNative: true });
    expect(tx.value).toBe(0n);
    expect(decodeFunctionData({ abi: UNISWAP_V2_ROUTER_ABI, data: tx.data }).functionName).toBe("swapExactTokensForETHSupportingFeeOnTransferTokens");
  });
});

describe("V3 calldata builders", () => {
  it("token→token → multicall([exactInputSingle]), deadline bound", () => {
    const tx = buildV3SwapTx({ deployment: ROBINHOOD, route: V3_ROUTE, amountIn: 1000n, minAmountOut: 995n, recipient: RECIP, deadline: DEADLINE, tokenInIsNative: false, tokenOutIsNative: false });
    expect(tx.value).toBe(0n);
    const outer = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data: tx.data });
    expect(outer.functionName).toBe("multicall");
    expect(outer.args?.[0]).toBe(DEADLINE);
    const inner = (outer.args?.[1] as `0x${string}`[]);
    expect(inner).toHaveLength(1);
    const call = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data: inner[0]! });
    expect(call.functionName).toBe("exactInputSingle");
    const params = call.args?.[0] as { recipient: Address; amountOutMinimum: bigint };
    expect(params.recipient).toBe(RECIP);
    expect(params.amountOutMinimum).toBe(995n);
  });

  it("native output → swap to ADDRESS_THIS + unwrapWETH9 to user, value 0", () => {
    const tx = buildV3SwapTx({ deployment: ROBINHOOD, route: V3_ROUTE, amountIn: 1000n, minAmountOut: 995n, recipient: RECIP, deadline: DEADLINE, tokenInIsNative: false, tokenOutIsNative: true });
    const outer = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data: tx.data });
    const inner = outer.args?.[1] as `0x${string}`[];
    expect(inner).toHaveLength(2);
    const swap = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data: inner[0]! });
    expect((swap.args?.[0] as { recipient: Address }).recipient).toBe("0x0000000000000000000000000000000000000002");
    const unwrap = decodeFunctionData({ abi: UNISWAP_V3_SWAP_ROUTER_02_ABI, data: inner[1]! });
    expect(unwrap.functionName).toBe("unwrapWETH9");
    expect(unwrap.args?.[1]).toBe(RECIP);
  });

  it("native input → value = amountIn", () => {
    const tx = buildV3SwapTx({ deployment: ROBINHOOD, route: V3_ROUTE, amountIn: 1000n, minAmountOut: 995n, recipient: RECIP, deadline: DEADLINE, tokenInIsNative: true, tokenOutIsNative: false });
    expect(tx.value).toBe(1000n);
  });
});

// ── Prequote safety extractor (uniswap branch) ──────────────────────────────

function uniQuoteData(safety: unknown) {
  return { chainId: 4663, tokenIn: { address: TOKEN_A }, tokenOut: { address: TOKEN_B }, safety };
}

describe("extractQuote — uniswap safety verdict", () => {
  const params = { amountIn: "10", slippageBps: 50 };

  it("factory ok + liquidity above threshold + no FoT → pass", () => {
    const q = extractQuote("uniswap.swap.quote", params, uniQuoteData({
      factory: { checked: true, allowlisted: true },
      liquidity: { checked: true, usd: 100000, aboveThreshold: true },
      fot: { suspected: false },
    }));
    expect(q?.verdict).toBe("pass");
    expect(q?.chainId).toBe(4663);
  });

  it("factory NOT allowlisted → fail (integrity)", () => {
    const q = extractQuote("uniswap.swap.quote", params, uniQuoteData({
      factory: { checked: true, allowlisted: false },
      liquidity: { checked: true, usd: 100000, aboveThreshold: true },
      fot: { suspected: false },
    }));
    expect(q?.verdict).toBe("fail");
  });

  it("factory check failed → unknown (never pass without confirmation)", () => {
    const q = extractQuote("uniswap.swap.quote", params, uniQuoteData({
      factory: { checkFailed: true },
      liquidity: { checked: true, usd: 100000, aboveThreshold: true },
      fot: { suspected: false },
    }));
    expect(q?.verdict).toBe("unknown");
  });

  it("low liquidity OR FoT suspected → unknown (allowed-with-warning)", () => {
    const lowLiq = extractQuote("uniswap.swap.quote", params, uniQuoteData({
      factory: { checked: true, allowlisted: true },
      liquidity: { checked: true, usd: 100, aboveThreshold: false },
      fot: { suspected: false },
    }));
    expect(lowLiq?.verdict).toBe("unknown");
    const fot = extractQuote("uniswap.swap.quote", params, uniQuoteData({
      factory: { checked: true, allowlisted: true },
      liquidity: { checked: true, usd: 100000, aboveThreshold: true },
      fot: { suspected: true },
    }));
    expect(fot?.verdict).toBe("unknown");
  });

  it("malformed safety block → null (recording skipped)", () => {
    expect(extractQuote("uniswap.swap.quote", params, uniQuoteData({ factory: {} }))).toBeNull();
  });
});

// Keep the native sentinel referenced (used by the handler; smoke-check it here).
it("native sentinel constant is the canonical EVM sentinel", () => {
  expect(NATIVE_TOKEN_ADDRESS.toLowerCase()).toBe("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee");
});
