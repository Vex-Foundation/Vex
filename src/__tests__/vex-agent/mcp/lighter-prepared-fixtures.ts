import { createHash } from "node:crypto";
import { encodeFunctionData } from "viem";
import { LIGHTER_CORE_WITHDRAW_GATEWAY_ABI } from "@tools/lighter/withdrawal/core-preflight.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import type { LighterKeyRegistrationReservationRow } from "@vex-agent/db/repos/lighter-key-registration-intents.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import type { LighterWithdrawalClaimAttemptRow } from "@vex-agent/db/repos/lighter-withdrawal-claims.js";
import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import type { LighterOrderPreviewRow } from "@vex-agent/db/repos/lighter-order-previews.js";
const suffix = "00000000-0000-4000-8000-000000000001";
const pending = { sessionId: "session-1", approvalStatus: "approval_pending" as const,
  executionState: "approval_pending" as const, expiresAt: "2030-01-01T00:00:00.000Z" };
const INTENT_ID = "lighter-onboard-00000000-0000-4000-8000-000000000001";
const WALLET = "0x1111111111111111111111111111111111111111";
const OBSERVED_AT = new Date("2030-01-01T00:00:00.000Z");
const INTENT_UPDATED_AT = new Date("2030-01-01T00:00:01.000Z");
const DEPOSIT_CALLDATA = buildLighterDepositCalldata({
  environment: "core",
  to: WALLET,
  amountUnits: 1_000_000n,
}).data;

const depositRow = {
  intentId: INTENT_ID,
  environment: "core",
  walletAddress: WALLET,
  depositTo: WALLET,
  depositContract: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
  chainId: 1,
  assetIndex: 3,
  routeType: 0,
  amountUnits: "1000000",
  settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  settlementTokenDecimals: 6,
  preflightMinimumTransferUnits: "1000000",
  preflightWalletBalanceUnits: "1975761",
  preflightWalletAllowanceUnits: "0",
  preflightWalletNativeBalanceWei: "512000000000000",
  preflightEthereumBlockNumber: "25776307",
  preflightLighterBlockNumber: "0",
  preflightObservedAt: OBSERVED_AT,
  preflightApproveGasLimit: "112698",
  preflightDepositGasLimit: "385004",
  preflightMaxFeePerGasWei: "120185306",
  preflightMaxPriorityFeePerGasWei: "100000000",
  preflightApproveMaxFeeWei: "13544642193588",
  preflightDepositMaxFeeWei: "46271739031624",
  preflightTotalMaxFeeWei: "59816381225212",
  preflightNativeReserveWei: "46271739031624",
  preflightRequiredNativeBalanceWei: "106088120256836",
  preflightPublicSnapshot: {
    observedAt: OBSERVED_AT.toISOString(),
    environment: "core",
    lighterRestBaseUrl: "https://mainnet.zklighter.elliot.ai",
    settlementNetworkName: "Ethereum mainnet",
    walletAddress: WALLET,
    beneficiaryAddress: WALLET,
    chainId: 1,
    settlementBlockNumber: "25776307",
    ethereumBlockNumber: "25776307",
    lighterBlockNumber: "0",
    gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
    gatewayImplementationAddress: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
    gatewayCodeHash: `0x${"1".repeat(64)}`,
    settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    settlementTokenImplementationAddress: null,
    settlementTokenCodeHash: `0x${"2".repeat(64)}`,
    settlementTokenSymbol: "USDC",
    settlementTokenDecimals: 6,
    assetIndex: 3,
    routeType: 0,
    amountUnits: "1000000",
    minimumTransferUnits: "1000000",
    depositCalldata: DEPOSIT_CALLDATA,
    depositValueWei: "0",
    walletBalanceUnits: "1975761",
    walletAllowanceUnits: "0",
    walletNativeBalanceWei: "512000000000000",
    approvalRequired: true,
    approveGasLimit: "112698",
    depositGasLimit: "385004",
    maxFeePerGasWei: "120185306",
    maxPriorityFeePerGasWei: "100000000",
    approveMaxFeeWei: "13544642193588",
    depositMaxFeeWei: "46271739031624",
    totalMaxFeeWei: "59816381225212",
    nativeReserveWei: "46271739031624",
    requiredNativeBalanceWei: "106088120256836",
  },
  updatedAt: INTENT_UPDATED_AT,
} as LighterOnboardingIntentRow;

