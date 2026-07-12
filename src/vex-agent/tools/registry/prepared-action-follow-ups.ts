/** Explicit allow-list for trusted prepare → execute handoffs. */

import type {
  ApprovalPreviewScalar,
  PreparedActionFollowUp,
} from "../types.js";

export interface ValidatedPreparedActionFollowUp {
  readonly toolName: "wallet_send_confirm";
  readonly args: {
    readonly network: "eip155" | "solana";
    readonly intentId: string;
  };
  readonly expiresAt: string;
  readonly approvalPreview: {
    readonly toolName: "wallet_send_confirm";
    readonly criticalArgs: Record<string, ApprovalPreviewScalar>;
  };
}

export type PreparedActionFollowUpValidation =
  | { readonly ok: true; readonly followUp: ValidatedPreparedActionFollowUp }
  | { readonly ok: false; readonly reason: "unknown_mapping" | "invalid_contract" };

const INTENT_ID_RE = /^intent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_KEYS = ["network", "chain", "to", "amount", "token"] as const;

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
 * closed. For wallet sends, only network + intentId cross into confirm args;
 * the richer preview is validated independently and never rebuilt from args.
 */
export function validatePreparedActionFollowUp(
  sourceToolName: string,
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
  if (
    sourceToolName !== "wallet_send_prepare" ||
    candidate.toolName !== "wallet_send_confirm"
  ) {
    return { ok: false, reason: "unknown_mapping" };
  }

  const argKeys = Object.keys(candidate.args).sort();
  if (argKeys.join(",") !== "intentId,network") {
    return { ok: false, reason: "invalid_contract" };
  }
  const network = candidate.args.network;
  const intentId = candidate.args.intentId;
  if (
    (network !== "eip155" && network !== "solana") ||
    typeof intentId !== "string" ||
    !INTENT_ID_RE.test(intentId)
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
      args: { network, intentId },
      expiresAt: candidate.expiresAt,
      approvalPreview: {
        toolName: "wallet_send_confirm",
        criticalArgs,
      },
    },
  };
}
