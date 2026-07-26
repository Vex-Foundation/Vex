/**
 * Shared constants for the Solana transaction helpers: the timing/retry knobs
 * used inside this folder, plus the one CHAIN-LEVEL limit a caller outside it
 * needs.
 */

export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;
export const CONFIRM_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_SEND_RETRIES = 2;
export const DEFAULT_NETWORK_RETRIES = 3;

/**
 * Solana's hard per-transaction compute-unit ceiling (protocol constant, not
 * venue-specific): https://solana.com/docs/core/fees/compute-budget — "each
 * transaction is capped at 1,400,000 CUs".
 *
 * Lives here, in the shared transaction layer rather than in a venue module,
 * because it is a fact about the chain: a per-venue copy of a chain limit is
 * exactly how two venues drift apart. `jupiter-swaps/constants.ts` re-exports
 * it for its existing importers.
 *
 * Its consumer is `jupiter-swaps/build-response-guard.ts`, which substitutes it
 * as the CONSERVATIVE assumed compute-unit limit when a `/build` response
 * carries a compute-unit-PRICE instruction but no compute-unit-LIMIT
 * instruction — the documented normal shape of a `/build` response
 * (`/docs/swap/build`: `computeBudgetInstructions` is "compute unit price
 * instruction (does not include compute unit limit)"), which the signed
 * transaction still executes under Solana's default per-instruction CU
 * allocation with no cap tighter than this maximum. Live-reverified 2026-07-24
 * (Codex batch-4 turn-2 closure, C6).
 */
export const SOLANA_MAX_COMPUTE_UNITS_PER_TRANSACTION = 1_400_000;
