/**
 * vex.projects.create - Vex Studio project creation (stage P).
 *
 * Handler responsibility, and nothing else: resolve wallet ids server-side so
 * an unknown id fails closed before anything exists, then hand the validated
 * input to the single owner of project state
 * (`main/database/projects/create.ts`). The slug, the projects root, the
 * directory claim and the transaction all belong to that owner.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, type Result } from "@shared/ipc/result.js";
import {
  projectCreateInputSchema,
  projectCreateResultSchema,
  type ProjectCreateResult,
} from "@shared/schemas/projects.js";
import { createProject } from "../../database/projects/create.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { resolveProjectWallets } from "./wallet-refs.js";

export function registerProjectsCreateHandler(): () => void {
  return registerHandler({
    channel: CH.projects.create,
    domain: "projects",
    inputSchema: projectCreateInputSchema,
    outputSchema: projectCreateResultSchema,
    handle: async (input, ctx): Promise<Result<ProjectCreateResult>> => {
      const wallets = resolveProjectWallets(input.wallets, ctx.requestId);
      if (wallets.kind === "invalid") {
        log.info(
          `[ipc:vex:projects:create] invalid_wallet_selection correlationId=${ctx.requestId}`,
        );
        return err(wallets.error);
      }
      const outcome = await createProject(input, wallets.refs, ctx.requestId);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:projects:create] ok permission=${outcome.data.permission} ` +
            `agents=${outcome.data.agents.length} correlationId=${ctx.requestId}`,
        );
      } else {
        log.info(
          `[ipc:vex:projects:create] errCode=${outcome.error.code} correlationId=${ctx.requestId}`,
        );
      }
      return outcome;
    },
  });
}
