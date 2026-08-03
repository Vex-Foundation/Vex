/**
 * The INFORM half of the 2026-08-03 owner decree: a slippage refusal must hand
 * the agent every number it needs to choose the NEXT tolerance itself.
 *
 * The refusal names three things — the tolerance this attempt applied, the
 * ceiling a retry may not exceed, and the price impact actually observed — and
 * says plainly that Vex made exactly one attempt and will not widen anything on
 * the agent's behalf. Widening what a mission accepts is a money decision.
 *
 * It also asserts the two failures that must NOT converge: a market `slippage`
 * revert (raise the tolerance) and a calldata PRICE-FLOOR refusal (never raise
 * it — the floor is derived from the tolerance already granted, so raising it
 * lets the refused calldata through). Kyber's `KYBER_PRICE_FLOOR_VIOLATED` and
 * Pendle's `price_floor` are the two instances of the second kind.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";

import {
  preSignRefusalGuidance,
  type PreSignSlippageBounds,
} from "@tools/evm-chains/pre-sign-revert-refusal.js";
import { jupiterPreBroadcastRefusalGuidance } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/pre-broadcast-rejection-refusal.js";
import { slippageRemediation } from "@utils/error-summary.js";
import { PENDLE_PRICE_FLOOR_REMEDY } from "@vex-agent/tools/protocols/pendle/calldata/price-floor.js";

const BOUNDS: PreSignSlippageBounds = { appliedBps: 50, maxBps: 1000, observedPriceImpactFraction: 0.0231 };
/** What the EVM venues hand the shared remedy: cost-positive impact + the shipped stale-reserve caution. */
const EVM_REMEDY = { ...BOUNDS, staleReserveCaution: true } as const;

const evmRefusal = (slippage: PreSignSlippageBounds): string =>
  preSignRefusalGuidance({ revertReason: "Return amount is not enough", failureCode: "slippage", slippage });

const jupiterRefusal = (slippage: { appliedBps: number | null; maxBps: number }): string =>
  jupiterPreBroadcastRefusalGuidance({
    rejectionReason: "custom program error 0x1771",
    rejection: { kind: "slippage", anchorErrorNumber: 6001 },
    slippage,
  });

describe("slippageRemediation — the numbers an autonomous agent has to act on", () => {
  const text = slippageRemediation(EVM_REMEDY);

  it("names the applied tolerance and the ceiling", () => {
    expect(text).toContain("this attempt used 50");
    expect(text).toContain("above 1000");
  });

  it("quotes the observed impact beside the tolerance that was applied", () => {
    expect(text).toContain("Observed price impact 2.31%, this attempt used 50 bps");
  });

  it("says the next tolerance is the agent's explicit choice, and that Vex made ONE attempt", () => {
    expect(text).toMatch(/higher slippageBps that YOU choose explicitly/);
    expect(text).toMatch(/exactly one attempt was made, at the tolerance this call passed/i);
  });

  it("attributes the failure to the market, not to the venue, and rules out an unchanged retry", () => {
    expect(text).toMatch(/market moving, not the venue failing/i);
    expect(text).toMatch(/retrying unchanged will be refused the same way/i);
  });

  it("keeps the shipped strongly-negative-impact caution, which the new sentence must not contradict", () => {
    expect(text).toMatch(/priceImpact is strongly negative/i);
    expect(text).toMatch(/more tolerance would only buy a worse fill/i);
  });

  it("still carries the caution when the observed impact IS negative — the case it exists for", () => {
    const negative = slippageRemediation({ ...EVM_REMEDY, observedPriceImpactFraction: -0.0412 });
    expect(negative).toContain("Observed price impact -4.12%");
    expect(negative).toMatch(/strongly negative/i);
  });

  it("drops the impact sentence rather than printing a number nobody measured", () => {
    for (const missing of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const text = slippageRemediation({ appliedBps: 50, maxBps: 1000, staleReserveCaution: true, observedPriceImpactFraction: missing });
      expect(text).not.toMatch(/observed price impact/i);
      expect(text).not.toMatch(/NaN|Infinity/);
    }
  });

  it("states the venue default instead of inventing a number when the request named no tolerance", () => {
    const text = slippageRemediation({ appliedBps: null, maxBps: 1000, staleReserveCaution: true, observedPriceImpactFraction: 0.01 });
    expect(text).toMatch(/set no slippageBps of its own, so the venue applied its default/i);
    // Half a comparison is worse than none: no "this attempt used null bps".
    expect(text).toContain("Observed price impact 1.00%.");
    expect(text).not.toMatch(/used null/);
  });
});

