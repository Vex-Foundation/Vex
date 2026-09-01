/**
 * The Vex Studio approved-dispatch path - sibling of `../dispatch-approved.ts`,
 * with the same ordering and none of the agent-session machinery.
 *
 * ## The order, and why it is the same order
 *
 *   1. claim the continuation (Studio arm: no lease, see `StudioContinuation`);
 *   2. the dispatch preflight, then the tool context built from the PROJECT
 *      (reads only, moves nothing);
 *   3. ONE transaction under the session control lock (`studio-gate.ts`):
 *      operator-stop gate, dispatch-slot claim FENCED ON THE DISPATCH
 *      GENERATION, project re-check against the ENQUEUE scope version,
 *      manifest identity, authority-digest equality and a fresh complete-card
 *      rebuild;
 *   4. dispatch;
 *   5. commit the settlement.
 *
 * Step 3 is the boundary, exactly as it is for the agent, and for one extra
 * reason here: the slot claim is a SINGLE conditional UPDATE that requires the
 * durable dispatch generation to still equal the one recorded at enqueue. A
 * lock or unlock that commits before this statement makes it match zero rows.
 * That is what turns "the user locked Vex" into "no queued Studio action can
 * still dispatch" without an in-memory flag anybody has to trust.
 *
 * Everything in that transaction COMMITS BEFORE the dispatch runs, for the same
 * reason as the agent path: holding the session control lock across a provider
 * or wallet call would let a stuck HTTP request block the operator's own Stop.
 *
 * ## EVERY EXIT IS TERMINAL
 *
 * There is no path through this module that leaves the row `not_started` or
 * `dispatching` with nobody owning it. A refusal before the dispatch is a CAS
 * (`studio-gate.ts`); a refusal after the claim settles the claim in the same
 * transaction; an unprovable dispatch is `indeterminate` in ONE statement that
 * carries whatever text survived. The outcome this function returns and the
 * durable row always say the same thing, because an agent that is told "not
 * queued" while an approvable row still exists is the defect this path is
 * shaped to prevent.
 *
 * ## What this path must never do
 *
 * NO `buildResumedApprovalToolContext`. That helper hydrates from the SESSION's
 * wallet columns, which for a project are a compatibility MIRROR;
 * `project_wallets` is authoritative. Resuming from the mirror would let a
 * drifted mirror decide which key signs.
 *
 * NO transcript message and NO `result_message_id`. The caller is a blocked MCP
 * request, and a `result_message_id` is what makes a row resumable by an AGENT
 * TURN, which must never happen for a call the agent never made.
 *
 * NO `markExecutionStatusWith`. It is unconditional; every write here is a CAS,
 * because the reconciler and this dispatcher can legitimately race.
 *
 * NO retry, ever. A settlement write that fails after the dispatch already ran
 * leaves an outcome nobody can prove, which is `indeterminate` - a distinct
 * terminal state, not a failure, and never a reason to run the call again. The
 * bounded retry inside `commitIndeterminate`, and the repair owner it hands an
 * exhausted write to (`../../studio/write-repair.ts`), are the single
 * exception: both retry a STATUS WRITE against a row whose dispatch already
 * happened, and neither can reach a tool, so neither can cause a second
 * dispatch.
 *
 * ## A LOST CAS IS ANSWERED BY THE ROW, NEVER BY THE ATTEMPT
 *
 * Every write here is a CAS, so every write here can lose. A `false` return
 * means another writer owns the row, and from that moment this function's
 * intended outcome is a belief, not a fact. So every lost CAS reads the durable
 * row and reports THAT: the reported state and the committed state cannot
 * disagree, because an agent told "refused" while a dispatch is on its way, or
 * told "indeterminate" for a status that never committed, is the whole defect
 * class this module exists to prevent. A row that is unreadable, or readable
 * but not yet terminal, is reported as exactly that - unconfirmed - and the
 * settlement announce (gated on the same terminal predicate in
 * `continuation.ts`) stays silent, leaving the release to the eventual winner
 * and to the broker's periodic durable read.
 */

import logger from "@utils/logger.js";
import { withTransaction } from "../../../../../db/client.js";
import * as approvalIntentsRepo from "../../../../../db/repos/approval-intents.js";
import { admitStudioCall } from "@vex-agent/mcp/admission.js";
import { buildProjectToolContext } from "@vex-agent/mcp/project-context.js";
import type { ProjectScope } from "@vex-agent/mcp/project-scope.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

