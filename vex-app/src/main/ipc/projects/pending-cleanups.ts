import { refreshCleanupHolders } from "../../studio/pending-cleanup-holders.js";
import { CH } from "@shared/ipc/channels.js";
import { projectPendingCleanupsInputSchema, projectPendingCleanupsSchema } from "@shared/schemas/project-cleanup.js";
import { readPendingProjectCleanups } from "../../database/projects/pending-cleanups.js";
import { registerHandler } from "../register-handler.js";

/** A bounded read; retry uses the existing delete gate and durable trash intent. */
export function registerProjectsPendingCleanupsHandler(): () => void {
  return registerHandler({
    channel: CH.projects.pendingCleanups,
    domain: "projects",
    inputSchema: projectPendingCleanupsInputSchema,
    outputSchema: projectPendingCleanupsSchema,
    handle: async (input, ctx) => {
      const result = await readPendingProjectCleanups(input.offset);
      if (!result.ok) return result;
      return { ok: true, data: await refreshCleanupHolders(result.data, ctx.signal) };
    },
  });
}
