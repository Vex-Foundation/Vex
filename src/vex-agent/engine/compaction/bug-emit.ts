/**
 * Terminal branch-failure bug emit for the preparation pipeline.
 *
 * Mirrors `compact-jobs/bug-emit.ts`: only a PERMANENT failure this worker
 * actually settled surfaces here. A branch that still has attempts left retries
 * on the next poll, and a report per attempt is noise, not signal.
 *
 * Fail-closed via `emitBugReportSafe` — a support-sink failure must never break
 * the worker loop.
 */

export async function emitPreparationBranchPermanentlyFailedBug(args: {
  readonly preparationId: number;
  readonly sessionId: string;
  readonly branch: "summary" | "chunks";
  readonly errorMsg: string;
}): Promise<void> {
  const { getBugReportSink } = await import(
    "../support/bug-report-registry.js"
  );
  const { emitBugReportSafe } = await import(
    "../../../lib/diagnostics/bug-report-sink.js"
  );
  const logger = (await import("@utils/logger.js")).default;
  await emitBugReportSafe(
    getBugReportSink(),
    {
      source: "worker",
      category: "compact_unable_at_critical",
      severity: "critical",
      title: `compaction-prep.${args.branch}_permanently_failed`,
      // The preparation id rides in the description rather than in `refs`:
      // that schema is `.strict()` and its id fields belong to other
      // subsystems. Widening a shared diagnostics contract for one correlation
      // field is not worth the blast radius.
      description: `preparation=${args.preparationId} ${args.errorMsg}`,
      refs: {
        sessionId: args.sessionId,
      },
      agentContext: {
        stopReason: "compact_unable_at_critical",
      },
    },
    logger,
  );
}
