/**
 * The `last_verification_reason` vocabulary (migration 065) and the stall
 * threshold/throttle that decide when a pending row reads as
 * `stalled_verification`.
 */

import type { AgentActivityEvent } from "./event-row.js";

/**
 * How many CONSECUTIVE inconclusive verification attempts make a pending row
 * `stalled_verification` (migration 065).
 *
 * 20 ≈ 10 minutes of fast-lane checks or ≈ 20 minutes of global sweeps — long
 * enough that a slow-but-healthy transaction never trips it, short enough that a
 * permanently unverifiable chain (`no_safe_rpc`) is named while the user still
 * remembers the transaction.
 *
 * DERIVED, NEVER STORED. Crossing this threshold changes what the UI and the
 * agent are TOLD; it never changes `status`, and it can never fail a row.
 */
export const STALLED_VERIFICATION_ATTEMPTS = 20;

/**
 * THE BOUND ON `last_verification_reason` (migration 065): a CLOSED SET of our
 * own named codes, and the ONE owner of that vocabulary.
 *
 * It lives here, beside `STALLED_VERIFICATION_ATTEMPTS` and
 * `isStalledVerification`, because the read side of this column already lives
 * here. It used to live in `sync/bridge-activity-repair-contracts.ts` while
 * three sweeps wrote reasons it had never heard of — the EVM sweep's
 * `receipt_not_found`/`lookup_error` and the Solana sweep's five — so the
 * "closed set" was closed over one writer out of three. Every one of them is
 * admitted BY NAME below.
 *
 * WHAT THIS COLUMN MEANS, exactly: *why the last verification CHECK could not
 * conclude*. It is NOT "why the row is pending" and NOT "what evidence the
 * amounts have" — a conclusive-but-non-terminal observation and an
 * amount-evidence fact are different facts in different columns, with their own
 * writers. Putting either here is what made two columns collide.
 *
 * The column is surfaced verbatim to the UI (`AgentScanRow.tsx`) and to the
 * agent (`inspect-views/transactions.ts`), so bounding it by NAME — not by
 * length — is what keeps an unbounded string of someone else's making out of a
 * user-visible field, and it is also what makes the value actionable: the agent
 * can tell `no_safe_rpc` ("we could not look") from `not_yet_confirmed` ("we
 * looked, it is still mining").
 *
 * DELIBERATELY NOT A DB CHECK. Migration 065 is expand-only; a CHECK would make
 * every future reason a migration. The union plus the single writer is the
 * boundary.
 */
/**
 * How long `verification_attempts` must wait between increments (migration 068).
 *
 * The counter measures a STALL, and its threshold is documented in minutes; the
 * lane polls in seconds. Without this throttle a healthy transaction merely
 * unknown to the queried node reaches the 20-attempt threshold in 100 s at the
 * 5 s cadence and renders as "verification stalled" — a lie about what the
 * system knows. With it, `verification_attempts` counts inconclusive WINDOWS,
 * so the threshold keeps its ~10-minute meaning at any polling rate.
 */
export const STALL_INCREMENT_MIN_INTERVAL_MS = 30_000;

export const VERIFICATION_REASONS = [
  // ── The bridge verifier's own (`sync/bridge-activity-repair-verification.ts`) ──
  "malformed_fill_hash",
  "no_safe_rpc",
  "fill_reverted",
  /**
   * PRE-EXISTING ROWS ONLY. Superseded by the four precise reasons below, which
   * say WHY no receipt was obtained; nothing produces it any more.
   */
  "receipt_unavailable",
  "malformed_fill_signature",
  "fill_failed",
  "not_yet_confirmed",
  "signature_status_unavailable",
  // ── The bridge sweep's inconclusive exits ──
  "verification_failed",
  "filled_without_hash",
  "provider_unreachable",
  "chain_mismatch",
  "correlation_mismatch",
  "missing_route",
  "refund_evidence_write_failed",
  // The order-id recovery queue's own inconclusive exits. A crash-after-deposit
  // row has NO order id, so this queue is the only verifier it has: without a
  // reasoned stall it could be retried forever while the UI kept rendering an
  // ordinary healthy pending.
  "recovery_throw",
  "recovery_null",
  "attach_conflict",
  // ── The EVM receipt sweep (`sync/agent-activity-repair.ts`) ──
  "receipt_not_found",
  /** The lookup itself threw — we could not look, as opposed to looking and learning nothing. */
  "rpc_error",
  // ── The Solana sweep (`sync/solana-activity-repair.ts`) ──
  "unreadable_signature_status",
  "get_transaction_unavailable",
  "unreadable_transaction_meta",
  "no_blockhash_evidence",
  "block_height_unavailable",
  // ── The bridge verifier's five-way split of the old `receipt_unavailable` ──
  /** An endpoint echoed the right chain and answered "no receipt yet" — WAIT. */
  "fill_not_mined",
  /** No endpoint ever answered — we cannot see this chain at all. */
  "rpc_unreachable",
  /**
   * An endpoint ANSWERED and REFUSED the request: a JSON-RPC error response,
   * not a transport failure. Measured origin (owner's install, 2026-09-04): a
   * public endpoint served `eth_chainId` for Arbitrum One and returned
   * `-32602 archive request` for a month-old receipt. That is a statement about
   * THIS ENDPOINT, not about the chain, and calling it `rpc_unreachable` is what
   * let a row re-probe the same refusing URL 1227 times. Surfaces must say "an
   * endpoint refused the request", never "chain unreachable".
   */
  "rpc_refused_request",
  /** Every endpoint answered `eth_chainId` with a different chain than the one we need. */
  "chain_echo_mismatch",
  /**
   * A receipt exists but its status is a value viem cannot read. NOT a revert:
   * claiming a revert we cannot prove is a claim beyond the evidence.
   */
  "unreadable_receipt_status",
  /**
   * The EVM lane looked and NO node knew this hash — no receipt, no mempool
   * entry, and the wallet's own nonce has not passed it. An inconclusive CHECK,
   * not a conclusion: the transaction may be sitting in a node we did not ask,
   * which is exactly why a terminalization built on it needs a bounded window.
   */
  "tx_unknown_to_node",
] as const;

export type VerificationReason = (typeof VERIFICATION_REASONS)[number];

/** Admit a known code, or fall back to the generic one. An UNRECOGNISED string is never stored. */
export function toVerificationReason(raw: string | undefined): VerificationReason {
  return VERIFICATION_REASONS.find((known) => known === raw) ?? "verification_failed";
}

/**
 * `true` iff this row is pending AND we have repeatedly been unable to verify
 * it. NOT a failure — it means "we could not look", which the copy must say.
 */
export function isStalledVerification(
  row: Pick<AgentActivityEvent, "status" | "verificationAttempts">,
): boolean {
  return row.status === "pending"
    && row.verificationAttempts >= STALLED_VERIFICATION_ATTEMPTS;
}
