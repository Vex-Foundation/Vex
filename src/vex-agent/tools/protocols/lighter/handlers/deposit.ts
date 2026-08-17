import { getAddress, type Hex } from "viem";

import * as onboardingIntentsRepo from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import {
  resolveSelectedAddress,
  resolveSigningWallet,
  walletScopeErrorToResult,
} from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ChainWallet } from "@tools/wallet/multi-auth.js";
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_DEPOSIT_CHAIN_ID,
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_DEPOSIT_ROUTE_TYPE,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "@tools/lighter/wallet-funding/constants.js";
import { buildLighterDepositApprovalDisclosure } from "@tools/lighter/wallet-funding/deposit-approval-disclosure.js";
import { decimalToBaseUnits } from "@tools/lighter/wallet-funding/onboarding-plan.js";
import { buildLighterDepositExecutionDeps } from "@tools/lighter/wallet-funding/deposit-execution-deps.js";
import {
  executeApprovedLighterDeposit,
  type LighterDepositExecutionResult,
} from "@tools/lighter/wallet-funding/deposit-execution.js";
import { LIGHTER_DEPOSIT_RELEASE_GATE } from "@tools/lighter/wallet-funding/release-gates.js";
import { acquireLighterDepositExecutionLease } from "@tools/lighter/wallet-funding/execution-lease.js";
import { assertLighterDepositApprovalBinding } from "../deposit-approval-binding.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import logger from "@utils/logger.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { readEnvironment } from "../params.js";

const MIN_DEPOSIT_UNITS = decimalToBaseUnits(LIGHTER_DEPOSIT_MIN_USDC, LIGHTER_SETTLEMENT_ASSET_DECIMALS);
const INTENT_TTL_MS = 15 * 60 * 1000;

function buildDepositApprovalFollowUp(intent: LighterOnboardingIntentRow): PreparedActionFollowUp {
  const disclosure = buildLighterDepositApprovalDisclosure(intent);
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.deposit",
    intentId: intent.intentId,
    environment: intent.environment,
    walletAddress: intent.walletAddress,
    depositTo: intent.depositTo ?? "",
    depositContract: intent.depositContract ?? "",
    chainId: intent.chainId,
    assetIndex: intent.assetIndex ?? -1,
    routeType: intent.routeType ?? -1,
    amountUnits: intent.amountUnits ?? "",
    amountDisplay: disclosure.amountDisplay,
    summary: disclosure.summary,
    scopeNote: disclosure.scopeNote,
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.deposit", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt.toISOString(),
    approvalPreview: { toolName: "deposit", namespace: "lighter", criticalArgs },
  };
}

function depositApprovalPreparedPayload(intent: LighterOnboardingIntentRow): Record<string, unknown> {
  const disclosure = buildLighterDepositApprovalDisclosure(intent);
  return {
    source: "vex_lighter_onboarding_deposit_intent",
    status: "approval_prepared",
    message: "Lighter deposit prepared; Vex will request approval for this exact deposit.",
    intentId: intent.intentId,
    environment: intent.environment,
    amountDisplay: disclosure.amountDisplay,
    creditAddress: disclosure.creditAddress,
    summary: disclosure.summary,
    scopeNote: disclosure.scopeNote,
    createsAccountNote: disclosure.createsAccountNote,
    gasNote: disclosure.gasNote,
    approvalUi: {
      surface: "approval_card",
      approveLabel: "Approve and deposit",
      rejectLabel: "Reject",
    },
    userGuidance:
      "An approval card is now available in the app. Tell the user to review the deposit details and click Approve and deposit only if they are correct; do not ask them to type another approval command.",
  };
}

function depositUserGuidance(execution: LighterDepositExecutionResult): string {
  switch (execution.status) {
    case "gate_closed":
      return "The deposit approval was recorded, but live deposits are blocked by the default-closed deposit release gate. Tell the user nothing was signed or submitted.";
    case "credited":
      return execution.resolvedAccountIndex === null
        ? "The deposit transaction is confirmed on-chain; Lighter credits the account asynchronously, so the account index is not resolved yet. Tell the user the deposit is on-chain and the Lighter account will appear shortly; offer to re-check onboarding status."
        : `The deposit is confirmed on-chain and credited to Lighter account ${execution.resolvedAccountIndex}. Tell the user their Lighter account is funded.`;
    case "ambiguous":
      return `The ${execution.stage} transaction outcome could not be confirmed. Tell the user the state is uncertain and that it must be reconciled before any retry; do not say it succeeded or failed.`;
    case "failed":
      return `The ${execution.stage} transaction failed, so no funds moved to Lighter. Tell the user the deposit did not go through.`;
  }
}

