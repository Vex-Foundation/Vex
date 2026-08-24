/** Explicit allow-list for trusted prepare → execute handoffs. */

import { createHash } from "node:crypto";

import type {
  ApprovalPreviewScalar,
  PreparedActionFollowUp,
} from "../types.js";
import {
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "@tools/lighter/wallet-funding/constants.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import { buildLighterDepositCalldata } from "@tools/lighter/wallet-funding/deposit-calldata.js";

/**
 * The ONE prepare → confirm handoff pair, as two exported constants.
 *
 * THE EMITTER AND THE VALIDATOR MUST AGREE, and nothing used to make them.
 * `tools/internal/wallet/send/prepare.ts` writes `toolName` into the follow-up
 * it authors, and {@link validatePreparedActionFollowUp} compares it against a
 * literal here; the two lived in different modules with no shared symbol, so
 * the Batch 2 rename silently broke the pair (the validator answered
 * `unknown_mapping` for every transfer — fail-closed, but the feature was
 * dead). Both sides now import these, so a future rename is a COMPILE ERROR
 * rather than a money-path feature that quietly stops working.
 *
 * Deliberately typed as literals (`as const`), not `string`: the literal type
 * is what lets {@link ValidatedPreparedActionFollowUp} keep naming the exact
 * tool rather than widening to `string`.
 */
export const PREPARED_ACTION_SOURCE_TOOL = "WalletSendPrepare" as const;
export const PREPARED_ACTION_FOLLOW_UP_TOOL = "WalletSendConfirm" as const;

export interface ValidatedWalletSendFollowUp {
  readonly toolName: typeof PREPARED_ACTION_FOLLOW_UP_TOOL;
  readonly args: {
    readonly walletFamily: "eip155" | "solana";
    readonly intentId: string;
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: typeof PREPARED_ACTION_FOLLOW_UP_TOOL;
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterOrderCreateFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.order.create";
    readonly params: {
      readonly intentId: string;
    };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "order.create";
    readonly namespace?: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterOrderCancelFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.order.cancel";
    readonly params: { readonly intentId: string };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "order.cancel";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterOrderModifyFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.order.modify";
    readonly params: { readonly intentId: string };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "order.modify";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterOrderCancelAllFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.order.cancelAll";
    readonly params: { readonly intentId: string };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "order.cancelAll";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterPositionCloseFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.position.close";
    readonly params: { readonly intentId: string };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "position.close";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterDepositFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.deposit";
    readonly params: {
      readonly intentId: string;
    };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "deposit";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterKeyRegistrationFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.key.register";
    readonly params: { readonly intentId: string };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "key.register";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export interface ValidatedLighterWithdrawalFollowUp {
  readonly toolName: "execute_tool";
  readonly args: {
    readonly toolId: "lighter.withdraw";
    readonly params: { readonly intentId: string };
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "withdraw";
    readonly namespace: "lighter";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export type ValidatedPreparedActionFollowUp =
  | ValidatedWalletSendFollowUp
  | ValidatedLighterOrderCreateFollowUp
  | ValidatedLighterOrderCancelFollowUp
  | ValidatedLighterOrderModifyFollowUp
  | ValidatedLighterOrderCancelAllFollowUp
  | ValidatedLighterPositionCloseFollowUp
  | ValidatedLighterDepositFollowUp
  | ValidatedLighterWithdrawalFollowUp
  | ValidatedLighterKeyRegistrationFollowUp;

export type PreparedActionFollowUpValidation =
  | { readonly ok: true; readonly followUp: ValidatedPreparedActionFollowUp }
  | { readonly ok: false; readonly reason: "unknown_mapping" | "invalid_contract" };

const WALLET_INTENT_ID_RE = /^intent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_INTENT_ID_RE = /^lighter-exec-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_LIFECYCLE_INTENT_ID_RE = /^lighter-lifecycle-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_DEPOSIT_INTENT_ID_RE = /^lighter-onboard-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_WITHDRAWAL_INTENT_ID_RE = /^lighter-withdrawal-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_ORDER_CREATE_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__order__create__prepare",
]);
const LIGHTER_ORDER_CANCEL_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__order__cancel__prepare",
]);
const LIGHTER_ORDER_MODIFY_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__order__modify__prepare",
]);
const LIGHTER_ORDER_CANCEL_ALL_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__order__cancelAll__prepare",
]);
const LIGHTER_POSITION_CLOSE_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__position__close__prepare",
]);
const LIGHTER_DEPOSIT_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__deposit__prepare",
]);
const LIGHTER_KEY_REGISTRATION_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__key__register__prepare",
]);
const LIGHTER_WITHDRAWAL_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__withdraw__prepare",
]);
const PREVIEW_KEYS = ["network", "chain", "to", "amount", "token"] as const;
const LIGHTER_PREVIEW_KEYS = [
  "orderSummary",
  "marketSymbol",
  "baseAmountDisplay",
  "priceDisplay",
  "notionalDisplay",
  "orderExpiryIso",
  "toolId",
  "intentId",
  "environment",
  "accountIndex",
  "apiKeyIndex",
  "marketIndex",
  "side",
  "baseAmountInteger",
  "priceInteger",
  "orderType",
  "timeInForce",
  "reduceOnly",
  "previewId",
  "matchHash",
] as const;
const LIGHTER_DEPOSIT_PREVIEW_KEYS = [
  "toolId",
  "intentId",
  "environment",
  "walletAddress",
  "depositTo",
  "depositContract",
  "chainId",
  "assetIndex",
  "routeType",
  "amountUnits",
  "amountDisplay",
  "settlementTokenAddress",
  "settlementTokenDecimals",
  "preflightMinimumTransferUnits",
  "preflightWalletBalanceUnits",
  "preflightWalletAllowanceUnits",
  "preflightEthereumBlockNumber",
  "preflightLighterBlockNumber",
  "preflightObservedAt",
  "settlementNetworkName",
  "lighterRestBaseUrl",
  "beneficiaryAddress",
  "gatewayImplementationAddress",
  "gatewayCodeHash",
  "settlementTokenImplementationAddress",
  "settlementTokenCodeHash",
  "depositCalldata",
  "depositValueWei",
  "approvalRequired",
  "summary",
  "scopeNote",
] as const;
const LIGHTER_KEY_REGISTRATION_PREVIEW_KEYS = [
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
const LIGHTER_WITHDRAWAL_PREVIEW_KEYS = [
  "toolId", "intentId", "previewId", "matchHash", "environment", "operationClass",
  "accountIndex", "apiKeyIndex", "walletAddress", "destinationAddress", "signingChainId",
  "settlementChainId", "settlementNetworkName", "assetIndex", "assetSymbol", "assetDecimals",
  "settlementTokenAddress", "routeType", "route", "amountUnits", "amountDisplay",
  "minimumWithdrawalUnits", "availableBalanceUnits", "collateralUnits", "initialMarginUnits",
  "pendingOrderCount", "openPositionCount", "activeOrderCount", "withdrawalDelaySeconds",
  "estimatedClaimableAt", "gatewayAddress", "gatewayImplementation", "gatewayCodeHash",
  "settlementTokenCodeHash", "preflightObservedAt", "summary", "scopeNote",
] as const;

const LIGHTER_DISPLAY_AMOUNT_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const LIGHTER_DEPOSIT_DISPLAY_AMOUNT_RE =
  /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)? (?:USDC|USDG)$/;
