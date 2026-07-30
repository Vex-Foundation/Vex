/**
 * The compaction-v2 APPLY cutover — Tx B of the durable two-phase apply.
 *
 * ## The two phases, and why they are two
 *
 * Tx A (`casBeginApply`, owned by the caller in `consume-at-boundary.ts`)
 * commits `apply_requested → applying` on its own. That separate commit is the
 * ONLY thing that makes a crashed cutover detectable: an `applying` row with a
 * dead heartbeat is a cutover that started. Fold it into Tx B and there is no
 * such evidence, and ANANKE's `recoverStuckApplying` has nothing to reason
 * about.
 *
 * Tx B is this module. It re-acquires the FULL lock order from scratch — it may
 * run milliseconds or minutes after Tx A, so nothing Tx A observed may be
 * assumed still true:
 *
 *   1. session advisory lock  (`acquireSessionControlLock`)
 *   2. queued-stop gate / control rows (`gateOnOperatorStopWithClient`)
 *   2b. the caller's lease ownership, re-read under the lock
 *   3. the `sessions` row      (`lockSessionAndReadGeneration`, FOR UPDATE)
 *   4. the preparation row     (FOR UPDATE)
 *   5. money rows              (`getUnresolvedMoneyStateForSession`)
 *
 * That order is not cosmetic. Capture (`compaction-prep/capture.ts`) takes the
 * session row before the preparation row; taking the preparation row first here
 * would close a deadlock cycle between the two. And the stop gate must be
 * re-checked INSIDE this transaction, not merely at the iteration boundary: the
 * boundary check and this transaction are separated by an await, and an agent
 * session never observes mission-run control at all. Stop always outranks
 * compaction.
 *
 * ## Exits, and which FSM edge each takes
 *
 * The distinction is whether the request can still be satisfied later:
 *
 *   - stop queued, or money state unresolved → `casDeferApply` → back to
 *     `apply_requested`. The request outlives the attempt. NEVER downgraded to
 *     `summary_ready`, which would silently discard a cutover the user asked
 *     for.
 *   - generation moved, nothing compactable, or a preparation with no validated
 *     summary → `casFailApply` → terminal `failed`. These can never become true
 *     again for THIS row, and leaving it `apply_requested` would park the
 *     session forever: the row stays live, the one-live-per-session index blocks
 *     every future fork, and pressure climbs with no path forward.
 *
 * ## The generation is the frozen target, asserted — never `current + 1`
 *
 * The cutover bumps `sessions.checkpoint_generation` to EXACTLY the row's
 * `target_checkpoint_generation`, and refuses to proceed unless the session is
 * still at the row's `base_checkpoint_generation`. `casMarkApplied` writes
 * `applied_generation` from that same frozen column in the same transaction.
 * Recovery's discriminator — "did the session reach the generation this row was
 * always going to produce?" — is only answerable because of that. A cutover
 * that computed `current + 1` from a re-read would make a crashed apply
 * indistinguishable from a completed one.
 *
 * ## Forced critical bypasses the gate but still READS it
 *
 * `forced_critical` does not skip the money-state read; it records what was in
 * flight (`recordMoneyGateBypassReasons`, inside this transaction so the audit
 * and the action commit together) and then proceeds anyway. The reasons are the
 * evidence a later incident needs. Bypassing without reading would log a
 * promise we never kept.
 *
 * No `compact_jobs` enqueue and no giant-tool fallback: both are legacy-path
 * concepts that contract C6 forbids here.
 */

import type { PoolClient } from "pg";

