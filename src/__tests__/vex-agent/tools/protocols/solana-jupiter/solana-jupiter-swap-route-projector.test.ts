/**
 * `solana.swap.quote` surfaces price impact and the execution route
 * (2026-07-25 restoration).
 *
 * Solana was the only swap venue in the repo whose quote carried no price
 * impact — KyberSwap and Pendle both ship one — even though the validated
 * `/build` response already carried `priceImpactPct` and `routePlan`.
 *
 * Shapes below are taken from the recorded live captures
 * (`agents_dm/agentscan-phase3/fixtures/swap-build-instructions.json` and
 * `swap-order-quote.json`), which are also the evidence for the unit trap
 * these tests pin: Jupiter's `priceImpactPct` is a decimal FRACTION
 * (`-0.00015864212550172836`), 100x smaller than its sibling `priceImpact`
 * (`-0.015864212550172837`, percentage points) — surfacing it as a "percent"
 * would understate slippage by two orders of magnitude.
 */

import { describe, expect, it } from "vitest";
import type { JupiterSwapBuildResponse } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/types.js";
import { projectJupiterSwapRoute } from "@vex-agent/tools/protocols/solana-jupiter/swap-route-projector.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function buildResponse(overrides: Partial<JupiterSwapBuildResponse> = {}): JupiterSwapBuildResponse {
  return {
    inputMint: SOL,
    outputMint: USDC,
    inAmount: "10000000",
    outAmount: "758696",
    otherAmountThreshold: "758696",
    swapMode: "ExactIn",
    slippageBps: 50,
    priceImpactPct: "-0.00015864212550172836",
    routePlan: [
      {
        percent: 100,
        bps: 10000,
        swapInfo: {
          ammKey: "GMCJvYGf5Ex2ARiMquaBDqU6iKM8uiEQkB8jCnoNfHpC",
          label: "GoonFi V2",
          inputMint: SOL,
          outputMint: USDC,
          inAmount: "10000000",
          outAmount: "758696",
        },
      },
    ],
    computeBudgetInstructions: [],
    setupInstructions: [],
    swapInstruction: { programId: "", accounts: [], data: "" },
    cleanupInstruction: null,
    otherInstructions: [],
    ...overrides,
  } as JupiterSwapBuildResponse;
}

describe("projectJupiterSwapRoute", () => {
  it("passes the provider's price impact through verbatim, as a labeled FRACTION", () => {
    const projected = projectJupiterSwapRoute(buildResponse());
    // Exact string — never parsed, rounded, or rescaled.
    expect(projected.priceImpactFraction).toBe("-0.00015864212550172836");
  });

  it("reports an absent price impact as null — an unknown impact is never a reassuring zero", () => {
    const raw = buildResponse();
    delete (raw as { priceImpactPct?: string }).priceImpactPct;
    expect(projectJupiterSwapRoute(raw).priceImpactFraction).toBeNull();
  });

  it("surfaces which venue fills the swap and what share it carries", () => {
    const projected = projectJupiterSwapRoute(buildResponse());
    expect(projected.routePlan).toEqual([{
      amm: "GoonFi V2",
      ammKey: "GMCJvYGf5Ex2ARiMquaBDqU6iKM8uiEQkB8jCnoNfHpC",
      inputMint: SOL,
      outputMint: USDC,
      inAmountRaw: "10000000",
      outAmountRaw: "758696",
      percent: 100,
    }]);
  });

  it("keeps every hop of a split route, in provider order", () => {
    const projected = projectJupiterSwapRoute(buildResponse({
      routePlan: [
        {
          percent: 70, bps: 7000,
          swapInfo: { ammKey: "AmmA", label: "Whirlpool", inputMint: SOL, outputMint: USDC, inAmount: "7000000", outAmount: "531087" },
        },
        {
          percent: 30, bps: 3000,
          swapInfo: { ammKey: "AmmB", label: "Raydium CLMM", inputMint: SOL, outputMint: USDC, inAmount: "3000000", outAmount: "227609" },
        },
      ],
    }));
    expect(projected.routePlan.map((h) => [h.amm, h.percent])).toEqual([
      ["Whirlpool", 70],
      ["Raydium CLMM", 30],
    ]);
  });

  it("degrades to an empty route rather than throwing inside a quote handler", () => {
    const raw = buildResponse();
    (raw as { routePlan: unknown }).routePlan = undefined;
    expect(projectJupiterSwapRoute(raw).routePlan).toEqual([]);
  });
});
