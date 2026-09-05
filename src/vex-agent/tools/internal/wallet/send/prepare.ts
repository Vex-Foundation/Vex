/**
 * Wallet send - `WalletSendPrepare`. Creates a DB-backed `wallet_intents`
 * row only; no key decrypt and no broadcast. The selected wallet ADDRESS is
 * resolved address-only (puzzle 5 phase 5B) and recorded on the intent so the
 * confirm path can assert signer-match before consuming.
 */

import { randomUUID } from "node:crypto";
import { PREPARED_ACTION_FOLLOW_UP_TOOL } from "@vex-agent/tools/registry/prepared-action-follow-ups.js";

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

// ── WalletSendPrepare ─────────────────────────────────────────────────

/**
 * THE IN-APP MESSAGE. True only on the lane that has the trusted follow-up: the
 * turn loop reads this result's `preparedActionFollowUp` and dispatches
 * `WalletSendConfirm` itself, so the agent is told not to call it again.
 */
const IN_APP_PREPARED_MESSAGE = "Transfer prepared; Vex will confirm it automatically.";

/**
 * THE MCP MESSAGE. Nothing dispatches the confirm on that lane, so the message
 * names the call, the id it needs and the window it has, and says what happens
 * when the caller makes it. The measured defect I-1 was an agent waiting for a
 * dispatch that was never going to happen.
 *
 * The window is READ from the TTL the row is written with, so the sentence
 * cannot outlive the number it quotes.
 *
 * The last clause is PERMISSION-AWARE because the confirm gate is
 * restricted-only (`confirm.ts`: `!context.approved && sessionPermission ===
 * "restricted"`). Telling a full-permission caller that "the approval card is
 * raised there" promised a human review that this project does not perform: the
 * next call signs and broadcasts real funds with nobody in the loop. The
 * sentence now says which of the two it is, read from the permission the
 * context was admitted under - a stronger claim needs the stronger evidence, so
 * the card is only promised where the gate actually raises one.
 */
function mcpPreparedMessage(
  intentId: string,
  permission: InternalToolContext["sessionPermission"],
): string {
  const minutes = String(WALLET_INTENT_TTL_MS / 60_000);
  const whatHappens =
    permission === "restricted"
      ? "the approval card is raised there."
      : "this project has full permission, so confirm broadcasts immediately and no approval card is raised.";
  return (
    `Transfer prepared: call WalletSendConfirm with intentId ${intentId} within ${minutes} minutes `
    + `to broadcast; ${whatHappens}`
  );
}

export async function handleWalletSendPrepare(
  params: Record<string, unknown>,
  context: InternalToolContext,
): Promise<ToolResult> {
  const validated = validatePrepareParams(params);
  if (!validated.ok) {
    return validated.result;
  }
  const { network, to, amount, token, chain } = validated.values;

  // Per-session selected wallet (puzzle 5 phase 5B) - address only, no decrypt.
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
  // committed here - no key decrypt, no broadcast on this path at all.
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

  const overMcp = context.toolLane === "mcp";
  const result = ok({
    intentId,
    network,
    chain: chain ?? undefined,
    to,
    amount,
    token: token ?? "native",
    status: "prepared",
    expiresAt,
    message: overMcp
      ? mcpPreparedMessage(intentId, context.sessionPermission)
      : IN_APP_PREPARED_MESSAGE,
  });
  if (overMcp) {
    // No `preparedActionFollowUp`: the only consumer of that field is the
    // in-app turn loop, which does not run on this lane. Attaching it here
    // would be a handoff to nobody, and the message above already names the
    // call the caller has to make itself.
    return result;
  }
  return {
    ...result,
    preparedActionFollowUp: {
      toolName: PREPARED_ACTION_FOLLOW_UP_TOOL,
      // The confirm TOOL's param key is `walletFamily` (SPEC §1.1); `network`
      // is only the internal/stored spelling of the same value.
      args: { walletFamily: network, intentId },
      expiresAt,
      approvalPreview: {
        toolName: PREPARED_ACTION_FOLLOW_UP_TOOL,
        criticalArgs: { ...previewJson.criticalArgs },
      },
    },
  };
}
