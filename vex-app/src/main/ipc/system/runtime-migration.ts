/**
 * vex.system.runtimeMigration* - moving an existing install's data into the
 * native runtime before it starts (the migration screen).
 *
 * Main owns the decision (`runtime/migration/native-start-gate.ts`): boot
 * detects, and the native runtime starts only once nothing is pending. These
 * handlers only expose the gate: the status, the move, start-fresh, and the
 * removal of the old data (IPC only; Settings gets its UI later). Outside
 * the native runtime there is nothing to move.
 *
 * A move takes minutes, so `runtimeMigrationMove` resolves when it settles
 * and every step is broadcast on `EV.system.runtimeMigrationProgress`. A
 * caller that joins a move in flight is sent its latest event directly, the
 * way `vex:database:migrate` replays to a late joiner.
 */

import { z } from "zod";
import { CH, EV } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  runtimeMigrationRemoveOldDataInputSchema,
  runtimeMigrationRemoveOldDataResultSchema,
  runtimeMigrationResultSchema,
  runtimeMigrationStartFreshResultSchema,
  runtimeMigrationStatusSchema,
  type RuntimeMigrationFailed,
  type RuntimeMigrationRemoveOldDataResult,
  type RuntimeMigrationResult,
  type RuntimeMigrationStartFreshResult,
  type RuntimeMigrationStatus,
} from "@shared/schemas/runtime-migration.js";
import { broadcastToAllWindows } from "../../lifecycle/broadcast.js";
import {
  nativeStartGate,
  runtimeMigrationProgressBus,
} from "../../runtime/migration/native-start-gate.js";
import { getRuntimeMode } from "../../runtime/runtime-mode.js";
import { registerHandler } from "../register-handler.js";

const empty = z.object({}).strict();

const NOT_NATIVE: RuntimeMigrationFailed = {
  kind: "failed",
  reason: "not_pending",
  message: "This install does not run on the native runtime.",
  requiredBytes: null,
  availableBytes: null,
};

const native = (): boolean => getRuntimeMode() === "native";

export function registerSystemRuntimeMigrationHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.system.runtimeMigrationStatus,
      domain: "system",
      inputSchema: empty,
      outputSchema: runtimeMigrationStatusSchema,
      handle: async (): Promise<Result<RuntimeMigrationStatus>> =>
        ok(native() ? await nativeStartGate().status() : { kind: "not_needed" }),
    }),

    registerHandler({
      channel: CH.system.runtimeMigrationMove,
      domain: "system",
      inputSchema: empty,
      outputSchema: runtimeMigrationResultSchema,
      handle: async (_input, ctx): Promise<Result<RuntimeMigrationResult>> => {
        if (!native()) return ok(NOT_NATIVE);
        const gate = nativeStartGate();
        const last = gate.lastProgress();
        if (last !== null && !ctx.event.sender.isDestroyed()) {
          ctx.event.sender.send(EV.system.runtimeMigrationProgress, last);
        }
        return ok(await gate.migrate());
      },
    }),

    registerHandler({
      channel: CH.system.runtimeMigrationStartFresh,
      domain: "system",
      inputSchema: empty,
      outputSchema: runtimeMigrationStartFreshResultSchema,
      handle: async (): Promise<Result<RuntimeMigrationStartFreshResult>> =>
        ok(native() ? await nativeStartGate().startFresh() : NOT_NATIVE),
    }),

    registerHandler({
      channel: CH.system.runtimeMigrationRemoveOldData,
      domain: "system",
      inputSchema: runtimeMigrationRemoveOldDataInputSchema,
      outputSchema: runtimeMigrationRemoveOldDataResultSchema,
      handle: async (input): Promise<Result<RuntimeMigrationRemoveOldDataResult>> =>
        ok(
          native()
            ? await nativeStartGate().removeOldData(input)
            : { kind: "refused", reason: "not_completed", message: "This install does not run on the native runtime." },
        ),
    }),

    runtimeMigrationProgressBus.subscribe((progress) =>
      broadcastToAllWindows(EV.system.runtimeMigrationProgress, progress),
    ),
  ];
}
