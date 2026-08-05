/**
 * THE ORDERING FACT: has this process brought the schema up to date yet?
 *
 * ## The defect this closes
 *
 * On a live start the engine workers began ticking the moment compose reported
 * Postgres reachable (22:21:53), while the schema was still one migrate run
 * behind. Every fast-lane cycle for the next 19 seconds died on
 * `sync.fast_lane.cycle_failed: column "evm_claim_lease_until" does not exist`,
 * twice a second, until `ipc:vex:database:migrate` completed (`applied=3`) at
 * 22:22:12 and the lane self-healed.
 *
 * Nothing was corrupted — the failures were reads against columns that did not
 * exist yet — but a worker issuing SQL against a schema it has not been told is
 * ready is a race, not a policy, and the next migration to ADD a write path
 * would not be as harmless.
 *
 * ## Why a latch, and why here
 *
 * The per-worker `probeReady` checks prove ONE table exists. That is exactly
 * what let the fast lane through: `protocol_sync_jobs` existed, its new columns
 * did not. The fact a worker actually needs is process-wide and singular —
 * "migrations have run to completion in this process" — so it is recorded ONCE,
 * by the only code that can know it, and read by every worker's start gate.
 *
 * Write-once and monotonic: `applied` and `noop` both mean the schema is at the
 * version this build ships (a `noop` run found nothing left to apply). A FAILED
 * run marks nothing, so the workers keep waiting and say so.
 */

let applied = false;

/**
 * Record that a migration run completed successfully. Called only by
 * `migrate-runner.ts` — the one place that can observe the run's outcome.
 */
export function markMigrationsApplied(): void {
  applied = true;
}

/** Whether a migration run has completed successfully in this process. */
export function migrationsApplied(): boolean {
  return applied;
}
