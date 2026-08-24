/**
 * vex.projects.updateScope - permission, wallet and agent-roster edits.
 *
 * Wallet ids are resolved here, exactly as on the create path, so an unknown id
 * refuses the edit before the transaction opens. `wallets` being absent means
 * "leave the selection alone"; the DB owner receives `null` for that case and
 * never touches `project_wallets` or the session's mirrored wallet columns.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, type Result } from "@shared/ipc/result.js";
import {
  projectUpdateScopeInputSchema,
  projectUpdateScopeResultSchema,
  type ProjectUpdateScopeResult,
} from "@shared/schemas/projects.js";
import { updateProjectScope } from "../../database/projects/scope.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
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
      }
      return outcome;
    },
  });
}
