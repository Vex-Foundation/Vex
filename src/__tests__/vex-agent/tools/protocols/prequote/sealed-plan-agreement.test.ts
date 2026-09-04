/**
 * The approval card's plan and the snapshot's sealed plan must be the SAME plan.
 *
 * THE GAP THIS CLOSES. A matched prequote row carries two independently written
 * descriptions of the same set of transactions: the spendability preview in
 * `safety_detail`, which is what a person READS on the approval card, and the
 * `debitPlan` inside the route snapshot, which is what the execute is HELD TO
 * immediately before signing (`compareDebitPlanRoles`). Both are sealed - the
 * snapshot by its digest, the preview by the recorder's schema - and until this
 * check nothing held them against each other. A row whose card said "will send
 * allowance -> swap" while its snapshot sealed "allowance_reset, allowance,
 * swap, swap_fee" would have shown a human one plan and enforced another, which
 * is exactly the binding rule 09 forbids breaking.
 *
 * The experiments below drive the REAL snapshot codecs of BOTH venues (sealed
 * through `sealRouteSnapshot` / `sealUniswapSnapshot`, restored through the real
 * restorers), because a hand-built route_ref could carry a digest production
 * would refuse and would prove nothing about the path that actually runs.
 */

import { describe, it, expect } from "vitest";

import {
  buildBoundDebitPlan,
  canonicalizeDebitPlan,
  type BoundDebitPlan,
} from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import {
  UNISWAP_SNAPSHOT_VERSION,
  sealUniswapSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/uniswap.js";
import { checkSealedDebitPlanAgreement } from "@vex-agent/tools/protocols/prequote/gate/decision.js";
import { sealedDebitPlanFromRouteRef } from "@vex-agent/tools/protocols/prequote/gate/safety-detail.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

const FEE_CAP = {
  mode: "eip1559" as const,
  maxFeePerGasWei: 11_210_000n,
  maxPriorityFeePerGasWei: 1_210_000n,
};

/** The plan both artifacts of a healthy row describe: reset, approve, swap. */
const PLAN: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" as const },
    { role: "allowance", pricing: "measured" as const },
    { role: "swap", pricing: "measured" as const },
  ],
  feeCap: FEE_CAP,
});

/** The same three roles, but one more transaction than the card would state. */
const PLAN_WITH_FEE_LEG: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" as const },
    { role: "allowance", pricing: "measured" as const },
    { role: "swap", pricing: "measured" as const },
    { role: "swap_fee", pricing: "measured" as const },
  ],
  feeCap: FEE_CAP,
});

/** The same three roles under a HIGHER per-gas ceiling than the card stated. */
const PLAN_AT_HIGHER_CEILING: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" as const },
    { role: "allowance", pricing: "measured" as const },
    { role: "swap", pricing: "measured" as const },
  ],
  feeCap: { mode: "eip1559", maxFeePerGasWei: 99_210_000n, maxPriorityFeePerGasWei: 1_210_000n },
});

/** The same three roles, but the swap was priced conservatively, not measured. */
const PLAN_WITH_CONSERVATIVE_SWAP: BoundDebitPlan = buildBoundDebitPlan({
  legs: [
    { role: "allowance_reset", pricing: "measured" as const },
    { role: "allowance", pricing: "measured" as const },
    { role: "swap", pricing: "conservative" as const },
  ],
  feeCap: FEE_CAP,
});

const ROUTE_SUMMARY = {
  tokenIn: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  amountIn: "12000000000000000",
  tokenOut: "0x17f31d221a86c091a32d398653f5306fc4d93c0d",
  amountOut: "21335790672285165158400",
  routeID: "r1",
  checksum: "c1",
  route: [[{ pool: "0xpool", exchange: "orvex-cl", swapAmount: "12000000000000000" }]],
} as const;

/** A KyberSwap `route_ref` as the quote handler seals it, through the real codec. */
function kyberRouteRef(plan: BoundDebitPlan): unknown {
  const encoded = encodeRouteSnapshotRaw(ROUTE_SUMMARY);
  if (!encoded.ok) throw new Error("fixture route must encode");
  return sealRouteSnapshot({
    v: ROUTE_SNAPSHOT_VERSION,
    provider: "kyberswap",
    raw: encoded.raw,
    approvedAmountOutRaw: ROUTE_SUMMARY.amountOut,
    approvedMinOutRaw: "20269000000000000000000",
    approvedAmountOutHuman: "21335.79",
    approvedMinOutHuman: "20269.0",
    tokenOutSymbol: "CCF",
    effectiveSlippageBps: 50,
    expiresAt: "2026-08-31T10:00:00.000Z",
    eligibility: { kind: "executable", priceImpactFraction: 0.001, adverse: false },
    debitPlan: plan,
  });
}