import { claimResumeContinuation } from "../../continuation.js";
import { shortSha256, summarizeErrorForLog } from "../../helpers.js";
import type { ApproveSnapshot } from "../../snapshot.js";
import {
  approvalPreviewExactlyMatches,
  checkApprovalManifestIdentity,
  readApprovalQuoteAuthority,
  readApprovalPrequoteAuthority,
  readStudioApprovalToolCall,
  studioAuthorityDigestMatches,
} from "../../tool-call-envelope.js";
import { buildApprovalIntentPreview } from "../../enqueue.js";
import {
  ApprovalPostDecisionError,
  type ApprovePrepareOutcome,
  type PreparedContinuation,
} from "../../types.js";
import { studioDispatchPreflightAllows } from "../../studio/dispatch-gate.js";
import { studioRefusalText } from "../../studio/refusal-settlement.js";
import { encodeStudioSettlement } from "../../studio/settlement-codec.js";
import { registerStudioWriteRepair } from "../../studio/write-repair.js";
import { loadProjectScope } from "./studio-project-scope.js";
import {
  reportDurableStudioRow,
  UNCONFIRMED_REFUSAL,
  UNRECORDED_AFTER_DISPATCH,
} from "./studio-report.js";
import {
  refuseStudioBeforeDispatch,
  runStudioDispatchGate,
  STUDIO_REFUSAL_CAUSES,
  type StudioGateOutcome,
} from "./studio-gate.js";

/**
 * Side effects after an `approved_in_tx` snapshot whose row is
 * `origin = 'studio_mcp'`.
 */
