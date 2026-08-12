/**
 * WHEN the Solana sweep looks at a row: the batch bounds, the flat re-check
 * cadence, and the operator-visible escalation threshold.
 *
 * MOVE-ONLY extraction out of `../solana-activity-repair.ts`, which re-exports
 * every name below. Scheduling changes for its own reason (RPC cost, job
 * interval, fairness) and says nothing about what an observation MEANS - that is
 * `./row-resolution.js`.
 */

import type { AgentActivityEvent } from "@vex-agent/db/repos/agent-activity.js";

/** Bounded batch per sweep run (mirrors the EVM/bridge sweeps' own C11 discipline). */
export const SOLANA_SWEEP_BATCH_LIMIT = 25;
export const SOLANA_HASHLESS_RECOVERY_BATCH_LIMIT = 25;

/**
 * Flat re-check cadence, matching the job's own 30s interval (migration 061).
 *
 * This replaced an escalating 60s -> 5m -> 30m -> 2h backoff. That backoff
 * existed when a check meant a transaction-body fetch plus a protocol-aware
 * decode; the terminality check is one batched `getSignatureStatuses` entry, so
 * the cost of re-asking is negligible and a stuck row should not wait hours to
 * be noticed.
 */
export const SOLANA_SWEEP_DUE_INTERVAL_MS = 30_000;

/** Operator-visible escalation threshold (log only - never a failure trigger). */
export const SOLANA_SWEEP_ESCALATION_AGE_MS = 4 * 3_600_000;

/** `true` iff this row has never been checked, or was last checked at least one interval ago. */
export function isSolanaSweepCandidateDue(
  row: Pick<AgentActivityEvent, "submitAttemptedAt" | "lastCheckedAt">,
  nowMs: number,
): boolean {
  if (!row.submitAttemptedAt) return false; // defensive; the candidate query already requires this.
  if (Number.isNaN(Date.parse(row.submitAttemptedAt))) return false;
  if (!row.lastCheckedAt) return true;
  const lastCheckedMs = Date.parse(row.lastCheckedAt);
  if (Number.isNaN(lastCheckedMs)) return true;
  return nowMs - lastCheckedMs >= SOLANA_SWEEP_DUE_INTERVAL_MS;
}

/** `true` once a row has been pending long enough to warrant an operator-visible log (never a failure trigger). */
export function isSolanaSweepEscalated(
  row: Pick<AgentActivityEvent, "submitAttemptedAt">,
  nowMs: number,
): boolean {
  if (!row.submitAttemptedAt) return false;
  const submittedAtMs = Date.parse(row.submitAttemptedAt);
  if (Number.isNaN(submittedAtMs)) return false;
  return nowMs - submittedAtMs >= SOLANA_SWEEP_ESCALATION_AGE_MS;
}
