/** Explicit allow-list for trusted prepare → execute handoffs. */

import type {
  ApprovalPreviewScalar,
  PreparedActionFollowUp,
} from "../types.js";

export interface ValidatedWalletSendFollowUp {
  readonly toolName: "wallet_send_confirm";
  readonly args: {
    readonly walletFamily: "eip155" | "solana";
    readonly intentId: string;
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "wallet_send_confirm";
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
    readonly toolName: "execute_tool";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export type ValidatedPreparedActionFollowUp =
  | ValidatedWalletSendFollowUp
  | ValidatedLighterOrderCreateFollowUp;

export type PreparedActionFollowUpValidation =
  | { readonly ok: true; readonly followUp: ValidatedPreparedActionFollowUp }
  | { readonly ok: false; readonly reason: "unknown_mapping" | "invalid_contract" };

const WALLET_INTENT_ID_RE = /^intent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIGHTER_INTENT_ID_RE = /^lighter-exec-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_KEYS = ["network", "chain", "to", "amount", "token"] as const;
const LIGHTER_PREVIEW_KEYS = [
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
 * protocol `execute_tool` handoff for Lighter order-create intents. Every other
 * source/target pair fails closed as "unknown_mapping".
 */
export function validatePreparedActionFollowUp(
  sourceToolName: string,
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (sourceToolName === "execute_tool" && candidate.toolName === "execute_tool") {
    return validateLighterOrderCreateFollowUp(candidate);
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
  if (preview.toolName !== "execute_tool") {
    return { ok: false, reason: "invalid_contract" };
  }
  const criticalArgs: Record<string, ApprovalPreviewScalar> = {};
  for (const key of LIGHTER_PREVIEW_KEYS) {
    const value = preview.criticalArgs[key];
    if (!isScalar(value)) return { ok: false, reason: "invalid_contract" };
    criticalArgs[key] = value;
  }
  if (
    criticalArgs.toolId !== "lighter.order.create" ||
    criticalArgs.intentId !== intentId ||
    (criticalArgs.environment !== "core" && criticalArgs.environment !== "rhc") ||
    typeof criticalArgs.accountIndex !== "number" ||
    !Number.isSafeInteger(criticalArgs.accountIndex) ||
    criticalArgs.accountIndex < 0 ||
    typeof criticalArgs.apiKeyIndex !== "number" ||
    !Number.isSafeInteger(criticalArgs.apiKeyIndex) ||
    criticalArgs.apiKeyIndex < 2 ||
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
        toolName: "execute_tool",
        criticalArgs,
      },
    },
  };
}
