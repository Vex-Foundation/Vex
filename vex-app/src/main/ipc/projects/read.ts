/**
 * vex.projects.get / vex.projects.list - read-only project surface (stage P).
 *
 * Neither read exposes a filesystem capability: the DTO carries a root-relative
 * `rootPath` and a display-only `displayPath`. The backing session is not part
 * of the read surface either, beyond its id, and no agent-mode session API
 * returns it because those reads filter `scope = 'vex_app'`.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  projectGetInputSchema,
  projectGetResultSchema,
  projectListInputSchema,
  projectListSchema,
  type ProjectGetResult,
  type ProjectList,
} from "@shared/schemas/projects.js";
import { getProject, listProjects } from "../../database/projects/read.js";
import { registerHandler } from "../register-handler.js";
import { withProjectFiles, withProjectFilesAll } from "./files.js";

export function registerProjectsGetHandler(): () => void {
  return registerHandler({
    channel: CH.projects.get,
    domain: "projects",
    inputSchema: projectGetInputSchema,
    outputSchema: projectGetResultSchema,
    handle: async (input, ctx): Promise<Result<ProjectGetResult>> => {
      const outcome = await getProject(input.projectId, ctx.requestId);
      if (!outcome.ok || outcome.data === null) return outcome;
      return ok(await withProjectFiles(outcome.data, ctx.requestId));
    },
  });
}

export function registerProjectsListHandler(): () => void {
  return registerHandler({
    channel: CH.projects.list,
    domain: "projects",
    inputSchema: projectListInputSchema,
    outputSchema: projectListSchema,
    handle: async (_input, ctx): Promise<Result<ProjectList>> => {
      const outcome = await listProjects(ctx.requestId);
      if (!outcome.ok) return outcome;
      return ok(await withProjectFilesAll(outcome.data, ctx.requestId));
    },
  });
}