export const deposit = { ...depositRow, settlementTokenSymbol: "USDC",
  preflightApproveMaxFeeWei: String(112698n * 120185306n),
  preflightDepositMaxFeeWei: String(385004n * 120185306n),
  preflightTotalMaxFeeWei: String((112698n + 385004n) * 120185306n),
  preflightNativeReserveWei: String(385004n * 120185306n),
  preflightRequiredNativeBalanceWei: String((112698n + 2n * 385004n) * 120185306n), ...pending, capability: "deposit" as const, expiresAt: new Date(pending.expiresAt) };
const PUBLIC_KEY = "ab".repeat(40);
const FINGERPRINT = createHash("sha256")
  .update(Buffer.from(PUBLIC_KEY, "hex"))
  .digest("hex");
const NOW = new Date("2030-01-01T00:00:00.000Z");

export const registration: LighterKeyRegistrationReservationRow = {
  intentId: "lighter-onboard-00000000-0000-4000-8000-000000000001",
  sessionId: "session-1",
  environment: "core",
  walletAddress: "0x1111111111111111111111111111111111111111",
  chainId: 1,
  accountIndex: 42,
  apiKeyIndex: 6,
  slotObservedAt: NOW,
  slotObservationHash: "a".repeat(64),
  approvalStatus: "approval_pending",
  executionState: "approval_pending",
  vaultCredentialId: "lighter/core/account-42/api-key-6",
  publicKey: PUBLIC_KEY,
  publicKeyFingerprint: FINGERPRINT,
  keyGeneratedAt: NOW,
  registrationNonce: "0",
  registrationNonceObservedAt: NOW,
  registrationTxType: null,
  registrationTxHash: null,
  registrationTxExpiredAt: null,
  registrationTxStagedAt: null,
  registrationSubmittedTxHash: null,
  registrationSubmitCode: null,
  registrationPredictedExecutionTimeMs: null,
  registrationSubmitAcceptedAt: null,
  registrationAmbiguityReason: null,
  registrationKeyVerifiedAt: null,
  registrationClientCheckedAt: null,
  postRegistrationNonce: null,
  registrationNonceSynchronizedAt: null,
  registrationActivatedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: new Date("2030-01-01T00:15:00.000Z"),
};
const withdrawalRow = {
  intentId: "withdrawal-rhc-1", previewId: "lwp_aaaaaaaaaaaaaaaaaaaaaaaa", sessionId: "session-1",
  matchHash: "a".repeat(64), environment: "rhc", operationClass: "secure_l2_withdrawal",
  signingChainId: 466324, settlementChainId: 4663,
  settlementNetworkName: "Robinhood Chain mainnet", accountIndex: 42, apiKeyIndex: 4,
  walletAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  destinationAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  assetIndex: 3, assetSymbol: "USDG", assetDecimals: 6,
  settlementTokenAddress: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  routeType: 0, amountUnits: "2000000", minimumWithdrawalUnits: "1000000",
  availableBalanceUnits: "8000000", collateralUnits: "10000000",
  initialMarginUnits: "1000000", pendingOrderCount: 0, openPositionCount: 0,
  activeOrderCount: 0, withdrawalDelaySeconds: 2687,
  gatewayAddress: "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d",
  gatewayImplementation: "0x82DE5B1161C93afDFE21bA0D5343f01Cd7401d90",
  gatewayCodeHash: `0x${"1".repeat(64)}`,
  settlementTokenCodeHash: `0x${"2".repeat(64)}`,
  preflightObservedAt: "2030-01-01T00:00:00.000Z",
} as unknown as LighterWithdrawalIntentRow;