const EVM_ADDRESS_RE = /^0x[0-9a-f]{40}$/i;

function isScalar(value: unknown): value is ApprovalPreviewScalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Validate and canonicalize a handler-authored follow-up. Unknown pairs fail
 * closed. For wallet sends, only walletFamily + intentId cross into confirm
 * args (`criticalArgs` keeps the preview vocabulary, where the family is still
 * spelled `network` — that is stored preview data, not a param);
 * the richer preview is validated independently and never rebuilt from args.
 *
 * Maintainer decision: every prepare → execute/confirm mapping must be named
 * here. The registry currently allows WalletSendPrepare → WalletSendConfirm
 * and the protocol `execute_tool` handoffs for the explicitly registered
 * Lighter order, deposit, key-registration, and withdrawal intents. Every
 * other source/target pair fails closed as "unknown_mapping".
 */
export function validatePreparedActionFollowUp(
  sourceToolName: string,
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (
    LIGHTER_ORDER_CREATE_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.order.create"
  ) {
    return validateLighterOrderCreateFollowUp(candidate);
  }
  if (
    LIGHTER_ORDER_CANCEL_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.order.cancel"
  ) {
    return validateLighterOrderCancelFollowUp(candidate);
  }
  if (
    LIGHTER_ORDER_MODIFY_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.order.modify"
  ) {
    return validateLighterOrderModifyFollowUp(candidate);
  }
  if (
    LIGHTER_ORDER_CANCEL_ALL_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.order.cancelAll"
  ) {
    return validateLighterOrderCancelAllFollowUp(candidate);
  }
  if (
    LIGHTER_POSITION_CLOSE_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.position.close"
  ) {
    return validateLighterPositionCloseFollowUp(candidate);
  }
  if (
    LIGHTER_DEPOSIT_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.deposit"
  ) {
    return validateLighterDepositFollowUp(candidate);
  }
  if (
    LIGHTER_KEY_REGISTRATION_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.key.register"
  ) {
    return validateLighterKeyRegistrationFollowUp(candidate);
  }
  if (
    LIGHTER_WITHDRAWAL_PREPARE_SOURCES.has(sourceToolName)
    && candidate.toolName === "execute_tool"
    && candidate.args.toolId === "lighter.withdraw"
  ) {
    return validateLighterWithdrawalFollowUp(candidate);
  }

  if (
    sourceToolName !== PREPARED_ACTION_SOURCE_TOOL ||
    candidate.toolName !== PREPARED_ACTION_FOLLOW_UP_TOOL
  ) {
    return { ok: false, reason: "unknown_mapping" };
  }

  const argKeys = Object.keys(candidate.args).sort();
  if (argKeys.join(",") !== "intentId,walletFamily") {
    return { ok: false, reason: "invalid_contract" };
  }
  const network = candidate.args.walletFamily;
  const intentId = candidate.args.intentId;
  if (
    (network !== "eip155" && network !== "solana") ||
    typeof intentId !== "string" ||
    !WALLET_INTENT_ID_RE.test(intentId)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }

  const preview = candidate.approvalPreview;
  if (preview.toolName !== PREPARED_ACTION_FOLLOW_UP_TOOL) {
    return { ok: false, reason: "invalid_contract" };
  }
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  if (
    criticalArgs.network !== network ||
    typeof criticalArgs.to !== "string" ||
    criticalArgs.to.length === 0 ||
    typeof criticalArgs.amount !== "string" ||
    criticalArgs.amount.length === 0 ||
    !(criticalArgs.chain === null || typeof criticalArgs.chain === "string") ||
    !(criticalArgs.token === null || typeof criticalArgs.token === "string")
  ) {
    return { ok: false, reason: "invalid_contract" };
  }
  if (
    (network === "eip155" &&
      !(typeof criticalArgs.chain === "string" && criticalArgs.chain.length > 0)) ||
    (network === "solana" && criticalArgs.chain !== null)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }

  return {
    ok: true,
    followUp: {
      toolName: PREPARED_ACTION_FOLLOW_UP_TOOL,
      args: { walletFamily: network, intentId },
      expiresAt: candidate.expiresAt,
      approvalPreview: {
        toolName: PREPARED_ACTION_FOLLOW_UP_TOOL,
        criticalArgs,
      },
    },
  };
}

function validateLighterKeyRegistrationFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) {
    return { ok: false, reason: "invalid_contract" };
  }
  if (
    Object.keys(candidate.args).sort().join(",") !== "params,toolId"
    || candidate.args.toolId !== "lighter.key.register"
  ) {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const paramsRecord = params as Record<string, unknown>;
  const intentId = paramsRecord.intentId;
  if (
    Object.keys(paramsRecord).join(",") !== "intentId"
    || typeof intentId !== "string"
    || !LIGHTER_DEPOSIT_INTENT_ID_RE.test(intentId)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }
  const preview = candidate.approvalPreview;
  if (preview.toolName !== "key.register" || preview.namespace !== "lighter") {
    return { ok: false, reason: "invalid_contract" };
  }
  if (
    Object.keys(preview.criticalArgs).sort().join(",")
    !== [...LIGHTER_KEY_REGISTRATION_PREVIEW_KEYS].sort().join(",")
  ) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_KEY_REGISTRATION_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  const environment = criticalArgs.environment;
  if (environment !== "core" && environment !== "rhc") {
    return { ok: false, reason: "invalid_contract" };
  }
  const deployment = getLighterFundingDeployment(environment);
  const publicKey = criticalArgs.publicKey;
  const fingerprint = criticalArgs.publicKeyFingerprint;
  if (
    criticalArgs.toolId !== "lighter.key.register"
    || criticalArgs.intentId !== intentId
    || typeof criticalArgs.walletAddress !== "string"
    || !EVM_ADDRESS_RE.test(criticalArgs.walletAddress)
    || criticalArgs.ethereumChainId !== deployment.settlementChainId
    || criticalArgs.lighterChainId !== deployment.lighterSignerChainId
    || typeof criticalArgs.accountIndex !== "number"
    || !Number.isSafeInteger(criticalArgs.accountIndex)
    || criticalArgs.accountIndex <= 0
    || typeof criticalArgs.apiKeyIndex !== "number"
    || !Number.isInteger(criticalArgs.apiKeyIndex)
    || criticalArgs.apiKeyIndex < 4
    || criticalArgs.apiKeyIndex > 254
    || typeof criticalArgs.registrationNonce !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(criticalArgs.registrationNonce)
    || BigInt(criticalArgs.registrationNonce) > (1n << 48n) - 1n
    || typeof publicKey !== "string"
    || !/^[0-9a-f]{80}$/.test(publicKey)
    || typeof fingerprint !== "string"
    || !/^[0-9a-f]{64}$/.test(fingerprint)
    || createHash("sha256").update(Buffer.from(publicKey, "hex")).digest("hex")
      !== fingerprint
    || criticalArgs.vaultCredentialId
      !== `lighter/${environment}/account-${criticalArgs.accountIndex}/api-key-${criticalArgs.apiKeyIndex}`
    || !isBoundedText(criticalArgs.summary)
    || !isBoundedText(criticalArgs.authorityNote)
    || !isBoundedText(criticalArgs.signatureNote)
    || !isBoundedText(criticalArgs.scopeNote)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }
  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: {
        toolId: "lighter.key.register",
        params: { intentId },
      },
      expiresAt: candidate.expiresAt,
      approvalPreview: {
        toolName: "key.register",
        namespace: "lighter",
        criticalArgs,
      },
    },
  };
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 600;
}

function validateLighterDepositFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) {
    return { ok: false, reason: "invalid_contract" };
  }
  const argKeys = Object.keys(candidate.args).sort();
  if (argKeys.join(",") !== "params,toolId" || candidate.args.toolId !== "lighter.deposit") {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const paramsRecord = params as Record<string, unknown>;
  const intentId = paramsRecord.intentId;
  if (
    Object.keys(paramsRecord).join(",") !== "intentId" ||
    typeof intentId !== "string" ||
    !LIGHTER_DEPOSIT_INTENT_ID_RE.test(intentId)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }

  const preview = candidate.approvalPreview;
  if (preview.toolName !== "deposit" || preview.namespace !== "lighter") {
    return { ok: false, reason: "invalid_contract" };
  }
  if (
    Object.keys(preview.criticalArgs).sort().join(",") !==
    [...LIGHTER_DEPOSIT_PREVIEW_KEYS].sort().join(",")
  ) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_DEPOSIT_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  const environment = criticalArgs.environment;
  if (environment !== "core" && environment !== "rhc") {
    return { ok: false, reason: "invalid_contract" };
  }
  const funding = getLighterFundingDeployment(environment);
  const exactDepositCalldata = expectedLighterDepositCalldata(criticalArgs, environment);
  if (
    criticalArgs.toolId !== "lighter.deposit" ||
    criticalArgs.intentId !== intentId ||
    criticalArgs.environment !== funding.environment ||
    typeof criticalArgs.walletAddress !== "string" ||
    !EVM_ADDRESS_RE.test(criticalArgs.walletAddress) ||
    criticalArgs.depositTo !== criticalArgs.walletAddress ||
    typeof criticalArgs.depositContract !== "string" ||
    criticalArgs.depositContract.toLowerCase() !== funding.gatewayProxy.toLowerCase() ||
    criticalArgs.chainId !== funding.settlementChainId ||
    criticalArgs.assetIndex !== funding.settlementAssetIndex ||
    criticalArgs.routeType !== funding.perpsRouteType ||
    typeof criticalArgs.amountUnits !== "string" ||
    !/^[1-9][0-9]*$/.test(criticalArgs.amountUnits) ||
    typeof criticalArgs.amountDisplay !== "string" ||
    !LIGHTER_DEPOSIT_DISPLAY_AMOUNT_RE.test(criticalArgs.amountDisplay) ||
    !criticalArgs.amountDisplay.endsWith(` ${funding.settlementSymbol}`) ||
    typeof criticalArgs.settlementTokenAddress !== "string" ||
    criticalArgs.settlementTokenAddress.toLowerCase() !==
      funding.settlementTokenProxy.toLowerCase() ||
    criticalArgs.settlementTokenDecimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS ||
    !isPositiveIntegerString(criticalArgs.preflightMinimumTransferUnits) ||
    !isNonNegativeIntegerString(criticalArgs.preflightWalletBalanceUnits) ||
    !isNonNegativeIntegerString(criticalArgs.preflightWalletAllowanceUnits) ||
    !isPositiveIntegerString(criticalArgs.preflightEthereumBlockNumber) ||
    !isNonNegativeIntegerString(criticalArgs.preflightLighterBlockNumber) ||
    typeof criticalArgs.preflightObservedAt !== "string" ||
    !Number.isFinite(Date.parse(criticalArgs.preflightObservedAt)) ||
    criticalArgs.settlementNetworkName !== funding.settlementNetworkName ||
    criticalArgs.lighterRestBaseUrl !== funding.restBaseUrl ||
    criticalArgs.beneficiaryAddress !== criticalArgs.walletAddress ||
    (criticalArgs.gatewayImplementationAddress !== null
      && (typeof criticalArgs.gatewayImplementationAddress !== "string"
        || !EVM_ADDRESS_RE.test(criticalArgs.gatewayImplementationAddress))) ||
    (funding.expectedGatewayImplementation !== undefined
      && typeof criticalArgs.gatewayImplementationAddress === "string"
      && criticalArgs.gatewayImplementationAddress.toLowerCase()
        !== funding.expectedGatewayImplementation.toLowerCase()) ||
    (funding.expectedGatewayImplementation !== undefined
      && criticalArgs.gatewayImplementationAddress === null) ||
    typeof criticalArgs.gatewayCodeHash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(criticalArgs.gatewayCodeHash) ||
    (criticalArgs.settlementTokenImplementationAddress !== null
      && (typeof criticalArgs.settlementTokenImplementationAddress !== "string"
        || !EVM_ADDRESS_RE.test(criticalArgs.settlementTokenImplementationAddress))) ||
    (funding.expectedSettlementTokenImplementation !== undefined
      && typeof criticalArgs.settlementTokenImplementationAddress === "string"
      && criticalArgs.settlementTokenImplementationAddress.toLowerCase()
        !== funding.expectedSettlementTokenImplementation.toLowerCase()) ||
    (funding.expectedSettlementTokenImplementation !== undefined
      && criticalArgs.settlementTokenImplementationAddress === null) ||
    typeof criticalArgs.settlementTokenCodeHash !== "string" ||
    !/^0x[0-9a-f]{64}$/i.test(criticalArgs.settlementTokenCodeHash) ||
    typeof criticalArgs.depositCalldata !== "string" ||
    !/^0x8a857083[0-9a-f]+$/i.test(criticalArgs.depositCalldata) ||
    criticalArgs.depositCalldata.toLowerCase() !== exactDepositCalldata?.toLowerCase() ||
    criticalArgs.depositValueWei !== "0" ||
    typeof criticalArgs.approvalRequired !== "boolean" ||
    BigInt(criticalArgs.preflightWalletBalanceUnits) < BigInt(criticalArgs.amountUnits) ||
    BigInt(criticalArgs.preflightMinimumTransferUnits) > BigInt(criticalArgs.amountUnits) ||
    criticalArgs.approvalRequired !== (
      BigInt(criticalArgs.preflightWalletAllowanceUnits) < BigInt(criticalArgs.amountUnits)
    ) ||
    typeof criticalArgs.summary !== "string" ||
    criticalArgs.summary.trim().length === 0 ||
    criticalArgs.summary.length > 600 ||
    typeof criticalArgs.scopeNote !== "string" ||
    criticalArgs.scopeNote.trim().length === 0 ||
    criticalArgs.scopeNote.length > 600
  ) {
    return { ok: false, reason: "invalid_contract" };
  }

  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: {
        toolId: "lighter.deposit",
        params: { intentId },
      },
      expiresAt: candidate.expiresAt,
      approvalPreview: {
        toolName: "deposit",
        namespace: "lighter",
        criticalArgs,
      },
    },
  };
}

function expectedLighterDepositCalldata(
  criticalArgs: Record<string, ApprovalPreviewScalar>,
  environment: "core" | "rhc",
): string | null {
  if (
    typeof criticalArgs.walletAddress !== "string"
    || typeof criticalArgs.amountUnits !== "string"
    || !/^[1-9][0-9]*$/.test(criticalArgs.amountUnits)
    || typeof criticalArgs.assetIndex !== "number"
    || criticalArgs.routeType !== 0
  ) return null;
  try {
    return buildLighterDepositCalldata({
      environment,
      to: criticalArgs.walletAddress,
      amountUnits: BigInt(criticalArgs.amountUnits),
      assetIndex: criticalArgs.assetIndex,
      route: "perps",
    }).data;
  } catch {
    return null;
  }
}

