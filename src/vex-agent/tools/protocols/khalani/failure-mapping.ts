/**
 * Khalani failure classifier (Phase 2 W1) — the COORDINATOR-FIXED, closed-set
 * decision of which Khalani quote/build failures are fallback-eligible (a fallback
 * venue such as Relay could serve the route) versus handled inside Khalani.
 *
 * Mirrors the closed-set discipline of
 * `registry/venue-fallback-eligibility.ts`: builders have no discretion to widen
 * or narrow the sets, classification is keyed on EXACT exception `externalName`
 * values, and any unrecognised name fails closed to `deny` (never suggests a
 * fallback venue).
 *
 * Fallback-eligible ("Khalani cannot service this route; a fallback could"):
 *   - empty `routes[]` from POST /v1/quotes — the PRIMARY signal. It is NOT an
 *     exception (the quotes endpoint returns zero routes, it does not throw); in
 *     stream mode the decision is made only after a clean NDJSON close (see
 *     `quote-result.ts`).
 *   - `CannotFillException`, `NotSupportedChainException`,
 *     `NotSupportedTokenException`, `NotSupportedContractException`,
 *     `NotSupportedAssetReverseContractException`.
 *   - `deposit_mined_revert` (REVISION 1 — fallback-on-execute-revert design) —
 *     the `bridge_deposit` leg of `khalani.bridge`'s staged broadcast was
 *     signed, broadcast, MINED, and reverted on-chain (`outcome.kind ===
 *     "reverted"`). Produced by the caller ONLY for the `bridge_deposit` leg
 *     role (REVISION 1 R1) — an `allowance`/`allowance_reset` leg reverting is
 *     an ERC-20 approve failure, never a route/venue signal. A failed receipt
 *     proves the exact signed deposit tx was included and reverted — distinct
 *     from the `BroadcastException` submit-ambiguity below — but it does NOT
 *     prove Relay would succeed (R2/R3): the classification only makes
 *     `BridgeQuoteRelay` (a read-only quote probe) worth suggesting, never an
 *     automatic Relay execution.
 *
 * Not eligible (handle inside Khalani / fix the request — a fallback would not
 * help). Each carries the in-Khalani handling category so a caller (W3a
 * handlers) does not re-derive the `externalName` → action mapping:
 *   - `QuoteNotFoundException`             → `requote`
 *   - `InternalErrorException`            → `backoff`
 *   - `BroadcastException`                → `resign` (chain-level RPC issue —
 *                                            funds/nonce/blockhash — that would
 *                                            hit Relay too)
 *   - `ValidationException` /
 *     `BadRequestException` /
 *     `UnexpectedFromAddressException`    → `fix_request`
 *   - `DuplicateRecordException`          → `fetch_existing`
 *   - `NotSupportedDepositMethodException`→ `retry_deposit_method` (omit the
 *                                            method first; escalating to a
 *                                            fallback only if EVERY method then
 *                                            fails is the caller's decision, not
 *                                            this classifier's)
 *   - every other / unknown / absent name → `deny` (fail closed)
 *
 * Names present in the live taxonomy but deliberately NOT in either fixed set
 * (`IntentNotFoundException`, `BuildDepositParsingException`) land in `deny` by
 * the closed-set rule: safe (they never suggest a fallback), and the caller
 * surfaces them
 * as a generic Khalani failure rather than this module inventing a policy the
 * coordinator did not fix.
 *
 * Pure, no IO. It ONLY classifies — it does not decide retries or backoff
 * timing. The fallback messaging (`handlers/fallback.ts`) reads the outcome;
 * the bridge handlers (W3a) read the handling category.
 */

/**
 * Exact fallback triggers (an exception `externalName`, the empty-routes
 * signal, or the role-scoped `deposit_mined_revert` mined-revert signal).
 */
export type KhalaniRevealTrigger =
  | "empty_routes"
  | "deposit_mined_revert"
  | "CannotFillException"
  | "NotSupportedChainException"
  | "NotSupportedTokenException"
  | "NotSupportedContractException"
  | "NotSupportedAssetReverseContractException";

