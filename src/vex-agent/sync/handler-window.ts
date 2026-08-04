/**
 * THE 90 s MONEY GATE — one constant, one predicate, and no cycle.
 *
 * This is a LEAF on purpose. The gate is read by both the pending lane
 * (`agent-activity-repair.ts`, which decides whether an observation may run a
 * status CAS) and the fast lane (`fast-lane.ts`, which arms the lanes). Leaving
 * the constant in one of those modules and the predicate in the other is what
 * made them import each other; a shared leaf is the ordinary repo answer, and
 * both modules re-export their existing names so no caller's import changed.
 *
 * WHY THE GATE EXISTS AT ALL — it is money truth, not latency slack. For the
 * first seconds after a broadcast the owning handler is still decoding its own
 * receipt and is about to write real `executed_*` amounts. A status-only confirm
 * that wins that once-only CAS first forfeits those amounts PERMANENTLY: the row
 * ends `confirmed` with `estimated` quotes and null executed columns, which is
 * the exact defect this wave exists to fix. So the lane may LOOK from age zero —
 * that is what makes a 5 s cadence worth having — and may not CONCLUDE until the
 * handler provably cannot still be writing.
 */

/**
 * How long after its signed submit a row belongs exclusively to its own handler.
 *
 * DELIBERATELY NOT SHORTENED with the 5 s observation cadence: the two measure
 * different things. The cadence is how often we may look; this is how long
 * someone else's write is still expected.
 */
export const REPAIR_CANDIDATE_AGE_MS = 90_000;

/**
 * `true` once the owning broadcast handler can no longer be writing this row.
 *
 * A row with no `submitAttemptedAt`, or an unparseable one, is treated as INSIDE
 * the window — the conservative direction, because the cost of waiting is a
 * delay and the cost of being wrong is a permanently amountless money row.
 */
export function isPastHandlerWindow(
  row: { readonly submitAttemptedAt: string | null },
  nowMs: number,
): boolean {
  if (!row.submitAttemptedAt) return false;
  const submittedMs = Date.parse(row.submitAttemptedAt);
  if (Number.isNaN(submittedMs)) return false;
  return nowMs - submittedMs >= REPAIR_CANDIDATE_AGE_MS;
}
