import { getAddress } from "viem";

import { getLighterClient } from "@tools/lighter/client.js";
import { readLighterApiKeySlotObservation } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { readUniqueLighterCoreMasterAccount } from "@tools/lighter/wallet-funding/account-ownership.js";
import { LIGHTER_DEPOSIT_CHAIN_ID } from "@tools/lighter/wallet-funding/constants.js";
import { buildLighterKeyRegistrationApprovalDisclosure } from "@tools/lighter/wallet-funding/key-registration-approval-disclosure.js";
import { LIGHTER_KEY_REGISTRATION_RELEASE_GATE } from "@tools/lighter/wallet-funding/release-gates.js";
import * as keyIntentsRepo from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import { isLighterIntegrationEnabled } from "@vex-agent/db/repos/lighter-integration-settings.js";
import {
  getLighterOnboardingWorkflow,
  transitionLighterOnboardingWorkflowWith,
  type LighterOnboardingWorkflowRow,
} from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import type { ProtocolHandler } from "../../types.js";
import { assertLighterKeyRegistrationApprovalBinding } from "../key-registration-approval-binding.js";
import { getConfiguredLighterKeyRegistrationExecutor } from "../key-registration-execution.js";
import { getConfiguredLighterKeyRegistrationCredentialPreparer } from "../key-registration-preparation.js";
import { readEnvironment } from "../params.js";

const INTENT_TTL_MS = 15 * 60 * 1_000;

async function resolveOrAdoptExistingAccount(
  sessionId: string,
  walletAddress: string,
): Promise<LighterOnboardingWorkflowRow | null> {
  let workflow = await getLighterOnboardingWorkflow("core", walletAddress);
  if (workflow?.workflowState !== "integration_enabled") return workflow;

  const accountIndex = await readUniqueLighterCoreMasterAccount(
    getLighterClient(),
    walletAddress,
  );
  const adopted = await withSessionControlLock(sessionId, (client) =>
    transitionLighterOnboardingWorkflowWith(client, {
      environment: "core",
      walletAddress,
      expectedStates: ["integration_enabled"],
      nextState: "account_resolved",
      resolvedAccountIndex: accountIndex,
    }));
  if (adopted !== null) return adopted;

  workflow = await getLighterOnboardingWorkflow("core", walletAddress);
  if (
    workflow?.workflowState === "account_resolved"
    && workflow.resolvedAccountIndex === accountIndex
  ) {
    return workflow;
  }
  throw new Error("The Lighter onboarding workflow changed while adopting the owned account.");
}

function buildKeyRegistrationApprovalFollowUp(
  intent: keyIntentsRepo.LighterKeyRegistrationReservationRow,
): PreparedActionFollowUp {
  const disclosure = buildLighterKeyRegistrationApprovalDisclosure(intent);
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
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
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.key.register",
      params: { intentId: intent.intentId },
    },
    expiresAt: intent.expiresAt.toISOString(),
    approvalPreview: {
      toolName: "key.register",
      namespace: "lighter",
      criticalArgs,
    },
  };
}

function approvalPreparedPayload(
  intent: keyIntentsRepo.LighterKeyRegistrationReservationRow,
): Record<string, unknown> {
  const disclosure = buildLighterKeyRegistrationApprovalDisclosure(intent);
  return {
    source: "vex_lighter_key_registration_intent",
    status: "approval_prepared",
    message:
      "Lighter key registration prepared; Vex will request approval for this exact account, slot, public key, and nonce.",
    intentId: intent.intentId,
    environment: intent.environment,
    walletAddress: disclosure.walletAddress,
    accountIndex: disclosure.accountIndex,
    apiKeyIndex: disclosure.apiKeyIndex,
    registrationNonce: disclosure.registrationNonce,
    publicKeyFingerprint: disclosure.publicKeyFingerprint,
    publicKeyFingerprintDisplay: disclosure.publicKeyFingerprintDisplay,
    summary: disclosure.summary,
    authorityNote: disclosure.authorityNote,
    signatureNote: disclosure.signatureNote,
    scopeNote: disclosure.scopeNote,
    expiresAt: intent.expiresAt.toISOString(),
    approvalUi: {
      surface: "approval_card",
      approveLabel: "Approve key registration",
      rejectLabel: "Reject",
    },
    userGuidance:
      "An approval card is available in the app. Tell the user to verify the wallet, account, API-key index, fingerprint, and authority, then click Approve key registration only if they are correct.",
  };
}