describe("every venue's slippage refusal carries the same remedy", () => {
  it("the EVM pre-sign refusal keeps its venue-specific cause and appends the shared remedy", () => {
    const text = evmRefusal(BOUNDS);
    expect(text).toContain("the pool moved past the minimum output written into this quote's calldata");
    expect(text).toContain(slippageRemediation(EVM_REMEDY));
  });

  it("the Jupiter pre-broadcast refusal keeps otherAmountThreshold and appends the same remedy", () => {
    const slippage = { appliedBps: 50, maxBps: 1000 };
    const text = jupiterRefusal(slippage);
    expect(text).toContain("otherAmountThreshold");
    expect(text).toContain(slippageRemediation({ ...slippage, staleReserveCaution: false }));
  });

  it("Jupiter carries NEITHER the stale-reserve caution NOR an impact figure — its priceImpact sign is inverted", () => {
    // The repo's own captured healthy Jupiter quote is `priceImpactPct:
    // "-0.00015…"`: negative is ORDINARY there, the opposite of KyberSwap's
    // cost-positive derivation. Copying either would report every normal
    // Jupiter swap as anomalous. Pinned by
    // `solana/jupiter-swap-pre-broadcast-refusal.test.ts` too.
    const text = jupiterRefusal({ appliedBps: 50, maxBps: 1000 });
    expect(text).not.toMatch(/priceImpact/i);
    expect(text).not.toMatch(/observed price impact/i);
    // The rest of the remedy still reaches it — only the caution is venue-gated.
    expect(text).toMatch(/higher slippageBps that YOU choose explicitly/);
    expect(text).toMatch(/exactly one attempt was made/i);
  });

  it("a venue with no impact to report says less, never something false", () => {
    const text = evmRefusal({ appliedBps: 50, maxBps: 1000 });
    expect(text).toMatch(/nothing was signed/i);
    expect(text).toContain("this attempt used 50");
    expect(text).not.toMatch(/observed price impact/i);
  });
});

describe("a calldata price-floor refusal is NOT a market-slippage refusal", () => {
  it("Pendle's price-floor remedy forbids raising slippageBps — raising it would lower the floor", () => {
    expect(PENDLE_PRICE_FLOOR_REMEDY).toMatch(/Do NOT raise slippageBps/);
    expect(PENDLE_PRICE_FLOOR_REMEDY).toMatch(/lowers this floor/i);
    expect(PENDLE_PRICE_FLOOR_REMEDY).toMatch(/fresh quote/i);
    expect(PENDLE_PRICE_FLOOR_REMEDY).toMatch(/nothing was sent/i);
  });

  it("KyberSwap's own price-floor refusal keeps its wording and still gives no tolerance advice", () => {
    // `handlers/swap/execute-plan.ts` throws KYBER_PRICE_FLOOR_VIOLATED with
    // this hint. It is deliberately NOT routed through `slippageRemediation`:
    // the build widened the tolerance Vex asked for, so "raise slippageBps"
    // would tell the agent to grant exactly what the guard just refused.
    const source = readFileSync(
      path.resolve(__dirname, "../../../vex-agent/tools/protocols/kyberswap/handlers/swap/execute-plan.ts"),
      "utf8",
    );
    expect(source).toContain('"Nothing was signed. Get a fresh kyberswap.swap.quote."');
    expect(source).not.toMatch(/slippageRemediation/);
  });

  it("the two remedies stay textually distinguishable — no agent can read one as the other", () => {
    const marketSlippage = slippageRemediation(EVM_REMEDY);
    expect(marketSlippage).toMatch(/higher slippageBps/);
    expect(PENDLE_PRICE_FLOOR_REMEDY).not.toMatch(/higher slippageBps/);
    expect(marketSlippage).not.toContain(PENDLE_PRICE_FLOOR_REMEDY);
  });
});
