/**
 * Numeric chain ids must route exactly like their slug (Wave B, card B2).
 *
 * `token_find` (khalani.tokens.search) returns `chainId` as a NUMBER, so the
 * value the agent has in hand for a chain is routinely `8453`, not `"base"`.
 * Before this suite, that number took a completely different path from the
 * slug through the swap stack:
 *
 *   "8453" → resolveChainSlug THROWS (the slug map has no numeric key)
 *          → kyberAggregatorSlug() returns undefined
 *          → resolveUniswapChainId("8453") succeeds numerically
 *          → the venue router classified Base as a UNISWAP-ONLY chain
 *          → swap_quote told the agent "KyberSwap does not support chain 8453"
 *            (false — kyberswap/chains.ts registers Base with aggregator:true)
 *            and BURNED the session's one-shot Uniswap reveal on what was only
 *            an input-formatting difference.
 *
 * Every Uniswap deployment chain is also a Kyber aggregator chain today, so
 * that mis-classification was in fact the ONLY way to reach the reveal branch
 * at all. The contract asserted here: number, digit-string, and slug forms of
 * the same chain are indistinguishable to the router, and an id no registry
 * knows is refused BEFORE any reveal/fallback path — never by pretending a
 * venue lacks support it has.
 *
 * SCOPE: the READ-ONLY quote half. The MUTATING executes must accept the same
 * forms or a legal quote cannot be executed — that parity, and the prequote
 * match-hash regression that makes it safe, live in the sibling
 * `numeric-chain-id-execute-parity.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { VexError, ErrorCodes } from "../../../errors.js";

// Capture the (toolId, params) each alias dispatches — the protocol runtime
// itself is exercised elsewhere; what is under test is the routing decision.
// The parameters are declared so `mock.calls` is a real 2-tuple: a
// no-argument `vi.fn` types its calls as the EMPTY tuple, and `call[0]` below
// is then a compile error (TS2493) rather than the dispatched request.
const { executeProtocolTool } = vi.hoisted(() => ({
  executeProtocolTool: vi.fn(async (_request: unknown, _context: unknown) => ({ success: true, output: "ok" })),
}));

vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool,
}));

import { resolveChainSlug } from "@tools/kyberswap/chains.js";
import { resolveSwapVenues } from "@tools/uniswap/venue-router.js";
import { classifySwapFamily } from "@vex-agent/tools/internal/swap-family.js";
import {
  handleSwapQuote,
  handleSwapQuoteUniswap,
  handleTokenCheck,
} from "@vex-agent/tools/internal/action-aliases.js";
import {
  isUniswapPairRevealed,
  revealUniswapPair,
} from "@vex-agent/tools/registry/uniswap-reveal.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH_BASE = "0x4200000000000000000000000000000000000006";

/** A chain id no registry in the tree knows (neither Kyber nor Uniswap nor local). */
const UNKNOWN_CHAIN_ID = "424242";

let sessionCounter = 0;

/** Fresh session per test so a reveal from one case cannot leak into another. */
function freshContext(): InternalToolContext {
  sessionCounter += 1;
  return {
    sessionId: `numeric-chain-${sessionCounter}`,
    loadedDocuments: new Map<string, string>(),
    sessionPermission: "restricted",
    approved: false,
    missionRunId: null,
    planMode: false,
    missionId: null,
    sessionKind: "agent",
    contextUsageBand: "normal",
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  };
}

function lastDispatch(): { toolId: string; params: Record<string, unknown> } {
  const call = executeProtocolTool.mock.calls.at(-1);
  if (!call) throw new Error("executeProtocolTool was not called");
  const request = call[0];
  if (typeof request !== "object" || request === null) throw new Error("unexpected request shape");
  const { toolId, params } = request as { toolId: string; params: Record<string, unknown> };
  return { toolId, params };
}

beforeEach(() => {
  executeProtocolTool.mockClear();
});

// ── Layer 1: the chain registry itself ──────────────────────────────────────