async function resolveOrReserveIntent(input: {
  readonly sessionId: string;
  readonly walletAddress: string;
  readonly accountIndex: number;
}): Promise<keyIntentsRepo.LighterKeyRegistrationReservationRow> {
  const existing = await keyIntentsRepo.findLiveLighterKeyRegistrationIntentForAccount(
    "core",
    input.accountIndex,
  );
  if (existing !== null) return existing;

  const observation = await readLighterApiKeySlotObservation({
    client: getLighterClient(),
    environment: "core",
    accountIndex: input.accountIndex,
  });
  const reservation = await withSessionControlLock(input.sessionId, (client) =>
    keyIntentsRepo.reserveLighterApiKeySlotWith(client, {
      sessionId: input.sessionId,
      environment: "core",
      walletAddress: input.walletAddress,
      chainId: LIGHTER_DEPOSIT_CHAIN_ID,
      accountIndex: input.accountIndex,
      observation,
      expiresAt: new Date(Date.now() + INTENT_TTL_MS),
    }));
  return reservation.reservation;
}

async function prepareApprovalPendingIntent(
  intent: keyIntentsRepo.LighterKeyRegistrationReservationRow,
  sessionId: string,
): Promise<keyIntentsRepo.LighterKeyRegistrationReservationRow> {
  if (intent.sessionId !== sessionId) {
    throw new Error(
      `Lighter key-registration intent ${intent.intentId} belongs to another session and cannot be reused.`,
    );
  }
  let current = intent;
  if (current.executionState === "slot_reserved") {
    const preparer = getConfiguredLighterKeyRegistrationCredentialPreparer();
    if (preparer === null) {
      throw new Error(
        "The privileged Lighter key-registration credential preparer is unavailable. No key was generated.",
      );
    }
    const prepared = await preparer.prepare({ sessionId, intentId: current.intentId });
    current = await keyIntentsRepo.findLighterKeyRegistrationIntent(current.intentId)
      ?? (() => { throw new Error("Encrypted Lighter key metadata was not durably readable."); })();
    if (
      prepared.intentId !== current.intentId
      || prepared.environment !== current.environment
      || prepared.accountIndex !== current.accountIndex
      || prepared.apiKeyIndex !== current.apiKeyIndex
      || prepared.vaultCredentialId !== current.vaultCredentialId
      || prepared.publicKey !== current.publicKey
      || prepared.publicKeyFingerprint !== current.publicKeyFingerprint
    ) {
      throw new Error("Privileged Lighter key preparation did not match durable public metadata.");
    }
  }
  if (current.executionState === "key_generated_encrypted") {
    const observedAt = new Date();
    const nonce = await getLighterClient().getNextNonce("core", {
      accountIndex: current.accountIndex,
      apiKeyIndex: current.apiKeyIndex,
    });
    if (
      nonce.code !== 200
      || !Number.isSafeInteger(nonce.nonce)
      || nonce.nonce < 0
      || nonce.nonce > Number((1n << 48n) - 1n)
    ) {
      throw new Error(
        "Lighter did not return a valid public next nonce for the reserved API-key slot.",
      );
    }
    const approvalPending = await withSessionControlLock(sessionId, (client) =>
      keyIntentsRepo.markLighterKeyRegistrationApprovalPendingWith(client, {
        intentId: current.intentId,
        sessionId,
        registrationNonce: String(nonce.nonce),
        observedAt,
      }));
    if (approvalPending === null) {
      throw new Error("Lighter key registration lost its approval-preparation lifecycle transition.");
    }
    current = approvalPending;
  }
  if (current.executionState !== "approval_pending") {
    throw new Error(
      `Lighter key-registration intent ${current.intentId} is already in ${current.executionState}.`,
    );
  }
  return current;
}

