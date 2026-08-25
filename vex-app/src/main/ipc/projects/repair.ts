/**
 * vex.projects.repairFiles - reconcile every artifact, drift included.
 *
 * Repair is a SEPARATE CHANNEL rather than a flag on `updateScope` because it
 * carries authority an update does not: it is the only path that overwrites an
 * artifact a human edited after Vex wrote it. Making that an explicit user
 * action with its own name is what stops a routine settings edit from quietly
 * discarding someone's changes to their own `AGENTS.md`.
 *
 * It takes NO `expectedScopeVersion`. Repair does not change authority - it
 * reconciles files against whatever the committed scope already is - so there
 * is no version to consume and nothing for a concurrent edit to conflict with.
 * The render job reloads the latest committed scope when it runs, exactly as a
 * scope-triggered render does.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  projectRepairFilesInputSchema,
  projectRepairFilesResultSchema,
  type ProjectRepairFilesResult,
} from "@shared/schemas/projects.js";
import { getProject } from "../../database/projects/read.js";
import { log } from "../../logger/index.js";
import { projectNotFoundError } from "../../studio/project-errors.js";
import { renderProjectFiles } from "../../studio/installer.js";
import { registerHandler } from "../register-handler.js";
import { withProjectFiles } from "./files.js";

export function registerProjectsRepairFilesHandler(): () => void {
  return registerHandler({
    channel: CH.projects.repairFiles,
    domain: "projects",
    inputSchema: projectRepairFilesInputSchema,
    outputSchema: projectRepairFilesResultSchema,
    handle: async (input, ctx): Promise<Result<ProjectRepairFilesResult>> => {
      const render = await renderProjectFiles(input.projectId, "repair", ctx.requestId);
      if (!render.ok) {
        log.info(
          `[ipc:vex:projects:repairFiles] errCode=${render.error.code} correlationId=${ctx.requestId}`,
        );
        return err(render.error);
      }

      // Re-read AFTER the render so the returned row carries the marker the run
      // just advanced and the file status the run just produced.
      const project = await getProject(input.projectId, ctx.requestId);
      if (!project.ok) return err(project.error);
      if (project.data === null) return err(projectNotFoundError(ctx.requestId));

      return ok({
        project: await withProjectFiles(project.data, ctx.requestId),
        render: render.data,
      });
    },
  });
}
