/**
 * The ONE approval-enqueue transaction - queue row, intent row, mission-status
 * flip - shared by the agent turn loop and the Vex Studio MCP surface.
 *
 * MOVED, NOT REWRITTEN. The body below is the turn loop's enqueue transaction
 * (`turn-loop-tool-batch/approval-stop.ts`) with two changes and no third: the
 * `EngineContext` was replaced by the narrow record the two callers can both
 * produce, and the PRE-INSERT GATE became a parameter instead of a hard-coded
 * pair of statements. The turn loop passes exactly the gate it always ran
 * (session control lock + operator-stop gate), so its single-transaction and
 * emit-after-commit contracts are unchanged; the existing tests for both pin
 * that, unchanged.
 *
 * WHY THE GATE IS INJECTED. The two surfaces have different reasons to refuse
 * an enqueue and the same reason to insert one. The agent refuses when the
 * operator has stopped the run; Studio refuses when the project has moved
 * underneath the call. Both must be decided INSIDE this transaction - a gate
 * that commits separately is a window in which the thing it checked can change
 * - and neither belongs to the other. So the transaction owns the ORDER (gate
 * first, insert second, status flip last) and the caller owns the POLICY.
 *
 * The gate speaks three verdicts, and they are genuinely different outcomes:
 *
 *   `clear`        - insert, flip the run to `paused_approval`, emit.
 *   `auto_rejected`- insert for the AUDIT TRAIL and reject in the SAME
 *                    transaction, do not flip, do not emit. The row exists
 *                    because an action really did ask for approval; it can
 *                    never be decided because the run is already gone.
 *   `refused`      - insert NOTHING. The call never reached a queue, so there
 *                    is no card, no audit row and nothing to decide; the caller
 *                    answers its own caller with the typed reason.
 *
 * Emit-after-commit is unchanged and deliberate: the queue row, the intent row
 * and the status flip are all durable before any subscriber is told, so a
 * refetch on the signal always finds the card.
 */

import type { PoolClient } from "pg";

import type { MissionRunStatus } from "../../types.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { ActionKind } from "@vex-agent/tools/taxonomy.js";
import type { Permission } from "../../types.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { emitMissionUpdate } from "@vex-agent/engine/runtime/mission-bus.js";
import logger from "@utils/logger.js";
import { riskLevelFromActionKind } from "@vex-agent/tools/risk-level.js";
import {
  buildApprovalToolCall,
  computeRequestDigest,
} from "./tool-call-envelope.js";
import {
  buildIntentPreview,
  buildPolicySnapshot,
  type IntentPreview,
} from "../approval-intent-preview.js";

/** The binding contract, as `ToolResult` declares it structurally. */
type PreparedApprovalBinding = NonNullable<ToolResult["preparedApprovalBinding"]>;

/**
 * The approval card for a bound proposal: the DECODED effect the user reads,
 * the arguments it binds, and the identity of the row it will consume.
 *
 * The label rides `criticalArgs.effect` because `IntentPreview` has no label
 * field and the renderer shows the whole map. It is the sentence the human
 * authorizes, so it is carried WHOLE.
 */
function previewFromBinding(
  toolName: string,
  binding: PreparedApprovalBinding,
): IntentPreview {
  return {
    toolName,
    criticalArgs: {
      ...binding.preview.criticalArgs,
      effect: binding.preview.label,
      intentId: binding.resource.intentId,
      expiresAt: binding.intentExpiresAt,
    },
  };
}

/**
 * Puzzle 5 phase 3 - TTL stamped at enqueue (not at approve). The approve
 * gate (`prepareApprove` snapshot) and the scheduled sweep both rely on a
 * DB-visible `expires_at` so a stale approval gets auto-rejected even
 * without operator action. One hour is the default; a trusted prepared
 * action can supply an earlier expiry so its approval never outlives the
 * underlying wallet intent.
 */
export const APPROVAL_TTL_MS = 60 * 60 * 1000;