export async function applyStudioApproveSideEffects(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
): Promise<ApprovePrepareOutcome> {
  const row = snapshot.row;
  const sessionId = row.session_id;
  const projectId = row.project_id;
  const fallbackToolCallId =
    row.queue_tool_call_id ?? row.tool_call_id ?? approvalId;

  // 1. Claim. Cannot be busy and cannot mismatch: the Studio arm holds no
  //    lease and has no mission run to flip.
  const claim = await claimResumeContinuation({
    sessionId,
    missionRunId: null,
    approvalId,
    ownerPrefix: "approve-studio",
    origin: "studio_mcp",
    projectId,
  });
  if (claim.outcome !== "claimed") {
    throw new ApprovalPostDecisionError(
      approvalId,
      "studio_claim_impossible",
      shortSha256("studio_claim_impossible"),
    );
  }
  const continuation: PreparedContinuation = claim.continuation;

  // 2a. The preflight, FIRST: it is the only reader of the one condition the
  //     durable fence cannot represent - an advance that never committed
  //     because the database was unavailable when Vex was locked.
  if (!studioDispatchPreflightAllows()) {
    return await refusedOutcome(
      snapshot,
      continuation,
      await refuseStudioBeforeDispatch(
        approvalId,
        "generation_superseded",
        STUDIO_REFUSAL_CAUSES.fence_unproven,
      ),
    );
  }

  // 2b. The version the human approved under. A Studio row without one cannot
  //     have its authority re-proven at commit time, so it is refused rather
  //     than dispatched under whatever the project says now.
  const enqueueScopeVersion = row.scope_version_at_enqueue;
  if (enqueueScopeVersion === null) {
    logger.warn("engine.studio.enqueue_scope_version_missing", {
      approvalId,
      projectId,
    });
    return await refusedOutcome(
      snapshot,
      continuation,
      await refuseStudioBeforeDispatch(
        approvalId,
        "scope_unavailable",
        STUDIO_REFUSAL_CAUSES.scope_version_missing,
      ),
    );
  }

  // 2c. Context from the PROJECT, never from the session mirror.
  let scope: ProjectScope;
  try {
    scope = await loadProjectScope(projectId, sessionId);
  } catch (cause) {
    const summary = summarizeErrorForLog(cause);
    logger.warn("engine.studio.scope_unavailable", {
      approvalId,
      projectId,
      errorKind: summary.errorKind,
    });
    return await refusedOutcome(
      snapshot,
      continuation,
      await refuseStudioBeforeDispatch(
        approvalId,
        "scope_unavailable",
        STUDIO_REFUSAL_CAUSES.scope_unreadable,
      ),
    );
  }

  // 3. The one pre-dispatch transaction. The expected version is the ENQUEUE
  //    version, never `scope.scopeVersion`: comparing the value just read with
  //    itself would always match, and an edit committed between the approval
  //    snapshot and this load would dispatch under the NEW wallets.
  const gate = await runStudioDispatchGate({
    approvalId,
    sessionId,
    projectId,
    expectedScopeVersion: Number(enqueueScopeVersion),
  });
  if (gate.kind !== "claimed") {
    return await refusedOutcome(snapshot, continuation, gate);
  }

  // MANIFEST IDENTITY and AUTHORITY DIGEST both fail closed and both run AFTER
  // the slot claim, so a refused approval is terminal and cannot be replayed.
  const identity = checkApprovalManifestIdentity(row.queue_tool_call);
  if (!identity.ok) {
    logger.warn("engine.studio.manifest_identity_refused", {
      approvalId,
      projectId,
      reason: identity.reason,
    });
    return settleDispatched(approvalId, snapshot, continuation, {
      success: false,
      output: identity.refusal,
    });
  }
  const expiresAt = normalizedExpiry(row.expires_at);
  if (
    expiresAt === null
    || enqueueScopeVersion === null
    || !studioAuthorityDigestMatches(
      {
        envelope: row.queue_tool_call,
        preview: row.preview_json,
        expiresAt,
        sessionId,
        projectId: scope.projectId,
        scopeVersion: Number(enqueueScopeVersion),
        permission: row.queue_permission_at_enqueue,
      },
      row.request_digest,
    )
  ) {
    logger.warn("engine.studio.authority_digest_mismatch", {
      approvalId,
      projectId,
    });
    return settleDispatched(approvalId, snapshot, continuation, {
      success: false,
      output: studioRefusalText(
        "the stored request no longer matches the one this approval was "
        + "granted for",
      ),
    });
  }

  const toolCall = readStudioApprovalToolCall(
    row.queue_tool_call,
    fallbackToolCallId,
  );
  if (toolCall === null) {
    logger.warn("engine.studio.approval_call_unreadable", {
      approvalId,
      projectId,
    });
    return settleDispatched(approvalId, snapshot, continuation, {
      success: false,
      output: studioRefusalText(
        "the stored approved call could not be reconstructed safely",
      ),
    });
  }

  // Re-run the unapproved restricted admission immediately before dispatch.
  // Internal mutators stop at their approval gate; protocol mutators also
  // rebuild their current prequote/risk disclosures. The complete rebuilt card
  // must equal the JSON the user approved, including every top-level field and
  // every critical-argument key.
  const card = await revalidateStudioApprovalCard(scope, toolCall, row.preview_json);
  if (!card.ok) {
    logger.warn("engine.studio.approval_card_revalidation_refused", {
      approvalId,
      projectId,
      reason: card.reason,
    });
    return settleDispatched(approvalId, snapshot, continuation, {
      success: false,
      output: studioRefusalText(card.refusal),
    });
  }

  // The card rebuild above can await provider reads. A lock may begin during
  // that wait, after the first preflight and after the slot claim. Re-read the
  // synchronous main-side preflight on the last event-loop turn before the
  // approved call starts. This is what closes the non-signing mutation window.
  if (!studioDispatchPreflightAllows()) {
    return settleDispatched(approvalId, snapshot, continuation, {
      success: false,
      output: studioRefusalText(STUDIO_REFUSAL_CAUSES.fence_unproven),
    });
  }

  // 4. Dispatch through the SAME admission the original call took, with the
  //    approval this time. `executeProtocolTool` re-runs the prequote gate.
  const context = buildProjectToolContext(scope, {
    approved: true,
    approvalId,
    // WHICH QUOTE this card authorized, from the envelope the authority digest
    // above has just proven unchanged. The card rebuild already refuses a
    // changed disclosure; binding the claim to the row makes the same
    // substitution fail closed a second time, at the money path itself.
    approvedQuoteAuthority: readApprovalQuoteAuthority(row.queue_tool_call),
    // ...and WHICH PREQUOTE ROW it was gated on, from the same proven envelope.
    // The rerun prequote gate is fenced to that row, so a quote recorded while
    // the card waited cannot become the one this dispatch executes against.
    approvedPrequoteAuthority: readApprovalPrequoteAuthority(row.queue_tool_call),
  });
  let result: ToolResult;
  try {
    const admission = await admitStudioCall(
      {
        name: toolCall.toolName,
        args: toolCall.toolArgs,
        toolCallId: toolCall.toolCallId,
      },
      context,
    );
    result = admission.result;
  } catch (cause) {
    // The dispatch THREW. Whether it moved anything is unknowable from here,
    // so the honest terminal state is `indeterminate`, not `failed` - and the
    // REPORTED status is the same one, because the row and the answer must not
    // disagree about whether the outcome is provable.
    const summary = summarizeErrorForLog(cause);
    logger.warn("engine.studio.dispatch_threw", {
      approvalId,
      projectId,
      errorKind: summary.errorKind,
      errorHash: summary.errorHash,
    });
    const unprovable = studioRefusalText(
      "the action could not be completed and Vex cannot prove whether it took "
      + "effect, so it will NOT be retried",
    );
    const committed = await commitIndeterminate(
      approvalId,
      summary.errorHash,
      unprovable,
    );
    if (committed) {
      return {
        kind: "dispatched",
        approvalId,
        resolvedAt: snapshot.queueResolvedAt,
        executionStatus: "indeterminate",
        sessionId,
        missionRunId: null,
        continuation,
        toolResult: { success: false, output: unprovable },
      };
    }
    // The status write did not commit. Whatever the row says now is the answer;
    // claiming `indeterminate` here would assert a durable state that does not
    // exist.
    return await reportDurableStudioRow(approvalId, snapshot, continuation, UNRECORDED_AFTER_DISPATCH);
  }

  // 5. Settle.
  return settleDispatched(approvalId, snapshot, continuation, result);
}

type StudioCardRevalidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly refusal: string };

async function revalidateStudioApprovalCard(
  scope: ProjectScope,
  toolCall: NonNullable<ReturnType<typeof readStudioApprovalToolCall>>,
  storedPreview: unknown,
): Promise<StudioCardRevalidation> {
  let admission: Awaited<ReturnType<typeof admitStudioCall>>;
  try {
    admission = await admitStudioCall(
      {
        name: toolCall.toolName,
        args: toolCall.toolArgs,
        toolCallId: toolCall.toolCallId,
      },
      buildProjectToolContext({ ...scope, permission: "restricted" }),
    );
  } catch (cause) {
    const summary = summarizeErrorForLog(cause);
    logger.warn("engine.studio.approval_card_rebuild_failed", {
      errorKind: summary.errorKind,
      errorHash: summary.errorHash,
    });
    return {
      ok: false,
      reason: "rebuild_failed",
      refusal: "the current approval disclosures could not be rebuilt safely",
    };
  }
  if (admission.result.pendingApproval !== true) {
    return {
      ok: false,
      reason: "approval_no_longer_required",
      refusal:
        "the call no longer produced the approval card that was previously shown",
    };
  }
  const rebuilt = buildApprovalIntentPreview({
    toolName: toolCall.toolName,
    toolArgs: toolCall.toolArgs,
    result: admission.result,
    ...(admission.result.preparedApprovalBinding === undefined
      ? {}
      : { preparedApprovalBinding: admission.result.preparedApprovalBinding }),
  });
  if (!approvalPreviewExactlyMatches(rebuilt, storedPreview)) {
    return {
      ok: false,
      reason: "card_mismatch",
      refusal:
        "the current complete approval card no longer exactly matches the card the user approved",
    };
  }
  return { ok: true };
}

