/**
 * `mission.getSessionResult` — read-only ledger row for a session's NEWEST
 * mission run. Powers the post-mission summary card the session view shows
 * once a run finishes: that surface holds a session id, not a wallet address,
 * so it cannot use the wallet-scoped `listResults` / `getResultForRun` reads.
 *
 * Returns null when the session never opened a run (or accounting failed-soft
 * before an open committed). A row whose `outcome` is still `running` is
 * returned as-is — deciding that a live run has no summary to show is a
 * presentation call, made in the renderer, not here.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionGetSessionResultInputSchema,
  missionGetSessionResultResultSchema,
  type MissionGetSessionResultResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";
import { toMissionResultDto } from "./_result-dto.js";

export function registerMissionGetSessionResultHandler(): () => void {
  return registerHandler({
    channel: CH.mission.getSessionResult,
    domain: "mission",
    inputSchema: missionGetSessionResultInputSchema,
    outputSchema: missionGetSessionResultResultSchema,
    handle: async (input, ctx): Promise<Result<MissionGetSessionResultResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { getLatestResultForSession } = await import(
          "@vex-agent/db/repos/mission-results.js"
        );
        const row = await getLatestResultForSession(input.sessionId);
        log.info(
          `[ipc:vex:mission:getSessionResult] ok found=${row !== null} correlationId=${ctx.requestId}`,
        );
        return ok(row === null ? null : toMissionResultDto(row));
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:getSessionResult] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
