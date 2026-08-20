/**
 * vex.chat.submit — operator text entrypoint for the app shell.
 *
 * Main owns the bridge into the engine. The renderer sends only session id +
 * text; main validates the session, persists the first mission goal when
 * applicable, points the engine at the app-managed Postgres, and then routes
 * the turn through the canonical Vex Agent ingress.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  chatSubmitInputSchema,
  chatSubmitResultSchema,
  type ChatSubmitResult,
} from "@shared/schemas/chat.js";
import { ensureEngineDbUrl } from "./chat/engine-db-url.js";
import {
  classifyEngineError,
  sessionNotFoundError,
} from "./chat/engine-failure-copy.js";
import {
  getSessionById,
  setInitialMissionGoalIfUnset,
} from "../database/sessions-db.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

export function registerChatSubmitHandler(): () => void {
  return registerHandler({
    channel: CH.chat.submit,
    domain: "chat",
    inputSchema: chatSubmitInputSchema,
    outputSchema: chatSubmitResultSchema,
    handle: async (input, ctx): Promise<Result<ChatSubmitResult>> => {
      const session = await getSessionById(input.sessionId);
      if (!session.ok) return session;
      if (session.data === null) return err(sessionNotFoundError(ctx.requestId));

      let treatedAsInitialGoal = false;
      if (
        session.data.mode === "mission" &&
        (session.data.initialGoal === null ||
          session.data.initialGoal.trim().length === 0)
      ) {
        const goalOutcome = await setInitialMissionGoalIfUnset(
          input.sessionId,
          input.message,
        );
        if (!goalOutcome.ok) return goalOutcome;
        treatedAsInitialGoal = goalOutcome.data;
      }

      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;

      // Blocker 2 (fix-wave): the renderer's mount gate is defense-in-depth,
      // not the authority — a mission session must never carry a per-turn
      // reasoningEffort, so strip it here from the session's OWN DB-read
      // mode, using the `session` this handler already fetched above. This
      // catches any renderer race (or future renderer bug) that lets a
      // reasoningEffort ride a mission-session submit.
      const forwardedReasoningEffort =
        input.reasoningEffort !== undefined && session.data.mode !== "mission"
          ? input.reasoningEffort
          : undefined;
      if (input.reasoningEffort !== undefined && session.data.mode === "mission") {
        log.debug(
          `[ipc:vex:chat:submit] stripped reasoningEffort for mission session correlationId=${ctx.requestId}`,
        );
      }

      try {
        const { submitOperatorInstruction } = await import(
          "@vex-agent/engine/index.js"
        );
        const result = await submitOperatorInstruction(
          input.sessionId,
          input.message,
          ctx.signal,
          // S6: per-turn reasoning effort, validated by chatSubmitInputSchema.
          // Absent (or stripped above for a mission session) → the field is
          // omitted entirely and the provider selects its own default; there
          // is no engine-side "medium" fallback.
          forwardedReasoningEffort === undefined
            ? undefined
            : { reasoningEffort: forwardedReasoningEffort },
        );
        log.info(
          `[ipc:vex:chat:submit] ok sessionId=${input.sessionId} ` +
            `initialGoal=${treatedAsInitialGoal} correlationId=${ctx.requestId}`,
        );
        return ok({
          text: result.text,
          toolCallsMade: result.toolCallsMade,
          pendingApprovals: result.pendingApprovals,
          stopReason: result.stopReason,
          missionStatus: result.missionStatus,
          treatedAsInitialGoal,
        });
      } catch (cause) {
        const kind = cause instanceof Error ? cause.name : typeof cause;
        // Diagnostic detail: engine failure messages carry no user content
        // (they name modules, tables, providers), so the first line is safe
        // to log locally — without it every failure collapses to kind=Error.
        const detail =
          cause instanceof Error
            ? ` message=${JSON.stringify(cause.message.split("\n")[0]?.slice(0, 300) ?? "")}` +
              ` at=${JSON.stringify(cause.stack?.split("\n")[1]?.trim().slice(0, 200) ?? "")}`
            : "";
        log.warn(
          `[ipc:vex:chat:submit] failed kind=${kind}${detail} correlationId=${ctx.requestId}`,
        );
        return err(classifyEngineError(cause, ctx.requestId));
      }
    },
  });
}