import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import type { CompactionPreparation } from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as messagesRepo from "@vex-agent/db/repos/messages.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import { archivePrefix } from "@vex-agent/db/repos/sessions-archive.js";
import { getUnresolvedMoneyStateForSession } from "@vex-agent/db/repos/approval-intents/money-state.js";
import type { MoneyStateReason } from "@vex-agent/db/repos/approval-intents/money-state.js";
import { getPool, queryOneWith } from "@vex-agent/db/client.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import { selectWatermarkBoundedPrefix } from "@vex-agent/engine/checkpoint/watermark-prefix.js";
import {
  COMPACT_COMMIT_MAX_ATTEMPTS,
  COMPACT_COMMIT_RETRY_BACKOFF_MS,
} from "@vex-agent/engine/compact-jobs/policy.js";
import {
  type CommitAttemptTracker,
  lockSessionAndReadGeneration,
  replaceRollingSummaryAndBumpGeneration,
  runWithCommitRetry,
} from "@vex-agent/engine/compact-jobs/commit-primitives.js";
import { withCheckpointMutex } from "@vex-agent/engine/compact-jobs/state.js";
import { redact } from "@vex-agent/memory/redaction.js";
import logger from "@utils/logger.js";

import { emitApplyTransition } from "./emit-transition.js";

/**
 * Whether THIS execution honours the money gate. Distinct from the row's stored
 * `apply_source`, which records who ASKED: the critical path may force a row a
 * user queued, and the forcing is a property of the execution, not the request.
 */
export type ApplyExecutionMode = "requested" | "forced_critical";

export type ApplyCommitResult =
  | { kind: "applied"; generation: number; archivedMessages: number }
  | { kind: "money_state_blocked"; reasons: readonly MoneyStateReason[] }
  | { kind: "stop_queued" }
  | { kind: "generation_moved" }
  | { kind: "preparation_not_applicable"; reason: string }
  | {
      kind: "noop";
      reason: "empty_session" | "no_compactable" | "watermark_not_live";
    };

export interface CommitPreparationInput {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly preparationId: number;
  /**
   * The calling runner's OWN lease owner id. Re-validated against the live lease
   * inside Tx B, and matched against `apply_locked_by`. Never adopted from the
   * row — see `consume-at-boundary.ts`.
   */
  readonly runnerLeaseId: string;
  readonly mode: ApplyExecutionMode;
}

/** Outcome of the locked transaction, before any FSM release write. */
type TxOutcome =
  | { kind: "applied"; generation: number; archivedMessages: number }
  | { kind: "defer"; result: ApplyCommitResult; reason: string }
  | { kind: "terminal"; result: ApplyCommitResult; error: string }
  /**
   * Write NOTHING and report. Used only when this process does not own the
   * apply lease: `casDeferApply` is owner-fenced and would simply miss, but
   * `casFailApply` deliberately is NOT (a conflict may be discovered by either
   * the requester or the owner), so calling it here would let a non-owner
   * TERMINALIZE another runner's in-flight cutover.
   */
  | { kind: "abandon"; result: ApplyCommitResult };

/**
 * Perform the cutover for a preparation already in `applying` and owned by
 * `runnerLeaseId`. The caller owns Tx A; this is Tx B.
 */
export async function commitPreparation(
  input: CommitPreparationInput,
): Promise<ApplyCommitResult> {
  // The in-process mutex the legacy path uses, for the same reason: two
  // cutovers for one session must not interleave their plan/commit pairs even
  // before they reach the advisory lock.
  const outcome = await withCheckpointMutex(input.sessionId, () =>
    runWithCommitRetry(
      {
        sessionId: input.sessionId,
        source: `compaction_apply:${input.mode}`,
        maxAttempts: COMPACT_COMMIT_MAX_ATTEMPTS,
        backoffMs: COMPACT_COMMIT_RETRY_BACKOFF_MS,
      },
      (tracker) => runCutoverTransaction(input, tracker),
    ),
  );

  // FSM release happens AFTER the cutover transaction, never inside it: a
  // deferral must survive the ROLLBACK that produced it.
  if (outcome.kind === "defer") {
    // Emit only if OUR CAS won: a lost one means another writer owns the row.
    const released = await preparationsRepo.casDeferApply(
      input.preparationId,
      input.runnerLeaseId,
      outcome.reason,
    );
    if (released) emitApplyTransition(input.sessionId, "apply_requested");
    return outcome.result;
  }
  if (outcome.kind === "abandon") return outcome.result;
  if (outcome.kind === "terminal") {
    const failed = await preparationsRepo.casFailApply(
      input.preparationId,
      outcome.error,
    );
    if (failed) emitApplyTransition(input.sessionId, "failed");
    return outcome.result;
  }
  // Reached only after Tx B COMMITted — a rolled-back cutover returns above.
  emitApplyTransition(input.sessionId, "applied");
  return {
    kind: "applied",
    generation: outcome.generation,
    archivedMessages: outcome.archivedMessages,
  };
}

