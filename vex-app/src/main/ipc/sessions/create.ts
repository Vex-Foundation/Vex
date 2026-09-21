/**
 * vex.sessions.create — Phase 2 multi-session shell (M12).
 *
 * Creates a new session row, plus (mission mode only) a companion
 * `missions` draft row in the same DB transaction. Returns the freshly
 * persisted list-item shape so the renderer can splice it into the
 * sidebar cache without a follow-up `vex.sessions.list` roundtrip.
 *
 * Mission setup conversational flow is NOT invoked here — that's deferred
 * to the engine's `processMissionSetupTurn` on the first message of the
 * mission session. This handler stays NO-LLM by design.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, type Result } from "@shared/ipc/result.js";
import {
  sessionCreateInputSchema,
  sessionCreateResultSchema,
  type SessionCreateResult,
} from "@shared/schemas/sessions.js";
import { createSession } from "../../database/sessions-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { deskWalletRef, invalidWalletSelectionError, resolveWalletRef } from "../_wallet-refs.js";

export function registerSessionsCreateHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.create,
    domain: "internal",
    inputSchema: sessionCreateInputSchema,
    outputSchema: sessionCreateResultSchema,
    handle: async (input, ctx): Promise<Result<SessionCreateResult>> => {
      // Resolve selected wallet IDs → {id,address} server-side. Invalid id →
      // fail closed WITHOUT creating the session (or the mission row).
      const evm = resolveWalletRef("evm", input.selectedEvmWalletId);
      const solana = resolveWalletRef("solana", input.selectedSolanaWalletId);
      if (evm === "invalid" || solana === "invalid") {
        log.info(
          `[ipc:vex:sessions:create] invalid_wallet_selection correlationId=${ctx.requestId}`,
        );
        return err(invalidWalletSelectionError(ctx.requestId));
      }
      // A Lighter desk session has no wallet picker in front of it, so an
      // absent selection means "nobody was asked", not "chat only".
      // Only an agent-mode create carries a workspace; a mission never does.
      const workspace = input.mode === "agent" ? input.workspace ?? null : null;
      const outcome = await createSession(input, {
        evm: deskWalletRef(workspace, evm),
        solana,
      });
      if (outcome.ok) {
        log.info(
          `[ipc:vex:sessions:create] ok ` +
            `mode=${outcome.data.mode} permission=${outcome.data.permission} ` +
            `correlationId=${ctx.requestId}`,
        );
      } else {
        log.info(
          `[ipc:vex:sessions:create] errCode=${outcome.error.code} ` +
            `correlationId=${ctx.requestId}`,
        );
      }
      return outcome;
    },
  });
}
