/**
 * vex.projects.create - Vex Studio project creation (stage P).
 *
 * Handler responsibility, and nothing else: resolve wallet ids server-side so
 * an unknown id fails closed before anything exists, hand the validated input
 * to the single owner of project state (`main/database/projects/create.ts`),
 * and then RENDER the files that project was created to have. The slug, the
 * projects root, the directory claim and the transaction all belong to that
 * owner; the reconciliation belongs to the installer.
 *
 * ## The render runs AFTER the commit, and it cannot fail the create
 *
 * The dialog that calls this promises "Vex writes an MCP config for each agent
 * you select". Creation used to write none: every artifact came back `missing`
 * and the only route to the promised files was finding Repair. So a create now
 * enqueues the same per-project serialized render every other trigger uses,
 * with its own `create` trigger.
 *
 * It runs after the transaction commits, for the reason `updateScope` states:
 * a render before the commit could write authority the transaction then rolled
 * back. And its failure is never the call's failure - the project EXISTS, its
 * directory is claimed and its backing session is written, so reporting "create
 * failed" would be false and would invite the user to create it again. A render
 * that could not run comes back as a named `runFailure` on the envelope.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  projectCreateInputSchema,
  projectCreateResultSchema,
  type ProjectCreateResult,
} from "@shared/schemas/projects.js";
import { createProject } from "../../database/projects/create.js";
import { log } from "../../logger/index.js";
import { renderProjectFiles } from "../../studio/installer.js";
import { registerHandler } from "../register-handler.js";
import {
  buildProjectRenderEnvelope,
  renderFailureOutcome,
} from "./render-envelope.js";
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
      if (!outcome.ok) {
        log.info(
          `[ipc:vex:projects:create] errCode=${outcome.error.code} correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      {
        log.info(
          `[ipc:vex:projects:create] ok permission=${outcome.data.permission} ` +
            `agents=${outcome.data.agents.length} correlationId=${ctx.requestId}`,
        );
      }

      const render = await renderProjectFiles(
        outcome.data.id,
        "create",
        ctx.requestId,
      );
      if (!render.ok) {
        log.info(
          `[ipc:vex:projects:create] render errCode=${render.error.code} `
            + `correlationId=${ctx.requestId}`,
        );
      }

      // RE-READ, always. A completed render advances the durable last-rendered
      // marker, and `outcome.data` was read before the render ran: returning it
      // would show the "Vex has never completed a full pass" banner above a
      // report of the pass that just finished.
      return ok(
        await buildProjectRenderEnvelope(
          outcome.data,
          render.ok
            ? render.data
            : renderFailureOutcome(
              render.error,
              outcome.data.scopeVersion,
              "create",
            ),
          ctx.requestId,
        ),
      );
    },
  });
}