describe("resolveChainSlug — numeric chain ids resolve through the SAME table", () => {
  it("resolves a digit-string chain id to its canonical slug", () => {
    expect(resolveChainSlug("8453")).toBe("base");
    expect(resolveChainSlug("1")).toBe("ethereum");
    expect(resolveChainSlug("42161")).toBe("arbitrum");
    expect(resolveChainSlug("4663")).toBe("robinhood");
  });

  it("tolerates the surrounding whitespace a copied id carries", () => {
    expect(resolveChainSlug(" 8453 ")).toBe("base");
  });

  it("leaves slug and alias resolution byte-identical", () => {
    expect(resolveChainSlug("base")).toBe("base");
    expect(resolveChainSlug("BASE")).toBe("base");
    expect(resolveChainSlug(" ethereum ")).toBe("ethereum");
    expect(resolveChainSlug("eth")).toBe("ethereum");
    expect(resolveChainSlug("arb")).toBe("arbitrum");
    expect(resolveChainSlug("matic")).toBe("polygon");
  });

  it("refuses an unknown numeric id with the unsupported-chain code, naming the id", () => {
    let thrown: unknown;
    try {
      resolveChainSlug(UNKNOWN_CHAIN_ID);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(VexError);
    const error = thrown instanceof VexError ? thrown : null;
    expect(error?.code).toBe(ErrorCodes.KYBER_UNSUPPORTED_CHAIN);
    expect(error?.message).toContain(UNKNOWN_CHAIN_ID);
  });

  it("still refuses an unknown slug (behavior unchanged)", () => {
    expect(() => resolveChainSlug("not-a-chain")).toThrow(VexError);
  });

  it("does not treat a non-integer numeric input as a chain id", () => {
    expect(() => resolveChainSlug("84.53")).toThrow(VexError);
    expect(() => resolveChainSlug("-1")).toThrow(VexError);
  });
});

// ── Layer 2: venue classification ───────────────────────────────────────────

describe("venue router — a numeric id classifies as the slug does", () => {
  it("routes a numeric Base id to KyberSwap as primary, not Uniswap", () => {
    const bySlug = resolveSwapVenues("base");
    const byId = resolveSwapVenues("8453");
    expect(bySlug?.primary).toEqual({ venue: "kyberswap", kyberSlug: "base" });
    expect(byId?.primary).toEqual({ venue: "kyberswap", kyberSlug: "base" });
    expect(byId?.options.map((option) => option.venue)).toEqual(
      bySlug?.options.map((option) => option.venue),
    );
  });

  it("classifies the swap family identically for both forms", () => {
    expect(classifySwapFamily("8453")).toEqual({ kind: "evm", venue: "kyberswap", chain: "base" });
    expect(classifySwapFamily("base")).toEqual({ kind: "evm", venue: "kyberswap", chain: "base" });
  });

  it("returns no venues for a chain id nothing registers", () => {
    expect(resolveSwapVenues(UNKNOWN_CHAIN_ID)).toBeUndefined();
    expect(classifySwapFamily(UNKNOWN_CHAIN_ID)).toEqual({ kind: "unknown" });
  });
});

// ── Layer 3: the agent-facing alias ─────────────────────────────────────────

describe("swap_quote — token_find's numeric chainId is accepted and routed honestly", () => {
  it("accepts a JSON NUMBER chain id and dispatches KyberSwap on the canonical slug", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1.5" },
      context,
    );

    expect(result.success).toBe(true);
    const { toolId, params } = lastDispatch();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params.chain).toBe("base");
    // The formatting of the chain must not have consumed the session's reveal.
    expect(isUniswapPairRevealed(context.sessionId)).toBe(false);
  });

  it("accepts a digit-string chain id the same way", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: "8453", tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1.5" },
      context,
    );

    expect(result.success).toBe(true);
    expect(lastDispatch().toolId).toBe("kyberswap.swap.quote");
    expect(lastDispatch().params.chain).toBe("base");
    expect(isUniswapPairRevealed(context.sessionId)).toBe(false);
  });

  it("keeps the slug form working unchanged", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: "base", tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1.5", slippageBps: 50 },
      context,
    );

    expect(result.success).toBe(true);
    const { toolId, params } = lastDispatch();
    expect(toolId).toBe("kyberswap.swap.quote");
    expect(params).toEqual({
      chain: "base",
      tokenIn: WETH_BASE,
      tokenOut: USDC_BASE,
      amountIn: "1.5",
      slippageBps: 50,
    });
    expect(isUniswapPairRevealed(context.sessionId)).toBe(false);
  });

  it("all three forms of the same chain produce the identical dispatch", async () => {
    const forms: readonly unknown[] = [8453, "8453", "base"];
    const dispatched: string[] = [];
    for (const chain of forms) {
      const context = freshContext();
      await handleSwapQuote(
        { chain, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "2" },
        context,
      );
      const { toolId, params } = lastDispatch();
      dispatched.push(`${toolId}:${String(params.chain)}`);
    }
    expect(new Set(dispatched).size).toBe(1);
    expect(dispatched[0]).toBe("kyberswap.swap.quote:base");
  });

  it("refuses an unsupported numeric id honestly and does NOT unlock the Uniswap fallback", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: Number(UNKNOWN_CHAIN_ID), tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain(UNKNOWN_CHAIN_ID);
    // Honest attribution: this is an unknown chain, NOT "KyberSwap does not
    // support it" — the venue supports every chain the reveal would offer.
    expect(result.output).not.toMatch(/KyberSwap does not support/i);
    expect(executeProtocolTool).not.toHaveBeenCalled();
    expect(isUniswapPairRevealed(context.sessionId)).toBe(false);
  });

  it("refuses an unsupported digit-string id the same way", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: UNKNOWN_CHAIN_ID, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1" },
      context,
    );

    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
    expect(isUniswapPairRevealed(context.sessionId)).toBe(false);
  });

  it("still rejects a chain that is neither a slug, an id, nor solana", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: "not-a-chain", tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1" },
      context,
    );

    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
    expect(isUniswapPairRevealed(context.sessionId)).toBe(false);
  });

  it("still routes the literal solana chain to Jupiter", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5" },
      context,
    );

    expect(result.success).toBe(true);
    expect(lastDispatch().toolId).toBe("solana.swap.quote");
  });

  it("rejects a chain that is neither a string nor a number", async () => {
    const context = freshContext();
    const result = await handleSwapQuote(
      { chain: true, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1" },
      context,
    );

    expect(result.success).toBe(false);
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });
});

describe("swap_quote_uniswap — the same numeric chain id is accepted post-reveal", () => {
  it("accepts a JSON NUMBER chain id and resolves the Uniswap deployment key", async () => {
    const context = freshContext();
    revealUniswapPair(context.sessionId);

    const result = await handleSwapQuoteUniswap(
      { chain: 8453, tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1.5" },
      context,
    );

    expect(result.success).toBe(true);
    const { toolId, params } = lastDispatch();
    expect(toolId).toBe("uniswap.swap.quote");
    expect(params.chain).toBe("base");
  });
});

describe("token_check — token_find's numeric chainId reaches the token API", () => {
  it("accepts a JSON NUMBER chain id", async () => {
    const context = freshContext();
    const result = await handleTokenCheck({ chain: 8453, address: USDC_BASE }, context);

    expect(result.success).toBe(true);
    const { toolId, params } = lastDispatch();
    expect(toolId).toBe("kyberswap.tokens.check");
    expect(params).toEqual({ chain: "8453", address: USDC_BASE });
  });
});
