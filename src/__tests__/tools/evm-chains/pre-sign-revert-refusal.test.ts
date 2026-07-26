/**
 * The agent-facing narrative for a leg the PRE-SIGN `eth_estimateGas`
 * refused: what is provable (nothing was submitted), what the chain said, and
 * what the agent can change to make a retry succeed.
 *
 * Rule 8 of the phase-3 plan ("DO NOT BREAK AUTONOMY") is the acceptance test
 * for every string in here, so it is asserted directly: refuse only what would
 * actually lose money; say what to change and whether a retry can succeed;
 * leave a path the agent can walk alone.
 */

import { describe, expect, it } from "vitest";
import { ExecutionRevertedError, InsufficientFundsError } from "viem";

import {
  classifyDependentLegPoolStateRevert,
  classifyPreSignRevert,
  dependentLegPoolStateRefusalGuidance,
  preSignRefusalGuidance,
} from "@tools/evm-chains/pre-sign-revert-refusal.js";
import {
  DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
  DependentLegGasEstimateError,
} from "@tools/evm-chains/dependent-leg-gas-estimate.js";

const SLIPPAGE = { appliedBps: 50, maxBps: 1000 } as const;

function revertedWith(reason: string): ExecutionRevertedError {
  return new ExecutionRevertedError({ message: `execution reverted: ${reason}` });
}

/** The two functions as a venue handler wires them (its own scrub is the identity here). */
function refuse(err: unknown) {
  const classified = classifyPreSignRevert(err);
  if (classified === null) return null;
  return {
    ...classified,
    guidance: preSignRefusalGuidance({ ...classified, slippage: SLIPPAGE }),
  };
}

describe("classifyPreSignRevert — what the revert means", () => {
  it.each([
    // KyberSwap MetaAggregationRouterV2 — captured live on Base, 2026-07-25.
    ["Return amount is not enough"],
    // Uniswap V3 SwapRouter / V2 Router02 — the same condition, other wording.
    ["Too little received"],
    ["Too much requested"],
    ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"],
    ["UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"],
  ])("%s is a slippage refusal that names slippageBps", (reason) => {
    const refusal = refuse(revertedWith(reason));

    expect(refusal).not.toBeNull();
    expect(refusal!.failureCode).toBe("slippage");
    expect(refusal!.revertReason).toBe(reason);
    expect(refusal!.guidance).toContain("slippageBps");
    // Quotes numbers, per the house style for a refusal message.
    expect(refusal!.guidance).toContain("50");
    expect(refusal!.guidance).toContain("1000");
  });

  it("carries the chain's own reason verbatim as the evidence", () => {
    expect(refuse(revertedWith("Return amount is not enough"))!.guidance)
      .toContain("Return amount is not enough");
  });

  it("a deadline revert names the deadline, never slippageBps", () => {
    const refusal = refuse(revertedWith("Transaction too old"))!;

    expect(refusal.failureCode).toBe("deadline_expired");
    expect(refusal.guidance).not.toContain("slippageBps");
    expect(refusal.guidance).toMatch(/quote/i);
  });

  it("a balance/allowance revert does not tell the agent to raise tolerance", () => {
    const refusal = refuse(revertedWith("STF"))!;

    expect(refusal.failureCode).toBe("allowance_or_balance");
    expect(refusal.guidance).not.toContain("slippageBps");
  });

  it("an unrecognized but decoded revert is still a refusal, and invents no remedy", () => {
    const refusal = refuse(revertedWith("SomeRouter: WEIRD_STATE"))!;

    expect(refusal.failureCode).toBe("simulation_reverted");
    expect(refusal.guidance).toContain("SomeRouter: WEIRD_STATE");
    expect(refusal.guidance).not.toContain("slippageBps");
    expect(refusal.guidance).toMatch(/no specific remedy is known/i);
  });

  it("finds the reason through a wrapped .cause chain", () => {
    const outer = new Error("wrapped");
    (outer as Error & { cause?: unknown }).cause = revertedWith("Too little received");

    expect(refuse(outer)!.failureCode).toBe("slippage");
  });
});

