/**
 * vex.sessions.rename — set a session's user display title.
 *
 * The name is validated by `sessionTitleSchema` (trimmed, 1-80 chars) at the
 * boundary; renaming an unknown or soft-deleted id returns `ok(null)` rather
 * than an error, because a stale renderer cache is not a fault worth
 * surfacing. The returned row carries `missionStatus`, so the renderer can
 * safely `setQueryData(detail, row)` after the mutation.
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  sessionRenameInputSchema,
  sessionRenameResultSchema,
  type SessionRenameResult,
} from "@shared/schemas/sessions.js";
import { renameSession } from "../../database/sessions-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerSessionsRenameHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.rename,
    domain: "internal",
    inputSchema: sessionRenameInputSchema,
    outputSchema: sessionRenameResultSchema,
    handle: async (input, ctx): Promise<Result<SessionRenameResult>> => {
      // The title itself is user content — log only the hit, never the name.
      const outcome = await renameSession(input.id, input.name);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:sessions:rename] ok hit=${outcome.data !== null} ` +
            `correlationId=${ctx.requestId}`,
        );
      } else {
        log.info(
          `[ipc:vex:sessions:rename] errCode=${outcome.error.code} ` +
            `correlationId=${ctx.requestId}`,
        );
      }
      return outcome;
    },
  });
}
