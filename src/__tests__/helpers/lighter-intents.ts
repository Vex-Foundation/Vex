import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type { LighterOrderLifecycleIntentRow } from "@vex-agent/db/repos/lighter-order-lifecycle-intents.js";
const WALLET = "0x1111111111111111111111111111111111111111";
const GATEWAY = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
const NOW = "2030-01-01T00:00:00.000Z";

export function lifecycleIntent(overrides: Partial<LighterOrderLifecycleIntentRow> = {}): LighterOrderLifecycleIntentRow {
  return {
    intentId: `lighter-lifecycle-${"a".repeat(32)}`, sessionId: "session-1", protocolExecutionId: null,
    approvalId: null, matchHash: "b".repeat(64), environment: "rhc", accountIndex: 42, apiKeyIndex: 7,
    actionType: "cancel_one", marketIndex: 0, providerOrderId: "1152921504606846975",
    requestedBaseAmountInteger: null, requestedPriceInteger: null, requestedSide: null, reduceOnly: false,
    providerSnapshotJson: {}, credentialRefJson: { kind: "encrypted_vault_reference", environment: "rhc",
      accountIndex: 42, apiKeyIndex: 7, vaultCredentialId: "lighter/rhc/account-42/api-key-7" },
    approvalStatus: "approval_pending", executionState: "approval_pending", decisionReason: null, decidedAt: null,
    preSubmitRevalidationJson: null, preSubmitRevalidatedAt: null, nonceReservationId: null, nonceValue: null,
    signerExpiryMs: null, signerTxHash: null, submittedTxHash: null, submitCode: null, submitMessage: null,
    predictedExecutionTimeMs: null, volumeQuotaRemaining: null, providerOutcomeJson: null,
    providerOutcomeCheckedAt: null, ambiguousReason: null, createdAt: NOW, updatedAt: NOW,
    expiresAt: "2030-01-01T00:05:00.000Z", ...overrides,
  };
}

