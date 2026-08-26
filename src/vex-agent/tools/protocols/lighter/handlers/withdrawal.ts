import { randomUUID } from "node:crypto";
import { formatUnits, getAddress, type Hex, type TransactionReceipt } from "viem";

import { getLighterClient } from "@tools/lighter/client.js";
import {
  defaultLighterTradingVaultCredentialId,
  evaluateLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";
import { LIGHTER_CORE_WITHDRAW_GATEWAY_ABI, readLighterCoreWithdrawalPreflight } from "@tools/lighter/withdrawal/core-preflight.js";
import { buildLighterCoreWithdrawalPreview } from "@tools/lighter/withdrawal/core-preview.js";
import { readLighterRhcWithdrawalPreflight } from "@tools/lighter/withdrawal/rhc-preflight.js";
import { buildLighterRhcWithdrawalPreview } from "@tools/lighter/withdrawal/rhc-preview.js";
import { getLighterSecureWithdrawalProfile } from "@tools/lighter/withdrawal/profiles.js";
import {
  assertLighterWithdrawalClaimPreflightWithinApproval,
  buildLighterWithdrawalClaimPreview,
  readLighterWithdrawalClaimPreflight,
} from "@tools/lighter/withdrawal/core-claim.js";
import { proveLighterCoreWithdrawalSettlement } from "@tools/lighter/withdrawal/settlement-proof.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import { decimalToBaseUnits } from "@tools/lighter/wallet-funding/onboarding-plan.js";
import { acquireLighterDepositExecutionLease } from "@tools/lighter/wallet-funding/execution-lease.js";
import { signStageBroadcast } from "@tools/evm-chains/staged-broadcast.js";
import {
  markLegacyEvmNonceAccepted,
  reserveLegacyEvmNonce,
  stageLegacyEvmNonce,
  terminalizeLegacyEvmNonce,
  type LegacyEvmNonceReservation,
} from "@vex-agent/db/repos/evm-nonce-reservations.js";
import { getUniswapDeployment } from "@tools/uniswap/deployments.js";
import {
  getUniswapEvmClients,
  getUniswapHistoricalPublicClient,
  getUniswapPublicClient,
} from "@tools/uniswap/evm-client.js";
import * as withdrawalIntentsRepo from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import * as withdrawalClaimsRepo from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import {
  withSessionControlLock,
  withSessionControlLocks,
} from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import { resolveSelectedAddress, resolveSigningWallet, walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import type { PreparedActionFollowUp } from "../../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import type { ProtocolHandler } from "../../types.js";
import logger from "@utils/logger.js";
import {
  assertLighterWithdrawalApprovalBinding,
  buildLighterWithdrawalCriticalArgs,
} from "../withdrawal-approval-binding.js";
import {
  assertLighterWithdrawalClaimApprovalBinding,
  buildLighterWithdrawalClaimCriticalArgs,
} from "../withdrawal-claim-approval-binding.js";
import {
  executeApprovedLighterWithdrawal,
  getConfiguredLighterCoreWithdrawalExecutionDeps,
} from "../withdrawal-execution.js";
import { buildLighterWithdrawalReadyForSignerPlan } from "../withdrawal-execution-plan.js";
import { reconcileLighterWithdrawal } from "../withdrawal-reconciliation.js";
import { resolveLighterReadOnlyAccountAuth } from "../read-account-auth.js";
import { listLighterTradingCredentialScopes } from "../trading-credential-scope.js";
import {
  buildWithdrawalClaimPreparedPresentation,
  buildWithdrawalClaimSubmittedPresentation,
  buildWithdrawalPreparedPresentation,
  buildWithdrawalStatusPresentation,
  buildWithdrawalSubmittedPresentation,
} from "../withdrawal-presentation.js";

function buildApprovalFollowUp(intent: LighterWithdrawalIntentRow): PreparedActionFollowUp {
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.withdraw", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: {
      toolName: "withdraw",
      namespace: "lighter",
      criticalArgs: buildLighterWithdrawalCriticalArgs(intent),
    },
  };
}

function buildClaimApprovalFollowUp(
  attempt: withdrawalClaimsRepo.LighterWithdrawalClaimAttemptRow,
): PreparedActionFollowUp {
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.withdraw.claim", params: { claimId: attempt.claimId } },
    expiresAt: attempt.expiresAt,
    approvalPreview: {
      toolName: "claim",
      namespace: "lighter",
      criticalArgs: buildLighterWithdrawalClaimCriticalArgs(attempt),
    },
  };
}

