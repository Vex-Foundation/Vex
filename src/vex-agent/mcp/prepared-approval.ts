import * as intents from "../db/repos/lighter-order-execution-intents.js";
import * as previews from "../db/repos/lighter-order-previews.js";
import { buildCreateApprovalFollowUp } from "../tools/protocols/lighter/handlers/write.js";
import { resolveInjectedProtocolTool } from "../tools/registry/injected-protocol-tools.js";
import { validatePreparedActionFollowUp, type ValidatedPreparedActionFollowUp } from "../tools/registry/prepared-action-follow-ups.js";
import type { StudioToolCall } from "./admission.js";

/** Rebuild the order card from session-owned durable data, including on resume. */
export async function readStudioPreparedApproval(
  sessionId: string,
  call: StudioToolCall,
): Promise<ValidatedPreparedActionFollowUp | undefined> {
  if (resolveInjectedProtocolTool(call.name)?.toolId !== "lighter.order.create") return undefined;
  if (Object.keys(call.args).join(",") !== "intentId" || typeof call.args.intentId !== "string") {
    throw new Error("The prepared Lighter order must identify one exact intent.");
  }
  const intent = await intents.findByIntentId(sessionId, call.args.intentId);
  if (!intent || intent.executionState !== "approval_pending" || intent.approvalStatus !== "approval_pending"
    || !Number.isFinite(Date.parse(intent.expiresAt)) || Date.parse(intent.expiresAt) <= Date.now()) {
    throw new Error("The prepared Lighter order is missing, expired, or no longer awaiting approval. Prepare a fresh order.");
  }
  const preview = await previews.findById(sessionId, intent.environment, intent.previewId);
  if (!preview) throw new Error("The saved Lighter order preview is unavailable. Prepare a fresh order.");
  const validated = validatePreparedActionFollowUp(
    "lighter.order.create.prepare", buildCreateApprovalFollowUp(intent, preview),
  );
  if (!validated.ok) throw new Error("The saved Lighter order cannot produce a valid approval card.");
  return validated.followUp;
}
