/**
 * `mission.restartWithInstruction` — the post-stop "tell Vex what to do
 * differently" affordance.
 *
 * Same shape as `mission.start`: the engine primitive synchronously appends
 * the operator instruction and prepares a durable `mission_runs` row, and
 * `dispatched` is returned only once that row exists. The turn loop itself
 * runs in the background through `dispatchPreparedMission`, which owns the
 * failure logging, the bounded engine-error push and the bug report.
 *
 * The instruction is untrusted, model-visible text. It is length-capped by the
 * Zod input schema HERE and again inside the engine primitive — validating in
 * only one place would make the boundary depend on the caller having done its
 * job, and this text becomes a transcript row the agent re-reads every turn.
 *
 * A drifted or never-accepted contract comes back as `contract_dirty` and the
 * renderer routes the user to Review/Edit. Restarting against a contract the
 * user never accepted would be a consent bypass, so it fails closed here
 * rather than re-accepting anything on the user's behalf.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionRestartWithInstructionInputSchema,
  missionRestartWithInstructionResultSchema,
  type MissionRestartWithInstructionResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";
import { dispatchPreparedMission } from "./_engine-dispatch.js";

export function registerMissionRestartWithInstructionHandler(): () => void {
  return registerHandler({
    channel: CH.mission.restartWithInstruction,
    domain: "mission",
    inputSchema: missionRestartWithInstructionInputSchema,
    outputSchema: missionRestartWithInstructionResultSchema,
    handle: async (
      input,
      ctx,
    ): Promise<Result<MissionRestartWithInstructionResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { restartMissionWithInstruction } = await import(
          "@vex-agent/engine/mission/restart-with-instruction.js"
        );
        const { runPreparedMissionStart } = await import(
          "@vex-agent/engine/core/runner/mission.js"
        );

        const outcome = await restartMissionWithInstruction({
          sessionId: input.sessionId,
          missionId: input.missionId,
          instruction: input.instruction,
        });
        // Length, not content: the instruction is user text and never reaches
        // a log line.
        log.info(
          `[ipc:vex:mission:restartWithInstruction] outcome=${outcome.outcome} ` +
            `missionId=${input.missionId} instructionLength=${input.instruction.length} ` +
            `correlationId=${ctx.requestId}`,
        );
        if (outcome.outcome !== "prepared") {
          return ok(outcome);
        }

        const { runId, missionId, sessionId } = outcome.prepared;
        dispatchPreparedMission(
          () => runPreparedMissionStart(outcome.prepared),
          {
            sessionId,
            missionId,
            missionRunId: runId,
            correlationId: ctx.requestId,
            channelLabel: "vex:mission:restartWithInstruction",
            scope: "mission",
          },
        );
        await emitControlStateAfterChange(sessionId, ctx.requestId);
        return ok({ outcome: "dispatched", missionRunId: runId, sessionId });
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:restartWithInstruction] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