export const LIGHTER_WITHDRAWAL_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.withdraw.claim.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    const intentId = typeof params.intentId === "string" ? params.intentId.trim() : "";
    if (!sessionId || intentId.length === 0) return fail("Manual Lighter claim preparation requires a wallet-bound withdrawal intent id.");
    let selected: string;
    try {
      selected = getAddress(resolveSelectedAddress(context.walletResolution, context.walletPolicy, "eip155"));
    } catch (error) {
      return walletScopeErrorToResult(error);
    }
    const intent = await withdrawalIntentsRepo.findByIntentId(sessionId, intentId)
      ?? await withdrawalIntentsRepo.findByIntentIdForWallet(intentId, selected);
    if (intent === null) {
      return fail(`No Lighter withdrawal intent ${intentId} exists for the selected wallet.`);
    }
    const profile = getLighterSecureWithdrawalProfile(intent.environment);
    const funding = getLighterFundingDeployment(intent.environment);
    if (funding.expectedGatewayImplementation === undefined) {
      return fail(`The reviewed ${profile.sourceName} gateway implementation is unavailable.`);
    }
    if (intent.executionState !== "claimable" || intent.pendingBalanceUnits !== intent.amountUnits) {
      return fail(`${profile.sourceName} withdrawal ${intentId} is not exactly claimable. Reconcile its status before preparing a wallet transaction.`);
    }
    if (selected !== getAddress(intent.walletAddress)) return fail(`The selected Vex wallet does not own this ${profile.sourceName} withdrawal claim.`);
    const deployment = getUniswapDeployment(profile.settlementChainId);
    if (deployment === undefined) return fail(`${profile.settlementNetworkName} is unavailable for ${profile.sourceName} claim preparation.`);
    let preview;
    try {
      const snapshot = await readLighterWithdrawalClaimPreflight({
        profile,
        publicClient: getUniswapPublicClient(deployment),
        walletAddress: intent.walletAddress,
        gatewayAddress: intent.gatewayAddress,
        expectedGatewayImplementation: funding.expectedGatewayImplementation,
        expectedGatewayCodeHash: intent.gatewayCodeHash,
        settlementTokenAddress: intent.settlementTokenAddress,
        expectedSettlementTokenCodeHash: intent.settlementTokenCodeHash,
        amountUnits: BigInt(intent.amountUnits),
      });
      preview = buildLighterWithdrawalClaimPreview({ profile, sessionId, withdrawalIntentId: intent.intentId, snapshot });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    let attempt;
    try {
      attempt = await withSessionControlLocks([sessionId, intent.sessionId], (client) =>
        withdrawalClaimsRepo.createManualClaimAttemptWith(client, {
          claimId: `lighter-withdrawal-claim-${randomUUID()}`,
          preview,
        }));
    } catch (error) {
      return fail(error instanceof Error ? error.message : `Manual ${profile.sourceName} claim could not be reserved durably.`);
    }
    const amountDisplay = `${formatUnits(BigInt(attempt.amountUnits), 6)} ${profile.assetSymbol}`;
    return {
      ...ok({
        source: `vex_lighter_${intent.environment}_manual_claim_intent`,
        status: "approval_prepared",
        amountSemantics: "exact_transfer",
        claimId: attempt.claimId,
        withdrawalIntentId: attempt.withdrawalIntentId,
        amountDisplay,
        settlementNetwork: profile.settlementNetworkName,
        networkFeeCeilingWei: attempt.networkFeeCeilingWei,
        expiresAt: attempt.expiresAt,
        ...buildWithdrawalClaimPreparedPresentation(amountDisplay),
      }),
      preparedActionFollowUp: buildClaimApprovalFollowUp(attempt),
    };
  },

  "lighter.withdraw.claim": async (params, context) => {
    const sessionId = context.sessionId;
    const claimId = typeof params.claimId === "string" ? params.claimId.trim() : "";
    if (!sessionId || claimId.length === 0) return fail("Manual Lighter claim requires a session-scoped prepared claim id.");
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Manual Lighter claim requires its matching approved settlement-network claim card.", pendingApproval: true };
    }
    const attempt = await withdrawalClaimsRepo.findByClaimId(sessionId, claimId);
    if (attempt === null) return fail(`No manual Lighter claim ${claimId} exists in this session.`);
    const profile = getLighterSecureWithdrawalProfile(attempt.operationClass === "manual_core_usdc_claim" ? "core" : "rhc");
    try {
      await assertLighterWithdrawalClaimApprovalBinding({ approvalId: context.approvalId, sessionId, attempt });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (Date.parse(attempt.expiresAt) <= Date.now()) {
      await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markDecisionWith(client, {
        claimId, sessionId, approvalId: context.approvalId!, decision: "expired", reason: "approved claim resume observed expired preview",
      }));
      return fail(`Manual ${profile.sourceName} claim ${claimId} expired before execution.`);
    }
    const approved = await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markDecisionWith(client, {
      claimId, sessionId, approvalId: context.approvalId!, decision: "approved",
      reason: `user approved exact ${profile.settlementNetworkName} ${profile.sourceName} ${profile.assetSymbol} claim`,
    }));
    if (approved === null) return fail(`Manual ${profile.sourceName} claim ${claimId} has already left prepared state.`);
    const lease = await acquireLighterDepositExecutionLease({ chainId: profile.settlementChainId, walletAddress: approved.walletAddress, intentId: approved.withdrawalIntentId }).catch(() => null);
    if (lease === null || !lease.acquired) return fail(`Could not acquire the Lighter ${profile.settlementNetworkName} wallet execution slot. Nothing was signed.`);
    try {
      await lease.handle.assertOwned();
      let signer;
      try {
        signer = resolveSigningWallet(context.walletResolution, context.walletPolicy, "eip155");
      } catch (error) {
        return walletScopeErrorToResult(error);
      }
      if (signer.family !== "eip155" || getAddress(signer.address) !== getAddress(approved.walletAddress)) {
        return fail(`The resolved signing wallet does not match the approved ${profile.sourceName} claim wallet. Nothing was signed.`);
      }
      const deployment = getUniswapDeployment(profile.settlementChainId);
      if (deployment === undefined) return fail(`${profile.settlementNetworkName} is unavailable for ${profile.sourceName} claim execution.`);
      const clients = getUniswapEvmClients(deployment, signer.privateKey as Hex);
      const fresh = await readLighterWithdrawalClaimPreflight({
        profile,
        publicClient: clients.publicClient,
        walletAddress: approved.walletAddress,
        gatewayAddress: approved.gatewayAddress,
        expectedGatewayImplementation: approved.gatewayImplementation,
        expectedGatewayCodeHash: approved.gatewayCodeHash,
        settlementTokenAddress: approved.settlementTokenAddress,
        expectedSettlementTokenCodeHash: approved.settlementTokenCodeHash,
        amountUnits: BigInt(approved.amountUnits),
      });
      assertLighterWithdrawalClaimPreflightWithinApproval(approved.preflightJson, fresh);
      await lease.handle.assertOwned();
      const nonceState: { reservation: LegacyEvmNonceReservation | null } = { reservation: null };
      const outcome = await signStageBroadcast(
        clients.publicClient,
        clients.walletClient,
        { to: getAddress(approved.gatewayAddress), data: approved.calldata as Hex, value: 0n },
        {
          onNonceReserved: async (request) => {
            if (nonceState.reservation !== null) {
              throw new Error("Lighter withdrawal claim nonce was reserved more than once.");
            }
            nonceState.reservation = await reserveLegacyEvmNonce(request, "lighter_withdrawal_claim");
            return nonceState.reservation.nonce;
          },
          onHashStaged: async (handles) => {
            const staged = await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markStagedWith(client, {
              claimId, sessionId, txHash: handles.txHash, fromAddress: handles.fromAddress, nonce: handles.nonce,
            }));
            if (staged === null) throw new Error("Manual claim hash could not be staged durably before broadcast.");
            if (nonceState.reservation === null) {
              throw new Error("Lighter withdrawal claim hash reached staging without a nonce reservation.");
            }
            await stageLegacyEvmNonce(nonceState.reservation.id, handles);
          },
          onAccepted: async () => {
            await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markSubmittedWith(client, claimId, sessionId));
            if (nonceState.reservation === null) {
              throw new Error("Lighter withdrawal claim was accepted without a nonce reservation.");
            }
            await markLegacyEvmNonceAccepted(nonceState.reservation.id);
          },
        },
        undefined,
        undefined,
        {
          gasLimit: BigInt(approved.gasLimit),
          maxFeePerGas: BigInt(approved.feeCeilingPerGasWei),
          maxPriorityFeePerGas: BigInt(approved.priorityFeeCeilingWei),
          maxNetworkFeeWei: BigInt(approved.networkFeeCeilingWei),
        },
      );
      if (outcome.kind !== "ambiguous" && nonceState.reservation !== null) {
        try {
          await terminalizeLegacyEvmNonce(nonceState.reservation.id);
        } catch (cause) {
          logger.warn("lighter.withdrawal_claim.evm_nonce_terminal_write_failed", {
            reservationId: nonceState.reservation.id,
            errorKind: cause instanceof Error ? cause.name : "UnknownError",
          });
        }
      }
      if (outcome.kind === "ambiguous") {
        await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markOutcomeWith(client, {
          claimId, sessionId, outcome: "ambiguous", reason: `manual_claim_${outcome.stage}_outcome_unknown`,
        }));
        return ok({ source: `vex_lighter_${profile.environment}_manual_claim`, status: "ambiguous", claimId, txHash: outcome.txHash,
          userGuidance: `Tell the user the ${profile.settlementNetworkName} claim outcome is uncertain and must be reconciled. Do not retry or prepare another claim.` });
      }
      await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markSubmittedWith(client, claimId, sessionId));
      if (outcome.replacement !== undefined) {
        await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.recordReplacementWith(client, {
          claimId, sessionId, replacementTxHash: outcome.replacement!.replacementTxHash,
        }));
      }
      if (outcome.kind === "confirmed") {
        const [block, latest, pending] = await Promise.all([
          clients.publicClient.getBlock({ blockNumber: outcome.receipt.blockNumber, includeTransactions: false }),
          clients.publicClient.getBlockNumber(),
          clients.publicClient.readContract({ address: getAddress(approved.gatewayAddress), abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI, functionName: "getPendingBalance", args: [getAddress(approved.ownerAddress), 3] }),
        ]);
        proveLighterCoreWithdrawalSettlement({ receipt: outcome.receipt, canonicalBlockHash: block.hash,
          latestBlockNumber: latest, owner: approved.ownerAddress, gatewayAddress: approved.gatewayAddress,
          tokenAddress: approved.settlementTokenAddress, amountUnits: BigInt(approved.amountUnits), requiredConfirmations: 1 });
        if (pending !== 0n) throw new Error("Confirmed manual claim left a nonzero exact gateway pending balance.");
      }
      await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markOutcomeWith(client, {
        claimId, sessionId, outcome: "confirming", receipt: publicReceipt(outcome.receipt),
      }));
      const amountDisplay = `${formatUnits(BigInt(approved.amountUnits), 6)} ${profile.assetSymbol}`;
      return ok({ source: `vex_lighter_${profile.environment}_manual_claim`, status: "confirming", claimId,
        txHash: outcome.receipt.transactionHash, receiptStatus: outcome.receipt.status,
        amountDisplay,
        ...(outcome.kind === "confirmed"
          ? buildWithdrawalClaimSubmittedPresentation(amountDisplay)
          : {
              presentation: "concise_error",
              message: `The ${amountDisplay} claim transaction reverted.`,
              userGuidance: `Reply briefly: "The ${amountDisplay} claim transaction reverted." Do not say the funds arrived or add unrelated account details.`,
            }) });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const current = await withdrawalClaimsRepo.findByClaimId(sessionId, claimId).catch(() => null);
      if (current?.txHash === null) {
        await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markUnsubmittedFailureWith(client, {
          claimId, sessionId, reason: "manual claim failed before durable transaction staging",
        })).catch(() => false);
        return fail(reason);
      }
      if (current !== null) {
        await withSessionControlLock(sessionId, (client) => withdrawalClaimsRepo.markOutcomeWith(client, {
          claimId, sessionId, outcome: "ambiguous", reason: "manual_claim_post_staging_outcome_unknown",
        })).catch(() => false);
        return ok({ source: `vex_lighter_${profile.environment}_manual_claim`, status: "ambiguous", claimId,
          txHash: current.replacementTxHash ?? current.txHash, reason,
          userGuidance: `Tell the user the staged ${profile.settlementNetworkName} claim must be reconciled and must not be retried.` });
      }
      return fail(reason);
    } finally {
      await lease.handle.releaseExecutionLease().catch(() => {});
    }
  },

  "lighter.withdraw.status": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter withdrawal status requires a host session id.");
    const intentId = typeof params.intentId === "string" ? params.intentId.trim() : "";
    let walletAddress: string;
    try {
      walletAddress = getAddress(resolveSelectedAddress(
        context.walletResolution,
        context.walletPolicy,
        "eip155",
      ));
    } catch (error) {
      return walletScopeErrorToResult(error);
    }
    // Status is always selected-wallet scoped, including rows created in this
    // session. A session can outlive a wallet-selection change, so session
    // ownership alone is not sufficient authorization to disclose or refresh
    // a withdrawal.
    let intent = intentId.length > 0
      ? await withdrawalIntentsRepo.findByIntentIdForWallet(intentId, walletAddress)
      : await withdrawalIntentsRepo.findLatestForWallet(walletAddress);
    if (intent === null) return fail(intentId.length > 0
      ? `No Lighter withdrawal intent ${intentId} exists for the selected wallet.`
      : "No Lighter withdrawal intent exists for the selected wallet.");
    const recoveredFromEarlierSession = intent.sessionId !== sessionId;
    const profile = getLighterSecureWithdrawalProfile(intent.environment);
    let claimAttempt = await withdrawalClaimsRepo.findLatestForWithdrawalIntent(intent.intentId);
    if (
      intent.executionState === "manual_claim_prepared"
      && claimAttempt?.state === "prepared"
      && Date.parse(claimAttempt.expiresAt) <= Date.now()
    ) {
      await withSessionControlLocks([intent.sessionId, claimAttempt.sessionId], (client) =>
        withdrawalClaimsRepo.expirePreparedWith(client, claimAttempt!.claimId, claimAttempt!.sessionId));
      intent = await withdrawalIntentsRepo.findByIntentId(intent.sessionId, intent.intentId) ?? intent;
      claimAttempt = await withdrawalClaimsRepo.findLatestForWithdrawalIntent(intent.intentId);
    }
    if (!["destination_confirmed", "rejected", "failed", "refunded", "expired"].includes(intent.executionState)) {
      if (intent.signerTxHash === null || intent.submissionStagedAt === null) {
        return ok({
          ...withdrawalStatusPayload(intent, claimAttempt),
          recoveredFromEarlierSession,
        });
      }
      const privilegedAuth = await resolveLighterReadOnlyAccountAuth(intent.environment, intent.accountIndex);
      if (privilegedAuth === null) {
        return ok({
          ...withdrawalStatusPayload(intent, claimAttempt),
          recoveredFromEarlierSession,
          reconciliationStatus: "awaiting_vault",
          reconciliationError: `Unlock the local vault to derive bounded read-only ${profile.sourceName} reconciliation access.`,
          userGuidance: "Tell the user the durable withdrawal exists, but fresh evidence requires an unlocked local vault. Do not prepare or retry a withdrawal.",
        });
      }
      const settlement = getUniswapDeployment(profile.settlementChainId);
      if (settlement === undefined) return ok({
        ...withdrawalStatusPayload(intent, claimAttempt),
        recoveredFromEarlierSession,
        reconciliationStatus: "degraded",
        reconciliationError: `${profile.settlementNetworkName} deployment is unavailable for evidence refresh.`,
        userGuidance: "Tell the user the durable withdrawal exists, but fresh settlement evidence is unavailable. Do not prepare or retry a withdrawal.",
      });
      try {
        intent = await reconcileLighterWithdrawal({
          intent,
          client: getLighterClient(),
          privilegedAuth,
          publicClient: getUniswapPublicClient(settlement),
          historicalPublicClient: getUniswapHistoricalPublicClient(settlement),
        });
      } catch {
        return ok({
          ...withdrawalStatusPayload(intent, claimAttempt),
          recoveredFromEarlierSession,
          reconciliationStatus: "degraded",
          reconciliationError: "Exact evidence refresh failed; this durable status was returned without signing, submitting, or retrying anything.",
          userGuidance: intent.executionState === "ambiguous"
            ? "Tell the user the durable withdrawal exists and remains unresolved. Do not say nothing was signed, do not prepare another withdrawal, and retry only the evidence status read."
            : "Tell the user the durable withdrawal status could not be refreshed. Do not retry any transaction.",
        });
      }
    }
    claimAttempt = await withdrawalClaimsRepo.findLatestForWithdrawalIntent(intent.intentId);
    return ok({
      ...withdrawalStatusPayload(intent, claimAttempt),
      recoveredFromEarlierSession,
    });
  },

  "lighter.withdraw.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter withdrawal preparation requires a host session id.");
    if (params.environment !== "core" && params.environment !== "rhc") {
      return fail("Secure withdrawal requires an explicit environment: core for USDC or rhc for USDG.");
    }
    const environment = params.environment;
    const profile = getLighterSecureWithdrawalProfile(environment);
    const amountRaw = params.amountIn;
    if (typeof amountRaw !== "string") return fail(`amountIn must be an exact ${profile.assetSymbol} decimal string, for example "2".`);
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
    const scopes = listLighterTradingCredentialScopes(environment);
    const distinctScopes = [...new Map(scopes.map((scope) => [`${scope.accountIndex}:${scope.apiKeyIndex}`, scope])).values()];
    const owned: typeof distinctScopes = [];
    for (const scope of distinctScopes) {
      try {
        const account = await client.getAccount(environment, { by: "index", value: scope.accountIndex });
        if (account.accounts.some((row) =>
          (row.index ?? row.account_index) === scope.accountIndex
          && typeof row.l1_address === "string"
          && getAddress(row.l1_address) === walletAddress)) {
          owned.push(scope);
        }
      } catch {
        return fail(`${profile.sourceName} account ownership could not be proven for every saved managed credential. No withdrawal was prepared.`);
      }
    }
    if (owned.length !== 1 || owned[0] === undefined) {
      return fail(
        owned.length === 0
          ? `The selected wallet has no uniquely proven managed ${profile.productName} trading account.`
          : `The selected wallet has multiple managed ${profile.sourceName} credential scopes; Vex will not guess which signer scope to use.`,
      );
    }
    const scope = owned[0];
    const privilegedAuth = await resolveLighterReadOnlyAccountAuth(environment, scope.accountIndex);
    if (privilegedAuth === null) {
      return fail(`The local vault must be unlocked so Vex can derive bounded read-only ${profile.sourceName} account authorization. No withdrawal was prepared.`);
    }
    const readiness = evaluateLighterTradingCredentialReadiness({
      environment,
      accountIndex: scope.accountIndex,
      apiKeyIndex: scope.apiKeyIndex,
      vaultCredentialId: defaultLighterTradingVaultCredentialId(scope),
    });
    if (!readiness.ready) return fail(`Managed ${profile.sourceName} signing access is not ready. No withdrawal was prepared.`);
    const settlement = getUniswapDeployment(profile.settlementChainId);
    if (settlement === undefined) return fail(`${profile.settlementNetworkName} deployment is unavailable. No withdrawal was prepared.`);

    let preview;
    try {
      const preflightInput = {
        walletAddress,
        accountIndex: scope.accountIndex,
        apiKeyIndex: scope.apiKeyIndex,
        amountUnits,
        client,
        privilegedAuth,
        publicClient: getUniswapPublicClient(settlement),
      };
      if (environment === "core") {
        const snapshot = await readLighterCoreWithdrawalPreflight(preflightInput);
        preview = buildLighterCoreWithdrawalPreview({ sessionId, snapshot });
      } else {
        const snapshot = await readLighterRhcWithdrawalPreflight(preflightInput);
        preview = buildLighterRhcWithdrawalPreview({ sessionId, snapshot });
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }

    type PreparationOutcome = withdrawalIntentsRepo.CreateLighterWithdrawalIntentOutcome
      | { readonly outcome: "reemit" | "live_approval"; readonly intent: LighterWithdrawalIntentRow };
    let outcome: PreparationOutcome;
    try {
      const existing = await withdrawalIntentsRepo.findNonterminalForScope(
        environment,
        scope.accountIndex,
      );
      const stale = existing !== null
        && withdrawalIntentsRepo.isSafelyExpirableApprovalPending(existing);
      const reemittable = existing !== null
        && withdrawalIntentsRepo.isSafelyReemittableApprovalPending(existing, preview);
      const lockSessionIds = stale ? [sessionId, existing.sessionId] : [sessionId];
      outcome = await withSessionControlLocks(lockSessionIds, async (db) => {
        if (reemittable && existing !== null) {
          const current = await withdrawalIntentsRepo.findByIntentIdWith(
            db,
            sessionId,
            existing.intentId,
          );
          if (
            current !== null
            && withdrawalIntentsRepo.isSafelyReemittableApprovalPending(current, preview)
          ) {
            const hasLiveApproval = await withdrawalIntentsRepo.hasPendingApprovalForIntentWith(
              db,
              sessionId,
              current.intentId,
            );
            return { outcome: hasLiveApproval ? "live_approval" : "reemit", intent: current };
          }
        }
        if (stale) {
          await withdrawalIntentsRepo.expireStaleApprovalPendingWith(db, {
            intentId: existing.intentId,
            sessionId: existing.sessionId,
            environment,
            accountIndex: scope.accountIndex,
          });
        }
        return withdrawalIntentsRepo.createOrFindLiveApprovalPendingWith(db, {
          intentId: `lighter-withdrawal-${randomUUID()}`,
          preview,
          credentialReadiness: readiness,
        });
      });
    } catch {
      return fail(`Vex could not safely reserve the durable ${profile.sourceName} withdrawal intent. No withdrawal was prepared.`);
    }
    if (outcome.outcome === "live_conflict") {
      return fail(`${profile.sourceName} account ${scope.accountIndex} already has unresolved withdrawal intent ${outcome.intent.intentId} in state ${outcome.intent.executionState}. Reconcile it before any new withdrawal.`);
    }
    const intent = outcome.intent;
    if (
      intent.approvalStatus !== "approval_pending"
      || intent.executionState !== "approval_pending"
      || Date.parse(intent.expiresAt) <= Date.now()
    ) {
      return fail(`${profile.sourceName} withdrawal intent ${intent.intentId} is no longer approval-pending. Prepare a fresh withdrawal.`);
    }
    const amountDisplay = `${formatUnits(BigInt(intent.amountUnits), 6)} ${profile.assetSymbol}`;
    const preparedPayload = ok({
      source: `vex_lighter_${environment}_withdrawal_intent`,
      status: outcome.outcome === "created"
        ? "approval_prepared"
        : outcome.outcome === "live_approval"
          ? "approval_pending_existing"
          : "approval_prepared_existing",
      amountSemantics: "exact_transfer",
      intentId: intent.intentId,
      previewId: intent.previewId,
      matchHash: intent.matchHash,
      environment,
      amountUnits: intent.amountUnits,
      amountDisplay,
      destinationAddress: intent.destinationAddress,
      settlementNetwork: profile.settlementNetworkName,
      route: "secure",
      withdrawalDelaySeconds: intent.withdrawalDelaySeconds,
      expiresAt: intent.expiresAt,
      ...buildWithdrawalPreparedPresentation(
        amountDisplay,
        outcome.outcome === "live_approval",
      ),
    });
    if (outcome.outcome === "live_approval") return preparedPayload;
    return {
      ...preparedPayload,
      preparedActionFollowUp: buildApprovalFollowUp(intent),
    };
  },

  "lighter.withdraw": async (params, context) => {
    const sessionId = context.sessionId;
    const intentId = typeof params.intentId === "string" ? params.intentId.trim() : "";
    if (!sessionId || intentId.length === 0) return fail("Lighter withdrawal requires a session-scoped prepared intent id.");
    if (!context.approved || !context.approvalId) {
      return { success: false, output: "Lighter withdrawal requires the matching approved Vex approval card.", pendingApproval: true };
    }
    const intent = await withdrawalIntentsRepo.findByIntentId(sessionId, intentId);
    if (intent === null) return fail(`No Lighter withdrawal intent ${intentId} exists in this session.`);
    const profile = getLighterSecureWithdrawalProfile(intent.environment);
    try {
      await assertLighterWithdrawalApprovalBinding({ approvalId: context.approvalId, sessionId, intent });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    if (Date.parse(intent.expiresAt) <= Date.now()) {
      await withdrawalIntentsRepo.markApprovalDecision({
        intentId, sessionId, approvalId: context.approvalId, decision: "expired",
        reason: `approved resume observed expired ${intent.environment} withdrawal intent`,
      });
      return fail(`${profile.sourceName} withdrawal intent ${intentId} expired before execution.`);
    }
    const approved = await withdrawalIntentsRepo.markApprovalDecision({
      intentId, sessionId, approvalId: context.approvalId, decision: "approved",
      reason: `user approved exact ${profile.sourceName} ${profile.assetSymbol} secure withdrawal`,
    });
    if (approved === null) return fail(`${profile.sourceName} withdrawal intent ${intentId} has already left approval_pending.`);
    const deps = getConfiguredLighterCoreWithdrawalExecutionDeps();
    if (deps === null) return fail(`Privileged ${profile.sourceName} withdrawal execution is unavailable. Nothing was signed or submitted.`);
    try {
      const result = await executeApprovedLighterWithdrawal({
        plan: buildLighterWithdrawalReadyForSignerPlan(approved),
        deps,
      });
      const amountDisplay = `${formatUnits(BigInt(approved.amountUnits), 6)} ${profile.assetSymbol}`;
      return ok({
        source: `vex_lighter_${approved.environment}_withdrawal_execution`,
        ...result,
        amountDisplay,
        ...(result.status === "submitted"
          ? buildWithdrawalSubmittedPresentation(
              amountDisplay,
              approved.withdrawalDelaySeconds,
            )
          : {
              presentation: "concise_error",
              message: `The ${amountDisplay} withdrawal outcome is still being verified. Please do not retry it yet.`,
              userGuidance: `Reply briefly: "The ${amountDisplay} withdrawal outcome is still being verified. Please do not retry it yet." Do not say it succeeded or failed, and do not add unrelated details.`,
            }),
      });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
};

function publicReceipt(receipt: TransactionReceipt): Record<string, unknown> {
  return {
    transactionHash: receipt.transactionHash, status: receipt.status,
    blockNumber: receipt.blockNumber.toString(10), blockHash: receipt.blockHash,
    from: receipt.from, to: receipt.to, gasUsed: receipt.gasUsed.toString(10),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(10), logCount: receipt.logs.length,
  };
}

function withdrawalStatusPayload(
  intent: LighterWithdrawalIntentRow,
  claim?: withdrawalClaimsRepo.LighterWithdrawalClaimAttemptRow | null,
): Record<string, unknown> {
  const profile = getLighterSecureWithdrawalProfile(intent.environment);
  const amountDisplay = `${formatUnits(BigInt(intent.amountUnits), 6)} ${profile.assetSymbol}`;
  return {
    source: `vex_lighter_${intent.environment}_withdrawal_reconciliation`,
    intentId: intent.intentId,
    environment: intent.environment,
    executionState: intent.executionState,
    approvalStatus: intent.approvalStatus,
    amountUnits: intent.amountUnits,
    amountDisplay,
    settlementNetwork: profile.settlementNetworkName,
    destinationAddress: intent.destinationAddress,
    signerTxHash: intent.signerTxHash,
    submittedTxHash: intent.submittedTxHash,
    providerTxStatus: intent.providerTxStatus,
    withdrawalHistoryId: intent.withdrawalHistoryId,
    withdrawalHistoryStatus: intent.withdrawalHistoryStatus,
    pendingBalanceUnits: intent.pendingBalanceUnits,
    claimMode: intent.claimMode,
    claimId: claim?.claimId ?? null,
    claimState: claim?.state ?? null,
    claimApprovalId: claim?.approvalId ?? intent.claimApprovalId,
    claimTxHash: claim?.txHash ?? intent.claimTxHash,
    claimReplacementTxHash: claim?.replacementTxHash ?? intent.claimReplacementTxHash,
    destinationTxHash: intent.destinationTxHash,
    destinationBlockNumber: intent.destinationBlockNumber,
    destinationConfirmations: intent.destinationConfirmations,
    lastCheckedAt: intent.lastCheckedAt,
    final: intent.executionState === "destination_confirmed",
    ...buildWithdrawalStatusPresentation(
      intent.executionState,
      amountDisplay,
      profile.settlementNetworkName,
    ),
  };
}
