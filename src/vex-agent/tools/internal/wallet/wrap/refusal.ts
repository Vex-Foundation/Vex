/**
 * The refusal vocabulary for the native <-> wrapped-native wrap path.
 *
 * A SEPARATE closed union from the generic-signing lane's, deliberately. That
 * lane refuses decoder outcomes ("unsupported_call", "token_2022_unsupported");
 * this one refuses registry, lifecycle and re-derivation outcomes. Widening the
 * other union to cover both would give every call site on either path a set of
 * codes it can never produce and can never handle meaningfully, and the two
 * vocabularies have different owners.
 *
 * Same conventions as that lane, and for the same reasons:
 *
 *  - a refusal is a RETURN VALUE, not a throw, so "we refused" and "something
 *    broke" stay distinguishable at every call site;
 *  - `message` is OUR fixed text with only allow-listed structural values
 *    interpolated (a chain alias, a field name, a decimal amount, an address).
 *    Raw provider payloads, calldata blobs and RPC error bodies never reach it:
 *    the message is model-visible and rule 90 keeps raw hex out of errors;
 *  - `details` values are STRINGS ONLY, so an amount cannot become a JSON
 *    number and lose precision on the way to the model.
 */

/** The named reason a wrap proposal was refused. */
export type WrapRefusalCode =
  /** The chain resolved, but no VERIFIED wrapped-native contract is registered for it. */
  | "unverified_chain"
  /** The supplied chain alias resolved to no chain at all. */
  | "unknown_chain"
  /** Malformed, missing or out-of-shape input that never reached derivation. */
  | "invalid_input"
  /** A REQUIRED gas fee bound the caller did not supply, or supplied in a non-EVM shape. */
  | "missing_fee_bounds"
  /** A caller-supplied field that could redirect funds or alter the bound proposal. */
  | "forbidden_field"
  /** The wallet cannot cover the amount plus the authorized network fee ceiling. */
  | "insufficient_balance"
  /** The proposal could not be simulated, so its effect is unknown. */
  | "simulation_failed"
  /** The recomputed proposal digest differs from the one stored beside the row. */
  | "digest_mismatch"
  /** The intent's own expiry has passed. */
  | "expired"
  /** The intent was already consumed; an approval is not reusable. */
  | "already_consumed"
  /** The intent was cancelled before confirm. */
  | "cancelled"
  /** The confirm-time re-derived `{to,data,value}` triple differs from the bound one. */
  | "payload_mismatch";

export interface WrapRefusal {
  readonly code: WrapRefusalCode;
  /** Model-visible sentence. Names the refused thing and, when useful, the way forward. */
  readonly message: string;
  /**
   * Structural, allow-listed facts a caller can act on: the chain alias that
   * has no verified contract, the offending field name, the amount short.
   * Strings only, so an amount cannot lose precision on the way to the model.
   */
  readonly details?: Readonly<Record<string, string>>;
}

export type WrapOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: WrapRefusal };

export function refuse<T>(
  code: WrapRefusalCode,
  message: string,
  details?: Readonly<Record<string, string>>,
): WrapOutcome<T> {
  return { ok: false, refusal: details === undefined ? { code, message } : { code, message, details } };
}

export function accept<T>(value: T): WrapOutcome<T> {
  return { ok: true, value };
}
