/**
 * The Solana sweep's PORT CONTRACT: exactly the external reads the sweep may
 * perform, the lookup vocabulary those reads answer in, and the shapes it
 * reports back.
 *
 * MOVE-ONLY extraction out of `../solana-activity-repair.ts`, which re-exports
 * every name below so no import site changes. It lives on its own because three
 * modules need it (the orchestration, the per-row resolution, the amount lane)
 * and because a port contract changes for its own reason: what the sweep is
 * allowed to ask the chain, not what it concludes from the answers.
 *
 * Production wiring for this port is `../solana-activity-repair-deps.js`.
 */

export interface SolanaSignatureStatusValue {
  readonly err: unknown;
  readonly confirmationStatus: string | null;
}

/**
 * `"found"` carries a genuine answer. `"not_found"` is a genuine "no such
 * record" answer FROM a trusted RPC (meaningful for the expiry gate).
 * `"unavailable"` means no healthy/verified RPC could be reached, or the
 * response was malformed - NEVER treated as "not found".
 */
export type SolanaRpcLookup<T> =
  | { readonly outcome: "found"; readonly value: T }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "unavailable" };

export interface SolanaActivitySweepDeps {
  /**
   * BATCHED status lookup - `getSignatureStatuses` takes an array, so one sweep
   * run costs ONE RPC round trip for its whole due batch instead of one per
   * row. The returned array is aligned with the input by index; a `null` entry
   * is a genuine "no such signature" from a trusted RPC. A transport failure or
   * a malformed response is `"unavailable"` for the WHOLE call - never silently
   * reinterpreted as per-row absence.
   */
  readonly getSignatureStatuses: (
    signatures: readonly string[],
  ) => Promise<SolanaRpcLookup<readonly (SolanaSignatureStatusValue | null)[]>>;
  /**
   * Raw `getTransaction` RPC result, requested with `encoding: "json"`,
   * `commitment: "finalized"`, `maxSupportedTransactionVersion: 0`.
   *
   * The ENCODING is part of this contract, not an adapter detail: the
   * instruction-level decoders read compiled instructions
   * (`programIdIndex`/`accounts`/`data`) and resolve account indexes against
   * `accountKeys` plus `meta.loadedAddresses`. `jsonParsed` would hand them a
   * different, program-dependent shape, and a decoder proven on a shape
   * production does not return is not proven at all.
   */
  readonly getFinalizedTransaction: (signature: string) => Promise<SolanaRpcLookup<unknown>>;
  readonly getCurrentBlockHeight: () => Promise<SolanaRpcLookup<number>>;
}

export interface SolanaActivitySweepResult {
  readonly recovered: number;
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
}

export interface SolanaBatchResolution {
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
}
