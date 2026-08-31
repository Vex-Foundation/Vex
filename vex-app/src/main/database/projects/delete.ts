/**
 * THE PROJECT DELETE TRANSACTION (stage B0): the authority commit.
 *
 * This module owns exactly one thing - the transaction that makes a project
 * durably gone - and it is a clone of `scope.ts`'s shape because that shape is
 * already proven against the same races:
 *
 *   1. read the backing session id BEFORE `BEGIN` (it is write-once and cannot
 *      go stale, and reading it inside would lock the project row before the
 *      session control lock, inverting the global lock order);
 *   2. `BEGIN`;
 *   3. `acquireSessionControlLockOn` - EDGE 0 of the global lock order;
 *   4. `assertProjectsRootUnchanged`;
 *   5. classify the project's durable approved rows;
 *   6. refuse every still-undecided intent, INSIDE this transaction;
 *   7. guarded soft-delete of the backing session;
 *   8. guarded soft-delete of the project row;
 *   9. `COMMIT`, then announce the refusals.
 *
 * ## Why the refusal is inside the transaction
 *
 * Identical to the `scope_changed` argument in `approval-refusals.ts`: a
 * pending Studio approval holds authority under a project this transaction is
 * about to remove. Refusing it in a SECOND transaction would leave a window in
 * which it could still be approved and dispatched under authority the user had
 * already destroyed. `refuseProjectStudioIntents` opens its own transaction and
 * is therefore deliberately NOT used here.
 *
 * ## Why an approved-but-not-started row is settled separately
 *
 * `refusePendingStudioIntents` settles through a CAS guarded on
 * `approval_queue.status = 'pending'`. A row a human already APPROVED is no
 * longer pending, so that sweep cannot touch it - it skips silently. Those rows
 * are therefore classified first:
 *
 *   - `not_started`  nothing ran. Settled `project_deleted` in its own write,
 *                    with the human's decision preserved: the record must say
 *                    "you approved this, and then you deleted the project",
 *                    not pretend the approval never happened.
 *   - `dispatching`  something IS running against a wallet right now. The whole
 *                    transaction ABORTS. Deleting a project out from under a
 *                    live dispatch would settle a row whose real outcome is
 *                    still arriving, and an unknown money outcome must be
 *                    reconciled, never overwritten.
 *
 * ## Why the session is soft-deleted by hand
 *
 * `softDeleteSession` filters `scope = 'vex_app'` and cannot touch a project's
 * `vex_studio` session. The statement here carries the mirrored filter, which
 * is the same guarantee in the other direction: whatever id it is handed, it
 * can only ever tombstone a Studio session.
 *
 * A hard delete is not an option in either direction:
 * `approval_intents.session_id` is `ON DELETE CASCADE`, so removing the session
 * would cascade away the very refusal rows this transaction just wrote.
 */

import type { Client } from "pg";
import { ok, type Result, type VexError } from "@shared/ipc/result.js";
import { VEX_STUDIO_SESSION_SCOPE } from "@shared/schemas/projects.js";
import { log } from "../../logger/index.js";
import {
  assertProjectsRootUnchanged,
  resolveProjectsRoot,
} from "../../studio/projects-root.js";
import {
  announceStudioRefusals,
  refusePendingStudioIntents,
  type RefusedStudioIntent,
} from "@vex-agent/engine/core/approval-runtime/studio/refuse.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import { buildStudioRefusalSettlement } from "@vex-agent/engine/core/approval-runtime/studio/refusal-settlement.js";
import { acquireSessionControlLockOn } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { dbError, withClient } from "../sessions/connection.js";

/** What the tombstone still owes, recorded on the row. */
export type ProjectCleanupState = "none" | "pending" | "trash_pending" | "done";

/** A tombstone whose cleanup is still OWED, and therefore still speaks for it. */
export type OwedProjectCleanupState = Exclude<
  ProjectCleanupState,
  "none" | "done"
>;

