/**
 * Relay-fallback reveal eligibility (Phase-2 bridge factory W5; plan R7/R9/R10,
 * dossier §3) — the closed decision of whether a Khalani bridge failure is
 * allowed to reveal the hidden `bridge_quote_relay` / `bridge_execute_relay`
 * pair for the route that failed.
 *
 * Division of responsibility (do NOT duplicate W1's classifier here): W1 owns
 * `khalani-failure-mapping.ts`, the closed classifier keyed on the EXACT Khalani
 * `externalName` values plus the canonical empty-`routes[]` no-route signal
 * (eligible: empty-routes, CannotFill, NotSupported{Chain,Token,Contract,
 * AssetReverseContract}; everything else — QuoteNotFound / InternalError /
 * Broadcast / Validation / BadRequest / UnexpectedFromAddress / DuplicateRecord
 * / NotSupportedDepositMethod / unknown — DENY). This module is the thin,
 * fail-closed SEAM that turns W1's verdict into a reveal decision, mirroring the
 * closed-set discipline of `uniswap-reveal-eligibility.ts`.
 *
 * COORDINATION NOTE (2026-07-23): W1 has not yet logged its `### W1` factory
 * delta, so `KhalaniFailureClassification` below is the MINIMAL shape this
 * decision depends on — NOT an import of W1 internals (per the factory rule
 * against importing unstable internals). When W1 lands its real classifier
 * export, W3a (which owns wiring the Khalani handler to both W1's classifier and
 * this seam) adapts W1's result to this shape at the call site. If W1's verdict
 * type is richer, the single field consumed here (`revealEligible`) is the only
 * contract that must hold.
 *
 * The route-scope of a reveal (which normalized route unlocks) and the
 * local-chain carve-out are enforced by `relay-reveal.ts`, not here. This
 * function answers only "is this failure class reveal-eligible at all?".
 */

/**
 * The minimal view of W1's Khalani failure classification the reveal decision
 * consumes. `revealEligible === true` iff W1 classified the failure as "Khalani
 * cannot service this route; a fallback venue could" (empty `routes[]` or a
 * NotSupported* / CannotFill `externalName`). W1 owns the closed source set.
 */
export interface KhalaniFailureClassification {
  readonly revealEligible: boolean;
}

/**
 * Closed reveal decision: a Relay route reveal may fire ONLY for a W1-classified
 * reveal-eligible Khalani failure. Fail-closed — an absent verdict or any value
 * other than a literal `true` is NOT eligible (guards a malformed/`any`-typed
 * result from silently widening eligibility, mirroring the typed-guard
 * discipline in `uniswap-reveal-eligibility.ts`).
 */
export function shouldRevealRelayFallback(
  classification: KhalaniFailureClassification | undefined,
): boolean {
  return classification?.revealEligible === true;
}
