/**
 * The refusal vocabulary shared by the generic-signing prepare path.
 *
 * Decode, canonicalization and the fee-bounds gate all answer the same way:
 * a TYPED refusal that names WHAT was refused, or a value. They do not throw.
 * A refusal here happens BEFORE any intent row exists, so it is an ordinary
 * domain outcome the tool reports, not an infrastructure failure, and modelling
 * it as a return value is what keeps "we refused" and "something broke"
 * distinguishable at every call site.
 *
 * Every message is OUR fixed text with only allow-listed structural values
 * interpolated (a selector, a program id, a field name, a decimal amount).
 * Raw provider payloads, calldata blobs, signatures and RPC error bodies never
 * reach it: rule 90 forbids raw hex blobs in errors, and the message is
 * model-visible.
 */

/** The named reason a proposal was refused before an intent could be created. */
export type TransactionRefusalCode =
  /** Calldata whose selector, layout or target is outside the closed v1 set. */
  | "unsupported_call"
  /** A Permit2 selector aimed at an address that is not the canonical deployment. */
  | "non_canonical_permit2"
  /** `data = 0x` to an address that HAS code: a receive/fallback invocation. */
  | "code_at_native_transfer_target"
  /** A Solana instruction, program or account shape outside the closed v1 set. */
  | "unsupported_instruction"
  /** Token-2022, excluded in v1 by name. */
  | "token_2022_unsupported"
  /** A versioned message whose address lookup tables could not be resolved. */
  | "unresolvable_address_lookup_table"
  /** A caller-supplied field that could redirect funds. */
  | "forbidden_field"
  /** A REQUIRED fee bound the caller did not supply. */
  | "missing_fee_bounds"
  /** Malformed or missing input that never reached decode. */
  | "invalid_input"
  /** The proposal could not be simulated, so its effect is unknown. */
  | "simulation_failed";

export interface TransactionRefusal {
  readonly code: TransactionRefusalCode;
  /** Model-visible sentence. Names the refused thing and, when useful, the way forward. */
  readonly message: string;
  /**
   * Structural, allow-listed facts a caller can act on: current network fee
   * estimates when bounds are missing, the offending field name, the decoded
   * revert reason. Strings only, so an amount cannot lose precision on the way
   * to the model.
   */
  readonly details?: Readonly<Record<string, string>>;
}

export type TransactionOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: TransactionRefusal };

export function refuse<T>(
  code: TransactionRefusalCode,
  message: string,
  details?: Readonly<Record<string, string>>,
): TransactionOutcome<T> {
  return { ok: false, refusal: details === undefined ? { code, message } : { code, message, details } };
}

export function accept<T>(value: T): TransactionOutcome<T> {
  return { ok: true, value };
}
