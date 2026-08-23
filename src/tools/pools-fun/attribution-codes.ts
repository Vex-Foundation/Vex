/**
 * pools.fun ATTRIBUTION CODE VOCABULARY - the single owner of every answer the
 * attestation endpoint is allowed to give.
 *
 * Three consumers read this file and nothing else for the vocabulary: the
 * client (`./attribution.ts`) classifies a response body against it, the sweep
 * (`@vex-agent/sync/pools-attribution.ts`) decides from it whether a row leaves
 * the retry lane forever, and the durable CHECK constraint on the rejection
 * column mirrors it (migration `087_pools_launch_attribution.sql`). A lockstep
 * test asserts the migration's literal set equals `POOLS_ATTEST_TERMINAL_CODES`
 * exactly, because a vocabulary that drifts from its constraint fails at write
 * time, in the sweep, days after the code that caused it shipped.
 *
 * WHY A CLOSED SET AT ALL. The partner's free text is never consumed anywhere
 * in this lane: an untrusted string that decides whether a row is retried is a
 * provider-controlled control flow. Only a code that appears below can move a
 * row, and everything else - including a code we have never seen - is a
 * PROTOCOL VIOLATION classified retryable, because an answer we cannot read is
 * not an answer that said no.
 */

/**
 * The partner read the request and definitively refused. A terminal row leaves
 * the sweep permanently: retrying cannot change any of these, and a lane that
 * retries a permanent refusal is a loop that only costs the partner requests.
 */
export const POOLS_ATTEST_TERMINAL_CODES = [
  /**
   * The signature does not recover to the launching wallet, or does not cover
   * the exact attested bytes. Terminal because the signature is produced ONCE,
   * inside the launch signing window, and nothing after the handler holds a
   * signer that could produce a different one.
   */
  "invalid_signature",
  /**
   * The request body did not satisfy the wire contract (shape, chain id, or
   * address form). Terminal because the sweep replays the same stored row
   * byte-for-byte: a body the partner refused once it refuses forever.
   */
  "validation_failed",
  /**
   * The token is not a pools.fun launch. The partner may only return this
   * AFTER a FINALIZED receipt disproves the pinned gateway/factory
   * relationship - never from an unindexed or pending lookup, which is what
   * `launch_not_ready` is for. That precondition is what makes this terminal
   * instead of a race we would be permanently discarding a real badge over.
   */
  "not_pools_launch",
] as const;

/**
 * The partner answered, but the answer does not settle anything. The row keeps
 * `attributed_at` NULL and is offered again on the next cadence.
 */
export const POOLS_ATTEST_RETRYABLE_CODES = [
  /**
   * The launch is not visible to the partner YET. Indexing and finality lag
   * behind our own confirmed receipt, and the backfill sweep can reach a token
   * minutes before the partner's view of the chain does. Retryable by
   * construction: the same request succeeds once the lag closes.
   */
  "launch_not_ready",
  /**
   * The partner does not serve chain 4663 on this deployment. This is LANE
   * MISCONFIGURATION, not a property of the row - every row would get it - so
   * it is classified retryable (nothing about this token is wrong) but logged
   * loudly as `pools.attribution.lane_misconfig`. Silently retrying a
   * misconfigured lane forever, with no operator-visible signal, is the failure
   * mode this code exists to make impossible.
   */
  "chain_unsupported",
] as const;

export type PoolsAttestTerminalCode = (typeof POOLS_ATTEST_TERMINAL_CODES)[number];
export type PoolsAttestRetryableCode = (typeof POOLS_ATTEST_RETRYABLE_CODES)[number];

/**
 * The one retryable code that means the LANE is wrong rather than the row.
 * Named here so the client and the sweep cannot disagree about which code gets
 * the loud log.
 */
export const POOLS_ATTEST_LANE_MISCONFIG_CODE = "chain_unsupported" satisfies PoolsAttestRetryableCode;

export function isPoolsAttestTerminalCode(value: unknown): value is PoolsAttestTerminalCode {
  return (
    typeof value === "string"
    && (POOLS_ATTEST_TERMINAL_CODES as readonly string[]).includes(value)
  );
}

export function isPoolsAttestRetryableCode(value: unknown): value is PoolsAttestRetryableCode {
  return (
    typeof value === "string"
    && (POOLS_ATTEST_RETRYABLE_CODES as readonly string[]).includes(value)
  );
}
