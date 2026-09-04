/**
 * `vex.runtime.cancelWake` — cancel pending wake rows for the session
 * + audit. Lazy imports the loop-wake + control-request repos so the
 * runtime IPC namespace stays disjoint from engine module graph at
 * handler-registration time.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  runtimeRequestInputSchema,
  runtimeCancelWakeResultSchema,
  type RuntimeCancelWakeResult,
} from "@shared/schemas/runtime.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "./_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { emitControlStateAfterChange } from "./_emit-control-state.js";

export function registerRuntimeCancelWakeHandler(): () => void {
  return registerHandler({
    channel: CH.runtime.cancelWake,
    domain: "runtime",
    inputSchema: runtimeRequestInputSchema,
    outputSchema: runtimeCancelWakeResultSchema,
    handle: async (input, ctx): Promise<Result<RuntimeCancelWakeResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { cancelForSession } = await import(
          "@vex-agent/db/repos/loop-wake.js"
        );
        const cancelledCount = await cancelForSession(
          input.sessionId,
          "user_cancel",
        );
        const { enqueueRequest } = await import(
          "@vex-agent/db/repos/runtime-control-requests.js"
        );
        // The wake cancellation above already ran synchronously — this row
        // is audit-only. Nothing ever observes/clears a `cancel_wake` row
        // (the checkpoint observer only matches pause_after_step/
        // stop_terminal), so inserting it `pending` would strand it forever
        // and the kind-agnostic `pending_control_kind` lookup would then
        // treat the whole session as permanently busy.
        await enqueueRequest({
          sessionId: input.sessionId,
          kind: "cancel_wake",
          requestedBy: "user",
          correlationId: ctx.requestId,
          reason: `cancelled=${cancelledCount}`,
          initialStatus: "cleared",
        });
        await emitControlStateAfterChange(input.sessionId, ctx.requestId);
        if (cancelledCount === 0) {
          return ok({ outcome: "no_pending_wake" });
        }
        return ok({ outcome: "cancelled_wake", cancelledCount });
      } catch (cause) {
        log.warn(
          `[ipc:vex:runtime:cancelWake] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
