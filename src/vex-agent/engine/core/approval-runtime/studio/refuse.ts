/**
 * The ONE primitive that terminally refuses PENDING Vex Studio intents.
 *
 * Modelled on `rejectPendingApprovalsWithClient` (`lease-and-status/
 * apply-user-stop.ts`), which does the same job for an operator Stop: lock the
 * rows the caller is about to settle, then write each decision through the
 * repo's CAS so the reject semantics stay owned by the repo.
 *
 * ## CAS BEFORE RELEASE, always
 *
 * Every caller of this primitive has a waiter to release: an MCP call blocked
 * on the approval. The order is non-negotiable and it is the reason this is a
 * primitive rather than a pattern each caller re-types - the durable refusal
 * COMMITS FIRST, and only then is the waiter told. The inverse order would let
 * a dispatch start against a row that was still pending while its caller had
 * already been told the call was cancelled.
 *
 * ## Why announcing is a separate call
 *
 * The refusal runs inside the caller's transaction (a Vex lock, a scope edit, a
 * quit). The settlement event may only be emitted AFTER that transaction
 * commits, because a subscriber reads the row by id on the signal. Splitting
 * the write from the announcement is what makes that ordering impossible to get
 * wrong: this module cannot emit early because it has no emit.
 *
 * ## Idempotent by construction
 *
 * The CAS predicate is `decision IS NULL`. A row that was already settled,
 * declined or refused matches nothing, so a refusal after a settlement is a
 * no-op that reports the real state - which is exactly what a decision arriving
 * after a refusal gets too, through the cached-decision path in
 * `snapshot/build.ts`.
 */

import type { ClientBase } from "pg";

import logger from "@utils/logger.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import type { StudioPendingRefusalReason } from "@vex-agent/db/repos/approval-intents.js";
import { emitStudioSettlement } from "@vex-agent/engine/runtime/studio-settlement-bus.js";

/** A row this primitive actually flipped. Ids only; nothing model-visible. */
export interface RefusedStudioIntent {
  readonly approvalId: string;
  readonly projectId: string | null;
}

/**
 * Which intents to refuse. `{ all: true }` is what a Vex lock and an
 * application quit mean; a project id is what a scope edit and a project
 * deletion mean.
 */
export type StudioRefusalTarget =
  | { readonly all: true }
  | { readonly projectId: string }
  | { readonly approvalId: string };

/**
 * The human sentence stored as `decision_reason` and shown on the approval
 * card. It states what did not happen, why, and what to do next; the machine
 * fact travels separately in `refusal_reason`.
 *
 * Keyed on `StudioPendingRefusalReason` and not on the whole refusal union, so
 * the record stays EXHAUSTIVE over exactly the causes that reach this
 * primitive. The post-decision causes (`stopped`, `generation_superseded`,
 * `scope_unavailable`, `expired`) are written by the dispatch path against an
 * already-approved row and carry their sentence in the settlement body; giving
 * them an entry here would suggest they can refuse a pending intent, which they
 * cannot.
 */
const REFUSAL_SENTENCES: Readonly<Record<StudioPendingRefusalReason, string>> = {
  lock:
    "Vex was locked before this action was approved, so it was cancelled. "
    + "Nothing was executed and no funds moved. Unlock Vex and ask again.",
  disconnect:
    "The coding agent that requested this action disconnected before it was "
    + "approved, so it was cancelled. Nothing was executed and no funds moved.",
  cancelled:
    "The coding agent cancelled this request before it was approved. Nothing "
    + "was executed and no funds moved.",
  project_deleted:
    "The Vex project this action belonged to was deleted, so the action was "
    + "cancelled. Nothing was executed and no funds moved.",
  scope_changed:
    "The project's permission or wallet selection changed while this action "
    + "was waiting for approval, so it was cancelled rather than run under the "
    + "old settings. Nothing was executed and no funds moved. Ask again to run "
    + "under the new scope.",
  vex_quit:
    "Vex shut down before this action was approved, so it was cancelled. "
    + "Nothing was executed and no funds moved.",
};

/**
 * Lock and terminally refuse every undecided Studio intent in `target`, in the
 * CALLER's transaction. Returns the rows this call actually flipped, for the
 * caller to announce after it commits.
 */
export async function refusePendingStudioIntents(
  client: ClientBase,
  target: StudioRefusalTarget,
  reason: StudioPendingRefusalReason,
): Promise<readonly RefusedStudioIntent[]> {
  const ids = await lockTargets(client, target);
  const refused: RefusedStudioIntent[] = [];
  for (const id of ids) {
    // Queue first, then intent - the same order every other decision path in
    // this repository writes them, so a reader that sees one always sees the
    // other in a committed transaction.
    const item = await approvalsRepo.rejectWith(client, id.approvalId);
    if (item === null) continue;
    const flipped = await approvalIntentsRepo.markDecisionWith(client, {
      approvalId: id.approvalId,
      kind: "rejected",
      reason: REFUSAL_SENTENCES[reason],
      idempotencyKey: id.approvalId,
      refusalReason: reason,
    });
    if (!flipped) continue;
    refused.push(id);
  }
  if (refused.length > 0) {
    logger.info("engine.studio.intents_refused", {
      reason,
      count: refused.length,
    });
  }
  return refused;
}

/**
 * Emit one settlement event per refused row. Call ONLY after the refusing
 * transaction has committed: a subscriber reads the row by id on this signal.
 */
export function announceStudioRefusals(
  refused: readonly RefusedStudioIntent[],
): void {
  for (const row of refused) {
    emitStudioSettlement({
      approvalId: row.approvalId,
      projectId: row.projectId,
      outcome: "rejected",
    });
  }
}

/**
 * Lock the rows. A single approval id still goes through `FOR UPDATE` and the
 * same predicate, so the one-shot path (an MCP cancellation for one call) and
 * the bulk paths cannot drift on what "still refusable" means.
 */
async function lockTargets(
  client: ClientBase,
  target: StudioRefusalTarget,
): Promise<readonly RefusedStudioIntent[]> {
  if ("approvalId" in target) {
    const res = await client.query<{ approval_id: string; project_id: string | null }>(
      `SELECT approval_id, project_id
         FROM approval_intents
        WHERE approval_id = $1
          AND origin = 'studio_mcp'
          AND decision IS NULL
        FOR UPDATE`,
      [target.approvalId],
    );
    return res.rows.map(toRefusedRow);
  }
  const projectId = "projectId" in target ? target.projectId : null;
  const res = await client.query<{ approval_id: string; project_id: string | null }>(
    `SELECT approval_id, project_id
       FROM approval_intents
      WHERE origin = 'studio_mcp'
        AND decision IS NULL
        ${projectId === null ? "" : "AND project_id = $1"}
      ORDER BY created_at ASC
      FOR UPDATE`,
    projectId === null ? [] : [projectId],
  );
  return res.rows.map(toRefusedRow);
}

function toRefusedRow(row: {
  approval_id: string;
  project_id: string | null;
}): RefusedStudioIntent {
  return { approvalId: row.approval_id, projectId: row.project_id };
}
