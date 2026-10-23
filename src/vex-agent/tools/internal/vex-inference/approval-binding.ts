/**
 * THE VEX INFERENCE DEPOSIT APPROVAL BINDING: what an approval of a deposit is bound to.
 *
 * WHY THIS MODULE EXISTS. `VexInferenceDepositConfirm` signs a stored VEX
 * transfer, so an approval of it must be an approval of the WHOLE transfer the
 * user read: amount, wallet, destination, fee bound, expiry. A card that shows
 * only the `intentId` (the generic dispatcher gate's argument-derived preview)
 * is not that, and approving it must never sign anything. So Confirm owns its
 * approval the way the generic signing confirms do
 * (`wallet/transaction/confirm-shared.ts`):
 *
 * 1. the handler asks for approval ONLY with a {@link depositApprovalBinding}
 *    built from the host's intent, which every enqueue path renders as the
 *    complete card (`approval-runtime/durable-approval-card.ts`) and folds into
 *    the approval's request digest;
 * 2. an approved resume is accepted ONLY when {@link verifyDepositApproval}
 *    proves the approval names THIS intent, its binding digest is the digest of
 *    the card this intent renders now, and the stored card row is that card,
 *    whole;
 * 3. a rejected or expired card RETIRES its intent
 *    ({@link retireDepositIntentOfRejectedApproval}), so no later direct call
 *    can sign what the user turned down.
 *
 * The card is rendered from the host's intent and nothing else: no model
 * argument reaches a line of it.
 */

import { createHash } from "node:crypto";

import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import {
  buildDurableApprovalCard,
  durableApprovalCardMatches,
  readEnvelopeToolName,
} from "@vex-agent/engine/core/approval-runtime/durable-approval-card.js";
import { readApprovalProposalBinding } from "@vex-agent/engine/core/approval-runtime/tool-call-envelope.js";
import logger from "@utils/logger.js";

import type { ToolResult } from "../../types.js";
import { depositCardArgs, VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL, type DepositCardArgs } from "./card.js";
import { getVexInferenceHost, type AgentDepositIntentView } from "./host.js";

/** The binding's resource name: the main-process agent deposit intent store (in memory, single use). */
export const VEX_INFERENCE_DEPOSIT_RESOURCE = "vex_inference_agent_deposit_intents" as const;
/** Bumped when {@link depositCardArgs} or the digest preimage changes shape. */
export const VEX_INFERENCE_DEPOSIT_DIGEST_VERSION = "vxdep-card-v1" as const;
const CARD_LABEL = "Deposit VEX into your Vex Inference balance";

type DepositApprovalBinding = NonNullable<ToolResult["preparedApprovalBinding"]>;

/** Canonical JSON of the card (sorted keys), the digest preimage. */
function canonicalCardJson(intentId: string, args: DepositCardArgs): string {
  const sorted = Object.keys(args).sort().map((key) => [key, args[key as keyof DepositCardArgs]]);
  return JSON.stringify({ version: VEX_INFERENCE_DEPOSIT_DIGEST_VERSION, intentId, card: sorted });
}

/** The digest of the card this intent renders. Deterministic: the same intent always yields the same digest. */
export function depositProposalDigest(intent: AgentDepositIntentView): string {
  return createHash("sha256").update(canonicalCardJson(intent.intentId, depositCardArgs(intent))).digest("hex");
}

/**
 * What an approval of this deposit is BOUND TO: the complete card, the
 * intent's own expiry, and the digest of that card. Built only from the host's
 * intent, only by the confirm handler, only on a `pendingApproval` return.
 */
export function depositApprovalBinding(intent: AgentDepositIntentView): DepositApprovalBinding {
  return {
    preview: { label: CARD_LABEL, criticalArgs: { ...depositCardArgs(intent) } },
    intentExpiresAt: intent.expiresAt,
    proposalDigest: depositProposalDigest(intent),
    proposalDigestVersion: VEX_INFERENCE_DEPOSIT_DIGEST_VERSION,
    resource: { table: VEX_INFERENCE_DEPOSIT_RESOURCE, intentId: intent.intentId },
  };
}

