/**
 * Quote/execute PARITY on the chain param (Wave B, card CP).
 *
 * Batch 1 (`numeric-chain-id-routing.test.ts`) widened only the READ-ONLY
 * quote aliases: `swap_quote`, `swap_quote_uniswap`, `token_check`. The two
 * MUTATING executes kept a bare `z.string()`, so an agent could quote a trade
 * with `chain: 8453` — the exact form `token_find` hands back — and have the
 * execute of that same trade refused with "expected string, received number".
 *
 * A quote/execute asymmetry on a money path is a silent dead end: nothing in
 * the refusal tells the model that the two halves of one tool pair disagree
 * about what a chain is, so the only escape is guessing. Both halves now read
 * the same schema (`internal/chain-param.ts`).
 *
 * The second half of this suite is the regression that makes the widening
 * safe: a quote authorizes its execute through a prequote match hash, and the
 * chain enters that hash as the NUMERIC id the dispatched chain param resolves
 * to (`prequote/gate.ts`). If accepting a new INPUT form moved that number for
 * any spelling, legitimate quotes would stop authorizing their own executes and
 * every swap would block at the gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture the (toolId, params) the QUOTE alias dispatches — the protocol
// runtime itself is exercised elsewhere; what is under test is the routing
// decision. The parameters are declared so `mock.calls` is a real 2-tuple (a
// no-argument `vi.fn` types its calls as the EMPTY tuple).
const { executeProtocolTool } = vi.hoisted(() => ({
  executeProtocolTool: vi.fn(async (_request: unknown, _context: unknown) => ({ success: true, output: "ok" })),
}));

vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool,
}));

import { resolveChainSlug, slugToChainId } from "@tools/kyberswap/chains.js";
import { handleSwapQuote } from "@vex-agent/tools/internal/action-aliases.js";
import { MUTATING_PROTOCOL_ALIAS_ROUTERS } from "@vex-agent/tools/mutating-aliases.js";
import { computePrequoteMatchHash } from "@vex-agent/tools/protocols/swap-prequote.js";
import { revealUniswapPair } from "@vex-agent/tools/registry/uniswap-reveal.js";
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
    sessionId: `chain-parity-${sessionCounter}`,
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

function mutatingRouter(name: string): (args: Record<string, unknown>, sessionId: string | undefined) => {
  toolId: string;
  params: Record<string, unknown>;
} {
  const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[name];
  if (!router) throw new Error(`no mutating alias router named ${name}`);
  return router;
}

const routeSwapExecute = mutatingRouter("swap_execute");
const routeSwapExecuteUniswap = mutatingRouter("swap_execute_uniswap");

const EXECUTE_ARGS = { tokenIn: WETH_BASE, tokenOut: USDC_BASE, amountIn: "1.5" };

describe("swap_execute — the execute half accepts every chain form the quote half does", () => {
  it("accepts a JSON NUMBER chain id and routes KyberSwap on the canonical slug", () => {
    const target = routeSwapExecute({ chain: 8453, ...EXECUTE_ARGS }, "sess-exec-1");

    expect(target.toolId).toBe("kyberswap.swap.execute");
    expect(target.params.chain).toBe("base");
  });

  it("accepts a digit-string chain id the same way", () => {
    const target = routeSwapExecute({ chain: "8453", ...EXECUTE_ARGS }, "sess-exec-2");

    expect(target.toolId).toBe("kyberswap.swap.execute");
    expect(target.params.chain).toBe("base");
  });

  it("keeps the slug form working unchanged", () => {
    const target = routeSwapExecute({ chain: "base", ...EXECUTE_ARGS, slippageBps: 50 }, "sess-exec-3");

    expect(target.toolId).toBe("kyberswap.swap.execute");
    expect(target.params).toEqual({
      chain: "base",
      tokenIn: WETH_BASE,
      tokenOut: USDC_BASE,
      amountIn: "1.5",
      slippageBps: 50,
    });
  });

  it("all three forms of the same chain produce the identical dispatch", () => {
    const dispatched = [8453, "8453", "base"].map((chain) => {
      const target = routeSwapExecute({ chain, ...EXECUTE_ARGS }, "sess-exec-4");
      return `${target.toolId}:${String(target.params.chain)}`;
    });

    expect(new Set(dispatched).size).toBe(1);
    expect(dispatched[0]).toBe("kyberswap.swap.execute:base");
  });

  it("refuses an unsupported numeric id with batch-1's wording, and never as a venue gap", () => {
    let thrown: unknown;
    try {
      routeSwapExecute({ chain: Number(UNKNOWN_CHAIN_ID), ...EXECUTE_ARGS }, "sess-exec-5");
    } catch (err) {
      thrown = err;
    }

    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain(`chain id ${UNKNOWN_CHAIN_ID} is not a chain Vex can swap on`);
    expect(message).toContain("either its slug or the chain id token_find");
    // Honest attribution — never "KyberSwap does not support it", which would
    // also spend the session's one-shot Uniswap reveal on a formatting problem.
    expect(message).not.toMatch(/KyberSwap does not support/i);
    expect((thrown as { revealEligible?: boolean }).revealEligible).toBe(false);
  });

  it("still rejects a chain that is neither a slug, an id, nor solana", () => {
    expect(() => routeSwapExecute({ chain: "not-a-chain", ...EXECUTE_ARGS }, "sess-exec-6")).toThrow(
      /cannot determine swap family/i,
    );
  });

  it("still routes the literal solana chain to Jupiter", () => {
    const target = routeSwapExecute(
      { chain: "solana", tokenIn: "SOL", tokenOut: "USDC", amountIn: "1.5" },
      "sess-exec-7",
    );

    expect(target.toolId).toBe("solana.swap.execute");
  });

  it("rejects a chain that is neither a string nor a number", () => {
    expect(() => routeSwapExecute({ chain: true, ...EXECUTE_ARGS }, "sess-exec-8")).toThrow(
      /chain/i,
    );
  });
});

describe("swap_execute_uniswap — the hidden execute accepts the same forms post-reveal", () => {
  it("accepts a JSON NUMBER chain id and resolves the Uniswap deployment key", () => {
    const sessionId = "sess-exec-uni-1";
    revealUniswapPair(sessionId);

    const target = routeSwapExecuteUniswap({ chain: 8453, ...EXECUTE_ARGS }, sessionId);

    expect(target.toolId).toBe("uniswap.swap.execute");
    expect(target.params.chain).toBe("base");
  });

  it("accepts a digit-string and a slug identically", () => {
    const sessionId = "sess-exec-uni-2";
    revealUniswapPair(sessionId);

    expect(routeSwapExecuteUniswap({ chain: "8453", ...EXECUTE_ARGS }, sessionId).params.chain).toBe("base");
    expect(routeSwapExecuteUniswap({ chain: "base", ...EXECUTE_ARGS }, sessionId).params.chain).toBe("base");
  });

  it("still refuses a chain with no verified Uniswap deployment", () => {
    const sessionId = "sess-exec-uni-3";
    revealUniswapPair(sessionId);

    expect(() => routeSwapExecuteUniswap({ chain: Number(UNKNOWN_CHAIN_ID), ...EXECUTE_ARGS }, sessionId))
      .toThrow(/no verified Uniswap deployment/i);
  });
});

// ── The regression that matters: the prequote gate must still pair them ──────
//
// A quote and its execute authorize each other through a match hash, and the
// chain enters that hash as the NUMERIC id the row's chain param resolves to
// (`prequote/gate.ts`'s `slugToChainId(resolveChainSlug(chainParam))`). Widening
// the execute's accepted INPUT must not move that number for any form —
// otherwise a legitimate quote would stop authorizing its own execute and every
// swap would block at the gate.

describe("prequote pairing — widening the input never moves the match hash", () => {
  /** The identity dimension under test; everything else is held fixed. */
  function swapHashForChainParam(chainParam: string): string {
    return computePrequoteMatchHash({
      kind: "swap",
      sessionId: "sess-hash",
      family: "eip155",
      provider: "kyberswap",
      chainId: slugToChainId(resolveChainSlug(chainParam)),
      walletAddress: "0x1111111111111111111111111111111111111111",
      tokenIn: WETH_BASE,
      tokenOut: USDC_BASE,
      amount: "1.5",
      recipient: "0x1111111111111111111111111111111111111111",
      approveExact: false,
      slippageBps: "",
    });
  }

  it("a slug quote and its slug execute still hash identically", async () => {
    const context = freshContext();
    await handleSwapQuote({ chain: "base", ...EXECUTE_ARGS }, context);
    const quoteChain = String(lastDispatch().params.chain);
    const executeChain = String(routeSwapExecute({ chain: "base", ...EXECUTE_ARGS }, context.sessionId).params.chain);

    // Byte-identical param first — the hash input is derived from it.
    expect(executeChain).toBe(quoteChain);
    expect(executeChain).toBe("base");
    expect(swapHashForChainParam(executeChain)).toBe(swapHashForChainParam(quoteChain));
  });

  it("a NUMBER quote now pairs with a NUMBER execute — the asymmetry is gone", async () => {
    const context = freshContext();
    await handleSwapQuote({ chain: 8453, ...EXECUTE_ARGS }, context);
    const quoteChain = String(lastDispatch().params.chain);
    const executeChain = String(routeSwapExecute({ chain: 8453, ...EXECUTE_ARGS }, context.sessionId).params.chain);

    expect(executeChain).toBe(quoteChain);
    expect(swapHashForChainParam(executeChain)).toBe(swapHashForChainParam(quoteChain));
  });

  it("all three input forms land on the SAME hash — how a chain was spelled never blocks a gate", () => {
    const hashes = ["base", "8453", "8453"].map(swapHashForChainParam);
    expect(new Set(hashes).size).toBe(1);
    // And the number form routes to the same param the other two do.
    const fromNumber = String(routeSwapExecute({ chain: 8453, ...EXECUTE_ARGS }, "sess-hash-forms").params.chain);
    expect(swapHashForChainParam(fromNumber)).toBe(hashes[0]);
  });
});
