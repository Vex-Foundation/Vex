import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import { buildLighterKeyRegistrationApprovalDisclosure } from "@tools/lighter/wallet-funding/key-registration-approval-disclosure.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

export const LIGHTER_KEY_REGISTRATION_CRITICAL_ARG_KEYS = [
  "toolId",
  "intentId",
  "environment",
  "walletAddress",
  "ethereumChainId",
  "lighterChainId",
  "accountIndex",
  "apiKeyIndex",
  "registrationNonce",
  "publicKey",
  "publicKeyFingerprint",
  "vaultCredentialId",
  "summary",
  "authorityNote",
  "signatureNote",
  "scopeNote",
] as const;

const REFUSAL =
  "Approved Lighter key registration refused because the approval record does not match the prepared intent. Nothing was signed or submitted.";

export async function assertLighterKeyRegistrationApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterKeyRegistrationReservationRow;
}): Promise<void> {
  const approval = await approvalsRepo.getByIdForSession(input.approvalId, input.sessionId);
  if (
    approval === null
    || approval.status !== "approved"
    || !toolCallTargetsIntent(approval.toolCall, input.intent.intentId)
  ) {
    throw refusal();
  }
  const auditIntent = await approvalIntentsRepo.getByApprovalId(input.approvalId);
  if (
    auditIntent === null
    || auditIntent.sessionId !== input.sessionId
    || auditIntent.decision !== "approved"
    || auditIntent.actionKind !== "user_wallet_broadcast"
    || auditIntent.executionStatus !== "dispatching"
    || !approvalPreviewMatchesIntent(auditIntent.previewJson, input.intent)
  ) {
    throw refusal();
  }
}

function toolCallTargetsIntent(toolCall: Record<string, unknown>, intentId: string): boolean {
  const command = toolCall.command ?? toolCall.name;
  if (command !== "execute_tool") return false;
  const args = readRecord(toolCall.args ?? toolCall.arguments);
  if (args === null || args.toolId !== "lighter.key.register") return false;
  const params = readRecord(args.params);
  return params !== null
    && Object.keys(params).join(",") === "intentId"
    && params.intentId === intentId;
}

function approvalPreviewMatchesIntent(
  previewJson: Record<string, unknown>,
  intent: LighterKeyRegistrationReservationRow,
): boolean {
  if (previewJson.toolName !== "key.register" || previewJson.namespace !== "lighter") {
    return false;
  }
  const criticalArgs = readRecord(previewJson.criticalArgs);
  if (
    criticalArgs === null
    || Object.keys(criticalArgs).sort().join(",")
      !== [...LIGHTER_KEY_REGISTRATION_CRITICAL_ARG_KEYS].sort().join(",")
  ) {
    return false;
  }
  let disclosure;
  try {
    disclosure = buildLighterKeyRegistrationApprovalDisclosure(intent);
  } catch {
    return false;
  }
  return criticalArgs.toolId === "lighter.key.register"
    && criticalArgs.intentId === intent.intentId
    && criticalArgs.environment === intent.environment
    && criticalArgs.walletAddress === disclosure.walletAddress
    && criticalArgs.ethereumChainId === disclosure.ethereumChainId
    && criticalArgs.lighterChainId === disclosure.lighterChainId
    && criticalArgs.accountIndex === disclosure.accountIndex
    && criticalArgs.apiKeyIndex === disclosure.apiKeyIndex
    && criticalArgs.registrationNonce === disclosure.registrationNonce
    && criticalArgs.publicKey === disclosure.publicKey
    && criticalArgs.publicKeyFingerprint === disclosure.publicKeyFingerprint
    && criticalArgs.vaultCredentialId === disclosure.vaultCredentialId
    && criticalArgs.summary === disclosure.summary
    && criticalArgs.authorityNote === disclosure.authorityNote
    && criticalArgs.signatureNote === disclosure.signatureNote
    && criticalArgs.scopeNote === disclosure.scopeNote;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function refusal(): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    REFUSAL,
    "Open the matching key-registration approval card, or prepare registration again.",
  );
}
