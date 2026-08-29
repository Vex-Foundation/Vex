/**
 * vex.projects.delete - remove a Vex Studio project (stage B0).
 *
 * The handler is thin on purpose: `studio/project-delete.ts` owns the order of
 * operations (close admission, drain, tombstone, announce, clean up) because
 * that order is a lifecycle contract, not IPC plumbing.
 *
 * What this layer owns:
 *
 *   - the SENDER and SCHEMA gates, via `registerHandler` like every boundary;
 *   - CANCELLATION, threaded as an `AbortSignal`. It is honoured only BEFORE
 *     the transaction opens; once the authority commit is under way it runs to
 *     a terminal state whatever the renderer does, because a half-applied
 *     deletion is not an outcome this app offers;
 *   - LOGGING that names the outcome and never the project's folder.
 *
 * `expectedName` travels through to be revalidated against the stored row
 * inside the transaction. Validating it here instead would be a check against a
 * value read before the lock was taken.
 */

import { CH } from "@shared/ipc/channels.js";
import type { Result } from "@shared/ipc/result.js";
import {
  projectDeleteInputSchema,
  projectDeleteResultSchema,
  type ProjectDeleteResult,
} from "@shared/schemas/projects.js";
import { deleteProject } from "../../studio/project-delete.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

export function registerProjectsDeleteHandler(): () => void {
  return registerHandler({
    channel: CH.projects.delete,
    domain: "projects",
    inputSchema: projectDeleteInputSchema,
    outputSchema: projectDeleteResultSchema,
    handle: async (input, ctx): Promise<Result<ProjectDeleteResult>> => {
      const outcome = await deleteProject(input, ctx.requestId, ctx.signal);
      if (outcome.ok) {
        // The OUTCOME and the project id only. Never the slug, the folder, or
        // the artifact paths: a delete's log line is read in support bundles.
        log.info(
          `[ipc:vex:projects:delete] outcome=${outcome.data.outcome} `
            + `projectId=${input.projectId} correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:projects:delete] errCode=${outcome.error.code} `
          + `projectId=${input.projectId} correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}