/**
 * Did the delete that created this tombstone ask for the FOLDER too?
 *
 * `cleanup_state` is where `runDeleteTransaction` writes that decision (it is
 * computed from `alsoTrashFolder` and stored on the row), so the column is the
 * only durable record of the user's folder intent and the only honest source
 * for an echo back to a caller. This is the one place that reads it as an
 * intent, so a later state cannot start meaning something else in two places.
 *
 * The parameter EXCLUDES `done` and `none` on purpose: neither records an
 * intent any more (`done` overwrites it once cleanup finishes), so answering
 * `false` for them would report "the user did not ask for the folder" when the
 * truth is "nobody knows any more". Callers holding one of those states have no
 * intent to echo and must say nothing instead.
 */
export function tombstoneRequestedTrash(
  cleanupState: OwedProjectCleanupState,
): boolean {
  return cleanupState === "trash_pending";
}

/** The transaction's verdict. */
export type ProjectTombstoneOutcome =
  /** The tombstone committed. */
  | {
      readonly kind: "tombstoned";
      readonly slug: string;
      readonly cleanupState: OwedProjectCleanupState;
    }
  /** No such project, or its stored name did not match `expectedName`. */
  | { readonly kind: "not_found" }
  /** An approved action was mid-dispatch. Nothing was written. */
  | { readonly kind: "blocked_pending_dispatch" }
  /** The project is ALREADY a tombstone; the caller resumes cleanup instead. */
  | {
      readonly kind: "already_tombstoned";
      readonly slug: string;
      readonly cleanupState: ProjectCleanupState;
      readonly attempts: number;
    };

/**
 * Tombstone a project.
 *
 * `expectedName` is revalidated HERE, against the stored row, so a stale or
 * mis-aimed request cannot delete a project the user was not looking at.
 */
export async function tombstoneProject(
  input: {
    readonly projectId: string;
    readonly expectedName: string;
    readonly alsoTrashFolder: boolean;
  },
  correlationId: string,
): Promise<Result<ProjectTombstoneOutcome, VexError>> {
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return rootOutcome;

  return withClient(async (client) => {
    // Announced only after COMMIT: a rolled-back delete refused nothing, and
    // announcing would release MCP calls whose authority still stands.
    let refused: readonly RefusedStudioIntent[] = [];
    try {
      const outcome = await runDeleteTransaction(
        client,
        input,
        rootOutcome.data,
        correlationId,
        (rows) => {
          refused = rows;
        },
      );
      if (outcome.ok) announceStudioRefusals(refused);
      return outcome;
    } catch (cause) {
      try {
        await client.query("ROLLBACK");
      } catch (rbCause) {
        log.warn(
          "[projects-db] ROLLBACK after tombstoneProject failure failed",
          rbCause,
        );
      }
      return dbError("tombstoneProject transaction failed", cause);
    }
  });
}

interface ProjectDeleteRow {
  readonly name: string;
  readonly slug: string;
  readonly backing_session_id: string;
  readonly deleted_at: Date | string | null;
  readonly cleanup_state: ProjectCleanupState;
  readonly cleanup_attempts: number;
}

