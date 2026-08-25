/**
 * The Vex Studio PRE-DISPATCH GATE, and the durable refusals it owns.
 *
 * Split out of `studio.ts` because it has its own reason to change: everything
 * here is about what happens BEFORE the tool runs, and every branch of it has
 * to leave the row TERMINAL.
 *
 * ## Why a pre-dispatch refusal has to be durable
 *
 * The row was approved by a human. Until something writes a terminal state it
 * stays `not_started`, which is the state the dispatch-slot CAS accepts - so a
 * refusal that only returns a message to its caller leaves a live, dispatchable
 * approval behind an agent that has already been told the action did not
 * happen. And nothing else would clean it up: the agent lifecycle scans exclude
 * Studio rows and the expiry sweep only looks at UNDECIDED ones. So every
 * refusal here is a CAS, and the answer the caller reports is the answer that
 * committed.
 *
 * ## The race with the dispatcher is decided by the predicate
 *
 * `casRefuseStudioBeforeDispatchWith` and `casClaimStudioDispatchSlotWith` both
 * require `execution_status = 'not_started'`. Exactly one of them can win for
 * any row, so "refused" and "dispatching" cannot both be true, and a refusal
 * that loses overwrites nothing and says so.
 *
 * ## Lock order, and the one refusal that is deliberately NOT in the gate
 *
 * The gate transaction holds the session control lock (edge 0) and then the
 * project row (last). A refusal for a slot claim that MISSED runs in its own
 * short transaction afterwards, on purpose: the row it wants may be held by
 * another dispatcher, and that dispatcher is waiting for the session control
 * lock this transaction holds. Refusing inside the gate would make those two
 * wait on each other.
 */

import type { PoolClient } from "pg";

import logger from "@utils/logger.js";
import { withTransaction } from "@vex-agent/db/client.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import type { StudioPostDecisionRefusalReason } from "@vex-agent/db/repos/approval-intents.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";

import { buildStudioRefusalSettlement } from "../../studio/refusal-settlement.js";
import { registerStudioWriteRepair } from "../../studio/write-repair.js";

/**
 * What the gate decided. `refused` always carries a row that is already
 * terminal, or `refusalCommitted: false` saying another writer owns it.
 */
export type StudioGateOutcome =
  | { readonly kind: "claimed" }
  | {
      readonly kind: "refused";
      readonly reason: StudioPostDecisionRefusalReason | "scope_changed";
      readonly output: string;
      readonly refusalCommitted: boolean;
    };

/** The human clause for each pre-dispatch cause. */
export const STUDIO_REFUSAL_CAUSES = {
  stopped: "Vex was stopped before this action could start",
  slot_lost:
    "Vex was locked or the action was already taken over by another dispatcher "
    + "before it could start",
  fence_unproven:
    "Vex cannot currently prove that its lock fence is in place, so it did not "
    + "start this approved action",
  scope_changed:
    "the project's permission or wallet selection changed before this action "
    + "could start",
  scope_unreadable:
    "the Vex project that authorized this action could not be read",
  scope_version_missing:
    "Vex has no record of the project settings this action was approved under",
} as const;

/**
 * Operator-stop gate, slot claim and project re-check, in ONE short DB-only
 * transaction under the session control lock, committed before any dispatch.
 *
 * `expectedScopeVersion` is the version recorded AT ENQUEUE, never the version
 * this process just read. Comparing the current version with itself proves
 * nothing; comparing it with the enqueue version is what proves that the
 * wallets and permission loaded for the dispatch are the ones the human
 * approved. The version is monotonic, so equality at gate time means no edit
 * committed in between.
 */