export const withdrawal = { ...withdrawalRow, ...pending, intentId: `lighter-withdrawal-${suffix}`, estimatedClaimableAt: "2030-01-01T00:44:47.000Z" };
const claimRow = {
  claimId: "claim-1",
  withdrawalIntentId: "withdrawal-1",
  sessionId: "session-1",
  previewId: "lwcp_aaaaaaaaaaaaaaaaaaaaaaaa",
  matchHash: "a".repeat(64),
  operationClass: "manual_core_usdc_claim",
  settlementChainId: 1,
  settlementNetworkName: "Ethereum mainnet",
  walletAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  ownerAddress: "0xaCEE6141F6171491D34699C9266cb06A41FAA43C",
  gatewayAddress: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7",
  gatewayImplementation: "0x8D692294a4824d868e35B3CEcd734aCf41B2342e",
  gatewayCodeHash: `0x${"1".repeat(64)}`,
  settlementTokenAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  settlementTokenCodeHash: `0x${"2".repeat(64)}`,
  assetIndex: 3,
  assetSymbol: "USDC",
  assetDecimals: 6,
  amountUnits: "2000000",
  calldata: `0x${"3".repeat(200)}`,
  valueWei: "0",
  gasLimit: "200000",
  quotedMaxFeePerGasWei: "100000000",
  quotedPriorityFeePerGasWei: "1000000",
  networkFeeCeilingWei: "80000000000000",
  preflightBlockNumber: "20000000",
  preflightObservedAt: "2030-01-01T00:00:00.000Z",
} as unknown as LighterWithdrawalClaimAttemptRow;

export const claim = { ...claimRow, sessionId: "session-1", expiresAt: pending.expiresAt, state: "prepared" as const,
  claimId: `lighter-withdrawal-claim-${suffix}`, withdrawalIntentId: withdrawal.intentId,
  calldata: encodeFunctionData({ abi: LIGHTER_CORE_WITHDRAW_GATEWAY_ABI, functionName: "withdrawPendingBalance",
    args: [claimRow.ownerAddress as `0x${string}`, 3, BigInt(claimRow.amountUnits)] }) };
const EXPIRY = Date.parse("2030-01-01T00:00:00.000Z");
const ocoRow = {
  intentId: "lighter-oco-1", sessionId: "session-1", matchHash: "a".repeat(64),
  environment: "rhc", accountIndex: 42, apiKeyIndex: 7, marketIndex: 0, side: "sell",
  baseAmountInteger: "10000", stopLossPreviewId: "sl", stopLossMatchHash: "b".repeat(64),
  stopLossPriceInteger: "285000", stopLossTriggerPriceInteger: "290000",
  takeProfitPreviewId: "tp", takeProfitMatchHash: "c".repeat(64),
  takeProfitPriceInteger: "325000", takeProfitTriggerPriceInteger: "330000",
  orderExpiryMs: EXPIRY,
} as LighterOcoExecutionIntentRow;

export function leg(kind: "stop-loss" | "take-profit"): LighterOrderPreviewRow {
  const stop = kind === "stop-loss";
  return {
    previewId: stop ? "sl" : "tp", sessionId: "session-1",
    matchHash: stop ? "b".repeat(64) : "c".repeat(64), environment: "rhc",
    accountIndex: 42, apiKeyIndex: 7, marketIndex: 0, side: "sell",
    baseAmountInteger: "10000", priceInteger: stop ? "285000" : "325000",
    orderType: kind, timeInForce: "immediate-or-cancel", reduceOnly: true,
    triggerPriceInteger: stop ? "290000" : "330000", orderExpiryMs: EXPIRY,
    clientOrderIndexPolicy: "vex_assigned_uint48", providerVersion: "lighter-order-preview-v1",
    previewJson: {
      symbol: "ETH", marketType: "perp",
      baseAmount: { display: "1", integer: "10000", decimals: 4 },
      price: { display: stop ? "2850" : "3250", integer: stop ? "285000" : "325000", decimals: 2 },
    },
    liveSourceJson: {}, createdAt: "2029-01-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

export const oco = { ...ocoRow, ...pending, intentId: `lighter-oco-${suffix}` };
