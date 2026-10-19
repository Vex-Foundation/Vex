/**
 * vex.system.runtimeInfo / runtimeRestart / runtimeReset - the Settings
 * "Local runtime" section (plan 8.4).
 *
 * Native mode only: `runtimeInfo` answers `permissions.denied` elsewhere, and
 * the two actions refuse with `not_native` (their guards live in
 * `runtime/native/local-runtime-maintenance.ts`). The renderer never sees a
 * path.
 *
 * `runtimeReset` takes the typed phrase (`runtimeResetInputSchema`), checked
 * here as well as in the renderer. On `reset` the app relaunches: the reset
 * leaves this process with no cluster, the schema latch already set and every
 * engine worker, cache and screen holding state from the deleted database,
 * and a fresh process is the one state that is consistent by construction.
 * The relaunch boots through the setup gate, which starts the runtime (a new
 * cluster), applies the migrations and resumes at unlock: wallets, the vault
 * and the config were kept, so setup has nothing else to ask. The
 * `.setup-complete` marker stays; only the wizard's finalize writes it, and a
 * completed wizard never runs finalize again, so removing it would send every
 * later launch through the first-run screens. Same scheduling as the vault
 * reset (`ipc/secrets.ts`): after the answer is on its way.
 */

import { app } from "electron";
import { z } from "zod";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  localRuntimeInfoSchema,
  runtimeResetInputSchema,
  runtimeResetResultSchema,
  runtimeRestartResultSchema,
  type LocalRuntimeInfo,
  type RuntimeResetResult,
  type RuntimeRestartResult,
} from "@shared/schemas/system.js";
import { log } from "../../logger/index.js";
import {
  readLocalRuntimeInfo,
  resetLocalData,
  restartLocalRuntime,
} from "../../runtime/native/local-runtime-actions.js";
import { getRuntimeMode } from "../../runtime/runtime-mode.js";
import { registerHandler } from "../register-handler.js";

const empty = z.object({}).strict();

export function registerSystemLocalRuntimeHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.system.runtimeInfo,
      domain: "system",
      inputSchema: empty,
      outputSchema: localRuntimeInfoSchema,
      handle: async (_input, ctx): Promise<Result<LocalRuntimeInfo>> => {
        if (getRuntimeMode() !== "native") {
          return err({
            code: "permissions.denied",
            domain: "system",
            message: "Vex is not running its bundled local runtime.",
            retryable: false,
            userActionable: false,
            redacted: true,
            correlationId: ctx.requestId,
          });
        }
        return ok(await readLocalRuntimeInfo());
      },
    }),

    registerHandler({
      channel: CH.system.runtimeRestart,
      domain: "system",
      inputSchema: empty,
      outputSchema: runtimeRestartResultSchema,
      handle: async (_input, ctx): Promise<Result<RuntimeRestartResult>> => {
        const result = await restartLocalRuntime();
        log.info(`[ipc:vex:system:runtimeRestart] ${result.kind} correlationId=${ctx.requestId}`);
        return ok(result);
      },
    }),

    registerHandler({
      channel: CH.system.runtimeReset,
      domain: "system",
      inputSchema: runtimeResetInputSchema,
      outputSchema: runtimeResetResultSchema,
      handle: async (_input, ctx): Promise<Result<RuntimeResetResult>> => {
        const result = await resetLocalData();
        log.info(`[ipc:vex:system:runtimeReset] ${result.kind} correlationId=${ctx.requestId}`);
        if (result.kind === "reset") {
          setImmediate(() => {
            app.relaunch();
            app.quit();
          });
        }
        return ok(result);
      },
    }),
  ];
}
