/**
 * `mission.edit` — stop the active run so the operator can edit the mission.
 *
 * Delegates to the engine's `stopActiveMissionForEdit`, which terminates the
 * run and returns the parent mission to `draft` (the next user turn then routes
 * through the mission-setup prompt and `mission_draft_update` is callable
 * again). No transcript cue is appended in this slice (deferred by design).
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionEditInputSchema,
  missionEditResultSchema,
  type MissionEditResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";

export function registerMissionEditHandler(): () => void {
  return registerHandler({
    channel: CH.mission.edit,
    domain: "mission",
    inputSchema: missionEditInputSchema,
    outputSchema: missionEditResultSchema,
    handle: async (input, ctx): Promise<Result<MissionEditResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { stopActiveMissionForEdit } = await import(
          "@vex-agent/engine/index.js"
        );
        const result = await stopActiveMissionForEdit(input.sessionId);
        if (result === null) {
          return ok({ outcome: "no_active_run" });
        }
        // Both `stopped` and the `already_terminal` race path changed (or
        // confirmed) the run's terminal state — refresh the renderer.
        await emitControlStateAfterChange(input.sessionId, ctx.requestId);
        return ok(
          result.stopped
            ? { outcome: "stopped" }
            : { outcome: "already_terminal" },
        );
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:edit] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
