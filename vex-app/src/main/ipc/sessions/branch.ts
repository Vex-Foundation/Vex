/**
 * vex.sessions.branch — fork a session at a message (A14).
 *
 * The renderer asks; main decides. The DB helper validates the anchor and
 * the tool-closed prefix inside one transaction and returns a named
 * discriminated outcome for every blocked state — the source transcript is
 * never rewritten and there is no auto-repair. Not idempotent: each
 * successful call creates a new session, so the renderer must never
 * auto-retry this channel.
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  sessionBranchInputSchema,
  sessionBranchResultSchema,
  type SessionBranchResult,
} from "@shared/schemas/sessions.js";
import { branchSession } from "../../database/sessions-db.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerSessionsBranchHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.branch,
    domain: "internal",
    inputSchema: sessionBranchInputSchema,
    outputSchema: sessionBranchResultSchema,
    handle: async (input, ctx): Promise<Result<SessionBranchResult>> => {
      const outcome = await branchSession(input);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:sessions:branch] ok outcome=${outcome.data.outcome} ` +
            `correlationId=${ctx.requestId}`,
        );
      } else {
        log.info(
          `[ipc:vex:sessions:branch] errCode=${outcome.error.code} ` +
            `correlationId=${ctx.requestId}`,
        );
      }
      return outcome;
    },
  });
}