function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isNonNegativeIntegerString(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function validateLighterOrderCreateFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) {
    return { ok: false, reason: "invalid_contract" };
  }
  const argKeys = Object.keys(candidate.args).sort();
  if (argKeys.join(",") !== "params,toolId") {
    return { ok: false, reason: "invalid_contract" };
  }
  if (candidate.args.toolId !== "lighter.order.create") {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const intentId = (params as Record<string, unknown>).intentId;
  if (
    Object.keys(params as Record<string, unknown>).join(",") !== "intentId" ||
    typeof intentId !== "string" ||
    !LIGHTER_INTENT_ID_RE.test(intentId)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }

  const preview = candidate.approvalPreview;
  if (preview.toolName !== "order.create" || preview.namespace !== "lighter") {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  if (
    typeof criticalArgs.orderSummary !== "string" ||
    criticalArgs.orderSummary.trim().length === 0 ||
    criticalArgs.orderSummary.length > 600 ||
    typeof criticalArgs.marketSymbol !== "string" ||
    criticalArgs.marketSymbol.trim().length === 0 ||
    criticalArgs.marketSymbol.length > 32 ||
    typeof criticalArgs.baseAmountDisplay !== "string" ||
    !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.baseAmountDisplay) ||
    typeof criticalArgs.priceDisplay !== "string" ||
    !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.priceDisplay) ||
    typeof criticalArgs.notionalDisplay !== "string" ||
    !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.notionalDisplay) ||
    typeof criticalArgs.orderExpiryIso !== "string" ||
    !Number.isFinite(Date.parse(criticalArgs.orderExpiryIso)) ||
    criticalArgs.toolId !== "lighter.order.create" ||
    criticalArgs.intentId !== intentId ||
    (criticalArgs.environment !== "core" && criticalArgs.environment !== "rhc") ||
    typeof criticalArgs.accountIndex !== "number" ||
    !Number.isSafeInteger(criticalArgs.accountIndex) ||
    criticalArgs.accountIndex < 0 ||
    typeof criticalArgs.apiKeyIndex !== "number" ||
    !Number.isSafeInteger(criticalArgs.apiKeyIndex) ||
    criticalArgs.apiKeyIndex < 4 ||
    criticalArgs.apiKeyIndex > 254 ||
    typeof criticalArgs.marketIndex !== "number" ||
    !Number.isSafeInteger(criticalArgs.marketIndex) ||
    criticalArgs.marketIndex < 0 ||
    criticalArgs.marketIndex > 65_535 ||
    (criticalArgs.side !== "buy" && criticalArgs.side !== "sell") ||
    typeof criticalArgs.baseAmountInteger !== "string" ||
    !/^[1-9][0-9]*$/.test(criticalArgs.baseAmountInteger) ||
    typeof criticalArgs.priceInteger !== "string" ||
    !/^[1-9][0-9]*$/.test(criticalArgs.priceInteger) ||
    (criticalArgs.orderType !== "limit" && criticalArgs.orderType !== "market") ||
    !(
      criticalArgs.timeInForce === "good-till-time" ||
      criticalArgs.timeInForce === "immediate-or-cancel" ||
      criticalArgs.timeInForce === "post-only"
    ) ||
    typeof criticalArgs.reduceOnly !== "boolean" ||
    typeof criticalArgs.previewId !== "string" ||
    criticalArgs.previewId.length === 0 ||
    typeof criticalArgs.matchHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(criticalArgs.matchHash)
  ) {
    return { ok: false, reason: "invalid_contract" };
  }

  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId },
      },
      expiresAt: candidate.expiresAt,
      approvalPreview: {
        toolName: "order.create",
        namespace: "lighter",
        criticalArgs,
      },
    },
  };
}

const LIGHTER_CANCEL_PREVIEW_KEYS = [
  "toolId", "intentId", "actionType", "environment", "accountIndex", "apiKeyIndex",
  "marketIndex", "providerOrderId", "clientOrderId", "side", "orderType", "timeInForce",
  "price", "initialBaseAmount", "remainingBaseAmount", "filledBaseAmount", "matchHash", "summary",
] as const;

function validateLighterOrderCancelFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) return { ok: false, reason: "invalid_contract" };
  if (Object.keys(candidate.args).sort().join(",") !== "params,toolId" || candidate.args.toolId !== "lighter.order.cancel") {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return { ok: false, reason: "invalid_contract" };
  const intentId = (params as Record<string, unknown>).intentId;
  if (Object.keys(params as Record<string, unknown>).join(",") !== "intentId" || typeof intentId !== "string" || !LIGHTER_LIFECYCLE_INTENT_ID_RE.test(intentId)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const preview = candidate.approvalPreview;
  if (preview.toolName !== "order.cancel" || preview.namespace !== "lighter") return { ok: false, reason: "invalid_contract" };
  if (Object.keys(preview.criticalArgs).sort().join(",") !== [...LIGHTER_CANCEL_PREVIEW_KEYS].sort().join(",")) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_CANCEL_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  if (
    criticalArgs.toolId !== "lighter.order.cancel" || criticalArgs.intentId !== intentId
    || criticalArgs.actionType !== "cancel_one"
    || (criticalArgs.environment !== "core" && criticalArgs.environment !== "rhc")
    || typeof criticalArgs.accountIndex !== "number" || !Number.isSafeInteger(criticalArgs.accountIndex) || criticalArgs.accountIndex < 0
    || typeof criticalArgs.apiKeyIndex !== "number" || !Number.isInteger(criticalArgs.apiKeyIndex) || criticalArgs.apiKeyIndex < 4 || criticalArgs.apiKeyIndex > 254
    || typeof criticalArgs.marketIndex !== "number" || !Number.isInteger(criticalArgs.marketIndex) || criticalArgs.marketIndex < 0 || criticalArgs.marketIndex > 65_535
    || typeof criticalArgs.providerOrderId !== "string" || !/^[1-9][0-9]*$/.test(criticalArgs.providerOrderId)
    || BigInt(criticalArgs.providerOrderId) > (1n << 60n) - 1n
    || typeof criticalArgs.clientOrderId !== "string" || !/^[0-9]+$/.test(criticalArgs.clientOrderId)
    || typeof criticalArgs.side !== "string" || typeof criticalArgs.orderType !== "string"
    || typeof criticalArgs.timeInForce !== "string" || typeof criticalArgs.price !== "string"
    || typeof criticalArgs.initialBaseAmount !== "string" || typeof criticalArgs.remainingBaseAmount !== "string"
    || typeof criticalArgs.filledBaseAmount !== "string" || typeof criticalArgs.matchHash !== "string"
    || !/^[0-9a-f]{64}$/.test(criticalArgs.matchHash)
    || typeof criticalArgs.summary !== "string" || criticalArgs.summary.length < 1 || criticalArgs.summary.length > 600
  ) return { ok: false, reason: "invalid_contract" };
  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: { toolId: "lighter.order.cancel", params: { intentId } },
      expiresAt: candidate.expiresAt,
      approvalPreview: { toolName: "order.cancel", namespace: "lighter", criticalArgs },
    },
  };
}

