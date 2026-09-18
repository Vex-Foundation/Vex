import { getAddress } from "viem";

import { getLighterClient } from "@tools/lighter/client.js";
import { getLighterFeePolicy } from "@tools/lighter/fee-policy.js";
import { readLighterApiKeySlotObservation } from "@tools/lighter/wallet-funding/api-key-slots.js";
import { readUniqueLighterMasterAccount } from "@tools/lighter/wallet-funding/account-ownership.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import { buildLighterKeyRegistrationApprovalDisclosure } from "@tools/lighter/wallet-funding/key-registration-approval-disclosure.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import * as keyIntentsRepo from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import type { LighterFeeAuthorizationIntentRow } from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import * as feeIntentsRepo from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import {
  isLighterIntegrationEnabled,
  setLighterIntegrationEnabled,
} from "@vex-agent/db/repos/lighter-integration-settings.js";
import {
  getLighterOnboardingWorkflow,
  transitionLighterOnboardingWorkflowWith,
  type LighterOnboardingWorkflowRow,
} from "@vex-agent/db/repos/lighter-onboarding-workflows.js";
import {
  withSessionControlLock,
  withSessionControlLocks,
} from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { PreparedActionFollowUp } from "../../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../../types.js";
import {
  assertLighterKeyRegistrationApprovalBinding,
  buildLighterKeyRegistrationCriticalArgs,
} from "../key-registration-approval-binding.js";
import { getConfiguredLighterKeyRegistrationExecutor } from "../key-registration-execution.js";
import { getConfiguredLighterKeyRegistrationCredentialPreparer } from "../key-registration-preparation.js";
import { getConfiguredLighterFeeAuthorizationService } from "../fee-authorization-execution.js";
import { readEnvironment } from "../params.js";

/**
 * VEX's fee is fixed (0.1% perps / 0.25% spot, a 10-year authorization) and
 * never re-priced per install, so there is nothing to re-approve later: fold
 * it into the SAME key-registration card instead of a second one. Returns
 * `null` whenever there is nothing to bundle right now - fees already
 * active, the environment carries no fee policy, the service is unavailable,
 * or the account is in a state `fees.approve.prepare` itself would refuse
 * (e.g. mid tier-change dispute). Every one of those is exactly today's
 * key-only card, unchanged, with the existing `nextToolId` handoff after
 * registration as the fallback path.
 */
async function resolveBundledFeeIntent(input: {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly context: ProtocolExecutionContext;
}): Promise<LighterFeeAuthorizationIntentRow | null> {
  if (getLighterFeePolicy(input.environment) === null) return null;
  const service = getConfiguredLighterFeeAuthorizationService();
  if (service === null) return null;
  const setup = {
    sessionId: input.sessionId,
    environment: input.environment,
    walletResolution: input.context.walletResolution,
    walletPolicy: input.context.walletPolicy,
  };
  try {
    const readiness = await service.inspect(setup);
    if (readiness.status !== "needs_approval") return null;
    const intent = await service.prepare({ ...setup, revoke: false });
    return intent.executionState === "approval_pending" ? intent : null;
  } catch {
    // Fee bundling is a bonus on top of key registration, never a blocker for
    // it. Anything wrong here surfaces later through the existing
    // fees.approve.prepare fallback instead of failing registration itself.
    return null;
  }
}

const INTENT_TTL_MS = 15 * 60 * 1_000;

async function resolveOrAdoptExistingAccount(
  sessionId: string,
  environment: LighterEnvironment,
  walletAddress: string,
): Promise<LighterOnboardingWorkflowRow | null> {
  let workflow = await getLighterOnboardingWorkflow(environment, walletAddress);
  if (workflow?.workflowState !== "integration_enabled") return workflow;

  const accountIndex = await readUniqueLighterMasterAccount(
    getLighterClient(),
    environment,
    walletAddress,
  );
  const adopted = await withSessionControlLock(sessionId, (client) =>
    transitionLighterOnboardingWorkflowWith(client, {
      environment,
      walletAddress,
      expectedStates: ["integration_enabled"],
      nextState: "account_resolved",
      resolvedAccountIndex: accountIndex,
    }));
  if (adopted !== null) return adopted;

  workflow = await getLighterOnboardingWorkflow(environment, walletAddress);
  if (
    workflow?.workflowState === "account_resolved"
    && workflow.resolvedAccountIndex === accountIndex
  ) {
    return workflow;
  }
  throw new Error("The Lighter onboarding workflow changed while adopting the owned account.");
}

