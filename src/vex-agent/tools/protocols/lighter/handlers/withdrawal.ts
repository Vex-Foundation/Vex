import { randomUUID } from "node:crypto";
import { formatUnits, getAddress } from "viem";

import { getLighterClient } from "@tools/lighter/client.js";
import {
  defaultLighterTradingVaultCredentialId,
  evaluateLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";
import { readLighterCoreWithdrawalPreflight } from "@tools/lighter/withdrawal/core-preflight.js";
import { buildLighterCoreWithdrawalPreview } from "@tools/lighter/withdrawal/core-preview.js";
import { decimalToBaseUnits } from "@tools/lighter/wallet-funding/onboarding-plan.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import { getUniswapPublicClient } from "@tools/uniswap/evm-client.js";
import * as withdrawalIntentsRepo from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { resolveSelectedAddress, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import type { ProtocolHandler } from "../../types.js";
import { assertLighterCoreWithdrawalApprovalBinding } from "../withdrawal-approval-binding.js";
import {
  executeApprovedLighterCoreWithdrawal,
  getConfiguredLighterCoreWithdrawalExecutionDeps,
} from "../withdrawal-execution.js";
import { buildLighterCoreWithdrawalReadyForSignerPlan } from "../withdrawal-execution-plan.js";
import { resolveLighterReadOnlyAccountAuth } from "../read-account-auth.js";
import { listLighterTradingCredentialScopes } from "../trading-credential-scope.js";

function buildApprovalFollowUp(intent: LighterWithdrawalIntentRow): PreparedActionFollowUp {
  const observedAtMs = Date.parse(intent.preflightObservedAt);
  const amountDisplay = `${formatUnits(BigInt(intent.amountUnits), 6)} USDC`;
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {
    toolId: "lighter.withdraw",
    intentId: intent.intentId,
    previewId: intent.previewId,
    matchHash: intent.matchHash,
    environment: "core",
    operationClass: "secure_l2_withdrawal",
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    walletAddress: intent.walletAddress,
    destinationAddress: intent.destinationAddress,
    signingChainId: 304,
    settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet",
    assetIndex: 3,
    assetSymbol: "USDC",
    assetDecimals: 6,
    settlementTokenAddress: intent.settlementTokenAddress,
    routeType: 0,
    route: "secure",
    amountUnits: intent.amountUnits,
    amountDisplay,
    minimumWithdrawalUnits: intent.minimumWithdrawalUnits,
    availableBalanceUnits: intent.availableBalanceUnits,
    collateralUnits: intent.collateralUnits,
    initialMarginUnits: intent.initialMarginUnits,
    pendingOrderCount: intent.pendingOrderCount,
    openPositionCount: intent.openPositionCount,
    activeOrderCount: intent.activeOrderCount,
    withdrawalDelaySeconds: intent.withdrawalDelaySeconds,
    estimatedClaimableAt: new Date(observedAtMs + intent.withdrawalDelaySeconds * 1_000).toISOString(),
    gatewayAddress: intent.gatewayAddress,
    gatewayImplementation: intent.gatewayImplementation,
    gatewayCodeHash: intent.gatewayCodeHash,
    settlementTokenCodeHash: intent.settlementTokenCodeHash,
    preflightObservedAt: intent.preflightObservedAt,
    summary: `Withdraw ${amountDisplay} from Lighter Core to ${intent.destinationAddress} on Ethereum mainnet using the secure route.`,
    scopeNote: "This approval submits the L2 withdrawal only. Any later manual Ethereum claim requires a separate wallet approval and network fee.",
  };
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.withdraw", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: { toolName: "withdraw", namespace: "lighter", criticalArgs },
  };
}

export const LIGHTER_WITHDRAWAL_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.withdraw.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Core withdrawal preparation requires a host session id.");
    if (params.environment !== undefined && params.environment !== "core") {
      return fail("Core USDC withdrawal supports environment=core only.");
    }
    const amountRaw = params.amountIn;
    if (typeof amountRaw !== "string") return fail('amountIn must be an exact USDC decimal string, for example "2".');
    let amountUnits: bigint;
    try {
      amountUnits = decimalToBaseUnits(amountRaw, 6);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let walletAddress: string;
    try {
      walletAddress = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
    } catch (error) {
      return walletScopeErrorToResult(error);
    }
    const client = getLighterClient();
    const scopes = listLighterTradingCredentialScopes("core");
    const distinctScopes = [...new Map(scopes.map((scope) => [`${scope.accountIndex}:${scope.apiKeyIndex}`, scope])).values()];
    const owned: typeof distinctScopes = [];
    for (const scope of distinctScopes) {
      try {
        const account = await client.getAccount("core", { by: "index", value: scope.accountIndex });
        if (account.accounts.some((row) =>
          (row.index ?? row.account_index) === scope.accountIndex
          && typeof row.l1_address === "string"
          && getAddress(row.l1_address) === walletAddress)) {
          owned.push(scope);
        }
      } catch {
        return fail("Core account ownership could not be proven for every saved managed credential. No withdrawal was prepared.");
      }
    }
    if (owned.length !== 1 || owned[0] === undefined) {
      return fail(
        owned.length === 0
          ? "The selected wallet has no uniquely proven managed Lighter Core trading account."
          : "The selected wallet has multiple managed Core credential scopes; Vex will not guess which signer scope to use.",
      );
    }
    const scope = owned[0];
    const privilegedAuth = await resolveLighterReadOnlyAccountAuth("core", scope.accountIndex);
    if (privilegedAuth === null) {
      return fail("The local vault must be unlocked so Vex can derive bounded read-only Core account authorization. No withdrawal was prepared.");
    }
    const readiness = evaluateLighterTradingCredentialReadiness({
      environment: "core",
      accountIndex: scope.accountIndex,
      apiKeyIndex: scope.apiKeyIndex,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
    });
    if (!readiness.ready) return fail("Managed Core signing access is not ready. No withdrawal was prepared.");
    const ethereum = getUniswapDeployment(1);
    if (ethereum === undefined) return fail("Ethereum mainnet deployment is unavailable. No withdrawal was prepared.");

    let preview;
    try {
      const snapshot = await readLighterCoreWithdrawalPreflight({
        walletAddress,
        accountIndex: scope.accountIndex,
        apiKeyIndex: scope.apiKeyIndex,
        amountUnits,
        client,
        privilegedAuth,
        publicClient: getUniswapPublicClient(ethereum),
      });
      preview = buildLighterCoreWithdrawalPreview({ sessionId, snapshot });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    let outcome: withdrawalIntentsRepo.CreateLighterWithdrawalIntentOutcome;
    try {
      outcome = await withSessionControlLock(sessionId, (db) =>
        withdrawalIntentsRepo.createOrFindLiveApprovalPendingWith(db, {
          intentId: `lighter-withdrawal-${randomUUID()}`,
          preview,
          credentialReadiness: readiness,
        }));
    } catch {
      return fail("Vex could not safely reserve the durable Core withdrawal intent. No withdrawal was prepared.");
    }
    if (outcome.outcome === "live_conflict") {
      return fail(`Core account ${scope.accountIndex} already has unresolved withdrawal intent ${outcome.intent.intentId} in state ${outcome.intent.executionState}. Reconcile it before any new withdrawal.`);
    }
    const intent = outcome.intent;
    if (
      intent.approvalStatus !== "approval_pending"
      || intent.executionState !== "approval_pending"
      || Date.parse(intent.expiresAt) <= Date.now()
    ) {
      return fail(`Core withdrawal intent ${intent.intentId} is no longer approval-pending. Prepare a fresh withdrawal.`);
    }
    return {
      ...ok({
        source: "vex_lighter_core_withdrawal_intent",
        status: outcome.outcome === "created" ? "approval_prepared" : "approval_prepared_existing",
        message: "Exact Core USDC secure withdrawal prepared; review the trusted approval card.",
        intentId: intent.intentId,
        previewId: intent.previewId,
        matchHash: intent.matchHash,
        environment: "core",
        amountUnits: intent.amountUnits,
        amountDisplay: `${formatUnits(BigInt(intent.amountUnits), 6)} USDC`,
        destinationAddress: intent.destinationAddress,
        settlementNetwork: "Ethereum mainnet",
        route: "secure",
        withdrawalDelaySeconds: intent.withdrawalDelaySeconds,
        expiresAt: intent.expiresAt,
        userGuidance: "Tell the user to review the approval card. Do not ask for a typed confirmation, account index, API key, nonce, or credential.",
      }),
      preparedActionFollowUp: buildApprovalFollowUp(intent),
    };
  },

  "lighter.withdraw": async (params, context) => {
    const sessionId = context.sessionId;
    const intentId = typeof params.intentId === "string" ? params.intentId.trim() : "";
    if (!sessionId || intentId.length === 0) return fail("Core withdrawal requires a session-scoped prepared intent id.");
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Core withdrawal requires the matching approved Vex approval card.", pendingApproval: true };
    }
    const intent = await withdrawalIntentsRepo.findByIntentId(sessionId, intentId);
    if (intent === null) return fail(`No Core withdrawal intent ${intentId} exists in this session.`);
    try {
      await assertLighterCoreWithdrawalApprovalBinding({ approvalId: context.approvalId, sessionId, intent });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (Date.parse(intent.expiresAt) <= Date.now()) {
      await withdrawalIntentsRepo.markApprovalDecision({
        intentId, sessionId, approvalId: context.approvalId, decision: "expired",
        reason: "approved resume observed expired Core withdrawal intent",
      });
      return fail(`Core withdrawal intent ${intentId} expired before execution.`);
    }
    const approved = await withdrawalIntentsRepo.markApprovalDecision({
      intentId, sessionId, approvalId: context.approvalId, decision: "approved",
      reason: "user approved exact Core USDC secure withdrawal",
    });
    if (approved === null) return fail(`Core withdrawal intent ${intentId} has already left approval_pending.`);
    const deps = getConfiguredLighterCoreWithdrawalExecutionDeps();
    if (deps === null) return fail("Privileged Core withdrawal execution is unavailable. Nothing was signed or submitted.");
    try {
      const result = await executeApprovedLighterCoreWithdrawal({
        plan: buildLighterCoreWithdrawalReadyForSignerPlan(approved),
        deps,
      });
      return ok({
        source: "vex_lighter_core_withdrawal_execution",
        ...result,
        userGuidance: result.status === "submitted"
          ? "Tell the user the Core withdrawal was submitted and is awaiting L2 plus Ethereum settlement proof; API acceptance is not final delivery."
          : "Tell the user the outcome is uncertain and Vex will reconcile it before any retry.",
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};
