/**
 * Approval runtime — lifecycle reconciler.
 *
 * Runs inside the EXISTING scheduled approval sweep (no second timer). It is
 * the durable floor under every faster resume path: whatever a crash, a lost
 * lease race, or a restart left half-done, this pass resolves deterministically
 * within one cycle.
 *
 * Four states, four answers. The first and third are SHARED with the fast
 * deferred-resume worker (`lifecycle-actions.ts`) so the two cannot disagree
 * about which states are safe to fix; the `dispatching` verdict is this pass's
 * alone, because only it takes the row lock and reads the live lease.
 *
 *   approved + not_started       → dispatch now. `not_started` PROVES the tool
 *                                  never ran (the CAS that takes the dispatch
 *                                  slot is the only way out of that state), so
 *                                  running it is safe and is what the user
 *                                  asked for.
 *
 *   approved + dispatching       → the tool MAY have run. Never re-dispatch.
 *   and provably abandoned          Transition to `indeterminate` AND write the
 *                                  explaining tool result in the SAME
 *                                  transaction, then raise a bug report and
 *                                  wake the agent.
 *
 *   result exists, unconsumed    → the outcome is already recorded; only the
 *                                  wake is missing. Claim and resume.
 *
 *   legacy row (pre-056, so no   → treated as the `dispatching` branch: with no
 *   `dispatch_started_at`)          age to reason about we assume the worst,
 *                                  and the lease check still has to pass.
 *
 * STALENESS IS LEASE-AWARE, NEVER TIME-ONLY. A heartbeated lease legitimately
 * outlives any fixed age, so a clock-only sweep would eventually declare a
 * healthy in-flight money-path dispatch "unknown" — a false alarm on the one
 * path where a wrong answer is most expensive. While a live lease exists this
 * pass takes NO action and simply waits for the next cycle.
 */