export function buildKeyRegistrationApprovalFollowUp(
  intent: keyIntentsRepo.LighterKeyRegistrationReservationRow,
  bundledFeeIntent: LighterFeeAuthorizationIntentRow | null = null,
): PreparedActionFollowUp {
  const criticalArgs = buildLighterKeyRegistrationCriticalArgs(intent, bundledFeeIntent);
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
  reissued = false,
  feeBundled = false,
): Record<string, unknown> {
  const disclosure = buildLighterKeyRegistrationApprovalDisclosure(intent);
  return {
    source: "vex_lighter_key_registration_intent",
    status: reissued ? "approval_reissued" : "approval_prepared",
    message: reissued
      ? "The unchanged Lighter key registration is safe to retry; Vex will request a fresh approval for the exact same account, slot, public key, and nonce."
      : feeBundled
        ? "Lighter key registration prepared; Vex will request one approval covering this exact account, slot, public key, nonce, and VEX's fixed trading fee (0.1% perps / 0.25% spot, authorized once for as long as the key is active)."
        : "Lighter key registration prepared; Vex will request approval for this exact account, slot, public key, and nonce.",
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
      approveLabel: feeBundled ? "Approve key registration and fees" : "Approve key registration",
      rejectLabel: "Reject",
    },
    userGuidance: feeBundled
      ? "Vex prepared the remaining secure trading setup, bundled with VEX's one-time fixed fee authorization, and an approval card is available in the app. Tell the user this single approval covers both. Do not ask them for or require them to validate account indexes, API-key indexes, nonces, fingerprints, or key material unless they explicitly request technical details."
      : "Vex prepared the remaining secure trading setup and an approval card is available in the app. Tell the user to review and approve that setup if they want to continue. Do not ask them for or require them to validate account indexes, API-key indexes, nonces, fingerprints, or key material unless they explicitly request technical details.",
  };
}

