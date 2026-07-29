/**
 * Approval-enqueue helpers — the fail-fast actionKind guard and the single
 * approval-enqueue transaction (queue + intent + paused_approval flip).
 *
 * Extracted verbatim from `turn-loop-tool-batch.ts`. The orchestrator owns
 * the approval-path ORDER (dispatch → actionKind fail-fast →
 * executedCalls.push → id/preview/policy/expiry → SINGLE DB transaction →
 * break); this module owns the fail-fast guard and the transaction body so
 * the ordering and the single-transaction invariant stay bit-for-bit.
 */

import type { EngineContext, MissionRunStatus } from "../../types.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ActionKind } from "@vex-agent/tools/taxonomy.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { withTransaction } from "@vex-agent/db/client.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import logger from "@utils/logger.js";
import { riskLevelFromActionKind } from "@vex-agent/tools/risk-level.js";
import {
  buildIntentPreview,
  buildPolicySnapshot,
  type IntentPreview,
} from "../approval-intent-preview.js";

/**
 * Puzzle 5 phase 3 — TTL stamped at enqueue (not at approve). The approve
 * gate (`prepareApprove` snapshot) and the scheduled sweep both rely on a
 * DB-visible `expires_at` so a stale approval gets auto-rejected even
 * without operator action. One hour is the default; a trusted prepared
 * action can supply an earlier expiry so its approval never outlives the
 * underlying wallet intent.
 */
const APPROVAL_TTL_MS = 60 * 60 * 1000;

/**
 * Approval-path fail-fast. Puzzle 5 phase 2: approval_intents.action_kind is
 * NOT NULL with a CHECK constraint over the 8 canonical ActionKind variants.
 * The dispatcher's `withActionKindFallback` MUST have stamped a kind before
 * this branch — a missing stamp here is a bug in tool registration or in the
 * dispatcher fallback. Fail fast (Codex 2/1B ruling) instead of silently
 * inserting a pseudo-kind or downgrading to a default — neither preserves the
 * policy invariant. Returns the validated kind so the enqueue path reads a
 * narrowed `ActionKind`.
 */
export function assertApprovalActionKind(
  result: ToolResult,
  toolCall: ParsedToolCall,
): ActionKind {
  if (result.actionKind === undefined) {
    throw new Error(
      `Approval intent requires result.actionKind for tool "${toolCall.name}" — ` +
      `dispatcher fallback should have stamped it. ` +
      `Check the tool's actionKind classification in tools/registry/ or protocols/.`,
    );
  }
  return result.actionKind;
}

/**
 * Outcome of the enqueue transaction.
 *
 * `auto_rejected` closes the restricted-mode stop race: a tool can still be
 * in flight when the operator stops the run, so by the time it comes back
 * asking for approval the run may be terminal — or a `stop_terminal` request
 * may be queued and not yet applied. Enqueueing in either case would park a
 * live, approvable action on a run nobody will ever resume. The row is still
 * written (audit trail) but immediately rejected in the SAME transaction, and
 * the run status is NOT flipped to `paused_approval`.
 */
export type ApprovalEnqueueOutcome =
  | { readonly kind: "enqueued"; readonly approvalId: string }
  | {
    readonly kind: "auto_rejected";
    readonly approvalId: string;
    readonly runStatus: MissionRunStatus | null;
  };

/**
 * Build the approval id/preview/policy/expiry and run the SINGLE enqueue
 * transaction (queue + intent + mission-status flip). A partial state (queue
 * without intent, or queue+intent without `paused_approval`) is
 * unrepresentable.
 */
