/**
 * vex.projects.updateScope - permission, wallet and agent-roster edits.
 *
 * Wallet ids are resolved here, exactly as on the create path, so an unknown id
 * refuses the edit before the transaction opens. `wallets` being absent means
 * "leave the selection alone"; the DB owner receives `null` for that case and
 * never touches `project_wallets` or the session's mirrored wallet columns.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  projectUpdateScopeInputSchema,
  projectUpdateScopeResultSchema,
  type ProjectUpdateScopeResult,
} from "@shared/schemas/projects.js";
import { updateProjectScope } from "../../database/projects/scope.js";
import { log } from "../../logger/index.js";
import { renderProjectFiles } from "../../studio/installer.js";
import { registerHandler } from "../register-handler.js";
import { withProjectFiles } from "./files.js";
import { resolveProjectWallets } from "./wallet-refs.js";

export function registerProjectsUpdateScopeHandler(): () => void {
  return registerHandler({
    channel: CH.projects.updateScope,
    domain: "projects",
    inputSchema: projectUpdateScopeInputSchema,
    outputSchema: projectUpdateScopeResultSchema,
    handle: async (input, ctx): Promise<Result<ProjectUpdateScopeResult>> => {
      let refs = null;
      if (input.wallets !== undefined) {
        const resolved = resolveProjectWallets(input.wallets, ctx.requestId);
        if (resolved.kind === "invalid") {
          log.info(
            `[ipc:vex:projects:updateScope] invalid_wallet_selection correlationId=${ctx.requestId}`,
          );
          return err(resolved.error);
        }
        refs = resolved.refs;
      }
      const outcome = await updateProjectScope(input, refs, ctx.requestId);
      if (!outcome.ok) {
        log.info(
          `[ipc:vex:projects:updateScope] errCode=${outcome.error.code} correlationId=${ctx.requestId}`,
        );
        return err(outcome.error);
      }

      // AFTER the commit, never before. The render reloads the latest committed
      // scope when the per-project queue lets it run, so an edit that lands
      // while this render is queued simply supersedes it - and a render that
      // ran before the commit could have written authority the transaction
      // then rolled back.
      const render = await renderProjectFiles(
        input.projectId,
        "scope_update",
        ctx.requestId,
      );
      if (!render.ok) {
        // The scope edit IS committed. Reporting the render failure as the
        // whole call's failure would tell the user their settings change did
        // not happen, which is false, so the error is surfaced as a refused
        // reconciliation instead of an error on the authority edit.
        log.info(
          `[ipc:vex:projects:updateScope] render errCode=${render.error.code} `
            + `correlationId=${ctx.requestId}`,
        );
        return ok({
          project: await withProjectFiles(outcome.data, ctx.requestId),
          render: {
            scopeVersion: outcome.data.scopeVersion,
            completed: false,
            trigger: "scope_update",
            artifacts: [],
            warnings: [
              {
                kind: "launch_required",
                agentId: null,
                detail:
                  "Your settings were saved, but Vex could not update this project's "
                  + "coding-agent files. Use Repair to try again.",
              },
            ],
          },
        });
      }

      return ok({
        project: await withProjectFiles(outcome.data, ctx.requestId),
        render: render.data,
      });
    },
  });
}
