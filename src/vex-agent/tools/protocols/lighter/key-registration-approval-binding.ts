import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import * as feeIntentsRepo from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import * as approvalIntentsRepo from "@vex-agent/db/repos/approval-intents.js";
import * as approvalsRepo from "@vex-agent/db/repos/approvals.js";
import { buildLighterKeyRegistrationApprovalDisclosure } from "@tools/lighter/wallet-funding/key-registration-approval-disclosure.js";
import {
  buildLighterFeeAuthorizationDisclosure,
  prefixLighterFeeDisclosureForBundle,
} from "./fee-authorization-disclosure.js";
import type { ApprovalPreviewScalar } from "../../types.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

const REFUSAL =
  "Approved Lighter key registration refused because the approval record does not match the prepared intent. Nothing was signed or submitted.";

/**
 * The exact criticalArgs a key-registration card discloses - alone, or with
 * VEX's fixed trading fee bundled onto the SAME card so one approval covers
 * both. Used to BUILD the card (`handlers/key-registration.ts`) and to VERIFY
 * it here, so the two can never drift apart. `bundledFeeIntent` is `null` for
 * the plain key-only card (unchanged shape, unchanged 16 keys) and non-null
 * for the combined one, where every fee field rides under its `fee`-prefixed
 * name (see `prefixLighterFeeDisclosureForBundle` for why).
 */
export function buildLighterKeyRegistrationCriticalArgs(
  intent: LighterKeyRegistrationReservationRow,
  bundledFeeIntent: LighterFeeAuthorizationIntentRow | null,
): Record<string, ApprovalPreviewScalar> {
  const disclosure = buildLighterKeyRegistrationApprovalDisclosure(intent);
  const keyArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.key.register",
    intentId: intent.intentId,
    environment: intent.environment,
    walletAddress: disclosure.walletAddress,
    ethereumChainId: disclosure.ethereumChainId,
    lighterChainId: disclosure.lighterChainId,
    accountIndex: disclosure.accountIndex,
    apiKeyIndex: disclosure.apiKeyIndex,
    registrationNonce: disclosure.registrationNonce,
    publicKey: disclosure.publicKey,
    publicKeyFingerprint: disclosure.publicKeyFingerprint,
    vaultCredentialId: disclosure.vaultCredentialId,
    summary: disclosure.summary,
    authorityNote: disclosure.authorityNote,
    signatureNote: disclosure.signatureNote,
    scopeNote: disclosure.scopeNote,
  };
  if (bundledFeeIntent === null) return keyArgs;
  return {
    ...keyArgs,
    ...prefixLighterFeeDisclosureForBundle(buildLighterFeeAuthorizationDisclosure(bundledFeeIntent)),
  };
}

/**
 * Verify the approved card matches the prepared key-registration intent -
 * and, if the approved card's own criticalArgs carry a `feeIntentId`, that it
 * ALSO matches a real, session-owned fee-authorization intent exactly as
 * disclosed. Returns that fee intent so the caller can execute it right after
 * key registration succeeds, or `null` for a plain key-only card. A lookup
 * failure anywhere in this chain refuses; it never falls back to the
 * key-only shape; a card either matches exactly or nothing is signed.
 */
export async function assertLighterKeyRegistrationApprovalBinding(input: {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly intent: LighterKeyRegistrationReservationRow;
}): Promise<LighterFeeAuthorizationIntentRow | null> {
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
  ) {
    throw refusal();
  }
  const previewJson = auditIntent.previewJson;
  if (previewJson.toolName !== "key.register" || previewJson.namespace !== "lighter") {
    throw refusal();
  }
  const criticalArgs = readRecord(previewJson.criticalArgs);
  if (criticalArgs === null) throw refusal();

  const feeIntentIdRaw = criticalArgs.feeIntentId;
  let bundledFeeIntent: LighterFeeAuthorizationIntentRow | null = null;
  if (feeIntentIdRaw !== undefined) {
    if (typeof feeIntentIdRaw !== "string" || feeIntentIdRaw.trim().length === 0) throw refusal();
    bundledFeeIntent = await feeIntentsRepo.findLighterFeeAuthorizationIntent(feeIntentIdRaw);
    if (bundledFeeIntent === null || bundledFeeIntent.sessionId !== input.sessionId) throw refusal();
  }

  let expected: Record<string, ApprovalPreviewScalar>;
  try {
    expected = buildLighterKeyRegistrationCriticalArgs(input.intent, bundledFeeIntent);
  } catch {
    throw refusal();
  }
  if (Object.keys(criticalArgs).sort().join(",") !== Object.keys(expected).sort().join(",")) {
    throw refusal();
  }
  for (const [key, value] of Object.entries(expected)) {
    if (criticalArgs[key] !== value) throw refusal();
  }
  return bundledFeeIntent;
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