export async function runStudioDispatchGate(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly expectedScopeVersion: number;
}): Promise<StudioGateOutcome> {
  let gate: StudioGateOutcome | { kind: "slot_lost" };
  try {
    gate = await withTransaction(
      async (client: PoolClient): Promise<StudioGateOutcome | { kind: "slot_lost" }> => {
        await acquireSessionControlLock(client, input.sessionId);

        const stopGate = await gateOnOperatorStopWithClient(client, {
          sessionId: input.sessionId,
          missionRunId: null,
        });
        if (stopGate.kind === "stopped") {
          const body = buildStudioRefusalSettlement(STUDIO_REFUSAL_CAUSES.stopped);
          const committed = await approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(
            client,
            {
              approvalId: input.approvalId,
              refusalReason: "stopped",
              settlementJson: body.settlementJson,
              settlementBytes: body.settlementBytes,
              resultHash: body.resultHash,
            },
          );
          return {
            kind: "refused",
            reason: "stopped",
            output: body.output,
            refusalCommitted: committed,
          };
        }

        const tookSlot = await approvalIntentsRepo.casClaimStudioDispatchSlotWith(
          client,
          input.approvalId,
        );
        if (!tookSlot) return { kind: "slot_lost" };

        // The project row is locked LAST, per the global lock order. The snapshot
        // transaction already checked it; this re-check exists because that
        // transaction has COMMITTED and released, so a scope edit could have
        // landed in between.
        if (input.projectId !== null) {
          const res = await client.query<{ scope_version: number }>(
            "SELECT scope_version FROM projects WHERE id = $1 FOR UPDATE",
            [input.projectId],
          );
          const project = res.rows[0];
          if (
            project === undefined
            || Number(project.scope_version) !== input.expectedScopeVersion
          ) {
            // The claim already committed this row to `dispatching` inside THIS
            // transaction, so the refusal has to settle it in the same
            // transaction: a gate that refuses must never commit a claim.
            const body = buildStudioRefusalSettlement(
              STUDIO_REFUSAL_CAUSES.scope_changed,
            );
            const settled = await approvalIntentsRepo.commitStudioSettlementWith(
              client,
              {
                approvalId: input.approvalId,
                status: "failed",
                refusalReason: "scope_changed",
                resultHash: body.resultHash,
                settlementJson: body.settlementJson,
                settlementBytes: body.settlementBytes,
              },
            );
            return {
              kind: "refused",
              reason: "scope_changed",
              output: body.output,
              refusalCommitted: settled,
            };
          }
        }
        return { kind: "claimed" };
      },
    );
  } catch (cause) {
    // THE WHOLE TRANSACTION FAILED, so it rolled back: no slot was claimed, no
    // refusal was written, and nothing dispatched. The row is still
    // `approved/not_started` and therefore still slot-CAS eligible, which is
    // exactly the state that must not survive - so the terminal refusal is
    // handed to the repair owner and retried until a terminal state exists.
    //
    // `generation_superseded` is the honest machine cause: what this
    // transaction could not do is prove the operator-stop gate and the fence,
    // which is the same thing a preflight that cannot answer reports.
    logger.warn("engine.studio.dispatch_gate_transaction_failed", {
      approvalId: input.approvalId,
      errorName: cause instanceof Error ? cause.name : "unknown",
    });
    const body = buildStudioRefusalSettlement(
      STUDIO_REFUSAL_CAUSES.fence_unproven,
    );
    registerStudioWriteRepair({
      write: "refusal",
      approvalId: input.approvalId,
      refusalReason: "generation_superseded",
      settlementJson: body.settlementJson,
      settlementBytes: body.settlementBytes,
      resultHash: body.resultHash,
    });
    const outcome = {
      kind: "refused" as const,
      reason: "generation_superseded" as const,
      output: body.output,
      // NOT committed, and the caller must not claim it was: it reads the
      // durable row and reports that instead.
      refusalCommitted: false,
    };
    logRefusal(input.approvalId, outcome);
    return outcome;
  }

  if (gate.kind !== "slot_lost") {
    if (gate.kind === "refused") logRefusal(input.approvalId, gate);
    return gate;
  }
  // Outside the gate transaction, for the lock-order reason in the header.
  return refuseStudioBeforeDispatch(
    input.approvalId,
    "generation_superseded",
    STUDIO_REFUSAL_CAUSES.slot_lost,
  );
}

/**
 * Refuse an approved-but-not-dispatched intent in its OWN short transaction.
 * Used for every cause decided outside the gate: a lost slot claim, a preflight
 * that cannot prove the fence, and a project scope that cannot be established.
 *
 * A `false` CAS means another writer owns the row. Nothing is overwritten and
 * the caller is told the refusal is not the durable answer.
 */
export async function refuseStudioBeforeDispatch(
  approvalId: string,
  reason: StudioPostDecisionRefusalReason,
  cause: string,
): Promise<Extract<StudioGateOutcome, { kind: "refused" }>> {
  const body = buildStudioRefusalSettlement(cause);
  let committed = false;
  try {
    committed = await withTransaction((client) =>
      approvalIntentsRepo.casRefuseStudioBeforeDispatchWith(client, {
        approvalId,
        refusalReason: reason,
        settlementJson: body.settlementJson,
        settlementBytes: body.settlementBytes,
        resultHash: body.resultHash,
      }),
    );
  } catch (writeCause) {
    // The refusal could not be written, and NOTHING ELSE WOULD EVER WRITE IT.
    // The expiry sweep scans `decision IS NULL` only, so it never revisits this
    // APPROVED row; the agent lifecycle scans exclude Studio rows. Left alone
    // the row stays `not_started`, which is the state the dispatch-slot CAS
    // accepts, behind a caller already told the action did not happen.
    //
    // So the write - the identical CAS, never a dispatch - is handed to the
    // repair owner, and the caller is told the answer is not confirmed rather
    // than being told a clean refusal happened.
    logger.warn("engine.studio.pre_dispatch_refusal_write_failed", {
      approvalId,
      reason,
      errorName: writeCause instanceof Error ? writeCause.name : "unknown",
    });
    registerStudioWriteRepair({
      write: "refusal",
      approvalId,
      refusalReason: reason,
      settlementJson: body.settlementJson,
      settlementBytes: body.settlementBytes,
      resultHash: body.resultHash,
    });
  }
  const outcome = {
    kind: "refused" as const,
    reason,
    output: body.output,
    refusalCommitted: committed,
  };
  logRefusal(approvalId, outcome);
  return outcome;
}

function logRefusal(
  approvalId: string,
  outcome: Extract<StudioGateOutcome, { kind: "refused" }>,
): void {
  logger.warn("engine.studio.dispatch_refused", {
    approvalId,
    reason: outcome.reason,
    refusalCommitted: outcome.refusalCommitted,
  });
}