/** What the pre-insert gate decided. See the module header. */
export type EnqueueGateVerdict =
  | {
      readonly kind: "clear";
      /**
       * The Studio dispatch generation current in THIS transaction. Stored on
       * the row so the dispatch-slot claim can require that it has not moved.
       * `undefined` for the agent lane, which has no dispatch gate.
       */
      readonly dispatchGeneration?: string;
    }
  | {
      readonly kind: "auto_rejected";
      readonly runStatus: MissionRunStatus | null;
      /** Structural log tag, never model-visible. */
      readonly logKind: string;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Runs FIRST inside the enqueue transaction, before any row is written. It owns
 * every lock the transaction takes ahead of the queue/intent rows, so it is
 * also the place the global lock order is honoured.
 */
export type EnqueuePreInsertGate = (
  client: PoolClient,
) => Promise<EnqueueGateVerdict>;

/**
 * Everything the transaction needs, and nothing that ties it to an agent turn.
 * `missionId` rides along only because the emit carries it.
 */
export interface EnqueueApprovalInput {
  readonly sessionId: string;
  readonly missionId: string | null;
  readonly missionRunId: string | null;
  readonly permission: Permission;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly toolCallId: string | undefined;
  readonly result: ToolResult;
  readonly toolContext: InternalToolContext;
  readonly intentActionKind: ActionKind;
  /**
   * Handler-authored preview for a registry-validated prepared follow-up
   * (`resolvePreparedActionFollowUp`). When present it REPLACES the
   * args-derived preview entirely - including any prequote enrichment below,
   * which only applies to a direct (non-handoff) dispatch.
   */
  readonly trustedPreview?: IntentPreview;
  /** Optional prepared-action expiry; approval must not outlive it. */
  readonly trustedExpiresAt?: string;
  /**
   * What this approval is BOUND TO, when the handler rebuilt it from a durable
   * proposal row (stage A4b, spec item 2). It is folded into the stored envelope
   * and therefore into the canonical request digest, so the approval identifies
   * the exact proposal a human read rather than a pair of identifiers; it also
   * SUPPLIES the preview and the expiry, so a caller never has to pass the same
   * facts twice and the three can never disagree.
   *
   * A caller-supplied binding would let the caller choose the sentence the user
   * approves, so the only producer is the confirm handler's own
   * `ToolResult.preparedApprovalBinding`, read from the result both call sites
   * already carry whole.
   */
  readonly preparedApprovalBinding?: PreparedApprovalBinding;
  readonly origin: "agent" | "studio_mcp";
  /** Studio only - the project whose scope authorized the call. */
  readonly projectId?: string;
  /** Studio only - the `projects.scope_version` the call was admitted under. */
  readonly scopeVersion?: number;
}

export type ApprovalEnqueueOutcome =
  | { readonly kind: "enqueued"; readonly approvalId: string }
  | {
      readonly kind: "auto_rejected";
      readonly approvalId: string;
      readonly runStatus: MissionRunStatus | null;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Build the approval id / preview / policy / expiry and run the SINGLE enqueue
 * transaction. A partial state (queue without intent, or queue+intent without
 * `paused_approval`) is unrepresentable.
 */
export async function enqueueApprovalIntentWithGate(
  input: EnqueueApprovalInput,
  gate: EnqueuePreInsertGate,
): Promise<ApprovalEnqueueOutcome> {
  const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const intentRiskLevel = riskLevelFromActionKind(input.intentActionKind);
  const result = input.result;
  // Stage 7 R5: carry the gate-matched swap safety verdict (typed, off the
  // ToolResult - NOT raw args) into the preview so restricted-mode approval
  // surfaces `pass` / `unknown` ("UNVERIFIED") before the human approves.
  const binding = input.preparedApprovalBinding;
  const intentPreview =
    (binding === undefined ? undefined : previewFromBinding(input.toolName, binding)) ??
    input.trustedPreview ??
    buildIntentPreview(
      input.toolName,
      input.toolArgs,
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
  const intentPolicy = buildPolicySnapshot(input.toolContext);
  // The INTENT's own expiry floors the default, so an approval can never
  // outlive the proposal it would broadcast - a Solana blockhash is valid for
  // about a minute, and the default TTL is an hour.
  const intentExpiresAt = resolveExpiresAt(binding?.intentExpiresAt ?? input.trustedExpiresAt);
  // The envelope is built ONCE and both stored and digested, so the digest
  // provably describes the value that will be dispatched. The binding travels
  // INSIDE it, which is what folds the proposal digest into the canonical
  // request digest rather than bolting a second digest on beside it.
  const envelope = buildApprovalToolCall(input.toolName, input.toolArgs, binding);
  const requestDigest =
    input.origin === "studio_mcp" ? computeRequestDigest(envelope) : null;

  const outcome = await withTransaction(async (client): Promise<ApprovalEnqueueOutcome> => {
    const verdict = await gate(client);
    if (verdict.kind === "refused") {
      return { kind: "refused", reason: verdict.reason };
    }
    const runIsDead = verdict.kind === "auto_rejected";
    const deadRunStatus: MissionRunStatus | null =
      verdict.kind === "auto_rejected" ? verdict.runStatus : null;

    await approvalsRepo.enqueueWith(
      client,
      approvalId,
      // An injected direct call (`kyberswap__swap__execute`) is CANONICALIZED
      // here into the `execute_tool {toolId, params}` envelope so the approval
      // survives a process restart: the injected lane resolves its name from
      // the process-local discovered set, which is empty in a fresh process,
      // and the human's Approve click would fail "not discovered". Every other
      // lane keeps today's `{command, args}` shape - see
      // `approval-runtime/tool-call-envelope.ts`.
      envelope,
      result.output,
      input.sessionId,
      input.toolCallId,
      input.permission,
      input.origin === "studio_mcp" ? "studio_mcp" : undefined,
    );
    await approvalIntentsRepo.createWith(client, {
      approvalId: approvalId,
      sessionId: input.sessionId,
      missionRunId: input.missionRunId,
      toolCallId: input.toolCallId ?? null,
      actionKind: input.intentActionKind,
      riskLevel: intentRiskLevel,
      previewJson: intentPreview,
      policyJson: intentPolicy,
      expiresAt: intentExpiresAt,
      origin: input.origin,
      projectId: input.projectId ?? null,
      scopeVersionAtEnqueue: input.scopeVersion ?? null,
      requestDigest,
      dispatchGenerationAtEnqueue:
        verdict.kind === "clear" ? verdict.dispatchGeneration ?? null : null,
    });

    if (runIsDead) {
      // Auto-reject in the SAME transaction and leave the terminal run alone.
      // The row exists for audit but can never be approved.
      await approvalsRepo.rejectWith(client, approvalId);
      logger.warn("engine.approval.auto_rejected_terminal_run", {
        sessionId: input.sessionId,
        missionRunId: input.missionRunId,
        approvalId,
        runStatus: deadRunStatus,
        actionKind: input.intentActionKind,
      });
      return { kind: "auto_rejected", approvalId, runStatus: deadRunStatus };
    }

    if (input.missionRunId) {
      await missionRunsRepo.updateStatus(
        input.missionRunId,
        "paused_approval",
        "approval_required",
        undefined,
        client,
      );
    }
    return { kind: "enqueued", approvalId };
  });

  // Emit-after-commit: the queue row, the intent row and the
  // `paused_approval` flip are all durable here, so a subscriber that
  // refetches `listPending` on this signal always finds the card. The
  // auto-rejected and refused arms emit nothing - the first can never be
  // decided, the second never existed.
  if (outcome.kind === "enqueued") {
    emitMissionUpdate({
      sessionId: input.sessionId,
      missionId: input.missionId,
      kind: "approval_enqueued",
    });
  }
  return outcome;
}

/**
 * `min(now + 1 h, trustedExpiresAt)` - a trusted prepared action's own expiry
 * floors the default so the approval can never outlive the wallet intent it
 * would broadcast.
 */
function resolveExpiresAt(trustedExpiresAt: string | undefined): string {
  const defaultExpiresAtMs = Date.now() + APPROVAL_TTL_MS;
  const trustedExpiresAtMs =
    trustedExpiresAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(trustedExpiresAt);
  return new Date(
    Math.min(
      defaultExpiresAtMs,
      Number.isFinite(trustedExpiresAtMs) ? trustedExpiresAtMs : defaultExpiresAtMs,
    ),
  ).toISOString();
}