describe("classifyPreSignRevert — what it refuses to classify", () => {
  it("returns null when the error carries no decoded on-chain revert reason", () => {
    expect(classifyPreSignRevert(new Error("connect ECONNREFUSED"))).toBeNull();
    expect(classifyPreSignRevert(new InsufficientFundsError({}))).toBeNull();
    expect(classifyPreSignRevert(new ExecutionRevertedError({}))).toBeNull();
  });

  it("returns null for a DependentLegGasEstimateError — a lagging node's reason is not evidence", () => {
    // Doctrine, live 2026-07-24/25 (`dependent-leg-gas-estimate.ts`): after an
    // approval THIS plan confirmed, the node reported `ERC20: transfer amount
    // exceeds allowance` for a transaction that was in fact fine, and an
    // unchanged retry succeeded. Classifying that string would assert exactly
    // the conclusion the retry loop exists because we cannot support. That
    // error has its own branch and its own honest wording.
    const err = new DependentLegGasEstimateError({
      attempts: 3,
      priorLegBlockNumber: 900n,
      observedHeadBlock: 902n,
      cause: revertedWith("ERC20: transfer amount exceeds allowance"),
    });

    expect(classifyPreSignRevert(err)).toBeNull();
  });
});

/** The dependent-leg error a venue sees once every lag-absorbing retry has failed. */
function afterEveryRetry(reason: string): DependentLegGasEstimateError {
  return new DependentLegGasEstimateError({
    attempts: DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
    priorLegBlockNumber: 900n,
    observedHeadBlock: 902n,
    cause: revertedWith(reason),
  });
}

describe("classifyDependentLegPoolStateRevert — where the lag doctrine stops applying", () => {
  it.each([
    ["Return amount is not enough"],
    ["Too little received"],
    ["UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"],
    ["Too much requested"],
  ])("%s survived every retry, so it is the pool moving — not the node lagging", (reason) => {
    // Two independent reasons this is safe, both checked against
    // `dependent-leg-gas-estimate.ts`:
    //  1. the retry loop has no early exit — the error escapes only after all
    //     `DEPENDENT_LEG_ESTIMATE_ATTEMPTS` failed across its backoff, and the
    //     LAST attempt runs after `waitForHeadAtLeast` saw the prior leg's block;
    //  2. lag cannot manufacture this reason. Pool reserves are not state our
    //     allowance leg touched, and a node behind the head reads them at an
    //     EARLIER block — closer to quote time, so a spurious price-guard
    //     refusal gets LESS likely, never more.
    const classified = classifyDependentLegPoolStateRevert(afterEveryRetry(reason));

    expect(classified).not.toBeNull();
    expect(classified!.failureCode).toBe("slippage");
    expect(classified!.revertReason).toBe(reason);
  });

  it("an allowance-shaped reason stays unclassified — that IS the doctrine's own case", () => {
    // The exact string a caught-up node lied with on 2026-07-24/25, plus
    // Uniswap's `TransferHelper` equivalent. Both describe the state the
    // confirming approval had just changed, which is precisely what a lagging
    // node has not applied yet.
    expect(classifyDependentLegPoolStateRevert(afterEveryRetry("ERC20: transfer amount exceeds allowance"))).toBeNull();
    expect(classifyDependentLegPoolStateRevert(afterEveryRetry("STF"))).toBeNull();
    expect(classifyDependentLegPoolStateRevert(afterEveryRetry("UniswapV2: TRANSFER_FAILED"))).toBeNull();
  });

  it("a deadline, a liquidity or an unmapped reason stays unclassified — the narrowing is pool-price only", () => {
    expect(classifyDependentLegPoolStateRevert(afterEveryRetry("Transaction too old"))).toBeNull();
    expect(classifyDependentLegPoolStateRevert(afterEveryRetry("UniswapV2Library: INSUFFICIENT_LIQUIDITY"))).toBeNull();
    expect(classifyDependentLegPoolStateRevert(afterEveryRetry("SomeRouter: WEIRD_STATE"))).toBeNull();
  });

  it("no decoded reason at all stays unclassified", () => {
    const noReason = new DependentLegGasEstimateError({
      attempts: DEPENDENT_LEG_ESTIMATE_ATTEMPTS,
      priorLegBlockNumber: 900n,
      observedHeadBlock: null,
      cause: new Error("connect ECONNREFUSED"),
    });

    expect(classifyDependentLegPoolStateRevert(noReason)).toBeNull();
  });

  it("classifyPreSignRevert remains the FIRST-TOUCH door and never classifies a dependent-leg error", () => {
    // Two questions with two different evidence bars: "is this a provable
    // refusal of a leg with no state of ours behind it" (that function) versus
    // "did a pool-state reason survive the lag retries" (this one). A venue
    // opts into the second one explicitly, in its own dependent-leg branch.
    expect(classifyPreSignRevert(afterEveryRetry("Return amount is not enough"))).toBeNull();
  });
});