async function runDeleteTransaction(
  client: Client,
  input: {
    readonly projectId: string;
    readonly expectedName: string;
    readonly alsoTrashFolder: boolean;
  },
  resolvedRoot: string,
  correlationId: string,
  recordRefusals: (rows: readonly RefusedStudioIntent[]) => void,
): Promise<Result<ProjectTombstoneOutcome, VexError>> {
  // BEFORE the transaction: `backing_session_id` is written once with the
  // project and never updated, so it cannot go stale, and reading it here keeps
  // the session control lock ahead of the project row lock.
  const backing = await client.query<{ backing_session_id: string }>(
    "SELECT backing_session_id FROM projects WHERE id = $1",
    [input.projectId],
  );
  const backingSessionId = backing.rows[0]?.backing_session_id ?? null;

  await client.query("BEGIN");

  // Edge 0, before any row lock. A missing project has no session to key on;
  // the read below then reports `not_found`, which is the same answer it would
  // have given anyway.
  if (backingSessionId !== null) {
    await acquireSessionControlLockOn(client, backingSessionId);
  }

  const rootCheck = await assertProjectsRootUnchanged(
    client,
    resolvedRoot,
    correlationId,
  );
  if (!rootCheck.ok) {
    await client.query("ROLLBACK");
    return rootCheck;
  }

  // The project row, WITHOUT the active-only predicate: an existing tombstone
  // is a different answer from a missing project, and the caller resumes
  // cleanup for one and reports `not_found` for the other.
  const current = await client.query<ProjectDeleteRow>(
    `SELECT name, slug, backing_session_id, deleted_at, cleanup_state, cleanup_attempts
       FROM projects WHERE id = $1 FOR UPDATE`,
    [input.projectId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    await client.query("ROLLBACK");
    return ok({ kind: "not_found" });
  }

  if (row.deleted_at !== null) {
    await client.query("ROLLBACK");
    return ok({
      kind: "already_tombstoned",
      slug: row.slug,
      cleanupState: row.cleanup_state,
      attempts: row.cleanup_attempts,
    });
  }

  // TYPED CONFIRMATION, revalidated against the stored value. Reported as
  // `not_found` rather than as its own code: from the renderer's side "this is
  // not the project you named" and "there is no such project" lead to the same
  // place, which is re-reading the list.
  if (row.name !== input.expectedName) {
    log.warn(
      `[projects-db] delete refused on a name mismatch projectId=${input.projectId} `
        + `correlationId=${correlationId}`,
    );
    await client.query("ROLLBACK");
    return ok({ kind: "not_found" });
  }

  // APPROVED ROWS FIRST. `refusePendingStudioIntents` cannot see them.
  const approved = await client.query<{
    approval_id: string;
    execution_status: string;
  }>(
    `SELECT approval_id, execution_status
       FROM approval_intents
      WHERE project_id = $1
        AND origin = 'studio_mcp'
        AND decision = 'approved'
        AND execution_status IN ('not_started', 'dispatching')
      FOR UPDATE`,
    [input.projectId],
  );

  if (approved.rows.some((r) => r.execution_status === "dispatching")) {
    // Something is running against a wallet RIGHT NOW. Its outcome is still
    // arriving and belongs to the dispatcher; settling it here would overwrite
    // a money result with a guess.
    await client.query("ROLLBACK");
    return ok({ kind: "blocked_pending_dispatch" });
  }

  for (const approvedRow of approved.rows) {
    // Nothing ran for these. Settled in a DISTINCT write that preserves the
    // human's `approved` decision alongside the `project_deleted` refusal.
    //
    // THE PRIMITIVE IS `casRefuseStudioBeforeDispatchWith`, NOT
    // `commitStudioSettlementWith`. The latter is fenced on
    // `execution_status = 'dispatching'` - it is the write a dispatcher makes
    // for a row it has already claimed - so aimed at a `not_started` row it
    // matched ZERO rows on every delete and its ignored return value was the
    // only thing hiding that. The result was a project tombstoned with a live,
    // human-approved, still slot-CAS-eligible action left behind it, which is
    // precisely the state this loop exists to destroy. The pre-dispatch CAS is
    // fenced on `decision = 'approved' AND execution_status = 'not_started'`,
    // which is exactly the class selected above.
    const body = buildStudioRefusalSettlement(
      "the Vex project that authorized this action was deleted before it could start",
    );
    const settled = await approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(
      client,
      {
        approvalId: approvedRow.approval_id,
        refusalReason: "project_deleted",
        resultHash: body.resultHash,
        settlementJson: body.settlementJson,
        settlementBytes: body.settlementBytes,
      },
    );
    if (!settled) {
      // THE WHOLE TRANSACTION ABORTS. Every row in this loop was selected and
      // locked `FOR UPDATE` a few statements ago under this same transaction,
      // so nothing else can have moved it; a zero-row CAS here means the row
      // no longer matches a predicate it demonstrably matched, which is an
      // invariant failure, not a lost race. Committing the tombstone anyway
      // would leave that approved action dispatchable against a wallet under
      // authority the user has just destroyed - so nothing is written and the
      // caller is told the delete failed rather than being told it succeeded.
      log.error(
        `[projects-db] approved Studio intent could not be refused during delete `
          + `projectId=${input.projectId} correlationId=${correlationId}`,
      );
      await client.query("ROLLBACK");
      return dbError(
        "tombstoneProject could not settle an approved Studio intent",
      );
    }
  }

  // Then every intent still awaiting a decision, through the ENGINE primitive -
  // which settles the `approval_queue` row as well as the intent, so the
  // pending list drains rather than keeping a row nobody can decide.
  recordRefusals(
    await refusePendingStudioIntents(
      client,
      { projectId: input.projectId },
      "project_deleted",
    ),
  );

  // The backing session. `scope = 'vex_studio'` is what stops this path from
  // ever tombstoning an agent-mode session, and `deleted_at IS NULL` makes it
  // idempotent.
  await client.query(
    `UPDATE sessions SET deleted_at = NOW()
      WHERE id = $1 AND scope = $2 AND deleted_at IS NULL`,
    [row.backing_session_id, VEX_STUDIO_SESSION_SCOPE],
  );

  const cleanupState: OwedProjectCleanupState = input.alsoTrashFolder
    ? "trash_pending"
    : "pending";

  // The project row LAST, per the lock order. Guarded on `deleted_at IS NULL`
  // so two concurrent deletes cannot both claim to have tombstoned it.
  const tombstoned = await client.query(
    `UPDATE projects
        SET deleted_at = NOW(),
            cleanup_state = $2,
            cleanup_attempts = 0,
            cleanup_last_error = NULL,
            updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL`,
    [input.projectId, cleanupState],
  );
  if (tombstoned.rowCount !== 1) {
    await client.query("ROLLBACK");
    return dbError(
      `tombstoneProject matched ${String(tombstoned.rowCount)} rows, expected 1`,
    );
  }

  await client.query("COMMIT");
  return ok({ kind: "tombstoned", slug: row.slug, cleanupState });
}

/** A tombstone whose cleanup is still owed. */
export interface UnfinishedProjectCleanup {
  readonly projectId: string;
  readonly slug: string;
  readonly cleanupState: "pending" | "trash_pending";
  readonly attempts: number;
}

/**
 * Every tombstone with cleanup still outstanding, oldest first.
 *
 * The startup repair owner's input. Bounded: a user cannot accumulate an
 * unbounded number of undeleted projects without noticing, and the limit keeps
 * one pathological state from turning startup into a sweep.
 */
export async function listUnfinishedProjectCleanups(): Promise<
  Result<readonly UnfinishedProjectCleanup[], VexError>
> {
  return withClient(async (client) => {
    try {
      const rows = await client.query<{
        id: string;
        slug: string;
        cleanup_state: "pending" | "trash_pending";
        cleanup_attempts: number;
      }>(
        `SELECT id, slug, cleanup_state, cleanup_attempts
           FROM projects
          WHERE deleted_at IS NOT NULL
            AND cleanup_state IN ('pending', 'trash_pending')
          ORDER BY deleted_at ASC
          LIMIT 50`,
      );
      return ok(
        rows.rows.map((r) => ({
          projectId: r.id,
          slug: r.slug,
          cleanupState: r.cleanup_state,
          attempts: r.cleanup_attempts,
        })),
      );
    } catch (cause) {
      return dbError("listUnfinishedProjectCleanups query failed", cause);
    }
  });
}

/** Mark a tombstone's cleanup finished. Guarded so it cannot revive a row. */
export async function markProjectCleanupDone(
  projectId: string,
): Promise<Result<boolean, VexError>> {
  return withClient(async (client) => {
    try {
      const updated = await client.query(
        `UPDATE projects
            SET cleanup_state = 'done', cleanup_last_error = NULL
          WHERE id = $1 AND deleted_at IS NOT NULL
            AND cleanup_state IN ('pending', 'trash_pending')`,
        [projectId],
      );
      return ok(updated.rowCount === 1);
    } catch (cause) {
      return dbError("markProjectCleanupDone failed", cause);
    }
  });
}

/**
 * Record a FAILED cleanup attempt.
 *
 * The state deliberately STAYS `pending`/`trash_pending`: the obligation still
 * stands, and there is no `failed` state for it to be forgotten in. `reason` is
 * a redacted sentence and is bounded to the column's own 500-character CHECK
 * before it is written, so a long provider message cannot abort the update that
 * is recording the failure.
 */
export async function recordProjectCleanupFailure(
  projectId: string,
  reason: string,
): Promise<Result<number, VexError>> {
  return withClient(async (client) => {
    try {
      const updated = await client.query<{ cleanup_attempts: number }>(
        `UPDATE projects
            SET cleanup_attempts = cleanup_attempts + 1,
                cleanup_last_error = $2
          WHERE id = $1 AND deleted_at IS NOT NULL
            AND cleanup_state IN ('pending', 'trash_pending')
          RETURNING cleanup_attempts`,
        [projectId, boundedCleanupError(reason)],
      );
      return ok(updated.rows[0]?.cleanup_attempts ?? 0);
    } catch (cause) {
      return dbError("recordProjectCleanupFailure failed", cause);
    }
  });
}

/**
 * The column's CHECK is 500 characters; this is the bound that keeps a long
 * message from failing the very write that records it.
 *
 * This is a BOUND, not a silent cut: the full cause is already in the operator
 * log at the point of failure, and what lands here is a short redacted summary
 * whose purpose is to tell the user which of their projects needs attention.
 */
function boundedCleanupError(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length <= 500) return trimmed;
  return `${trimmed.slice(0, 460)} (see the Vex log for the full message)`;
}

