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

import type { EngineContext } from "../../types.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ActionKind } from "@vex-agent/tools/taxonomy.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { riskLevelFromActionKind } from "@vex-agent/tools/risk-level.js";
import {
  buildIntentPreview,
  buildPolicySnapshot,
  type IntentPreview,
} from "../approval-intent-preview.js";
import { bindWalletSendConfirmApproval } from "../wallet-send-approval.js";

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
 * Build the approval id/preview/policy/expiry and run the SINGLE enqueue
 * transaction (queue + intent + mission-status flip). A partial state (queue
 * without intent, or queue+intent without `paused_approval`) is
 * unrepresentable. Returns the generated approval id.
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
   * args-derived preview entirely — including any hyperliquid/prequote
   * enrichment below, which only applies to a direct (non-handoff) dispatch.
   */
  readonly trustedPreview?: IntentPreview;
  /** Optional prepared-action expiry; approval must not outlive it. */
  readonly trustedExpiresAt?: string;
}): Promise<string> {
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

  // wallet_send_confirm: ALWAYS bind preview + expiry to the durable
  // wallet_intents row (session-scoped). Tool args are only {network,intentId};
  // building from args alone yields a blind card, and model-supplied to/amount
  // keys must never paint a lying preview. Fail closed if the intent is not a
  // live pending row — never enqueue without enough context to decide.
  // trustedPreview from prepare→follow-up is ignored here on purpose: the row
  // is the source of truth (and matches the prepare-time preview when healthy).
  let intentPreview: IntentPreview;
  let boundWalletExpiresAt: string | undefined;
  if (toolCall.name === "wallet_send_confirm") {
    const bound = await bindWalletSendConfirmApproval(
      context.sessionId,
      toolCall.arguments,
    );
    intentPreview = bound.preview;
    boundWalletExpiresAt = bound.expiresAt;
  } else {
    // Stage 7 R5: carry the gate-matched swap safety verdict (typed, off the
    // ToolResult — NOT raw args) into the preview so restricted-mode approval
    // surfaces `pass` / `unknown` ("UNVERIFIED") before the human approves.
    intentPreview =
      trustedPreview ??
      buildIntentPreview(
        toolCall.name,
        toolCall.arguments,
        result.prequote
          ? {
              prequoteVerdict: result.prequote.verdict,
              fotTax: result.prequote.fotTax,
              // Wave 5 (Pendle): the term-lock maturity rides the same typed channel;
              // buildIntentPreview renders the fixed lock warning (never from args).
              termLock: result.prequote.termLock,
              ...(result.hyperliquid ? { hyperliquid: result.hyperliquid } : {}),
            }
          : result.hyperliquid ? { hyperliquid: result.hyperliquid } : undefined,
      );
  }

  const intentPolicy = buildPolicySnapshot(toolContext);
  // Phase 3: stamp `expires_at` at enqueue so the approve gate +
  // scheduled sweep have a DB-visible TTL boundary (see APPROVAL_TTL_MS
  // header). `CreateIntentInput.previewJson/policyJson` were widened in
  // phase 3 to accept the structured builder shapes directly — no
  // `as unknown as Record<string, unknown>` cast needed. A trusted prepared
  // action's own expiry floors this so the approval can never outlive the
  // underlying wallet intent. wallet_send_confirm always floors at the
  // live intent row expiry as well.
  const defaultExpiresAtMs = Date.now() + APPROVAL_TTL_MS;
  const trustedExpiresAtMs =
    trustedExpiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(trustedExpiresAt);
  const boundWalletExpiresAtMs =
    boundWalletExpiresAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(boundWalletExpiresAt);
  const intentExpiresAt = new Date(
    Math.min(
      defaultExpiresAtMs,
      Number.isFinite(trustedExpiresAtMs) ? trustedExpiresAtMs : defaultExpiresAtMs,
      Number.isFinite(boundWalletExpiresAtMs) ? boundWalletExpiresAtMs : defaultExpiresAtMs,
    ),
  ).toISOString();

  // Single transaction: queue + intent + mission-status flip. A
  // partial state (queue without intent, or queue+intent without
  // `paused_approval`) is unrepresentable. Codex 2 phase-2 ruling:
  // the existing pattern of "queue insert, then updateStatus outside
  // tx" could leave a pending approval without the run actually
  // paused if the status update fails.
  await withTransaction(async (client) => {
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
    if (context.missionRunId) {
      await missionRunsRepo.updateStatus(
        context.missionRunId,
        "paused_approval",
        "approval_required",
        undefined,
        client,
      );
    }
  });

  return approvalId;
}