const LIGHTER_MODIFY_PREVIEW_KEYS = [
  ...LIGHTER_CANCEL_PREVIEW_KEYS,
  "requestedBaseAmount", "requestedBaseAmountInteger", "requestedPrice", "requestedPriceInteger",
] as const;

function validateLighterOrderModifyFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) return { ok: false, reason: "invalid_contract" };
  if (Object.keys(candidate.args).sort().join(",") !== "params,toolId" || candidate.args.toolId !== "lighter.order.modify") {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return { ok: false, reason: "invalid_contract" };
  const intentId = (params as Record<string, unknown>).intentId;
  if (Object.keys(params as Record<string, unknown>).join(",") !== "intentId" || typeof intentId !== "string" || !LIGHTER_LIFECYCLE_INTENT_ID_RE.test(intentId)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const preview = candidate.approvalPreview;
  if (preview.toolName !== "order.modify" || preview.namespace !== "lighter") return { ok: false, reason: "invalid_contract" };
  if (Object.keys(preview.criticalArgs).sort().join(",") !== [...LIGHTER_MODIFY_PREVIEW_KEYS].sort().join(",")) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_MODIFY_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  if (
    criticalArgs.toolId !== "lighter.order.modify" || criticalArgs.intentId !== intentId
    || criticalArgs.actionType !== "modify"
    || (criticalArgs.environment !== "core" && criticalArgs.environment !== "rhc")
    || typeof criticalArgs.accountIndex !== "number" || !Number.isSafeInteger(criticalArgs.accountIndex) || criticalArgs.accountIndex < 0
    || typeof criticalArgs.apiKeyIndex !== "number" || !Number.isInteger(criticalArgs.apiKeyIndex) || criticalArgs.apiKeyIndex < 4 || criticalArgs.apiKeyIndex > 254
    || typeof criticalArgs.marketIndex !== "number" || !Number.isInteger(criticalArgs.marketIndex) || criticalArgs.marketIndex < 0 || criticalArgs.marketIndex > 65_535
    || typeof criticalArgs.providerOrderId !== "string" || !/^[1-9][0-9]*$/.test(criticalArgs.providerOrderId)
    || BigInt(criticalArgs.providerOrderId) > (1n << 60n) - 1n
    || typeof criticalArgs.clientOrderId !== "string" || !/^[0-9]+$/.test(criticalArgs.clientOrderId)
    || typeof criticalArgs.side !== "string" || typeof criticalArgs.orderType !== "string"
    || typeof criticalArgs.timeInForce !== "string" || typeof criticalArgs.price !== "string"
    || typeof criticalArgs.initialBaseAmount !== "string" || typeof criticalArgs.remainingBaseAmount !== "string"
    || typeof criticalArgs.filledBaseAmount !== "string" || typeof criticalArgs.matchHash !== "string"
    || !/^[0-9a-f]{64}$/.test(criticalArgs.matchHash)
    || typeof criticalArgs.requestedBaseAmount !== "string" || !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.requestedBaseAmount)
    || typeof criticalArgs.requestedPrice !== "string" || !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.requestedPrice)
    || typeof criticalArgs.requestedBaseAmountInteger !== "string" || !/^[1-9][0-9]*$/.test(criticalArgs.requestedBaseAmountInteger)
    || BigInt(criticalArgs.requestedBaseAmountInteger) > (1n << 48n) - 1n
    || typeof criticalArgs.requestedPriceInteger !== "string" || !/^[1-9][0-9]*$/.test(criticalArgs.requestedPriceInteger)
    || BigInt(criticalArgs.requestedPriceInteger) > (1n << 32n) - 1n
    || typeof criticalArgs.summary !== "string" || criticalArgs.summary.length < 1 || criticalArgs.summary.length > 600
  ) return { ok: false, reason: "invalid_contract" };
  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: { toolId: "lighter.order.modify", params: { intentId } },
      expiresAt: candidate.expiresAt,
      approvalPreview: { toolName: "order.modify", namespace: "lighter", criticalArgs },
    },
  };
}

const LIGHTER_CANCEL_ALL_PREVIEW_KEYS = [
  "toolId", "intentId", "actionType", "environment", "accountIndex", "apiKeyIndex",
  "orderCount", "orderIdentities", "timeInForce", "cancelAtMs", "matchHash", "summary",
] as const;

function validateLighterOrderCancelAllFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) return { ok: false, reason: "invalid_contract" };
  if (Object.keys(candidate.args).sort().join(",") !== "params,toolId" || candidate.args.toolId !== "lighter.order.cancelAll") {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return { ok: false, reason: "invalid_contract" };
  const intentId = (params as Record<string, unknown>).intentId;
  if (Object.keys(params as Record<string, unknown>).join(",") !== "intentId" || typeof intentId !== "string" || !LIGHTER_LIFECYCLE_INTENT_ID_RE.test(intentId)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const preview = candidate.approvalPreview;
  if (preview.toolName !== "order.cancelAll" || preview.namespace !== "lighter") return { ok: false, reason: "invalid_contract" };
  if (Object.keys(preview.criticalArgs).sort().join(",") !== [...LIGHTER_CANCEL_ALL_PREVIEW_KEYS].sort().join(",")) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_CANCEL_ALL_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  const identities = typeof criticalArgs.orderIdentities === "string"
    ? criticalArgs.orderIdentities.split(",") : [];
  const validIdentities = identities.length > 0 && identities.length <= 100 && identities.every((identity) => {
    const match = /^(\d+):([1-9][0-9]*)$/.exec(identity);
    if (match === null) return false;
    const marketIndex = Number(match[1]);
    return Number.isInteger(marketIndex) && marketIndex >= 0 && marketIndex <= 65_535
      && BigInt(match[2]!) <= (1n << 60n) - 1n;
  });
  if (
    criticalArgs.toolId !== "lighter.order.cancelAll" || criticalArgs.intentId !== intentId
    || criticalArgs.actionType !== "cancel_all"
    || (criticalArgs.environment !== "core" && criticalArgs.environment !== "rhc")
    || typeof criticalArgs.accountIndex !== "number" || !Number.isSafeInteger(criticalArgs.accountIndex) || criticalArgs.accountIndex < 0
    || typeof criticalArgs.apiKeyIndex !== "number" || !Number.isInteger(criticalArgs.apiKeyIndex) || criticalArgs.apiKeyIndex < 4 || criticalArgs.apiKeyIndex > 254
    || typeof criticalArgs.orderCount !== "number" || !Number.isInteger(criticalArgs.orderCount)
    || criticalArgs.orderCount !== identities.length || !validIdentities
    || criticalArgs.timeInForce !== 0 || criticalArgs.cancelAtMs !== "0"
    || typeof criticalArgs.matchHash !== "string" || !/^[0-9a-f]{64}$/.test(criticalArgs.matchHash)
    || typeof criticalArgs.summary !== "string" || criticalArgs.summary.length < 1 || criticalArgs.summary.length > 600
  ) return { ok: false, reason: "invalid_contract" };
  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: { toolId: "lighter.order.cancelAll", params: { intentId } },
      expiresAt: candidate.expiresAt,
      approvalPreview: { toolName: "order.cancelAll", namespace: "lighter", criticalArgs },
    },
  };
}

const LIGHTER_POSITION_CLOSE_PREVIEW_KEYS = [
  "toolId", "intentId", "actionType", "environment", "accountIndex", "apiKeyIndex",
  "marketIndex", "symbol", "positionSide", "positionAmount", "averageEntryPrice", "closingSide",
  "baseAmount", "baseAmountInteger", "worstAcceptablePrice", "priceInteger", "maxSlippageBps",
  "reduceOnly", "orderType", "timeInForce", "matchHash", "summary",
] as const;

function validateLighterPositionCloseFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) return { ok: false, reason: "invalid_contract" };
  if (Object.keys(candidate.args).sort().join(",") !== "params,toolId" || candidate.args.toolId !== "lighter.position.close") {
    return { ok: false, reason: "invalid_contract" };
  }
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return { ok: false, reason: "invalid_contract" };
  const intentId = (params as Record<string, unknown>).intentId;
  if (Object.keys(params as Record<string, unknown>).join(",") !== "intentId" || typeof intentId !== "string" || !LIGHTER_LIFECYCLE_INTENT_ID_RE.test(intentId)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const preview = candidate.approvalPreview;
  if (preview.toolName !== "position.close" || preview.namespace !== "lighter") return { ok: false, reason: "invalid_contract" };
  if (Object.keys(preview.criticalArgs).sort().join(",") !== [...LIGHTER_POSITION_CLOSE_PREVIEW_KEYS].sort().join(",")) {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_POSITION_CLOSE_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  if (
    criticalArgs.toolId !== "lighter.position.close" || criticalArgs.intentId !== intentId
    || criticalArgs.actionType !== "close_position"
    || (criticalArgs.environment !== "core" && criticalArgs.environment !== "rhc")
    || typeof criticalArgs.accountIndex !== "number" || !Number.isSafeInteger(criticalArgs.accountIndex) || criticalArgs.accountIndex < 0
    || typeof criticalArgs.apiKeyIndex !== "number" || !Number.isInteger(criticalArgs.apiKeyIndex) || criticalArgs.apiKeyIndex < 4 || criticalArgs.apiKeyIndex > 254
    || typeof criticalArgs.marketIndex !== "number" || !Number.isInteger(criticalArgs.marketIndex) || criticalArgs.marketIndex < 0 || criticalArgs.marketIndex > 254
    || typeof criticalArgs.symbol !== "string" || criticalArgs.symbol.length < 1 || criticalArgs.symbol.length > 32
    || (criticalArgs.positionSide !== "long" && criticalArgs.positionSide !== "short")
    || (criticalArgs.closingSide !== "buy" && criticalArgs.closingSide !== "sell")
    || (criticalArgs.positionSide === "long" ? criticalArgs.closingSide !== "sell" : criticalArgs.closingSide !== "buy")
    || typeof criticalArgs.positionAmount !== "string" || !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.positionAmount)
    || typeof criticalArgs.averageEntryPrice !== "string" || !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.averageEntryPrice)
    || typeof criticalArgs.baseAmount !== "string" || !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.baseAmount)
    || typeof criticalArgs.worstAcceptablePrice !== "string" || !LIGHTER_DISPLAY_AMOUNT_RE.test(criticalArgs.worstAcceptablePrice)
    || typeof criticalArgs.baseAmountInteger !== "string" || !/^[1-9][0-9]*$/.test(criticalArgs.baseAmountInteger)
    || BigInt(criticalArgs.baseAmountInteger) > (1n << 48n) - 1n
    || typeof criticalArgs.priceInteger !== "string" || !/^[1-9][0-9]*$/.test(criticalArgs.priceInteger)
    || BigInt(criticalArgs.priceInteger) > (1n << 32n) - 1n
    || typeof criticalArgs.maxSlippageBps !== "number" || !Number.isInteger(criticalArgs.maxSlippageBps)
    || criticalArgs.maxSlippageBps < 1 || criticalArgs.maxSlippageBps > 500
    || criticalArgs.reduceOnly !== true || criticalArgs.orderType !== "market"
    || criticalArgs.timeInForce !== "immediate-or-cancel"
    || typeof criticalArgs.matchHash !== "string" || !/^[0-9a-f]{64}$/.test(criticalArgs.matchHash)
    || typeof criticalArgs.summary !== "string" || criticalArgs.summary.length < 1 || criticalArgs.summary.length > 600
  ) return { ok: false, reason: "invalid_contract" };
  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: { toolId: "lighter.position.close", params: { intentId } },
      expiresAt: candidate.expiresAt,
      approvalPreview: { toolName: "position.close", namespace: "lighter", criticalArgs },
    },
  };
}

