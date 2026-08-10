/**
 * Stored status and failure-code vocabulary for `agent_activity` rows, with
 * the two terminal-state predicates that read them.
 */

/**
 * A row's stored status (migration 044, widened by 068).
 *
 * `superseded_unproven` is a NON-FAILURE TERMINAL state (owner decision A6). It
 * asserts exactly two things: the hash is NO LONGER TRACKED AS IN FLIGHT, and
 * its inclusion/replacement outcome is UNPROVEN. It does NOT assert that the
 * transaction failed, that nothing was spent, or that a retry is safe — only
 * `nonce_superseded` establishes non-inclusion at all, and even then a
 * replacement reusing the nonce may have carried the same calldata.
 *
 * It carries NO `failure_code`, and no surface may render it as a failure. It
 * exists because the alternative is a row that stays `pending` forever, which is
 * what froze every background portfolio snapshot and kept the repair loops
 * shouting about a hash nothing was going to resolve.
 */
export type AgentActivityStatus =
  | "pending"
  | "confirmed"
  | "definitively_failed"
  | "superseded_unproven";

/** `true` for a status no longer in flight — the predicate every "is it done" question should ask. */
export function isTerminalActivityStatus(status: AgentActivityStatus): boolean {
  return status !== "pending";
}

/**
 * `true` iff this row ended in a state that means the transaction DID NOT
 * happen. `superseded_unproven` is deliberately excluded: we do not know.
 */
export function isFailedActivityStatus(status: AgentActivityStatus): boolean {
  return status === "definitively_failed";
}

/**
 * Closed enum — plan §4.1, grown to 11 members by FIX-SPINE round 1 (finding
 * 7/C1): `mined_revert` is the repair sweep's ONE definitive-failure path (a
 * receipt lookup that came back reverted). `confirmation_timeout` stays in
 * the enum but is RESERVED — nothing in this repo or the repair sweep ever
 * sets it; ambiguity (missing receipt, RPC error, receipt-wait throw) leaves
 * the row `pending` forever instead.
 */
export type AgentActivityFailureCode =
  | "route_not_found"
  | "slippage"
  | "deadline_expired"
  | "insufficient_liquidity"
  | "allowance_or_balance"
  | "chain_unsupported"
  | "simulation_reverted"
  | "mined_revert"
  | "broadcast_error"
  | "confirmation_timeout"
  | "unknown"
  // Bridge terminal codes (045): `bridge_refunded` = the bridge failed but funds
  // were returned to `refundTo` (money back != success); `bridge_failed` = a
  // provider-terminal failure / rejected step set.
  | "bridge_failed"
  | "bridge_refunded"
  // W5 (049): a locally-staged Solana tx whose blockhash proved expired
  // (blockHeight > the row's own persisted last_valid_block_height) before
  // any signature status was ever observed — safe because an expired
  // blockhash can never land. `market_closed` / `position_not_found` /
  // `insufficient_collateral` are NOT new codes (design REVISION 1 R1):
  // they start as structured `failure_reason` text under the existing
  // codes above, not new enum members, unless a future need for
  // code-level filtering justifies growing this enum.
  | "solana_signature_expired"
  // 076: the KyberSwap availability class - the venue could not serve us at
  // all (edge refusal, missing endpoint, rate limit, 5xx, timeout, or
  // transport-unreachable). Distinct from `route_not_found`, which is a
  // semantic verdict the venue rendered about the trade.
  | "venue_unavailable";
