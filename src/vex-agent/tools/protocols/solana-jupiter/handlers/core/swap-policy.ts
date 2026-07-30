/**
 * The policy and error-scrub seam shared by `solana.swap.quote` and
 * `solana.swap.execute`.
 *
 * Extracted verbatim from `../core.ts` as part of a façade-preserving
 * structural split, so both swap handlers read the SAME ceiling and the SAME
 * scrub boundary rather than each keeping its own copy.
 */

import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import { checkSlippageBps } from "@vex-agent/tools/protocols/slippage-policy.js";

import { num } from "../../../handler-helpers.js";

export const SWAP_PROTOCOL = "jupiter";
export const SWAP_NAMESPACE = "solana";

/** The ONE entry point for provider-error text reaching an output/log/reason (scrub boundary — mirrors kyberswap/lend). */
export function swapFailureMessage(err: unknown): string {
  return summarizeProtocolError(err).message;
}

/**
 * Vex's slippage ceiling, applied to the Jupiter venue.
 *
 * Jupiter's own range check permits 0–10,000 bps
 * (`jupiter-swaps/validation.ts`), and the manifest `unit: "bps"` gate
 * (`runtime/bps-param.ts`) proves integrality but deliberately applies no
 * maximum — so before this check a model could authorise a 5,000 bps swap here
 * while the identical KyberSwap request was refused. The ceiling is product
 * policy and has ONE owner (`slippage-policy.ts`); this is Jupiter's call site.
 *
 * No `venueMaxBps` is passed: Jupiter's 10,000 is ABOVE Vex's ceiling, so the
 * ceiling binds on its own (`effectiveMaxSlippageBps`).
 *
 * REJECTED, never clamped, and checked BEFORE wallet resolution or any provider
 * call — a price-protection parameter the caller got wrong must surface as the
 * caller's mistake, not be quietly lowered at the boundary where it costs money.
 *
 * @returns the agent-actionable rejection reason, or `null` when permitted.
 * An omitted value takes Jupiter's own default and is not this gate's business.
 */
export function jupiterSlippageViolation(toolId: string, p: Record<string, unknown>): string | null {
  const raw = num(p, "slippageBps");
  if (raw === undefined) return null;
  return checkSlippageBps(`Parameter "slippageBps" for ${toolId}`, raw);
}
