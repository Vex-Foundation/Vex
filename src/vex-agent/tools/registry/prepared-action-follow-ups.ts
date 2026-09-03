/** Explicit allow-list for trusted prepare → execute handoffs. */

import type {
  ApprovalPreviewScalar,
  PreparedActionFollowUp,
} from "../types.js";

/**
 * The ONE prepare → confirm handoff pair, as two exported constants.
 *
 * THE EMITTER AND THE VALIDATOR MUST AGREE, and nothing used to make them.
 * `tools/internal/wallet/send/prepare.ts` writes `toolName` into the follow-up
 * it authors, and {@link validatePreparedActionFollowUp} compares it against a
 * literal here; the two lived in different modules with no shared symbol, so
 * the Batch 2 rename silently broke the pair (the validator answered
 * `unknown_mapping` for every transfer - fail-closed, but the feature was
 * dead). Both sides now import these, so a future rename is a COMPILE ERROR
 * rather than a money-path feature that quietly stops working.
 *
 * Deliberately typed as literals (`as const`), not `string`: the literal type
 * is what lets {@link ValidatedPreparedActionFollowUp} keep naming the exact
 * tool rather than widening to `string`.
 */
export const PREPARED_ACTION_SOURCE_TOOL = "WalletSendPrepare" as const;
export const PREPARED_ACTION_FOLLOW_UP_TOOL = "WalletSendConfirm" as const;

export interface ValidatedPreparedActionFollowUp {
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
 * closed. For wallet sends, only walletFamily + intentId cross into confirm
 * args (`criticalArgs` keeps the preview vocabulary, where the family is still
 * spelled `network` - that is stored preview data, not a param);
 * the richer preview is validated independently and never rebuilt from args.
 *
 * Maintainer decision (2026-07): wallet-only. Exactly one mapping -
 * WalletSendPrepare → WalletSendConfirm. Do not add a second mapping
 * without an explicit product decision; every other source/target pair fails
 * closed as "unknown_mapping".
 */
export function validatePreparedActionFollowUp(
  sourceToolName: string,
  candidate: PreparedActionFollowUp,
): PreparedActionFollowUpValidation {
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
    !INTENT_ID_RE.test(intentId)
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