export const LIGHTER_DEPOSIT_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.deposit.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter deposit preparation requires a host session id.");

    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    if (environment.value !== "core") {
      return fail("Lighter wallet-funded deposit is available on Core only in this release.");
    }

    let walletAddress: string;
    try {
      walletAddress = getAddress(
        resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"),
      );
    } catch (err) {
      return walletScopeErrorToResult(err);
    }

    const amountInRaw = params.amountIn;
    if (typeof amountInRaw !== "string") {
      return fail('amountIn must be a decimal USDC string, for example "11".');
    }
    let amountUnits: bigint;
    try {
      amountUnits = decimalToBaseUnits(amountInRaw, LIGHTER_SETTLEMENT_ASSET_DECIMALS);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (amountUnits < MIN_DEPOSIT_UNITS) {
      return fail(`Lighter deposit must be at least ${LIGHTER_DEPOSIT_MIN_USDC} USDC; a smaller deposit is not credited.`);
    }

    const routeType = LIGHTER_DEPOSIT_ROUTE_TYPE.perps;

    const creation = await withSessionControlLock(sessionId, (client) =>
      onboardingIntentsRepo.createOrFindLiveDepositApprovalPendingWith(client, {
        sessionId,
        environment: "core",
        walletAddress,
        chainId: LIGHTER_DEPOSIT_CHAIN_ID,
        depositContract: getAddress(LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS),
        depositTo: walletAddress,
        assetIndex: LIGHTER_USDC_ASSET_INDEX,
        routeType,
        amountUnits: amountUnits.toString(),
        expiresAt: new Date(Date.now() + INTENT_TTL_MS),
      }),
    );
    if (creation.outcome === "live_conflict") {
      const conflict = creation.intent;
      return fail(
        conflict === null
          ? "Another Lighter deposit preparation won the concurrency race. No second deposit was prepared; check onboarding status before retrying."
          : `Lighter deposit intent ${conflict.intentId} is already unresolved in state ${conflict.executionState}. No second deposit was prepared; resolve or reconcile it before creating another.`,
      );
    }
    const created = creation.intent;

    let followUp: PreparedActionFollowUp;
    try {
      followUp = buildDepositApprovalFollowUp(created);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    return {
      ...ok(depositApprovalPreparedPayload(created)),
      preparedActionFollowUp: followUp,
    };
  },

  "lighter.deposit": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter deposit requires a host session id.");
    const intentId = params.intentId;
    if (typeof intentId !== "string" || intentId.trim().length === 0) {
      return fail("Missing required: intentId.");
    }
    if (!context.approved || !context.approvalId) {
      return {
        success: false,
        output: "Lighter deposit requires an approved Vex approval card for a prepared deposit intent.",
        pendingApproval: true,
      };
    }

    const intent = await onboardingIntentsRepo.findByIntentId(intentId.trim());
    if (!intent || intent.sessionId !== sessionId) {
      return fail(`No Lighter deposit intent ${intentId} found in this session.`);
    }
    if (intent.capability !== "deposit") {
      return fail(`Intent ${intent.intentId} is not a Lighter deposit intent.`);
    }
    try {
      await assertLighterDepositApprovalBinding({ approvalId: context.approvalId, sessionId, intent });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (intent.expiresAt.getTime() <= Date.now()) {
      await onboardingIntentsRepo.markApprovalDecision({
        intentId: intent.intentId,
        decision: "expired",
        approvalId: context.approvalId,
        reason: "approval resume observed an expired Lighter deposit intent",
      });
      return fail(`Lighter deposit intent ${intent.intentId} expired before approval resume.`);
    }

    const approved = await onboardingIntentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "approved",
      approvalId: context.approvalId,
      reason: "user approved exact Lighter deposit intent",
    });
    if (approved === null) {
      return fail(`Lighter deposit intent ${intent.intentId} has already left approval_pending.`);
    }

    // Gate BEFORE any key resolution or signing.
    if (!LIGHTER_DEPOSIT_RELEASE_GATE.isEnabled()) {
      return ok({
        source: "vex_lighter_deposit",
        status: "approval_recorded_gate_closed",
        message:
          "Lighter deposit approval was recorded, but live deposits are blocked by the default-closed deposit release gate. Nothing was signed or submitted.",
        intentId: approved.intentId,
        executionState: approved.executionState,
      });
    }

    const lease = await acquireLighterDepositExecutionLease({
      chainId: approved.chainId,
      walletAddress: approved.walletAddress,
      intentId: approved.intentId,
    }).catch(() => null);
    if (lease === null) {
      return fail(
        "Could not acquire the Lighter wallet execution lease. Nothing was signed; check onboarding status before retrying.",
      );
    }
    if (!lease.acquired) {
      const retryNote = lease.retryAfter === null
        ? "after the active wallet operation is reconciled"
        : `after ${lease.retryAfter.toISOString()}`;
      return fail(
        `Another Lighter operation owns this Ethereum wallet execution slot. Nothing was signed; retry ${retryNote}.`,
      );
    }

    const leaseHandle = lease.handle;
    try {
      await leaseHandle.assertOwned();

      let signer: ChainWallet;
      try {
        signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
      } catch (err) {
        return walletScopeErrorToResult(err);
      }
      if (signer.family !== "eip155") {
        return fail("Resolved wallet family mismatch for Lighter deposit.");
      }
      if (getAddress(signer.address) !== getAddress(approved.walletAddress)) {
        return fail("The resolved signing wallet does not match the prepared deposit wallet. Nothing was signed.");
      }

      const deps = buildLighterDepositExecutionDeps({
        privateKey: signer.privateKey as Hex,
        assertExecutionLease: () => leaseHandle.assertOwned(),
      });
      const execution = await executeApprovedLighterDeposit({ intent: approved, deps });
      return ok({
        source: "vex_lighter_live_deposit",
        ...execution,
        intentId: approved.intentId,
        userGuidance: depositUserGuidance(execution),
      });
    } catch (err) {
      await onboardingIntentsRepo.markAmbiguous(
        approved.intentId,
        `Deposit executor error: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      await leaseHandle.release().catch((err) => {
        logger.warn("lighter.deposit.execution_lease_release_failed", {
          intentId: approved.intentId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  },
};