export type ApprovalVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

const NOTHING = "Nothing was signed and no funds moved. Prepare the deposit again and approve the card it raises.";

/**
 * Prove an approved resume is an approval of THIS intent's complete card.
 * Fails closed on every missing piece: no approval id, an approval of another
 * session, no binding (a generic card), a binding of another intent or another
 * card, a stored card that is not the one this intent renders, or an envelope
 * that dispatches another tool.
 */
export async function verifyDepositApproval(
  approvalId: string | null | undefined,
  sessionId: string,
  intent: AgentDepositIntentView,
): Promise<ApprovalVerdict> {
  if (approvalId === undefined || approvalId === null || approvalId === "") {
    return { ok: false, reason: `this call is marked approved but names no approval, so Vex cannot check what was approved. ${NOTHING}` };
  }
  const approval = await approvalsRepo.getByIdForSession(approvalId, sessionId);
  if (approval === null) return { ok: false, reason: `the approval it names does not exist in this session. ${NOTHING}` };
  if (readEnvelopeToolName(approval.toolCall) !== VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL) {
    return { ok: false, reason: `the approval it names is for another action. ${NOTHING}` };
  }
  const bound = readApprovalProposalBinding(approval.toolCall);
  if (bound === null) {
    return { ok: false, reason: `the approval it names was granted on a card without the deposit's amount, wallet, destination and fee, so it cannot authorize a transfer. ${NOTHING}` };
  }
  if (bound.resource.table !== VEX_INFERENCE_DEPOSIT_RESOURCE || bound.resource.intentId !== intent.intentId) {
    return { ok: false, reason: `the approval it names was granted for a different prepared deposit. ${NOTHING}` };
  }
  const expected = depositApprovalBinding(intent);
  if (bound.proposalDigestVersion !== expected.proposalDigestVersion || bound.proposalDigest !== expected.proposalDigest) {
    return { ok: false, reason: `the approved card is not the card this deposit renders. ${NOTHING}` };
  }
  const card = await approvalIntentsRepo.getByApprovalId(approvalId);
  if (card === null) return { ok: false, reason: `the approval it names has no recorded card, so what the user read cannot be checked. ${NOTHING}` };
  const expectedCard = buildDurableApprovalCard(VEX_INFERENCE_DEPOSIT_CONFIRM_TOOL, {
    preview: expected.preview,
    intentExpiresAt: expected.intentExpiresAt,
    resource: { intentId: intent.intentId },
  });
  if (!durableApprovalCardMatches(expectedCard, card.previewJson)) {
    return { ok: false, reason: `the card stored for this approval is not the card this deposit renders. ${NOTHING}` };
  }
  return { ok: true };
}

/**
 * A rejected, expired or policy-blocked approval RETIRES the deposit intent it
 * was bound to, so the transfer the user turned down can never be signed by a
 * later call. Called by every rejection path after its decision committed.
 * No-op for any approval not bound to a Vex Inference deposit. Never throws:
 * retirement is an in-memory delete, and an unmounted host has no intents.
 */
export function retireDepositIntentOfRejectedApproval(sessionId: string, toolCall: Record<string, unknown>): void {
  const bound = readApprovalProposalBinding(toolCall);
  if (bound === null || bound.resource.table !== VEX_INFERENCE_DEPOSIT_RESOURCE) return;
  retireDepositIntent(sessionId, bound.resource.intentId);
}

/** Retire one intent by id (the enqueue auto-reject path holds the binding, not the stored envelope). */
export function retireDepositIntent(sessionId: string, intentId: string): void {
  const host = getVexInferenceHost();
  if (host === null) return;
  try {
    host.retireAgentDeposit(sessionId, intentId);
    logger.info("tools.vex_inference.deposit_intent_retired", { reason: "approval_rejected" });
  } catch (cause) {
    logger.warn("tools.vex_inference.deposit_intent_retire_failed", { type: cause instanceof Error ? cause.name : typeof cause });
  }
}
