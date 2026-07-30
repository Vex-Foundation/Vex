/**
 * BUG-REPORTING emit for memory-manager terminal job failures.
 *
 * Mirrors `compact-jobs/bug-emit.ts` — same fail-closed `emitBugReportSafe`
 * wrapper, same "terminal only" rule, same extraction so the inline block does
 * not pad the worker module.
 *
 * WHY IT WAS MISSING. Memory job failure settlement logged and nothing else:
 * no bug report, no event. A memory job that permanently gives up means
 * consolidation/reconcile silently stopped for that batch, and until now the
 * only trace was a `memLog.warn` nobody collects.
 *
 * NO `engine.error` EVENT HERE, deliberately. `memory_jobs` has no
 * `session_id` column — memory maintenance is GLOBAL work over
 * `knowledge_entries`, not session-scoped — and both error-channel consumers
 * filter strictly by session, so an event would render nowhere. A bug report
 * is the INTERNAL diagnostics channel: it needs no session and no UI, so it is
 * the right home for this today. Whether a global user-facing error surface
 * should exist is an open product decision.
 *
 * The memory job id rides in `context`, not `refs`: the refs schema is
 * `.strict()` and has no memory-job field, and widening a persisted contract
 * for a diagnostic id is not worth the migration surface.
 */

export async function emitMemoryWorkerPermanentlyFailedBug(args: {
  readonly jobId: number;
  readonly jobKind: string;
  readonly errorMsg: string;
}): Promise<void> {
  const { getBugReportSink } = await import("../support/bug-report-registry.js");
  const { emitBugReportSafe } = await import(
    "../../../lib/diagnostics/bug-report-sink.js"
  );
  const logger = (await import("@utils/logger.js")).default;
  await emitBugReportSafe(
    getBugReportSink(),
    {
      source: "worker",
      category: "memory_job_permanently_failed",
      severity: "error",
      title: "memory-worker.permanently_failed",
      description: args.errorMsg,
      context: {
        memoryJobId: args.jobId,
        jobKind: args.jobKind,
      },
      agentContext: {
        stopReason: "system_error",
      },
    },
    logger,
  );
}