/** How a not-fallback-eligible failure should be handled inside Khalani. */
export type KhalaniInKhalaniHandling =
  | "requote"
  | "backoff"
  | "resign"
  | "fix_request"
  | "fetch_existing"
  | "retry_deposit_method"
  | "deny";

/**
 * The failure signal a Khalani quote/build/execute attempt produced.
 * `empty_routes` is a value (zero routes), `exception` carries the mapped
 * `externalName` (which may be `undefined` for a transport/unnamed error →
 * classified `deny`), and `deposit_mined_revert` is the MINED on-chain revert
 * of the staged `bridge_deposit` leg (REVISION 1) — never a caught exception,
 * so it carries no `externalName`. Callers construct `deposit_mined_revert`
 * ONLY when the reverted leg's role is `bridge_deposit` (REVISION 1 R1).
 */
export type KhalaniFailureSignal =
  | { readonly kind: "empty_routes" }
  | { readonly kind: "exception"; readonly externalName: string | undefined }
  | { readonly kind: "deposit_mined_revert" };

/** The closed-set classification result. */
export type KhalaniFailureClassification =
  | { readonly outcome: "fallback_eligible"; readonly trigger: KhalaniRevealTrigger }
  | { readonly outcome: "not_eligible"; readonly handling: KhalaniInKhalaniHandling };

const REVEAL_ELIGIBLE_EXCEPTIONS: ReadonlyMap<string, KhalaniRevealTrigger> = new Map<
  string,
  KhalaniRevealTrigger
>([
  ["CannotFillException", "CannotFillException"],
  ["NotSupportedChainException", "NotSupportedChainException"],
  ["NotSupportedTokenException", "NotSupportedTokenException"],
  ["NotSupportedContractException", "NotSupportedContractException"],
  ["NotSupportedAssetReverseContractException", "NotSupportedAssetReverseContractException"],
]);

const IN_KHALANI_HANDLING: ReadonlyMap<string, KhalaniInKhalaniHandling> = new Map<
  string,
  KhalaniInKhalaniHandling
>([
  ["QuoteNotFoundException", "requote"],
  ["InternalErrorException", "backoff"],
  ["BroadcastException", "resign"],
  ["ValidationException", "fix_request"],
  ["BadRequestException", "fix_request"],
  ["UnexpectedFromAddressException", "fix_request"],
  ["DuplicateRecordException", "fetch_existing"],
  ["NotSupportedDepositMethodException", "retry_deposit_method"],
]);

/**
 * Classify a Khalani failure signal into a fallback decision + handling category.
 * Closed-set: unknown / absent `externalName` → `not_eligible` / `deny`.
 */
export function classifyKhalaniFailure(signal: KhalaniFailureSignal): KhalaniFailureClassification {
  if (signal.kind === "empty_routes") {
    return { outcome: "fallback_eligible", trigger: "empty_routes" };
  }
  if (signal.kind === "deposit_mined_revert") {
    return { outcome: "fallback_eligible", trigger: "deposit_mined_revert" };
  }

  const name = signal.externalName;
  // Absent or non-string name (transport/unnamed error) — fail closed.
  if (typeof name !== "string" || name.length === 0) {
    return { outcome: "not_eligible", handling: "deny" };
  }

  const trigger = REVEAL_ELIGIBLE_EXCEPTIONS.get(name);
  if (trigger !== undefined) {
    return { outcome: "fallback_eligible", trigger };
  }

  const handling = IN_KHALANI_HANDLING.get(name);
  return { outcome: "not_eligible", handling: handling ?? "deny" };
}

/**
 * Convenience predicate mirroring `isVenueFallbackWorthwhile`. Callers can
 * consume either the full classification or this boolean.
 */
export function isKhalaniVenueFallbackWorthwhile(signal: KhalaniFailureSignal): boolean {
  return classifyKhalaniFailure(signal).outcome === "fallback_eligible";
}