export function claimAttempt(overrides: Partial<LighterWithdrawalClaimAttemptRow> = {}): LighterWithdrawalClaimAttemptRow {
  const snapshot: LighterWithdrawalClaimAttemptRow["preflightJson"] = {
    observedAt: NOW, expiresAt: "2030-01-01T00:05:00.000Z", settlementChainId: 1,
    settlementNetworkName: "Ethereum mainnet", blockNumber: "20000000", blockHash: `0x${"a".repeat(64)}`,
    walletAddress: WALLET, ownerAddress: WALLET, gatewayAddress: GATEWAY,
    gatewayImplementation: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e", gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    assetIndex: 3, assetSymbol: "USDC", assetDecimals: 6, amountUnits: "2000000", pendingBalanceUnits: "2000000",
    calldata: "0x1234", valueWei: "0", nativeBalanceWei: "1000000000000000000", gasEstimate: "100000",
    gasLimit: "200000", quotedMaxFeePerGasWei: "100000000", quotedPriorityFeePerGasWei: "1000000",
    feeCeilingPerGasWei: "400000000", priorityFeeCeilingWei: "4000000", networkFeeCeilingWei: "80000000000000",
  };
  return {
    ...snapshot, claimId: "claim-1", withdrawalIntentId: "withdrawal-1", sessionId: "session-1", previewId: "lwcp_fixture",
    approvalId: null, matchHash: "a".repeat(64), operationClass: "manual_core_usdc_claim",
    preflightJson: snapshot, preflightObservedAt: NOW, preflightBlockNumber: snapshot.blockNumber,
    state: "prepared", decisionReason: null, decidedAt: null, txHash: null, replacementTxHash: null,
    fromAddress: null, nonce: null, receiptJson: null, ambiguousReason: null, stagedAt: null,
    submittedAt: null, confirmedAt: null, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

export function withdrawalIntent(overrides: Partial<LighterWithdrawalIntentRow> = {}): LighterWithdrawalIntentRow {
  return {
    intentId: "lighter-withdrawal-00000000-0000-4000-8000-000000000001",
    previewId: "lwp_fixture", sessionId: "session-1", protocolExecutionId: null,
    approvalId: null, matchHash: "a".repeat(64), environment: "core",
    operationClass: "secure_l2_withdrawal", endpoint: "https://mainnet.zklighter.elliot.ai",
    signingChainId: 304, settlementChainId: 1, settlementNetworkName: "Ethereum mainnet",
    accountIndex: 42, apiKeyIndex: 4, walletAddress: WALLET, destinationAddress: WALLET,
    credentialRefJson: { kind: "encrypted_vault_reference", environment: "core", accountIndex: 42,
      apiKeyIndex: 4, vaultCredentialId: "lighter/core/account-42/api-key-4" },
    assetIndex: 3, assetSymbol: "USDC", assetDecimals: 6,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    routeType: 0, amountUnits: "2000000", minimumWithdrawalUnits: "1000000",
    availableBalanceUnits: "8000000", collateralUnits: "10000000", initialMarginUnits: "1000000",
    maintenanceMarginUnits: "500000", pendingOrderCount: 0, openPositionCount: 0, activeOrderCount: 0,
    gatewayAddress: GATEWAY, gatewayImplementation: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
    gatewayCodeHash: `0x${"1".repeat(64)}`, settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    preflightJson: {}, preflightObservedAt: NOW, preSubmitRevalidationJson: null, preSubmitRevalidatedAt: null,
    withdrawalDelaySeconds: 1227, delayObservedAt: NOW,
    approvalStatus: "approval_pending", executionState: "approval_pending", decisionReason: null, decidedAt: null,
    nonceReservationId: null, nonceValue: null, signerTxHash: null, submittedTxHash: null, signerExpiryMs: null,
    submitCode: null, submitMessage: null, predictedExecutionTimeMs: null, volumeQuotaRemaining: null,
    providerTxStatus: null, providerTxEvidenceJson: null, withdrawalHistoryId: null, withdrawalHistoryStatus: null,
    withdrawalHistoryJson: null, pendingBalanceUnits: null, ambiguousReason: null, claimMode: null,
    claimApprovalId: null, claimTxHash: null, claimReplacementTxHash: null, destinationTxHash: null,
    destinationBlockNumber: null, destinationBlockHash: null, destinationConfirmations: null, destinationEvidenceJson: null,
    signedAt: null, submissionStagedAt: null, apiAcceptedAt: null, l2ExecutedAt: null, claimableAt: null,
    destinationConfirmedAt: null, lastCheckedAt: null, settlementScanFromBlock: null, withdrawalHistoryTimestamp: null,
    createdAt: NOW, updatedAt: NOW, expiresAt: "2030-01-01T00:05:00.000Z", ...overrides,
  };
}

export function onboardingIntent(
  overrides: Partial<LighterOnboardingIntentRow> = {},
): LighterOnboardingIntentRow {
  return {
    intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
    sessionId: "session-1",
    protocolExecutionId: null,
    approvalId: "approval-1",
    environment: "core",
    capability: "deposit",
    walletAddress: WALLET,
    chainId: 1,
    depositContract: GATEWAY,
    depositTo: WALLET,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "11000000",
    settlementTokenAddress: null,
    settlementTokenSymbol: null,
    settlementTokenDecimals: null,
    preflightMinimumTransferUnits: null,
    preflightWalletBalanceUnits: null,
    preflightWalletAllowanceUnits: null,
    preflightWalletNativeBalanceWei: null,
    preflightEthereumBlockNumber: null,
    preflightLighterBlockNumber: null,
    preflightObservedAt: null,
    preflightApproveGasLimit: null,
    preflightDepositGasLimit: null,
    preflightMaxFeePerGasWei: null,
    preflightMaxPriorityFeePerGasWei: null,
    preflightApproveMaxFeeWei: null,
    preflightDepositMaxFeeWei: null,
    preflightTotalMaxFeeWei: null,
    preflightNativeReserveWei: null,
    preflightRequiredNativeBalanceWei: null,
    approvalStatus: "approved",
    executionState: "ambiguous",
    approveTxHash: null,
    approveTxFrom: null,
    approveTxNonce: null,
    approveReplacementTxHash: null,
    approveReplacementReason: null,
    approveReplacementObservedAt: null,
    depositTxHash: null,
    depositTxFrom: null,
    depositTxNonce: null,
    depositReplacementTxHash: null,
    depositReplacementReason: null,
    depositReplacementObservedAt: null,
    depositL1BlockHash: null,
    depositL1BlockNumber: null,
    depositEventAccountIndex: null,
    lighterTxHash: null,
    lighterTxStatus: null,
    lighterBlockHeight: null,
    lighterExecutedAt: null,
    lighterEvidenceObservedAt: null,
    resolvedAccountIndex: null,
    decisionReason: null,
    failureReason: "receipt unavailable",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:01:00.000Z"),
    expiresAt: new Date("2030-01-01T00:15:00.000Z"),
    ...overrides,
  };
}
