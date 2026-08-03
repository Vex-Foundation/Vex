/**
 * EVM quote extraction (kyberswap.swap.quote, and the shape-identical Trench
 * Express curve quote). We deliberately do NOT import the handler-local
 * `QuoteSafetyLeg` type from kyberswap/handlers/swap.ts (it is not exported); we
 * structurally re-validate instead.
 */

import { z } from "zod";

import { aggregateVerdict } from "./verdict.js";
import type { LegVerdictDetail } from "./verdict.js";
import type { ExtractedQuote } from "./extracted-quote.js";

// EVM safety legs — structural re-validation of the kyberswap quote safety
// block (we do NOT import the handler-local QuoteSafetyLeg type).
const EvmNativeLegSchema = z.object({ native: z.literal(true) });
const EvmAuditLegSchema = z.object({
  isHoneypot: z.boolean(),
  isFOT: z.boolean(),
  tax: z.number(),
});
const EvmCheckFailedLegSchema = z.object({
  checkFailed: z.literal(true),
  reason: z.string(),
});
const EvmLegSchema = z.union([
  EvmNativeLegSchema,
  EvmAuditLegSchema,
  EvmCheckFailedLegSchema,
]);
const EvmSafetySchema = z.object({
  tokenIn: EvmLegSchema,
  tokenOut: EvmLegSchema,
});
type EvmLeg = z.infer<typeof EvmLegSchema>;

/** Bounded reason class — only the four literals the handler emits survive. */
const EVM_CHECK_FAILED_REASONS = new Set([
  "timeout",
  "rate_limited",
  "kyber_error",
  "unavailable",
]);

/**
 * Per-leg EVM verdict + bounded detail. Mirrors the ONE hard-abort in
 * `executeKyberSwap`: a CONFIRMED honeypot (`isHoneypot === true`) → fail. Per
 * owner doctrine that is the ONLY hard safety block for a swap — fee-on-transfer
 * / high tax is NOT a fail (the model decides on fee-bearing tokens, even in
 * full-autonomous + full-agent modes). The bounded detail STILL discloses
 * `{ isHoneypot, isFOT, tax }` so the model/human can see the fee-on-transfer in
 * the quote output (the verdict softens, the disclosure does not). A checkFailed
 * or malformed leg is fail-closed → unknown. Native does not worsen the verdict
 * (treated as pass at the leg level; aggregation ignores it anyway).
 */
function evmLegVerdict(leg: EvmLeg): LegVerdictDetail {
  if ("native" in leg) {
    return { verdict: "pass", detail: { native: true } };
  }
  if ("checkFailed" in leg) {
    // Defense-in-depth: only surface a bounded reason class, never raw text.
    const reason = EVM_CHECK_FAILED_REASONS.has(leg.reason) ? leg.reason : "unavailable";
    return { verdict: "unknown", detail: { checkFailed: true, reason } };
  }
  return {
    verdict: leg.isHoneypot ? "fail" : "pass",
    detail: { isHoneypot: leg.isHoneypot, isFOT: leg.isFOT, tax: leg.tax },
  };
}

// EVM quote result (kyberswap.swap.quote) — token addresses + chainId + safety.
const EvmQuoteResultSchema = z.object({
  chainId: z.number(),
  tokenIn: z.object({ address: z.string() }),
  tokenOut: z.object({ address: z.string() }),
  safety: EvmSafetySchema,
});

export function extractEvm(
  params: Record<string, unknown>,
  data: Record<string, unknown>,
): ExtractedQuote | null {
  const parsed = EvmQuoteResultSchema.safeParse(data);
  if (!parsed.success) return null;
  const amountRaw = params.amountIn;
  if (typeof amountRaw !== "string" || amountRaw.trim() === "") return null;
  const slippage = typeof params.slippageBps === "number" ? params.slippageBps : null;

  const inLeg = evmLegVerdict(parsed.data.safety.tokenIn);
  const outLeg = evmLegVerdict(parsed.data.safety.tokenOut);

  // No route facts are persisted here. A quote-time price floor used to ride
  // the `route_ref` column so `kyberswap.swap.execute` could hold the build to
  // it; that comparison was a zero tolerance stacked on the caller's own
  // `slippageBps` and was removed by owner decision (2026-07-25) — see
  // `@tools/kyberswap/swap-price-floor.js`. The execute now derives its floor
  // from the FRESH route it just fetched, so nothing needs carrying across.
  return {
    tokenIn: parsed.data.tokenIn.address,
    tokenOut: parsed.data.tokenOut.address,
    chainId: parsed.data.chainId,
    amount: amountRaw,
    slippageBps: slippage,
    verdict: aggregateVerdict([inLeg.verdict, outLeg.verdict]),
    safetyDetail: { tokenIn: inLeg.detail, tokenOut: outLeg.detail },
  };
}