async function runCutoverTransaction(
  input: CommitPreparationInput,
  tracker: CommitAttemptTracker,
): Promise<TxOutcome> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    // ── 1. session advisory lock ────────────────────────────────────
    await acquireSessionControlLock(client, input.sessionId);

    // ── 2. queued-stop gate ─────────────────────────────────────────
    const stopGate = await gateOnOperatorStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: input.missionRunId,
    });
    if (stopGate.kind === "stopped") {
      await client.query("ROLLBACK");
      return {
        kind: "defer",
        result: { kind: "stop_queued" },
        reason: `operator_stop:${stopGate.scope}`,
      };
    }

    // ── 2b. lease ownership, RE-checked under the lock ──────────────
    // Tx A proved it; Tx B proves it again. The two phases are separated by an
    // arbitrary gap, and a lease that changed hands in between must not let a
    // stale runner finish a cutover the new holder now owns. Read on THIS
    // client, so the answer is inside the advisory lock rather than before it.
    const lease = await runnerLeasesRepo.getLease(input.sessionId, client);
    if (
      lease === null
      || lease.ownerId !== input.runnerLeaseId
      || lease.expiresAt < new Date()
    ) {
      await client.query("ROLLBACK");
      return {
        kind: "abandon",
        result: { kind: "preparation_not_applicable", reason: "lease_not_held" },
      };
    }

    // ── 3. the sessions row ─────────────────────────────────────────
    const { currentGen } = await lockSessionAndReadGeneration(
      client,
      input.sessionId,
    );

    // ── 4. the preparation row ──────────────────────────────────────
    const row = await lockPreparationRow(client, input.preparationId);
    // Ownership BEFORE any decision that could write: see `abandon` above.
    if (row !== null && row.applyLockedBy !== input.runnerLeaseId) {
      await client.query("ROLLBACK");
      return {
        kind: "abandon",
        result: { kind: "preparation_not_applicable", reason: "not_lease_owner" },
      };
    }
    if (row === null || row.status !== "applying") {
      await client.query("ROLLBACK");
      return {
        kind: "terminal",
        result: {
          kind: "preparation_not_applicable",
          reason: row === null ? "row_missing" : `status:${row.status}`,
        },
        error: `apply: preparation not applying (${row?.status ?? "missing"})`,
      };
    }
    const summary = row.summaryOutput;
    if (row.summaryStatus !== "succeeded" || summary === null) {
      await client.query("ROLLBACK");
      return {
        kind: "terminal",
        result: {
          kind: "preparation_not_applicable",
          reason: `summary:${row.summaryStatus}`,
        },
        error: `apply: no validated summary (${row.summaryStatus})`,
      };
    }

    // The generation CAS. `base` is the generation this preparation was forked
    // against; anything else means a compaction landed in between and the
    // frozen corpus no longer describes this transcript.
    if (currentGen !== row.baseCheckpointGeneration) {
      await client.query("ROLLBACK");
      return {
        kind: "terminal",
        result: { kind: "generation_moved" },
        error: `apply: generation moved (base=${row.baseCheckpointGeneration}, current=${currentGen})`,
      };
    }
    if (row.targetCheckpointGeneration <= currentGen) {
      await client.query("ROLLBACK");
      return {
        kind: "terminal",
        result: {
          kind: "preparation_not_applicable",
          reason: "target_not_ahead",
        },
        error: `apply: target ${row.targetCheckpointGeneration} not ahead of ${currentGen}`,
      };
    }

    // ── 5. money rows ───────────────────────────────────────────────
    const moneyState = await getUnresolvedMoneyStateForSession(
      client,
      input.sessionId,
    );
    if (!moneyState.clear) {
      if (input.mode !== "forced_critical") {
        await client.query("ROLLBACK");
        return {
          kind: "defer",
          result: { kind: "money_state_blocked", reasons: moneyState.reasons },
          reason: `money_state:${moneyState.reasons.length}`,
        };
      }
      // Forced: read, record, proceed. Never a silent skip.
      const reasonRefs = moneyState.reasons.map((r) => `${r.kind}:${r.ref}`);
      await preparationsRepo.recordMoneyGateBypassReasons(
        input.preparationId,
        reasonRefs,
        client,
      );
      logger.warn("compaction.apply.money_gate_bypassed", {
        sessionId: input.sessionId,
        preparationId: input.preparationId,
        reasonKinds: moneyState.reasons.map((r) => r.kind),
        reasonCount: moneyState.reasons.length,
      });
    }

    // ── cutover ─────────────────────────────────────────────────────
    const messages = await messagesRepo.getLiveMessagesWithId(
      input.sessionId,
      client,
    );
    const plan = selectWatermarkBoundedPrefix(messages, row.watermarkMessageId);
    if (plan.mode === "noop") {
      await client.query("ROLLBACK");
      return {
        kind: "terminal",
        result: { kind: "noop", reason: plan.reason },
        error: `apply: nothing to compact (${plan.reason})`,
      };
    }

    // Branch A's output was validated and redacted before `summary_ready`;
    // re-running redaction is cheap and keeps the invariant local to the write.
    const redacted = redact(summary);
    await replaceRollingSummaryAndBumpGeneration(client, {
      sessionId: input.sessionId,
      summary: redacted.text,
      nextGen: row.targetCheckpointGeneration,
    });
    await archivePrefix(
      input.sessionId,
      plan.cutoffMessageId,
      plan.tail.length,
      client,
    );

    const marked = await preparationsRepo.casMarkApplied(
      input.preparationId,
      input.runnerLeaseId,
      client,
    );
    if (!marked) {
      // Lost the apply lease while holding every lock — impossible under the
      // advisory lock, but rolling back is the only safe answer if it happens.
      // Write nothing: whoever owns the row now is entitled to finish it.
      await client.query("ROLLBACK");
      return {
        kind: "abandon",
        result: { kind: "preparation_not_applicable", reason: "lease_lost" },
      };
    }

    tracker.commitAttempted = true;
    await client.query("COMMIT");

    return {
      kind: "applied",
      generation: row.targetCheckpointGeneration,
      archivedMessages: plan.prefix.length,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Non-actionable; the original error is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Lock and read the preparation row on the cutover's client.
 *
 * Composed from the repo's OWN exported column list and row mapper rather than
 * a hand-written projection, so a schema change reaches this read the same way
 * it reaches every other one. The `FOR UPDATE` is step 4 of the documented lock
 * order; `casMarkApplied`'s `apply_locked_by` fence remains the real guard.
 */
async function lockPreparationRow(
  client: PoolClient,
  preparationId: number,
): Promise<CompactionPreparation | null> {
  const row = await queryOneWith<
    Parameters<typeof preparationsRepo.mapRow>[0]
  >(
    client,
    `SELECT ${preparationsRepo.PREPARATION_COLUMNS}
       FROM compaction_preparations
      WHERE id = $1
      FOR UPDATE`,
    [preparationId],
  );
  return row === null ? null : preparationsRepo.mapRow(row);
}