/**
 * A tombstone's identity, read WITHOUT the active-only predicate.
 *
 * Cleanup needs the slug of a project that is, by definition, deleted. Every
 * other reader in this repository is active-only; this one exists so that the
 * exception is explicit and greppable rather than a predicate someone forgot.
 */
export async function readTombstonedProject(
  projectId: string,
): Promise<
  Result<
    | {
        readonly slug: string;
        readonly cleanupState: ProjectCleanupState;
        readonly attempts: number;
      }
    | null,
    VexError
  >
> {
  return withClient(async (client) => {
    try {
      const rows = await client.query<{
        slug: string;
        cleanup_state: ProjectCleanupState;
        cleanup_attempts: number;
      }>(
        `SELECT slug, cleanup_state, cleanup_attempts
           FROM projects WHERE id = $1 AND deleted_at IS NOT NULL`,
        [projectId],
      );
      const row = rows.rows[0];
      if (row === undefined) return ok(null);
      return ok({
        slug: row.slug,
        cleanupState: row.cleanup_state,
        attempts: row.cleanup_attempts,
      });
    } catch (cause) {
      return dbError("readTombstonedProject query failed", cause);
    }
  });
}

/**
 * Is this slug held by a tombstone whose cleanup has not finished?
 *
 * The create path asks BEFORE it claims the directory. The remover still owns
 * that folder, and racing it would mean the remover deleting the NEW project's
 * files. The partial unique index frees the slug at the database level as soon
 * as the tombstone exists; this check is what keeps the filesystem honest until
 * the removal is actually done.
 */
export async function slugHeldByUnfinishedCleanup(
  slug: string,
): Promise<Result<boolean, VexError>> {
  return withClient(async (client) => {
    try {
      const rows = await client.query<{ id: string }>(
        `SELECT id FROM projects
          WHERE slug = $1 AND deleted_at IS NOT NULL
            AND cleanup_state IN ('pending', 'trash_pending')
          LIMIT 1`,
        [slug],
      );
      return ok(rows.rows.length > 0);
    } catch (cause) {
      return dbError("slugHeldByUnfinishedCleanup query failed", cause);
    }
  });
}
