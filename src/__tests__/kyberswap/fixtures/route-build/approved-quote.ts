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

import {
  ROUTE_SNAPSHOT_VERSION,
  encodeRouteSnapshotRaw,
} from "@vex-agent/tools/protocols/quote-authority/snapshot.js";
import { computeApprovedMinOut } from "@tools/kyberswap/swap-price-floor.js";

/** The successful arm of `claimSwapExecutionSnapshot`, for a route summary and tolerance. */
export function approvedClaim(routeSummary: unknown, slippageBps: number) {
  const encoded = encodeRouteSnapshotRaw(routeSummary);
  if (!encoded.ok) {
    throw new Error(`approvedClaim: fixture route summary does not encode (${encoded.measuredBytes} bytes)`);
  }
  const amountOut = readAmountOut(routeSummary);
  return {
    ok: true as const,
    prequoteId: "prequote-fixture",
    routeSummary,
    snapshot: {
      v: ROUTE_SNAPSHOT_VERSION,
      provider: "kyberswap" as const,
      raw: encoded.raw,
      digest: encoded.digest,
      approvedAmountOutRaw: amountOut,
      approvedMinOutRaw: computeApprovedMinOut(amountOut, slippageBps).toString(),
      approvedAmountOutHuman: amountOut,
      approvedMinOutHuman: computeApprovedMinOut(amountOut, slippageBps).toString(),
      tokenOutSymbol: "OUT",
      effectiveSlippageBps: slippageBps,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      eligibility: { kind: "executable" as const, priceImpactFraction: 0.001, adverse: false },
    },
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