import { withTransaction } from "../../../db/client.js";
import * as approvalIntentsRepo from "../../../db/repos/approval-intents.js";
import * as runnerLeasesRepo from "../../../db/repos/runner-leases.js";
import { acquireSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import logger from "@utils/logger.js";

import {
  applyResumableLifecycleRow,
  type LifecycleRowOutcome,
  resumeLifecycleRow,
} from "./lifecycle-actions.js";
import {
  STALE_DISPATCH_THRESHOLD_MS,
  SWEEP_BATCH_LIMIT,
  summarizeErrorForLog,
  TOOL_RESULT_INDETERMINATE_MESSAGE,
} from "./helpers.js";
import {
  commitDecisionToolResultWith,
  decisionResultMetadata,
  emitToolResultAppended,
} from "./post-tx/result-message.js";

export interface ReconcileResult {
  readonly examined: number;
  /** `approved` + `not_started` rows dispatched by this pass. */
  readonly dispatched: number;
  /** Abandoned dispatches transitioned to `indeterminate`. */
  readonly indeterminate: number;
  /** Committed results whose agent wake this pass delivered. */
  readonly resumed: number;
  /** Rows deliberately left alone — a live lease still owns them. */
  readonly skippedLeaseHeld: number;
  /**
   * Rows skipped because their mission run has left the claimable statuses.
   * Unlike `skippedLeaseHeld` this does not clear on its own, so a number that
   * grows pass over pass is the operator's signal that approvals are piling up
   * behind runs nobody recovered — the case the fairness ordering keeps from
   * starving newer work, and the one the exhaustion seam is still owed for.
   */
  readonly skippedRunNotResumable: number;
  readonly errored: number;
}

export async function reconcileApprovalLifecycle(
  now: Date = new Date(),
): Promise<ReconcileResult> {
  const rows = await approvalIntentsRepo.getIncompleteLifecycle(
    SWEEP_BATCH_LIMIT,
  );
  let dispatched = 0;
  let indeterminate = 0;
  let resumed = 0;
  let skippedLeaseHeld = 0;
  let skippedRunNotResumable = 0;
  let errored = 0;

  for (const row of rows) {
    try {
      const outcome = await reconcileRow(row, now);
      if (outcome === "dispatched") dispatched += 1;
      else if (outcome === "indeterminate") indeterminate += 1;
      else if (outcome === "resumed") resumed += 1;
      else if (outcome === "lease_held") skippedLeaseHeld += 1;
      else if (outcome === "run_not_resumable") skippedRunNotResumable += 1;
    } catch (cause) {
      errored += 1;
      const errSummary = summarizeErrorForLog(cause);
      logger.warn("engine.approval_runtime.reconcile_row_threw", {
        approvalId: row.approvalId,
        sessionId: row.sessionId,
        missionRunId: row.missionRunId,
        executionStatus: row.executionStatus,
        errorKind: errSummary.errorKind,
        errorHash: errSummary.errorHash,
      });
    }
  }

  return {
    examined: rows.length,
    dispatched,
    indeterminate,
    resumed,
    skippedLeaseHeld,
    skippedRunNotResumable,
    errored,
  };
}

type RowOutcome = LifecycleRowOutcome | "indeterminate";

/** Structural payload for the indeterminate tool result — never a guess. */
const INDETERMINATE_RESULT_PAYLOAD = {
  success: false,
  indeterminate: true,
} as const;

async function reconcileRow(
  row: approvalIntentsRepo.ApprovalLifecycleRow,
  now: Date,
): Promise<RowOutcome> {
  // The two safe resolutions are shared with the fast deferred-resume worker,
  // so a state one of them can fix is never a state the other is blind to.
  const resumable = await applyResumableLifecycleRow(row);
  if (resumable !== "noop") return resumable;

  // Only this pass may judge a `dispatching` row: it is the one that takes the
  // row lock and reads the live lease.
  if (row.decision === "approved" && row.executionStatus === "dispatching") {
    return resolveAbandonedDispatch(row, now);
  }

  return "noop";
}

/**
 * `approved` + `dispatching`: the runtime stopped somewhere between taking the
 * dispatch slot and committing the result. We cannot know whether the tool ran,
 * and we must never find out by running it again.
 *
 * The decision AND its consequence are taken in ONE locked transaction — lock
 * the intent, read the lease, check the age, CAS the transition, write the
 * tool result that explains it. Two commits would leave a window in which a
 * crash produced a TERMINAL `indeterminate` row with no tool result in the
 * conversation and nothing that would ever reconcile it again: `indeterminate`
 * is not in any scan's incomplete set, so the agent would wait forever for an
 * answer to a tool call that had one recorded nowhere.
 */
async function resolveAbandonedDispatch(
  row: approvalIntentsRepo.ApprovalLifecycleRow,
  now: Date,
): Promise<RowOutcome> {
  const settled = await withTransaction(async (client) => {
    // Session control lock FIRST, BEFORE the intent row lock — the global lock
    // order in `lease-and-status/session-control-lock.ts` puts money-state rows
    // last, and taking the row first here would be the out-of-order acquisition
    // that order exists to forbid. It is also what makes the
    // `dispatching → indeterminate` transition visible to the compaction
    // safe-moment gate as a boundary rather than a race: `indeterminate` is the
    // honest "we cannot prove what happened" verdict, and a transcript rewrite
    // must never interleave with the moment it is written.
    await acquireSessionControlLock(client, row.sessionId);

    const locked = await approvalIntentsRepo.lockLifecycleRowWith(
      client,
      row.approvalId,
    );
    if (locked === null || locked.executionStatus !== "dispatching") {
      return { kind: "noop" } as const;
    }

    // A live lease is proof that work is in progress. It outranks the clock in
    // both directions: no lease and an old stamp means abandoned; a lease means
    // hands off, whatever the stamp says.
    const lease = await runnerLeasesRepo.getLease(locked.sessionId, client);
    if (lease !== null && lease.expiresAt >= now) {
      return { kind: "lease_held" } as const;
    }

    // A legacy row (migrated in with no `dispatch_started_at`) has no age to
    // reason about. It cannot be younger than the migration, and the lease
    // check above already proved nothing is running, so treat it as abandoned.
    if (locked.dispatchStartedAt !== null) {
      const startedAtMs = new Date(locked.dispatchStartedAt).getTime();
      if (now.getTime() - startedAtMs < STALE_DISPATCH_THRESHOLD_MS) {
        return { kind: "noop" } as const;
      }
    }

    const transitioned = await approvalIntentsRepo.casMarkIndeterminateWith(
      client,
      row.approvalId,
    );
    if (!transitioned) return { kind: "noop" } as const;

    // Same transaction as the status: tell the agent the truth, and make that
    // message a durable resume so the wake survives a failure after this too.
    const resultRow = await commitDecisionToolResultWith(client, {
      approvalId: row.approvalId,
      sessionId: row.sessionId,
      toolCallId: row.toolCallId ?? row.approvalId,
      content: TOOL_RESULT_INDETERMINATE_MESSAGE,
      payload: { ...INDETERMINATE_RESULT_PAYLOAD },
    });
    return { kind: "indeterminate", resultRow } as const;
  });

  if (settled.kind !== "indeterminate") return settled.kind;

  // Emit after COMMIT — a visible event always corresponds to a fetchable row.
  emitToolResultAppended(
    row.sessionId,
    settled.resultRow,
    decisionResultMetadata({ ...INDETERMINATE_RESULT_PAYLOAD }),
  );

  logger.warn("engine.approval_runtime.dispatch_indeterminate", {
    approvalId: row.approvalId,
    sessionId: row.sessionId,
    missionRunId: row.missionRunId,
    dispatchStartedAt: row.dispatchStartedAt,
  });

  await emitIndeterminateBugReport(row);
  await resumeLifecycleRow(row);
  return "indeterminate";
}

/**
 * An indeterminate money-path dispatch is an operator-visible event, not just a
 * log line. Best-effort: the structural log above is the fallback if the sink
 * is unreachable.
 */
async function emitIndeterminateBugReport(
  row: approvalIntentsRepo.ApprovalLifecycleRow,
): Promise<void> {
  try {
    const { getBugReportSink } = await import(
      "../../support/bug-report-registry.js"
    );
    const { emitBugReportSafe } = await import(
      "../../../../lib/diagnostics/bug-report-sink.js"
    );
    await emitBugReportSafe(
      getBugReportSink(),
      {
        source: "agent",
        category: "mission_system_error",
        severity: "error",
        title: "approvals.dispatch_indeterminate",
        description:
          "An approved tool dispatch was abandoned before its result was " +
          "recorded. The outcome is unknown and the action was NOT retried.",
        refs: {
          sessionId: row.sessionId,
          ...(row.missionRunId !== null
            ? { missionRunId: row.missionRunId }
            : {}),
          ...(row.toolCallId !== null ? { toolCallId: row.toolCallId } : {}),
        },
        agentContext: { runtimeStatus: null },
      },
      logger,
    );
  } catch {
    // Sink unreachable — the structural warn above is the observability floor.
  }
}
