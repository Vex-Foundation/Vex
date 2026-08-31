/**
 * Extraction of the typed approval-preview channels from a matched prequote's
 * bounded `safetyDetail`. The detail round-trips through the DB as JSONB, so it
 * is `Record<string, unknown>` and every field is treated as untrusted here.
 */

import {
  jupiterFeePreviewSchema,
  type JupiterFeePreview,
} from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";

import { spendabilityPreviewSchema } from "../../quote-authority/spendability.js";
import type { SpendabilityPreview } from "../../quote-authority/spendability-contract.js";

/**
 * Extract the quote-time spendability facts (WP2) from a matched prequote's
 * bounded `safetyDetail`, for the approval card.
 *
 * Re-parsed with the SAME schema the recorder validated against, because the
 * value has crossed persistence as JSONB since (rule 04). A row written before
 * this lane existed, by a venue that measures no balances, or by an older card
 * version yields `undefined` - and the card then simply carries no spendability
 * line, which is honest, rather than a partial one.
 */
export function spendabilityFromSafetyDetail(
  safetyDetail: Record<string, unknown>,
): SpendabilityPreview | undefined {
  const parsed = spendabilityPreviewSchema.safeParse(safetyDetail.spendability);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Extract the Pendle term-lock maturity from a matched swap prequote's bounded
 * `safetyDetail`, for the approval preview. The detail is `Record<string,
 * unknown>` (round-trips through the DB as JSONB), so every field is treated as
 * untrusted and narrowed; a non-Pendle detail naturally yields undefined.
 */
export function termLockFromSafetyDetail(
  safetyDetail: Record<string, unknown>,
): { maturityIso: string } | undefined {
  const tl = safetyDetail.termLock;
  if (typeof tl !== "object" || tl === null) return undefined;
  const iso = (tl as Record<string, unknown>).maturityIso;
  if (typeof iso !== "string" || Number.isNaN(Date.parse(iso))) return undefined;
  return { maturityIso: iso };
}

/**
 * Extract the Jupiter fee-bearing disclosure (W5 design §6 R4) from a matched
 * swap prequote's bounded `safetyDetail`, for the approval preview. Re-parsed
 * with the SAME Zod schema the recorder validated against — the detail is
 * `Record<string, unknown>` (round-trips through the DB as JSONB), so it is
 * treated as untrusted here too. A non-Jupiter detail naturally yields
 * undefined.
 */
export function feePreviewFromSafetyDetail(safetyDetail: Record<string, unknown>): JupiterFeePreview | undefined {
  const parsed = jupiterFeePreviewSchema.safeParse(safetyDetail.feePreview);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Extract the max fee-on-transfer tax (percent) across a matched prequote's EVM
 * legs from its bounded `safetyDetail`, for the restricted-mode approval preview.
 *
 * The EVM `safetyDetail` shape (built by `recordSwapPrequote`) is
 * `{ tokenIn: leg, tokenOut: leg }`, where a non-native, checked leg is
 * `{ isHoneypot, isFOT, tax }`. Per owner doctrine FoT is no longer a verdict
 * `fail`, so a high-tax token reaches the ALLOW path as `pass`; the human still
 * needs to SEE the tax, so we surface it through the typed channel.
 *
 * Defensive: the row's `safetyDetail` is `Record<string, unknown>` (it round-
 * trips through the DB as JSONB), so every field is treated as untrusted and
 * narrowed. Bridge/Solana details have no `isFOT`/`tax` leg shape, so they
 * naturally yield `undefined`. Returns the MAX FoT tax across legs that are
 * `isFOT === true && tax > 0`, or `undefined` when there is no such leg.
 */
export function maxFotTaxFromSafetyDetail(safetyDetail: Record<string, unknown>): number | undefined {
  let max: number | undefined;
  for (const legValue of Object.values(safetyDetail)) {
    if (typeof legValue !== "object" || legValue === null) continue;
    const leg = legValue as Record<string, unknown>;
    if (leg.isFOT !== true) continue;
    const tax = typeof leg.tax === "number" && Number.isFinite(leg.tax) ? leg.tax : 0;
    if (tax > 0 && (max === undefined || tax > max)) max = tax;
  }
  return max;
}
