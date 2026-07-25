/**
 * Agent Scan activity repo — write-boundary validation (Codex findings 9/C5).
 *
 * `assertFailureCode` fail-closes the `failure_code` enum before a row ever
 * reaches SQL; `sanitizeFailureReason` redacts + caps `failure_reason`
 * UNCONDITIONALLY, so a caller cannot bypass it by pre-sanitizing. Shared by
 * both `./swap.js` and `./bridge.js` — every write path funnels through here.
 * Exported for sibling import — not part of the public façade surface.
 *
 * `CLOSED_FAILURE_CODES` is ALSO exported directly (not just through
 * `assertFailureCode`) so the SQL<->TS lockstep test
 * (`agent-activity-failure-code-lockstep.test.ts`, W5/K1) can diff it against
 * the `agent_activity_failure_code_valid` migration CHECK without
 * hand-duplicating the list a third time.
 */

import { redact } from "../../../../lib/diagnostics/text-redaction.js";

import type { AgentActivityFailureCode } from "./types.js";

export const CLOSED_FAILURE_CODES: ReadonlySet<string> = new Set<AgentActivityFailureCode>([
  "route_not_found",
  "slippage",
  "deadline_expired",
  "insufficient_liquidity",
  "allowance_or_balance",
  "chain_unsupported",
  "simulation_reverted",
  "mined_revert",
  "broadcast_error",
  "confirmation_timeout",
  "unknown",
  "bridge_failed",
  "bridge_refunded",
  "solana_signature_expired",
]);

/**
 * W5 stage/error mapping (design REVISION 1 R1, K1 card deliverable) — guides
 * K2 (staged seam), K3 (Solana sweep), K5 (prediction), K6 (lend) on WHICH
 * `failure_code` to write for a given lend/prediction/Jupiter-swap failure.
 * R1's rule: reuse an existing code wherever its semantics genuinely match;
 * grow this enum only when a real filtering/routing need appears (there is
 * exactly ONE new code this migration adds: `solana_signature_expired`).
 * Domain-specific scenarios (market_closed, position_not_found,
 * insufficient_collateral) are NOT codes — they are `failure_reason` TEXT
 * under the closest matching existing code below, sanitized as always via
 * `sanitizeFailureReason`.
 *
 * | Stage                                   | Scenario                                                         | failure_code               | Notes |
 * |------------------------------------------|-------------------------------------------------------------------|-----------------------------|-------|
 * | Pre-broadcast (param/quote validation)    | invalid params, provider rejects the quote/build before signing   | `route_not_found`           | matches 044's existing swap-quote-rejected semantics |
 * | Pre-broadcast (economic floor)            | fresh quote fails the persisted threshold floor (R4b)              | `slippage`                  | reused verbatim, no new code |
 * | Pre-broadcast (deadline)                  | quote/build expired before signing                                 | `deadline_expired`          | reused verbatim |
 * | Pre-broadcast (sign refusal, R2b)         | provider-built tx already carries a nonzero signature (sole-signer check failed) | `unknown` + structured reason | the refusal itself is not chain-specific; the reason string carries the "why" |
 * | On-chain (mined revert)                   | `getTransaction` shows `err` set                                    | `mined_revert`              | K3's registered-decoder path (R3) |
 * | On-chain (blockhash expiry, R3)           | signature unknown AND `blockHeight > last_valid_block_height`      | `solana_signature_expired`  | the ONE new code this migration adds — safe because an expired blockhash can never land |
 * | On-chain (RPC/status ambiguous)           | uncertain outcome, healthy or unhealthy RPC                         | stays `pending`             | NOT a failure_code — 044/R3 doctrine: ambiguity never terminalizes; no give-up rail |
 * | Domain (prediction: market closed)        | Jupiter Prediction rejects because the market already resolved     | `unknown` + reason "market_closed: …"      | reason, not a code (R1) |
 * | Domain (prediction: position not found)   | claim/close references a position that no longer exists            | `unknown` + reason "position_not_found: …" | reason, not a code (R1) |
 * | Domain (lend: insufficient collateral)    | Jupiter Lend/Borrow rejects a withdraw/operate for collateral       | `allowance_or_balance` + reason "insufficient_collateral: …" | closest existing semantic match (R1); K6 confirms against the live API shape when it lands |
 */

/** Fail-closed runtime guard for the closed `failure_code` enum (never reaches SQL on a miss). */
export function assertFailureCode(code: string): asserts code is AgentActivityFailureCode {
  if (!CLOSED_FAILURE_CODES.has(code)) {
    throw new Error(`agent_activity: "${code}" is not a recognized failure_code`);
  }
}

/**
 * Repo-boundary sanitization for `failure_reason` (finding 9/C5) — applied
 * UNCONDITIONALLY inside every function that writes this column, so a
 * caller cannot bypass it by skipping its own redaction. Two-tier `redact()`
 * (hard-redacts secret shapes, masks addresses/hashes) then a hard 500-char
 * cap — raw provider/RPC text NEVER reaches this column.
 */
const MAX_FAILURE_REASON_CHARS = 500;
export function sanitizeFailureReason(reason: string): string {
  const redacted = redact(reason).text;
  return redacted.length > MAX_FAILURE_REASON_CHARS
    ? `${redacted.slice(0, MAX_FAILURE_REASON_CHARS)}…[truncated]`
    : redacted;
}
