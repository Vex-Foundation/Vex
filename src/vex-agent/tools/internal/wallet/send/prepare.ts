/**
 * Wallet send — `wallet_send_prepare`. Creates a DB-backed `wallet_intents`
 * row only; no key decrypt and no broadcast. The selected wallet ADDRESS is
 * resolved address-only (puzzle 5 phase 5B) and recorded on the intent so the
 * confirm path can assert signer-match before consuming.
 */

import { randomUUID } from "node:crypto";

import * as walletIntentsRepo from "@vex-agent/db/repos/wallet-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";

import type { ToolResult } from "../../../types.js";
import type { InternalToolContext } from "../../types.js";

import { resolveSelectedAddress, walletScopeErrorToResult } from "../resolve.js";
import {
  WALLET_INTENT_TTL_MS,
  buildWalletIntentPreview,
} from "../send-types.js";
import { ok } from "./results.js";
import { validatePrepareParams } from "./validation.js";

// ── wallet_send_prepare ─────────────────────────────────────────────────

export async function handleWalletSendPrepare(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const validated = validatePrepareParams(params);
  if (!validated.ok) {
    return validated.result;
  }
  const { network, to, amount, token, chain } = validated.values;

  // Per-session selected wallet (puzzle 5 phase 5B) — address only, no decrypt.
  let walletAddress: string;
  try {
    walletAddress = resolveSelectedAddress(context.walletResolution, context.walletPolicy, network);
  } catch (err) {
    return walletScopeErrorToResult(err);
  }

  const intentId = `intent-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + WALLET_INTENT_TTL_MS).toISOString();
  const previewJson = buildWalletIntentPreview({
    network,
    chain,
    to,
    amount,
    token,
  });

  // Under the session control lock: creating the intent is the moment the
  // session gains live money state, and the compaction safe-moment gate must
  // never read `clear` a microsecond before this row appears. DB-only and
  // committed here — no key decrypt, no broadcast on this path at all.
  await withSessionControlLock(context.sessionId, (client) =>
    walletIntentsRepo.createWith(client, {
      intentId,
      sessionId: context.sessionId,
      walletAddress,
      network,
      chainAlias: chain,
      toAddress: to,
      amount,
      token,
      previewJson,
      expiresAt,
      idempotencyKey: intentId,
    }),
  );

  const result = ok({
    intentId,
    network,
    chain: chain ?? undefined,
    to,
    amount,
    token: token ?? "native",
    status: "prepared",
    expiresAt,
    // Confirm is now auto-dispatched by the turn loop's trusted follow-up
    // handoff (see `preparedActionFollowUp` below) — this line is
    // transcript/model-facing copy only and no longer prescribes a
    // follow-up action the agent itself must take.
    message: "Transfer prepared; Vex will confirm it automatically.",
  });
  return {
    ...result,
    preparedActionFollowUp: {
      toolName: "wallet_send_confirm",
      args: { network, intentId },
      expiresAt,
      approvalPreview: {
        toolName: "wallet_send_confirm",
        criticalArgs: { ...previewJson.criticalArgs },
      },
    },
  };
}
