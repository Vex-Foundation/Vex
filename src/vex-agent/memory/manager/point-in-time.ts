/**
 * Point-in-time / no-lookahead gate (S5 §6, role-free under v2 FIX-1).
 *
 * This module computes the AUDIT timestamp boundary and a conservative
 * `pointInTimeChecked` flag that DEGRADES `strong` evidence when the boundary
 * is undeterminable — it never rejects a candidate. RETIREMENT NOTE (Agent
 * Scan W4): the ledger-derived outcome resolver this module's original design
 * paired with (`outcome-resolver.ts`, deref `executionId` → realized PnL) is
 * deleted; `consolidate.ts` now stamps a neutral placeholder outcome for
 * every trade-family candidate instead of deriving one. This module is
 * UNCHANGED and still stamps the same as-of boundary for that placeholder —
 * the boundary is a bi-temporal audit fact independent of whether the
 * outcome itself is graded from the ledger or neutral.
 *
 * v2 FIX-1 cut `role` off `evidenceRefs` ({executionId, captureItemId?,
 * instrumentKey?, positionKey?} only), so we cannot exclude an "outcome-role"
 * anchor. We do not need to: nothing here anchors on a derived outcome.
 *
 * Boundary derivation (genesis §677):
 *   - `candidate.eventTime` if the agent supplied it (when the trade happened),
 *   - else MIN(`created_at`) across the candidate's anchor executions (the first
 *     recorded action),
 *   - else NULL (no event_time AND no existing anchor) → `pointInTimeChecked`
 *     false (degrades `strong`).
 *
 * Pure decision core: anchor `created_at` lookups are injected (`ExecDeref`) so
 * the derivation is unit-testable without the executions repo.
 */

import type { EvidenceRefs } from "@vex-agent/memory/schema/memory-candidate.js";

// ── Injected anchor deref (executionId → created_at) ────────────────

/**
 * The minimal facts the boundary derivation needs about an anchor execution:
 * its `createdAt` (when the action was recorded). Returns null if the execution
 * no longer exists (TRUNCATE/replay safe via FIX-1).
 */
export interface ExecTimeRef {
  createdAt: string;
}

/** Injected read: an anchor execution's created_at, or null if it is gone. */
export type ExecTimeDeref = (executionId: number) => Promise<ExecTimeRef | null>;

// ── Decision boundary (available_at_decision_time) ──────────────────

/**
 * Derive the as-of decision boundary for a candidate: `eventTime` if the agent
 * supplied it, else the EARLIEST anchor-execution `created_at`, else null. The
 * returned `Date` is the value stamped onto `memory_candidates.
 * available_at_decision_time` (the audit boundary). A null boundary means the
 * candidate has neither an explicit event time nor any surviving anchor.
 */
export async function deriveDecisionBoundary(
  candidate: { eventTime: string | null; evidenceRefs: EvidenceRefs },
  deps: { getExecutionTime: ExecTimeDeref },
): Promise<Date | null> {
  if (candidate.eventTime) {
    const t = new Date(candidate.eventTime);
    if (!Number.isNaN(t.getTime())) return t;
  }

  let earliest: number | null = null;
  const seen = new Set<number>();
  for (const anchor of candidate.evidenceRefs) {
    if (seen.has(anchor.executionId)) continue;
    seen.add(anchor.executionId);
    const exec = await deps.getExecutionTime(anchor.executionId);
    if (!exec) continue; // anchor gone — FIX-1 replay safety
    const ms = new Date(exec.createdAt).getTime();
    if (Number.isNaN(ms)) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest === null ? null : new Date(earliest);
}

// ── No-lookahead check (pointInTimeChecked) ─────────────────────────

/**
 * Whether the candidate's outcome is point-in-time clean. CONSERVATIVE: a
 * derivable boundary → `true` (the outcome is derived from immutable ledger
 * facts, so by construction it is not lookahead input — the anchors are the
 * agent's own actions, not future market data). A NULL boundary (no eventTime
 * AND no surviving anchor) → `false` (we cannot prove the as-of, so we degrade
 * `strong` rather than falsely promote). Never rejects.
 */
export function checkNoLookahead(boundary: Date | null): boolean {
  return boundary !== null;
}
