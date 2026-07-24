/**
 * Wallet-send approval binding — bind restricted-mode approval previews to the
 * durable `wallet_intents` row, and cancel that row when the approval dies.
 *
 * Security boundary (restricted fund moves):
 *   - `wallet_send_confirm` tool args are only `{ network, intentId }`. Building
 *     the approval preview from those args alone produces a blind card (no to /
 *     amount). A poisoned agent can re-call confirm after the user rejects a
 *     rich prepare→follow-up card while the intent is still `pending`.
 *   - Preview MUST be built from the session-scoped wallet intent row, never
 *     from model-controlled args (including spoofed `to`/`amount` keys).
 *   - Reject / expire / policy-drift of a confirm approval MUST cancel the
 *     underlying intent so "Reject" is a real abort, not only a queue flip.
 */

import * as walletIntentsRepo from "@vex-agent/db/repos/wallet-intents.js";
import logger from "@utils/logger.js";

import type { IntentPreview } from "./approval-intent-preview.js";

export interface BoundWalletSendConfirmApproval {
  readonly preview: IntentPreview;
  /** ISO expiry of the wallet intent — approval must not outlive it. */
  readonly expiresAt: string;
}

/**
 * Load the session-scoped pending wallet intent and build a renderer-safe
 * preview from authoritative row columns. Fails closed when the intent is
 * missing, expired, non-pending, or network-mismatched — never enqueue a
 * blind or spoofable card.
 */
export async function bindWalletSendConfirmApproval(
  sessionId: string,
  args: Record<string, unknown>,
): Promise<BoundWalletSendConfirmApproval> {
  const intentId = typeof args.intentId === "string" ? args.intentId : "";
  const network = typeof args.network === "string" ? args.network : "";
  if (intentId.length === 0 || network.length === 0) {
    throw new Error(
      "wallet_send_confirm approval refused: missing network or intentId",
    );
  }
  if (network !== "eip155" && network !== "solana") {
    throw new Error(
      `wallet_send_confirm approval refused: invalid network "${network}"`,
    );
  }

  const intent = await walletIntentsRepo.getById(intentId, sessionId);
  if (intent === null) {
    throw new Error(
      "wallet_send_confirm approval refused: intent not found for this session",
    );
  }
  if (intent.network !== network) {
    throw new Error(
      `wallet_send_confirm approval refused: network mismatch (intent=${intent.network}, args=${network})`,
    );
  }
  if (intent.status !== "pending") {
    throw new Error(
      `wallet_send_confirm approval refused: intent is ${intent.status}`,
    );
  }
  if (new Date(intent.expiresAt) <= new Date()) {
    throw new Error(
      `wallet_send_confirm approval refused: intent expired at ${intent.expiresAt}`,
    );
  }

  // Authoritative columns only — never model args, never preview_json alone
  // (preview_json is denormalised convenience; to/amount live on the row).
  return {
    preview: {
      toolName: "wallet_send_confirm",
      criticalArgs: {
        network: intent.network,
        chain: intent.chainAlias,
        to: intent.toAddress,
        amount: intent.amount,
        token: intent.token,
      },
    },
    expiresAt: intent.expiresAt,
  };
}

/**
 * After an approval for `wallet_send_confirm` is rejected / expired /
 * policy-drifted, CAS-cancel the linked wallet intent so it cannot be
 * re-confirmed via a later thin approval card.
 *
 * Best-effort: a cancel miss (already terminal / wrong session) is fine; a
 * thrown DB error is logged and swallowed so the approval reject path still
 * completes (intent TTL remains a backstop).
 */
export async function cancelWalletIntentAfterApprovalRejection(
  sessionId: string,
  queueToolCall: Record<string, unknown>,
): Promise<void> {
  const name = queueToolCall.command ?? queueToolCall.name;
  if (name !== "wallet_send_confirm") return;

  const rawArgs = queueToolCall.args ?? queueToolCall.arguments;
  if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
    return;
  }
  const intentId = (rawArgs as Record<string, unknown>).intentId;
  if (typeof intentId !== "string" || intentId.length === 0) return;

  try {
    const cancelled = await walletIntentsRepo.cancelIfPending(intentId, sessionId);
    if (cancelled !== null) {
      logger.info("engine.approval_runtime.wallet_intent_cancelled_on_reject", {
        intentId,
        sessionId,
      });
    }
  } catch (cause) {
    logger.warn("engine.approval_runtime.wallet_intent_cancel_failed", {
      intentId,
      sessionId,
      errorKind: cause instanceof Error ? cause.constructor.name : typeof cause,
    });
  }
}