function validateLighterWithdrawalFollowUp(
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (!Number.isFinite(Date.parse(candidate.expiresAt))) return { ok: false, reason: "invalid_contract" };
  if (
    Object.keys(candidate.args).sort().join(",") !== "params,toolId"
    || candidate.args.toolId !== "lighter.withdraw"
  ) return { ok: false, reason: "invalid_contract" };
  const params = candidate.args.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, reason: "invalid_contract" };
  }
  const paramsRecord = params as Record<string, unknown>;
  const intentId = paramsRecord.intentId;
  if (
    Object.keys(paramsRecord).join(",") !== "intentId"
    || typeof intentId !== "string"
    || !LIGHTER_WITHDRAWAL_INTENT_ID_RE.test(intentId)
  ) return { ok: false, reason: "invalid_contract" };
  const preview = candidate.approvalPreview;
  if (preview.toolName !== "withdraw" || preview.namespace !== "lighter") {
    return { ok: false, reason: "invalid_contract" };
  }
  if (
    Object.keys(preview.criticalArgs).sort().join(",")
    !== [...LIGHTER_WITHDRAWAL_PREVIEW_KEYS].sort().join(",")
  ) return { ok: false, reason: "invalid_contract" };
  const args: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_WITHDRAWAL_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    args[key] = value;
  }
  const funding = getLighterFundingDeployment("core");
  if (
    args.toolId !== "lighter.withdraw"
    || args.intentId !== intentId
    || typeof args.previewId !== "string"
    || !/^lwp_[0-9a-f]{24}$/.test(args.previewId)
    || typeof args.matchHash !== "string"
    || !/^[0-9a-f]{64}$/.test(args.matchHash)
    || args.environment !== "core"
    || args.operationClass !== "secure_l2_withdrawal"
    || !safeNonNegativeInt(args.accountIndex)
    || !safeNonNegativeInt(args.apiKeyIndex)
    || Number(args.apiKeyIndex) < 4
    || Number(args.apiKeyIndex) > 254
    || typeof args.walletAddress !== "string"
    || !EVM_ADDRESS_RE.test(args.walletAddress)
    || args.destinationAddress !== args.walletAddress
    || args.signingChainId !== 304
    || args.settlementChainId !== 1
    || args.settlementNetworkName !== "Ethereum mainnet"
    || args.assetIndex !== 3
    || args.assetSymbol !== "USDC"
    || args.assetDecimals !== 6
    || typeof args.settlementTokenAddress !== "string"
    || args.settlementTokenAddress.toLowerCase() !== funding.settlementTokenProxy.toLowerCase()
    || args.routeType !== 0
    || args.route !== "secure"
    || !isPositiveIntegerString(args.amountUnits)
    || typeof args.amountDisplay !== "string"
    || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)? USDC$/.test(args.amountDisplay)
    || !isPositiveIntegerString(args.minimumWithdrawalUnits)
    || !isNonNegativeIntegerString(args.availableBalanceUnits)
    || !isNonNegativeIntegerString(args.collateralUnits)
    || !isNonNegativeIntegerString(args.initialMarginUnits)
    || BigInt(args.amountUnits) < BigInt(args.minimumWithdrawalUnits)
    || BigInt(args.amountUnits) > BigInt(args.availableBalanceUnits)
    || BigInt(args.amountUnits) > BigInt(args.collateralUnits)
    || BigInt(args.collateralUnits) - BigInt(args.amountUnits) < BigInt(args.initialMarginUnits)
    || !safeNonNegativeInt(args.pendingOrderCount)
    || !safeNonNegativeInt(args.openPositionCount)
    || !safeNonNegativeInt(args.activeOrderCount)
    || !safeNonNegativeInt(args.withdrawalDelaySeconds)
    || typeof args.estimatedClaimableAt !== "string"
    || !Number.isFinite(Date.parse(args.estimatedClaimableAt))
    || typeof args.gatewayAddress !== "string"
    || args.gatewayAddress.toLowerCase() !== funding.gatewayProxy.toLowerCase()
    || typeof args.gatewayImplementation !== "string"
    || funding.expectedGatewayImplementation === undefined
    || args.gatewayImplementation.toLowerCase() !== funding.expectedGatewayImplementation.toLowerCase()
    || typeof args.gatewayCodeHash !== "string"
    || !/^0x[0-9a-f]{64}$/i.test(args.gatewayCodeHash)
    || typeof args.settlementTokenCodeHash !== "string"
    || !/^0x[0-9a-f]{64}$/i.test(args.settlementTokenCodeHash)
    || typeof args.preflightObservedAt !== "string"
    || !Number.isFinite(Date.parse(args.preflightObservedAt))
    || !isBoundedText(args.summary)
    || !isBoundedText(args.scopeNote)
  ) return { ok: false, reason: "invalid_contract" };
  return {
    ok: true,
    followUp: {
      toolName: "execute_tool",
      args: { toolId: "lighter.withdraw", params: { intentId } },
      expiresAt: candidate.expiresAt,
      approvalPreview: { toolName: "withdraw", namespace: "lighter", criticalArgs: args },
    },
  };
}

function safeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