export async function enqueueApprovalIntent(args: {
  readonly context: EngineContext;
  readonly toolCall: ParsedToolCall;
  readonly result: ToolResult;
  readonly toolContext: InternalToolContext;
  readonly intentActionKind: ActionKind;
  /**
   * Handler-authored preview for a registry-validated prepared follow-up
   * (`resolvePreparedActionFollowUp`). When present it REPLACES the
   * args-derived preview entirely — including any prequote enrichment below,
   * which only applies to a direct (non-handoff) dispatch.
   */
  readonly trustedPreview?: IntentPreview;
  /** Optional prepared-action expiry; approval must not outlive it. */
  readonly trustedExpiresAt?: string;
}): Promise<ApprovalEnqueueOutcome> {
  const {
    context,
    toolCall,
    result,
    toolContext,
    intentActionKind,
    trustedPreview,
    trustedExpiresAt,
  } = args;

  const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const intentRiskLevel = riskLevelFromActionKind(intentActionKind);
  // Stage 7 R5: carry the gate-matched swap safety verdict (typed, off the
  // ToolResult — NOT raw args) into the preview so restricted-mode approval
  // surfaces `pass` / `unknown` ("UNVERIFIED") before the human approves.
  const intentPreview =
    trustedPreview ??
    buildIntentPreview(
      toolCall.name,
      toolCall.arguments,
      (result.prequote || result.riskPreview !== undefined)
        ? {
            prequoteVerdict: result.prequote?.verdict,
            fotTax: result.prequote?.fotTax,
            // Wave 5 (Pendle): the term-lock maturity rides the same typed channel;
            // buildIntentPreview renders the fixed lock warning (never from args).
            termLock: result.prequote?.termLock,
            // W5 (design §6 R4): the Jupiter fee-bearing disclosure rides the
            // same typed channel; buildIntentPreview renders it (never from args).
            feePreview: result.prequote?.feePreview,
            // B1/B3 (Batch 5): the Jupiter Lend Borrow LTV/health disclosure
            // rides its OWN top-level `ToolResult.riskPreview` sibling field
            // (it has no matched swap/bridge `prequote` at all) into the same
            // typed channel; buildIntentPreview renders it (never from args).
            riskPreview: result.riskPreview,
          }
        : undefined,
    );
  const intentPolicy = buildPolicySnapshot(toolContext);
  // Phase 3: stamp `expires_at` at enqueue so the approve gate +
  // scheduled sweep have a DB-visible TTL boundary (see APPROVAL_TTL_MS
  // header). `CreateIntentInput.previewJson/policyJson` were widened in
  // phase 3 to accept the structured builder shapes directly — no
  // `as unknown as Record<string, unknown>` cast needed. A trusted prepared
  // action's own expiry floors this so the approval can never outlive the
  // underlying wallet intent.
  const defaultExpiresAtMs = Date.now() + APPROVAL_TTL_MS;
  const trustedExpiresAtMs =
    trustedExpiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(trustedExpiresAt);
  const intentExpiresAt = new Date(
    Math.min(
      defaultExpiresAtMs,
      Number.isFinite(trustedExpiresAtMs) ? trustedExpiresAtMs : defaultExpiresAtMs,
    ),
  ).toISOString();

  // Single transaction: queue + intent + mission-status flip. A
  // partial state (queue without intent, or queue+intent without
  // `paused_approval`) is unrepresentable. Codex 2 phase-2 ruling:
  // the existing pattern of "queue insert, then updateStatus outside
  // tx" could leave a pending approval without the run actually
  // paused if the status update fails.
  return withTransaction(async (client): Promise<ApprovalEnqueueOutcome> => {
    // Restricted-mode stop race: the operator can stop the run WHILE this tool
    // is in flight. A row-lock re-check alone is not enough — it proves the run
    // was not terminal, not that the operator had not pressed Stop, and a
    // `stop_terminal` request that has not been INSERTED yet cannot be locked.
    // The session control lock is that boundary; the gate then applies a queued
    // stop through the one shared stop body so we never enqueue an approvable
    // action onto a run the user has already given up on.
    await acquireSessionControlLock(client, context.sessionId);
    const stopGate = await gateOnOperatorStopWithClient(client, {
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
    });
    const runIsDead = stopGate.kind === "stopped";
    const deadRunStatus: MissionRunStatus | null =
      stopGate.kind === "stopped" ? stopGate.runStatus : null;

    await approvalsRepo.enqueueWith(
      client,
      approvalId,
      { command: toolCall.name, args: toolCall.arguments },
      result.output,
      context.sessionId,
      toolCall.id,
      context.sessionPermission,
    );
    await approvalIntentsRepo.createWith(client, {
      approvalId: approvalId,
      sessionId: context.sessionId,
      missionRunId: context.missionRunId,
      toolCallId: toolCall.id ?? null,
      actionKind: intentActionKind,
      riskLevel: intentRiskLevel,
      previewJson: intentPreview,
      policyJson: intentPolicy,
      expiresAt: intentExpiresAt,
    });

    if (runIsDead) {
      // Auto-reject in the SAME transaction and leave the terminal run alone.
      // The row exists for audit but can never be approved.
      await approvalsRepo.rejectWith(client, approvalId);
      logger.warn("engine.approval.auto_rejected_terminal_run", {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId,
        approvalId,
        runStatus: deadRunStatus,
        actionKind: intentActionKind,
      });
      return { kind: "auto_rejected", approvalId, runStatus: deadRunStatus };
    }

    if (context.missionRunId) {
      await missionRunsRepo.updateStatus(
        context.missionRunId,
        "paused_approval",
        "approval_required",
        undefined,
        client,
      );
    }
    return { kind: "enqueued", approvalId };
  });
}
