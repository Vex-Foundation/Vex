/**
 * Test helper: the claimed execution snapshot a KyberSwap execute now builds
 * from.
 *
 * `kyberswap.swap.execute` no longer fetches a route. It CLAIMS the quote the
 * agent was shown (`protocols/prequote/claim.ts`) and builds from that
 * snapshot, which is what binds the fill to the approved price. Every handler
 * test that drives the execute past the claim therefore needs one of these.
 *
 * The snapshot is produced by the REAL codec - the same `encodeRouteSnapshotRaw`
 * and digest the quote handler uses - so a test double here cannot drift from
 * what production stores, and a suite that is not about the snapshot still
 * exercises a genuine one.
 */

import type { NativeDebitLegRole } from "@tools/evm-chains/swap-native-debit.js";
import { buildBoundDebitPlan } from "@vex-agent/tools/protocols/quote-authority/debit-plan.js";
import type { LegFeeCap } from "@tools/evm-chains/swap-native-debit.js";
import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
  sealRouteSnapshot,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";

/**
 * The default bound ceiling: well above every suite's prepared request, so a
 * suite whose subject is something else is never refused for a gas price it
 * never chose. The suites that ARE about the ceiling pass their own.
 *
 * 1 gwei, not the 1e15 wei/gas this used to carry. Since 2026-09-01 the
 * pre-sign gate prices every leg AFTER the one being signed, and the follow-up
 * reserve, at this APPROVED ceiling rather than at the current request's price
 * (a later leg may legally rise to it). A ceiling of 1e15 therefore made the
 * reserve alone cost ~1e21 wei against the fakes' 1e18 balance and refused every
 * swap for gas - which is the gate working, and the fixture being wrong. A
 * realistic ceiling is what "generous" has to mean now.
 */
const GENEROUS_CAP: LegFeeCap = {
  mode: "eip1559",
  maxFeePerGasWei: 10n ** 9n,
  maxPriorityFeePerGasWei: 10n ** 9n,
};

export interface ApprovedClaimOptions {
  /**
   * The transaction set the quote bound, in broadcast order. Defaults to the
   * plain one-leg swap; a suite whose allowance plan adds legs states them here,
   * because a set the execute does not reproduce is refused by name (WP2-B).
   */
  readonly legs?: readonly NativeDebitLegRole[];
  /** The per-gas ceiling every leg was quoted under. */
  readonly feeCap?: LegFeeCap;
}

/**
 * The transaction set a KyberSwap quote binds for a given allowance decision.
 *
 * The quote and the execute derive their leg sets from the SAME rule, and since
 * WP2-B a difference between them is a refusal - so a suite that changes what
 * `planKyberAllowance` answers must move the bound plan with it, exactly as a
 * real re-quote would.
 */
export function legsForAllowancePlan(plan: {
  readonly needsReset: boolean;
  readonly needsApprove: boolean;
}): readonly NativeDebitLegRole[] {
  return [
    ...(plan.needsReset ? (["allowance_reset"] as const) : []),
    ...(plan.needsApprove ? (["allowance"] as const) : []),
    "swap" as const,
  ];
}

/** The successful arm of `claimSwapExecutionSnapshot`, for a route summary and tolerance. */
export function approvedClaim(
  routeSummary: unknown,
  slippageBps: number,
  options: ApprovedClaimOptions = {},
) {
  const encoded = encodeRouteSnapshotRaw(routeSummary);
  if (!encoded.ok) {
    throw new Error(`approvedClaim: fixture route summary does not encode (${encoded.measuredBytes} bytes)`);
  }
  const amountOut = readAmountOut(routeSummary);
  return {
    ok: true as const,
    prequoteId: "prequote-fixture",
    routeSummary,
    snapshot: sealRouteSnapshot({
      v: ROUTE_SNAPSHOT_VERSION,
      provider: "kyberswap" as const,
      raw: encoded.raw,
      approvedAmountOutRaw: amountOut,
      approvedMinOutRaw: computeApprovedMinOut(amountOut, slippageBps).toString(),
      approvedAmountOutHuman: amountOut,
      approvedMinOutHuman: computeApprovedMinOut(amountOut, slippageBps).toString(),
      tokenOutSymbol: "OUT",
      effectiveSlippageBps: slippageBps,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      eligibility: { kind: "executable" as const, priceImpactFraction: 0.001, adverse: false },
      debitPlan: buildBoundDebitPlan({
        legs: (options.legs ?? ["swap"]).map((role) => ({ role, pricing: "measured" as const })),
        feeCap: options.feeCap ?? GENEROUS_CAP,
      }),
    }),
  };
}

function readAmountOut(routeSummary: unknown): string {
  if (typeof routeSummary !== "object" || routeSummary === null) {
    throw new Error("approvedClaim: route summary must be an object");
  }
  const amountOut = (routeSummary as { amountOut?: unknown }).amountOut;
  if (typeof amountOut !== "string") {
    throw new Error("approvedClaim: route summary must carry a string amountOut");
  }
  return amountOut;
}
