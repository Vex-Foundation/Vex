/**
 * Khalani failure classifier (Phase 2 W1) — the COORDINATOR-FIXED, closed-set
 * decision of which Khalani quote/build failures are reveal-eligible (a fallback
 * venue such as Relay could serve the route) versus handled inside Khalani.
 *
 * Mirrors the closed-set discipline of
 * `registry/uniswap-reveal-eligibility.ts`: builders have no discretion to widen
 * or narrow the sets, classification is keyed on EXACT exception `externalName`
 * values, and any unrecognised name fails closed to `deny` (never reveals).
 *
 * Reveal-eligible ("Khalani cannot service this route; a fallback could"):
 *   - empty `routes[]` from POST /v1/quotes — the PRIMARY signal. It is NOT an
 *     exception (the quotes endpoint returns zero routes, it does not throw); in
 *     stream mode the decision is made only after a clean NDJSON close (see
 *     `quote-result.ts`).
 *   - `CannotFillException`, `NotSupportedChainException`,
 *     `NotSupportedTokenException`, `NotSupportedContractException`,
 *     `NotSupportedAssetReverseContractException`.
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
 * the closed-set rule: safe (they never reveal), and the caller surfaces them
 * as a generic Khalani failure rather than this module inventing a policy the
 * coordinator did not fix.
 *
 * Pure, no IO. It ONLY classifies — it does not decide retries, backoff timing,
 * or reveal bookkeeping. The reveal registry (W5) reads the reveal decision;
 * the bridge handlers (W3a) read the handling category.
 */

/** Exact reveal triggers (an exception `externalName`, or the empty-routes signal). */
export type KhalaniRevealTrigger =
  | "empty_routes"
  | "CannotFillException"
  | "NotSupportedChainException"
  | "NotSupportedTokenException"
  | "NotSupportedContractException"
  | "NotSupportedAssetReverseContractException";

/** How a not-reveal-eligible failure should be handled inside Khalani. */
export type KhalaniInKhalaniHandling =
  | "requote"
  | "backoff"
  | "resign"
  | "fix_request"
  | "fetch_existing"
  | "retry_deposit_method"
  | "deny";

/**
 * The failure signal a Khalani quote/build attempt produced. `empty_routes` is
 * a value (zero routes), `exception` carries the mapped `externalName` (which
 * may be `undefined` for a transport/unnamed error → classified `deny`).
 */
export type KhalaniFailureSignal =
  | { readonly kind: "empty_routes" }
  | { readonly kind: "exception"; readonly externalName: string | undefined };

/** The closed-set classification result. */
export type KhalaniFailureClassification =
  | { readonly outcome: "reveal_eligible"; readonly trigger: KhalaniRevealTrigger }
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
 * Classify a Khalani failure signal into a reveal decision + handling category.
 * Closed-set: unknown / absent `externalName` → `not_eligible` / `deny`.
 */
export function classifyKhalaniFailure(signal: KhalaniFailureSignal): KhalaniFailureClassification {
  if (signal.kind === "empty_routes") {
    return { outcome: "reveal_eligible", trigger: "empty_routes" };
  }

  const name = signal.externalName;
  // Absent or non-string name (transport/unnamed error) — fail closed.
  if (typeof name !== "string" || name.length === 0) {
    return { outcome: "not_eligible", handling: "deny" };
  }

  const trigger = REVEAL_ELIGIBLE_EXCEPTIONS.get(name);
  if (trigger !== undefined) {
    return { outcome: "reveal_eligible", trigger };
  }

  const handling = IN_KHALANI_HANDLING.get(name);
  return { outcome: "not_eligible", handling: handling ?? "deny" };
}

/**
 * Convenience predicate mirroring `isRevealEligibleKyberFailure`. The reveal
 * registry (W5) can consume either the full classification or this boolean.
 */
export function isRevealEligibleKhalaniFailure(signal: KhalaniFailureSignal): boolean {
  return classifyKhalaniFailure(signal).outcome === "reveal_eligible";
}
