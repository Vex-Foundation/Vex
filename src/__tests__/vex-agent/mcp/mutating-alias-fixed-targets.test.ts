/**
 * WHICH MUTATING ALIASES ACTUALLY RESOLVE A VENUE - the fact
 * `vex_ToolDescribe.quoteGate` is published from.
 *
 * The false contract this pins: every mutating alias answered
 * `venue_resolved_per_call`, which says of a call that moves money that its
 * venue - and therefore the quote that authorizes it - cannot be known until
 * the call happens. For two of the four that is simply untrue:
 * `SwapExecuteUniswap` and `BridgeExecuteRelay` name their venue in their own
 * name and dispatch to ONE protocol tool, whatever the arguments. An agent told
 * otherwise has no way to learn which quote to take first.
 *
 * So the declaration in `tools/mutating-aliases.ts` is tested here against the
 * ROUTERS THEMSELVES, exercised over every chain and shape they accept: the
 * only thing that could make the published answer wrong is a router that can
 * reach a second venue, and that is exactly what these cases would catch.
 * `tool-describe-export.test.ts` then asserts the description is that target's
 * own gate, without restating the pairing.
 */

import { describe, it, expect } from "vitest";

import {
  FIXED_MUTATING_ALIAS_TARGETS,
  MUTATING_PROTOCOL_ALIAS_ROUTERS,
  fixedTargetOfMutatingAlias,
} from "@vex-agent/tools/mutating-aliases.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000042";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function route(alias: string, args: Record<string, unknown>) {
  const router = MUTATING_PROTOCOL_ALIAS_ROUTERS[alias];
  if (router === undefined) throw new Error(`${alias} is not a mutating alias`);
  return router(args, SESSION_ID);
}

/** Every chain shape `SwapExecuteUniswap` accepts, including a bare chain id. */
const UNISWAP_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "8453", 8453];

/** Chain pairs `BridgeExecuteRelay` accepts, across families and directions. */
const RELAY_PAIRS = [
  ["base", "arbitrum"],
  ["ethereum", "solana"],
  ["solana", "base"],
  ["arbitrum", "ethereum"],
];

describe("the two venue-named aliases have ONE target, whatever the arguments", () => {
  it.each(UNISWAP_CHAINS)("SwapExecuteUniswap on %s dispatches to uniswap.swap.execute", async (chain) => {
    const target = await route("SwapExecuteUniswap", {
      chain,
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: "1.5",
    });
    expect(target.toolId).toBe(FIXED_MUTATING_ALIAS_TARGETS.SwapExecuteUniswap);
    expect(target.toolId).toBe("uniswap.swap.execute");
  });

  it.each(RELAY_PAIRS)("BridgeExecuteRelay from %s to %s dispatches to relay.bridge", async (fromChain, toChain) => {
    const target = await route("BridgeExecuteRelay", {
      fromChain,
      fromToken: WETH,
      toChain,
      toToken: USDC,
      amountRaw: "1000000",
    });
    expect(target.toolId).toBe(FIXED_MUTATING_ALIAS_TARGETS.BridgeExecuteRelay);
    expect(target.toolId).toBe("relay.bridge");
  });

  it("declares a fixed target for exactly those two", () => {
    const declared = Object.keys(MUTATING_PROTOCOL_ALIAS_ROUTERS)
      .filter((alias) => fixedTargetOfMutatingAlias(alias) !== undefined)
      .sort();
    expect(declared).toEqual(["BridgeExecuteRelay", "SwapExecuteUniswap"]);
  });
});

describe("the two router aliases really do choose a venue", () => {
  // Not an assumption: `SwapExecute` is shown reaching two different protocol
  // tools from two different argument sets, which is what makes
  // `venue_resolved_per_call` an honest answer for it and a false one for the
  // pair above.
  it("SwapExecute reaches a different tool for an EVM chain than for Solana", async () => {
    const evm = await route("SwapExecute", {
      chain: "base",
      tokenIn: WETH,
      tokenOut: USDC,
      amountIn: "1.5",
    });
    const solana = await route("SwapExecute", {
      chain: "solana",
      tokenIn: SOL_MINT,
      tokenOut: USDC_MINT,
      amountIn: "1.5",
    });
    expect(evm.toolId).not.toBe(solana.toolId);
    expect(fixedTargetOfMutatingAlias("SwapExecute")).toBeUndefined();
  });

  it("BridgeExecute declares no fixed target, because it asks the venue registry", () => {
    // Its venue comes from `resolveBridgeVenue`, a live registry read, so the
    // answer is not knowable from the arguments alone - which is precisely what
    // `venue_resolved_per_call` says.
    expect(fixedTargetOfMutatingAlias("BridgeExecute")).toBeUndefined();
  });
});