export const LIGHTER_KEY_REGISTRATION_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.key.register.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter key-registration preparation requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    if (environment.value !== "core") {
      return fail("Lighter wallet-funded key registration is available on Core only in this release.");
    }
    let walletAddress: string;
    try {
      walletAddress = getAddress(
        resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      );
    } catch (error) {
      return walletScopeErrorToResult(error);
    }
    if (!(await isLighterIntegrationEnabled("core", walletAddress))) {
      return fail(
        "Lighter is not enabled for this Vex wallet. Enable the integration before preparing key registration; enabling it does not register a key.",
      );
    }
    let workflow: LighterOnboardingWorkflowRow | null;
    try {
      workflow = await resolveOrAdoptExistingAccount(sessionId, walletAddress);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (workflow?.resolvedAccountIndex === null || workflow === null) {
      return fail(
        "Lighter key registration requires a Phase 2-resolved account owned by the selected wallet.",
      );
    }
    if (
      workflow.workflowState !== "account_resolved"
      && workflow.workflowState !== "key_generated_encrypted"
      && workflow.workflowState !== "key_registration_approval_pending"
    ) {
      return fail(
        `Lighter onboarding workflow is in ${workflow.workflowState}; key registration cannot be prepared from this state.`,
      );
    }
    if (getConfiguredLighterKeyRegistrationCredentialPreparer() === null) {
      return fail(
        "The privileged Lighter key-registration credential preparer is unavailable. No slot was reserved and no key was generated.",
      );
    }
    try {
      const reserved = await resolveOrReserveIntent({
        sessionId,
        walletAddress,
        accountIndex: workflow.resolvedAccountIndex,
      });
      if (reserved.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return fail("The durable key-registration reservation belongs to a different wallet.");
      }
      const approvalPending = await prepareApprovalPendingIntent(reserved, sessionId);
      return {
        ...ok(approvalPreparedPayload(approvalPending)),
        preparedActionFollowUp: buildKeyRegistrationApprovalFollowUp(approvalPending),
      };
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },

  "lighter.key.register": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter key registration requires a host session id.");
    const intentId = params.intentId;
    if (typeof intentId !== "string" || intentId.trim().length === 0) {
      return fail("Missing required: intentId.");
    }
    if (!context.approved || !context.approvalId) {
      return {
        success: false,
        output:
          "Lighter key registration requires an approved Vex approval card for a prepared registration intent.",
        pendingApproval: true,
      };
    }
    const intent = await keyIntentsRepo.findLighterKeyRegistrationIntent(intentId.trim());
    if (intent === null || intent.sessionId !== sessionId) {
      return fail(`No Lighter key-registration intent ${intentId} exists in this session.`);
    }
    if (!(await isLighterIntegrationEnabled(intent.environment, intent.walletAddress))) {
      return fail(
        "Lighter was disabled for this wallet before key registration. Nothing was signed or submitted.",
      );
    }
    if (
      (intent.executionState === "approval_pending" || intent.executionState === "approved")
      && intent.expiresAt.getTime() <= Date.now()
    ) {
      return fail(`Lighter key-registration intent ${intent.intentId} expired before approval resume.`);
    }
    try {
      await assertLighterKeyRegistrationApprovalBinding({
        approvalId: context.approvalId,
        sessionId,
        intent,
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const approved = intent.executionState === "approval_pending"
      ? await withSessionControlLock(sessionId, (client) =>
        keyIntentsRepo.markLighterKeyRegistrationApprovedWith(client, {
          intentId: intent.intentId,
          sessionId,
          approvalId: context.approvalId!,
        }))
      : intent.approvalStatus === "approved" ? intent : null;
    if (approved === null) {
      return fail(`Lighter key-registration intent ${intent.intentId} is not approval-authorized.`);
    }
    if (!LIGHTER_KEY_REGISTRATION_RELEASE_GATE.isEnabled()) {
      return ok({
        source: "vex_lighter_key_registration",
        status: "approval_recorded_gate_closed",
        intentId: approved.intentId,
        executionState: approved.executionState,
        message:
          "Lighter key-registration approval was recorded, but the independent release gate is closed. Nothing was signed or submitted.",
      });
    }
    const executor = getConfiguredLighterKeyRegistrationExecutor();
    if (executor === null) {
      return ok({
        source: "vex_lighter_key_registration",
        status: "approval_recorded_execution_closed",
        intentId: approved.intentId,
        executionState: approved.executionState,
        message:
          "Lighter key-registration approval was recorded, but the privileged execution boundary is unavailable. Nothing was signed or submitted.",
      });
    }
    try {
      return ok(await executor.execute({
        sessionId,
        intentId: approved.intentId,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        abortSignal: context.abortSignal,
      }));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
