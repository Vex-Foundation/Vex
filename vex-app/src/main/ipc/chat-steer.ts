/**
 * vex.chat.steer — persist a user message into a LIVE turn (A33).
 *
 * Fires no turn and interrupts nothing: the engine's steering entry writes
 * exactly one `operator_interrupt` transcript row (queued_live) which the
 * live loop delivers at its next tool-batch boundary, never mid tool call.
 * `no_active_turn` persists nothing — the renderer submits normally
 * instead. Not idempotent on `queued_live`: never auto-retry this channel.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  chatSteerInputSchema,
  chatSteerResultSchema,
  type ChatSteerResult,
} from "@shared/schemas/chat.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import {
  classifyEngineError,
  sessionNotFoundError,
} from "./chat/engine-failure-copy.js";
import { getSessionById } from "../database/sessions-db.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

export function registerChatSteerHandler(): () => void {
  return registerHandler({
    channel: CH.chat.steer,
    domain: "chat",
    inputSchema: chatSteerInputSchema,
    outputSchema: chatSteerResultSchema,
    handle: async (input, ctx): Promise<Result<ChatSteerResult>> => {
      const session = await getSessionById(input.sessionId);
      if (!session.ok) return session;
      if (session.data === null) return err(sessionNotFoundError(ctx.requestId));

      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      try {
        const { submitSteeringMessage } = await import(
          "@vex-agent/engine/index.js"
        );
        const result = await submitSteeringMessage(
          input.sessionId,
          input.message,
        );
        log.info(
          `[ipc:vex:chat:steer] ok outcome=${result.outcome} ` +
            `sessionId=${input.sessionId} correlationId=${ctx.requestId}`,
        );
        return ok({ outcome: result.outcome });
      } catch (cause) {
        const kind = cause instanceof Error ? cause.name : typeof cause;
        log.warn(
          `[ipc:vex:chat:steer] failed kind=${kind} correlationId=${ctx.requestId}`,
        );
        return err(classifyEngineError(cause, ctx.requestId));
      }
    },
  });
}
