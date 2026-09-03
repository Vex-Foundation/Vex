/**
 * Wallet send handlers - prepare + confirm transfers (Solana + EVM multi-chain).
 *
 * Puzzle 5 phase 4: process-local `pendingIntents = new Map<...>` replaced
 * by DB-backed `wallet_intents` (migration 025). Confirm gates on
 * expiry + status + session ownership via the repo CAS, persists tx hash
 * on success, and surfaces structurally redacted failures so raw RPC /
 * wallet messages never leak into the transcript.
 *
 * This module is a compatibility FAÇADE. The implementation was split into a
 * `send/` subdirectory for LOC discipline; the public surface is unchanged:
 *   - send/validation.ts - prepare/confirm PRESENCE/EXISTING input checks
 *   - send/prepare.ts     - handleWalletSendPrepare (creates DB intent only)
 *   - send/confirm.ts     - handleWalletSendConfirm (gate → CAS → one executor)
 *   - send/finalize.ts    - outcome finalisation (audit writes + ToolResult)
 *   - send/results.ts     - shared ok/fail ToolResult constructors
 *
 * Sibling modules (unchanged):
 *   - send-types.ts          - ExecuteOutcome union, summarizeWalletError,
 *                              buildWalletIntentPreview, TTL constant
 *   - send-execute-solana.ts - Solana validation + staged broadcast
 *   - send-execute-evm.ts    - EVM setup + sendTx + receipt wait
 */

export { handleWalletSendPrepare } from "./send/prepare.js";
export { handleWalletSendConfirm } from "./send/confirm.js";
