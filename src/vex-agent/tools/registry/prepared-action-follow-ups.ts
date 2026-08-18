/** Explicit allow-list for trusted prepare → execute handoffs. */

import { createHash } from "node:crypto";

import type {
  ApprovalPreviewScalar,
  PreparedActionFollowUp,
} from "../types.js";
import {
  LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS,
  LIGHTER_CORE_MAINNET_USDC_ADDRESS,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "@tools/lighter/wallet-funding/constants.js";

export interface ValidatedWalletSendFollowUp {
  readonly toolName: "wallet_send_confirm";
  readonly args: {
    readonly walletFamily: "eip155" | "solana";
    readonly intentId: string;
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "wallet_send_confirm";
    readonly namespace?: string;
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

export type ValidatedPreparedActionFollowUp =
  | ValidatedWalletSendFollowUp
  | ValidatedLighterOrderCreateFollowUp
  | ValidatedLighterDepositFollowUp
  | ValidatedLighterKeyRegistrationFollowUp;

export type PreparedActionFollowUpValidation =
  | { readonly ok: true; readonly followUp: ValidatedPreparedActionFollowUp }
  | { readonly ok: false; readonly reason: "unknown_mapping" | "invalid_contract" };

const WALLET_INTENT_ID_RE = /^intent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_INTENT_ID_RE = /^lighter-exec-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_DEPOSIT_INTENT_ID_RE = /^lighter-onboard-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_ORDER_CREATE_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__order__create__prepare",
]);
const LIGHTER_DEPOSIT_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__deposit__prepare",
]);
const LIGHTER_KEY_REGISTRATION_PREPARE_SOURCES = new Set([
  "execute_tool",
  "lighter__key__register__prepare",
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

const LIGHTER_DISPLAY_AMOUNT_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const LIGHTER_DEPOSIT_DISPLAY_AMOUNT_RE =
  /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)? USDC$/;
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
 * Maintainer decision: every prepare→execute mapping must be named here. The
 * registry currently allows wallet_send_prepare → wallet_send_confirm and the
 * protocol `execute_tool` handoffs for Lighter order-create and deposit intents.
 * Every other source/target pair fails closed as "unknown_mapping".
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
    sourceToolName !== "wallet_send_prepare" ||
    candidate.toolName !== "wallet_send_confirm"
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
  if (preview.toolName !== "wallet_send_confirm") {
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
      toolName: "wallet_send_confirm",
      args: { walletFamily: network, intentId },
      expiresAt: candidate.expiresAt,
      approvalPreview: {
        toolName: "wallet_send_confirm",
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
  const publicKey = criticalArgs.publicKey;
  const fingerprint = criticalArgs.publicKeyFingerprint;
  if (
    criticalArgs.toolId !== "lighter.key.register"
    || criticalArgs.intentId !== intentId
    || criticalArgs.environment !== "core"
    || typeof criticalArgs.walletAddress !== "string"
    || !EVM_ADDRESS_RE.test(criticalArgs.walletAddress)
    || criticalArgs.ethereumChainId !== 1
    || criticalArgs.lighterChainId !== 304
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
      !== `lighter/core/account-${criticalArgs.accountIndex}/api-key-${criticalArgs.apiKeyIndex}`
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
  if (
    criticalArgs.toolId !== "lighter.deposit" ||
    criticalArgs.intentId !== intentId ||
    criticalArgs.environment !== "core" ||
    typeof criticalArgs.walletAddress !== "string" ||
    !EVM_ADDRESS_RE.test(criticalArgs.walletAddress) ||
    criticalArgs.depositTo !== criticalArgs.walletAddress ||
    typeof criticalArgs.depositContract !== "string" ||
    criticalArgs.depositContract.toLowerCase() !==
      LIGHTER_CORE_DEPOSIT_CONTRACT_ADDRESS.toLowerCase() ||
    criticalArgs.chainId !== 1 ||
    criticalArgs.assetIndex !== 3 ||
    criticalArgs.routeType !== 0 ||
    typeof criticalArgs.amountUnits !== "string" ||
    !/^[1-9][0-9]*$/.test(criticalArgs.amountUnits) ||
    typeof criticalArgs.amountDisplay !== "string" ||
    !LIGHTER_DEPOSIT_DISPLAY_AMOUNT_RE.test(criticalArgs.amountDisplay) ||
    typeof criticalArgs.settlementTokenAddress !== "string" ||
    criticalArgs.settlementTokenAddress.toLowerCase() !==
      LIGHTER_CORE_MAINNET_USDC_ADDRESS.toLowerCase() ||
    criticalArgs.settlementTokenDecimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS ||
    !isPositiveIntegerString(criticalArgs.preflightMinimumTransferUnits) ||
    !isNonNegativeIntegerString(criticalArgs.preflightWalletBalanceUnits) ||
    !isNonNegativeIntegerString(criticalArgs.preflightWalletAllowanceUnits) ||
    !isPositiveIntegerString(criticalArgs.preflightEthereumBlockNumber) ||
    !isNonNegativeIntegerString(criticalArgs.preflightLighterBlockNumber) ||
    typeof criticalArgs.preflightObservedAt !== "string" ||
    !Number.isFinite(Date.parse(criticalArgs.preflightObservedAt)) ||
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