async function resolveOrReserveIntent(input: {
  readonly sessionId: string;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number;
}): Promise<keyIntentsRepo.LighterKeyRegistrationReservationRow> {
  const existing = await keyIntentsRepo.findLiveLighterKeyRegistrationIntentForAccount(
    input.environment,
    input.accountIndex,
  );
  if (existing !== null) return existing;

  const observation = await readLighterApiKeySlotObservation({
    client: getLighterClient(),
    environment: input.environment,
    accountIndex: input.accountIndex,
  });
  const reservation = await withSessionControlLock(input.sessionId, (client) =>
    keyIntentsRepo.reserveLighterApiKeySlotWith(client, {
      sessionId: input.sessionId,
      environment: input.environment,
      walletAddress: input.walletAddress,
      chainId: getLighterFundingDeployment(input.environment).settlementChainId,
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
    const nonce = await getLighterClient().getNextNonce(current.environment, {
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
  if (isPristineApprovedIntent(current)) {
    const renewed = await withSessionControlLock(sessionId, (client) =>
      keyIntentsRepo.renewPristineApprovedLighterKeyRegistrationIntentWith(client, {
        intentId: current.intentId,
        sessionId,
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      }));
    if (renewed === null) {
      throw new Error(
        "Lighter key registration could not renew the pristine approved intent for retry.",
      );
    }
    current = renewed;
  }
  if (
    current.executionState !== "approval_pending"
    && !isPristineApprovedIntent(current)
  ) {
    throw new Error(
      `Lighter key-registration intent ${current.intentId} is already in ${current.executionState}.`,
    );
  }
  return current;
}

function isPristineApprovedIntent(
  intent: keyIntentsRepo.LighterKeyRegistrationReservationRow,
): boolean {
  return intent.executionState === "approved"
    && intent.approvalStatus === "approved"
    && intent.registrationTxType === null
    && intent.registrationTxHash === null
    && intent.registrationTxExpiredAt === null
    && intent.registrationTxStagedAt === null
    && intent.registrationSubmittedTxHash === null
    && intent.registrationSubmitCode === null
    && intent.registrationPredictedExecutionTimeMs === null
    && intent.registrationSubmitAcceptedAt === null
    && intent.registrationAmbiguityReason === null
    && intent.registrationKeyVerifiedAt === null
    && intent.registrationClientCheckedAt === null
    && intent.postRegistrationNonce === null
    && intent.registrationNonceSynchronizedAt === null
    && intent.registrationActivatedAt === null;
}

export const LIGHTER_KEY_REGISTRATION_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.key.register.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter key-registration preparation requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    let walletAddress: string;
    try {
      walletAddress = getAddress(
        resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      );
    } catch (error) {
      return walletScopeErrorToResult(error);
    }
    if (!(await isLighterIntegrationEnabled(environment.value, walletAddress))) {
      try {
        await setLighterIntegrationEnabled({
          environment: environment.value,
          walletAddress,
          enabled: true,
        });
      } catch (error) {
        return fail(
          `Vex could not start managed Lighter setup for the selected wallet: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let workflow: LighterOnboardingWorkflowRow | null;
    try {
      workflow = await resolveOrAdoptExistingAccount(
        sessionId,
        environment.value,
        walletAddress,
      );
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
      let reserved = await resolveOrReserveIntent({
        sessionId,
        environment: environment.value,
        walletAddress,
        accountIndex: workflow.resolvedAccountIndex,
      });
      if (reserved.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        return fail("The durable key-registration reservation belongs to a different wallet.");
      }
      if (reserved.sessionId !== sessionId) {
        const adopted = await withSessionControlLocks(
          [reserved.sessionId, sessionId],
          (client) => keyIntentsRepo.adoptPristineLighterKeyRegistrationApprovalWith(client, {
            intentId: reserved.intentId,
            previousSessionId: reserved.sessionId,
            sessionId,
            environment: reserved.environment,
            walletAddress: reserved.walletAddress,
            accountIndex: reserved.accountIndex,
            expiresAt: new Date(Date.now() + INTENT_TTL_MS),
          }),
        );
        if (adopted === null) {
          return fail(
            `Lighter key-registration intent ${reserved.intentId} belongs to another session and cannot be safely resumed.`,
          );
        }
        reserved = adopted;
      }
      const reissuingApproval = isPristineApprovedIntent(reserved);
      const approvalPending = await prepareApprovalPendingIntent(reserved, sessionId);
      const bundledFeeIntent = await resolveBundledFeeIntent({
        sessionId,
        environment: environment.value,
        context,
      });
      return {
        ...ok(approvalPreparedPayload(approvalPending, reissuingApproval, bundledFeeIntent !== null)),
        preparedActionFollowUp: buildKeyRegistrationApprovalFollowUp(approvalPending, bundledFeeIntent),
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
    let bundledFeeIntent: LighterFeeAuthorizationIntentRow | null;
    try {
      bundledFeeIntent = await assertLighterKeyRegistrationApprovalBinding({
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
    // Mark the bundled fee intent approved NOW, under the same card, rather
    // than after key registration executes: that execution can take real
    // wall-clock time (signing, submission, chain confirmation), and the fee
    // intent's own approval-pending TTL should not be spent waiting on it.
    let approvedFeeIntent: LighterFeeAuthorizationIntentRow | null = null;
    if (bundledFeeIntent !== null) {
      approvedFeeIntent = await withSessionControlLock(sessionId, (client) =>
        feeIntentsRepo.markLighterFeeAuthorizationDecisionWith(client, {
          intentId: bundledFeeIntent.intentId,
          sessionId,
          approvalId: context.approvalId!,
          status: "approved",
        }));
      // A lost race or an intent that moved out of approval_pending some other
      // way is not this call's problem to solve: registration proceeds either
      // way, and fees.approve.prepare remains the recovery path.
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
      const result = await executor.execute({
        sessionId,
        intentId: approved.intentId,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
        abortSignal: context.abortSignal,
      });
      if (result.status !== "active") return ok(result);
      if (approvedFeeIntent !== null) {
        const feeService = getConfiguredLighterFeeAuthorizationService();
        if (feeService !== null) {
          try {
            const feeResult = await feeService.execute({
              sessionId,
              intentId: approvedFeeIntent.intentId,
              walletResolution: context.walletResolution,
              walletPolicy: context.walletPolicy,
              abortSignal: context.abortSignal,
            });
            return ok({
              ...result,
              feeAuthorization: feeResult,
              message: feeResult.status === "active"
                ? "The local trading key is active and VEX's fixed trading fee (0.1% maker/taker perps, 0.25% maker/taker spot) is authorized for as long as this key stays active. No further fee approval is needed."
                : `The local trading key is active. ${feeResult.message}`,
            });
          } catch (error) {
            return ok({
              ...result,
              message: "The local trading key is active. VEX's bundled fee authorization hit an error and needs attention; check lighter.fees.status.",
              feeAuthorizationError: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      return ok(getLighterFeePolicy(approved.environment) !== null
        ? { ...result,
            message: "The local trading key is active. Continue Lighter fee authorization before preparing a new fee-bearing trade.",
            nextToolId: "lighter.fees.approve.prepare",
            nextParams: { environment: approved.environment },
            userGuidance: "Prepare the VEX fee approval now in this chat. The host card is consent; do not ask for another chat confirmation or account details.",
          }
        : result);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