function normalizedExpiry(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// ── Settlement ──────────────────────────────────────────────────────────

/**
 * Write the whole result and its byte size through the FENCED CAS, then report
 * the outcome. A `false` CAS means the row left `dispatching` underneath this
 * writer (the reconciler declared it `indeterminate`, or another writer
 * settled it); the honest answer is then the row's, not ours, so nothing is
 * overwritten.
 */
async function settleDispatched(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
  continuation: PreparedContinuation,
  result: ToolResult,
): Promise<ApprovePrepareOutcome> {
  const encoded = encodeStudioSettlement(result);
  const status = result.success ? "succeeded" : "failed";
  try {
    const settled = await withTransaction((client) =>
      approvalIntentsRepo.commitStudioSettlementWith(client, {
        approvalId,
        status,
        resultHash: shortSha256(encoded.json),
        settlementJson: encoded.json,
        settlementBytes: encoded.bytes,
      }),
    );
    if (!settled) {
      // The row left `dispatching` underneath this writer. Its state is the
      // answer; ours is a belief about a write that never landed.
      logger.warn("engine.studio.settlement_superseded", { approvalId });
      return await reportDurableStudioRow(
        approvalId,
        snapshot,
        continuation,
        UNRECORDED_AFTER_DISPATCH,
      );
    }
  } catch (cause) {
    // The dispatch ALREADY RAN. A failed settlement write cannot be retried as
    // a dispatch, so the terminal state is `indeterminate`, the textual output
    // is preserved with it, and THAT is what the caller is told.
    const summary = summarizeErrorForLog(cause);
    logger.warn("engine.studio.settlement_write_failed", {
      approvalId,
      errorKind: summary.errorKind,
      errorHash: summary.errorHash,
    });
    const committed = await commitIndeterminate(
      approvalId,
      summary.errorHash,
      result.output,
    );
    if (!committed) {
      return await reportDurableStudioRow(
        approvalId,
        snapshot,
        continuation,
        UNRECORDED_AFTER_DISPATCH,
      );
    }
    return {
      kind: "dispatched",
      approvalId,
      resolvedAt: snapshot.queueResolvedAt,
      executionStatus: "indeterminate",
      sessionId: snapshot.row.session_id,
      missionRunId: null,
      continuation,
      toolResult: { success: false, output: result.output },
    };
  }
  return {
    kind: "dispatched",
    approvalId,
    resolvedAt: snapshot.queueResolvedAt,
    executionStatus: status,
    sessionId: snapshot.row.session_id,
    missionRunId: null,
    continuation,
    toolResult: { success: result.success, output: result.output },
  };
}

/**
 * `dispatching -> indeterminate` together with whatever text survived, in ONE
 * statement.
 *
 * It has to be one statement: a status flip followed by the settlement CAS
 * could never work, because that CAS is fenced on `dispatching`, which the flip
 * has just left. Best effort by construction - this runs because a write
 * already failed, so a second failure is logged and the startup reconciler
 * remains the durable floor.
 */
async function commitIndeterminate(
  approvalId: string,
  errorHash: string,
  preservedOutput: string,
): Promise<boolean> {
  const encoded = encodeStudioSettlement({
    success: false,
    output: preservedOutput,
  });
  for (let attempt = 1; attempt <= INDETERMINATE_WRITE_ATTEMPTS; attempt++) {
    try {
      const committed = await withTransaction((client) =>
        approvalIntentsRepo.casMarkIndeterminateWithSettlementWith(client, {
          approvalId,
          settlementJson: encoded.json,
          settlementBytes: encoded.bytes,
          resultHash: errorHash,
        }),
      );
      // `false` is NOT retryable: the predicate requires `dispatching`, and a
      // row that has left it has a terminal state written by somebody else.
      // Retrying would only lose the same race again.
      if (committed) return true;
      logger.warn("engine.studio.indeterminate_write_superseded", { approvalId });
      return false;
    } catch (cause) {
      logger.error("engine.studio.indeterminate_write_failed", {
        approvalId,
        attempt,
        errorName: cause instanceof Error ? cause.name : "unknown",
      });
      if (attempt < INDETERMINATE_WRITE_ATTEMPTS) {
        await delay(INDETERMINATE_WRITE_BACKOFF_MS * attempt);
      }
    }
  }
  // EVERY attempt threw. The dispatch already ran, so this row must not stay
  // `dispatching`: nothing else would ever leave it, because the expiry sweep
  // scans undecided rows only and the agent lifecycle scans exclude Studio
  // rows. The identical STATUS WRITE - never a dispatch - is handed to the
  // repair owner, which retries it in this process until a terminal state
  // exists and then releases the blocked caller.
  registerStudioWriteRepair({
    write: "indeterminate",
    approvalId,
    settlementJson: encoded.json,
    settlementBytes: encoded.bytes,
    resultHash: errorHash,
  });
  return false;
}

/**
 * How many times the indeterminate STATUS WRITE is attempted. It is a status
 * write on a row whose dispatch has already run, so a retry cannot cause a
 * second dispatch; the transient failure it covers is a database blip in the
 * seconds after a call that may have moved funds, and leaving that row
 * `dispatching` costs the blocked agent an answer until the next process start.
 */
const INDETERMINATE_WRITE_ATTEMPTS = 3;
const INDETERMINATE_WRITE_BACKOFF_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A refusal that is ALREADY DURABLE becomes the IPC outcome, with `failed` as
 * the execution status because nothing ran and nothing can: that row is
 * terminal.
 *
 * A refusal that did NOT commit is not an outcome at all - see the branch
 * below.
 */
async function refusedOutcome(
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
  continuation: PreparedContinuation,
  gate: Extract<StudioGateOutcome, { kind: "refused" }>,
): Promise<ApprovePrepareOutcome> {
  if (!gate.refusalCommitted) {
    // The refusal is a belief: another writer owns the row, or the write never
    // landed. Never claim it happened - read the row and report its state, and
    // fall back to an explicitly unconfirmed answer. `failed` rather than
    // `indeterminate` on that fallback because NOTHING dispatched on this
    // path, so there is no unknown effect to warn about.
    return await reportDurableStudioRow(
      snapshot.row.approval_id,
      snapshot,
      continuation,
      UNCONFIRMED_REFUSAL,
      "failed",
    );
  }
  return {
    kind: "dispatched",
    approvalId: snapshot.row.approval_id,
    resolvedAt: snapshot.queueResolvedAt,
    executionStatus: "failed",
    sessionId: snapshot.row.session_id,
    missionRunId: null,
    continuation,
    toolResult: { success: false, output: gate.output },
  };
}
