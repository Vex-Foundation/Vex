/**
 * Ref-counted registry of in-flight CRITICAL operations — local, handler-
 * duration operations that must not be interrupted by an update restart
 * (skill vex-user-triggered-updates §"Safe restart gate").
 *
 * Recon confirmed no queryable in-flight signal exists today (the docker/db
 * single-flight vars are module-local), so the few destructive, handler-
 * duration handlers register here via `beginCriticalOp`/end and the
 * safe-restart gate consults `criticalOpInFlight()`.
 *
 * NOTE: agent/mission execution is NOT tracked here — it outlives the IPC
 * handler that starts it, so wrapping those handlers would mark the op for
 * only the brief enqueue. That dimension is gated by a DB query
 * (`hasActiveAgentWork`) instead.
 */

export const CRITICAL_OP = {
  dockerLifecycle: "docker_lifecycle",
  dbMigration: "db_migration",
  // Keystore / secret-vault writes + private-key decrypt (wallet generate /
  // import / restore / export, provider+api-key+embedding+agent-core persist).
  secretVaultOp: "secret_vault_op",
  // The user's Lighter leverage change: signing plus the submission window. A
  // Settings action has no agent activity and no approval row for the
  // safe-restart gate to detect, so the executor registers it here instead.
  lighterLeverageChange: "lighter_leverage_change",
} as const;

export type CriticalOpLabel = (typeof CRITICAL_OP)[keyof typeof CRITICAL_OP];

const counts = new Map<string, number>();

/** Mark a critical op in flight. Returns an idempotent `end` callback. */
export function beginCriticalOp(label: CriticalOpLabel): () => void {
  counts.set(label, (counts.get(label) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const next = (counts.get(label) ?? 1) - 1;
    if (next <= 0) counts.delete(label);
    else counts.set(label, next);
  };
}

/** True while any critical op is running. */
export function criticalOpInFlight(): boolean {
  return counts.size > 0;
}

/** Labels currently in flight (for a user-actionable block reason). */
export function activeCriticalOps(): readonly string[] {
  return [...counts.keys()];
}

/**
 * Wrap an async handler so its whole duration counts as a critical op.
 * `finally` guarantees the count is released on every return/throw path.
 */
export function trackCriticalOp<A extends unknown[], R>(
  label: CriticalOpLabel,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    const end = beginCriticalOp(label);
    try {
      return await fn(...args);
    } finally {
      end();
    }
  };
}

/** Test-only: clear all counts. */
export function __resetCriticalOpsForTests(): void {
  counts.clear();
}