describe("dependentLegPoolStateRefusalGuidance — one guidance, never a second copy", () => {
  const error = afterEveryRetry("Return amount is not enough");
  const text = dependentLegPoolStateRefusalGuidance({
    error,
    revertReason: "Return amount is not enough",
    failureCode: "slippage",
    slippage: SLIPPAGE,
  });

  it("embeds the native-input guidance verbatim rather than restating it", () => {
    expect(text).toContain(preSignRefusalGuidance({
      revertReason: "Return amount is not enough",
      failureCode: "slippage",
      slippage: SLIPPAGE,
    }));
  });

  it("names the remedy by parameter, both numbers, and the priceImpact exception", () => {
    expect(text).toContain("slippageBps");
    expect(text).toContain("50");
    expect(text).toContain("1000");
    expect(text).toMatch(/priceImpact/i);
  });

  it("shows the retries and the prior leg's block, so the agent knows lag was already waited out", () => {
    expect(text).toContain(String(DEPENDENT_LEG_ESTIMATE_ATTEMPTS));
    expect(text).toContain("900");
  });

  it("keeps the autonomy contract: nothing signed, re-running cannot duplicate, no ambiguity framing", () => {
    expect(text).toMatch(/nothing was signed/i);
    expect(text).toMatch(/cannot duplicate/i);
    expect(text).not.toMatch(/already recorded/i);
    expect(text).not.toMatch(/check the record/i);
  });

  it("scrubbing is the CALLER's job here too", () => {
    const scrubbed = dependentLegPoolStateRefusalGuidance({
      error,
      revertReason: "<already scrubbed by the venue>",
      failureCode: "slippage",
      slippage: SLIPPAGE,
    });

    expect(scrubbed).toContain("<already scrubbed by the venue>");
  });
});

describe("preSignRefusalGuidance — the autonomy contract (plan rule 8)", () => {
  const guidance = refuse(revertedWith("Return amount is not enough"))!.guidance;

  it("does not read as a loss: nothing was submitted and re-running cannot duplicate anything", () => {
    expect(guidance).toMatch(/nothing was signed/i);
    expect(guidance).toMatch(/cannot duplicate/i);
    expect(guidance).not.toMatch(/already recorded/i);
    expect(guidance).not.toMatch(/check the record/i);
  });

  it("says whether a retry can succeed, not merely that something was invalid", () => {
    expect(guidance).toMatch(/re-quote/i);
    expect(guidance).not.toMatch(/validation failed/i);
  });

  it("preserves the one shipped caution that contradicts blind tolerance-raising", () => {
    // `engine/prompts/protocols.ts` already teaches that on a chain whose
    // indexed reserves are stale, this exact revert plus a strongly negative
    // priceImpact means the QUOTE is wrong — raising tolerance there buys a
    // worse fill rather than a fill. The refusal must not contradict it.
    expect(guidance).toMatch(/priceImpact/i);
  });

  it("scrubbing is the CALLER's job — the reason is embedded exactly as handed in", () => {
    // C37: one scrub entry point per venue. This module must not fork a second
    // one, so whatever the handler passes is what appears.
    const text = preSignRefusalGuidance({
      revertReason: "<already scrubbed by the venue>",
      failureCode: "slippage",
      slippage: SLIPPAGE,
    });
    expect(text).toContain("<already scrubbed by the venue>");
  });
});