/** A Uniswap `route_ref` as its quote handler seals it, through the real codec. */
function uniswapRouteRef(plan: BoundDebitPlan): unknown {
  return sealUniswapSnapshot({
    v: UNISWAP_SNAPSHOT_VERSION,
    provider: "uniswap",
    chainId: 8453,
    tokenIn: { address: "0xaaaa", isNative: false, symbol: "AAA", decimals: 6 },
    tokenOut: { address: "0xbbbb", isNative: false, symbol: "BBB", decimals: 18 },
    totalInRaw: "1000000",
    swapAmountRaw: "997500",
    fee: { disposition: "charged", amountRaw: "2500", disclosureText: "Vex fee 0.25%" },
    approvedAmountOutRaw: "500000000000000000",
    approvedMinOutRaw: "497500000000000000",
    approvedAmountOutHuman: "0.5",
    approvedMinOutHuman: "0.4975",
    slippageBps: 50,
    expiresAt: "2026-08-31T10:00:00.000Z",
    debitPlan: plan,
  });
}

// ── The reader ────────────────────────────────────────────────────────────

describe("sealedDebitPlanFromRouteRef", () => {
  it("reads the plan a KyberSwap snapshot sealed", () => {
    expect(sealedDebitPlanFromRouteRef(kyberRouteRef(PLAN))).toEqual(PLAN);
  });

  it("reads the plan a Uniswap snapshot sealed, through that venue's own codec", () => {
    expect(sealedDebitPlanFromRouteRef(uniswapRouteRef(PLAN))).toEqual(PLAN);
  });

  it("yields nothing for a row that seals no snapshot at all", () => {
    // Jupiter records no route snapshot: it has no claim lane. Its rows reach
    // the gate with a null `route_ref` and must not be refused for it.
    expect(sealedDebitPlanFromRouteRef(null)).toBeUndefined();
    expect(sealedDebitPlanFromRouteRef(undefined)).toBeUndefined();
  });

  it("yields nothing for a snapshot whose seal no longer covers its contents", () => {
    // A plan edited in the durable row must not become a comparison basis: the
    // restorer refuses the digest mismatch and this reader reports no plan,
    // which leaves the row with one artifact and no contradiction to raise.
    const sealed = kyberRouteRef(PLAN);
    const tampered = { ...(sealed as Record<string, unknown>), debitPlan: PLAN_WITH_FEE_LEG };
    expect(sealedDebitPlanFromRouteRef(tampered)).toBeUndefined();
  });
});

// ── The equality check ────────────────────────────────────────────────────

describe("checkSealedDebitPlanAgreement", () => {
  /** Assert the row passes the gate untouched: there is nothing to refuse. */
  function assertPassesThrough(
    card: BoundDebitPlan | undefined,
    sealed: BoundDebitPlan | undefined,
  ): void {
    expect(checkSealedDebitPlanAgreement(card, sealed)).toBeNull();
  }

  it("passes a row whose card plan and sealed plan are the same plan", () => {
    // Not the same OBJECT: the card's copy comes back through JSONB, so the
    // comparison must hold over a structurally equal value, which is what the
    // canonical form the seal itself digests over gives.
    const restored = sealedDebitPlanFromRouteRef(kyberRouteRef(PLAN));
    assertPassesThrough(structuredClone(PLAN), restored);
  });

  it.each([
    ["an extra fee transfer the card never mentioned", PLAN_WITH_FEE_LEG],
    ["a higher per-gas ceiling than the card stated", PLAN_AT_HIGHER_CEILING],
    ["a conservatively priced swap the card presented as measured", PLAN_WITH_CONSERVATIVE_SWAP],
  ])("blocks when the sealed plan carries %s", (_case, sealed) => {
    const decision = checkSealedDebitPlanAgreement(PLAN, sealed);
    expect(decision?.kind).toBe("block");
    if (decision?.kind !== "block") throw new Error("expected a block decision");
    // The refusal NAMES both sources and the way out, because a person told
    // only "blocked" cannot tell which of the two descriptions was wrong.
    expect(decision.message).toContain(
      "the card's plan and the sealed plan disagree - request a fresh quote",
    );
    expect(decision.message).toContain(canonicalizeDebitPlan(PLAN));
    expect(decision.message).toContain(canonicalizeDebitPlan(sealed));
    expect(decision.message).toContain("nothing was signed");
  });

  it("blocks through the REAL restore path, not only over hand-built plans", () => {
    const sealed = sealedDebitPlanFromRouteRef(uniswapRouteRef(PLAN_WITH_FEE_LEG));
    const decision = checkSealedDebitPlanAgreement(PLAN, sealed);
    expect(decision?.kind).toBe("block");
  });

  it.each([
    ["only the card carries one - the venue seals no snapshot", PLAN, undefined],
    ["only the snapshot carries one - the venue measures no balances", undefined, PLAN],
    ["neither artifact carries one", undefined, undefined],
  ])("passes a row where %s", (_case, card, sealed) => {
    // A check for CONTRADICTION, never a requirement that both artifacts exist:
    // there is no second description here to disagree with, and refusing would
    // block quotes that are perfectly consistent with themselves.
    assertPassesThrough(card, sealed);
  });

  it("leaks no wallet, token or provider text into the refusal", () => {
    const decision = checkSealedDebitPlanAgreement(PLAN, PLAN_WITH_FEE_LEG);
    if (decision?.kind !== "block") throw new Error("expected a block decision");
    expect(decision.message).not.toContain(ROUTE_SUMMARY.tokenIn);
    expect(decision.message).not.toContain(ROUTE_SUMMARY.tokenOut);
    expect(decision.message).not.toContain(ROUTE_SUMMARY.routeID);
    expect(decision.message).not.toContain("0x");
  });
});
