import { CH, EV } from "../../shared/ipc/channels.js";
import {
  runtimeMigrationProgressSchema,
  runtimeMigrationRemoveOldDataInputSchema,
} from "../../shared/schemas/runtime-migration.js";
import { nativeRuntimeStatusSchema } from "../../shared/schemas/system.js";
import type { SystemBridge } from "../../shared/types/bridge/shell/system.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

export const system = {
  health() {
    return invokeWithSchema(CH.system.health, {});
  },
  osInfo() {
    return invokeWithSchema(CH.system.osInfo, {});
  },
  network() {
    return invokeWithSchema(CH.system.network, {});
  },
  runtime() {
    return invokeWithSchema(CH.system.runtime, {});
  },
  runtimeStatus() {
    return invokeWithSchema(CH.system.runtimeStatus, {});
  },
  runtimeRetry() {
    return invokeWithSchema(CH.system.runtimeRetry, {});
  },
  localRuntimeCheck() {
    return invokeWithSchema(CH.system.localRuntimeCheck, {});
  },
  onRuntimeProgress(cb) {
    return subscribe(EV.system.runtimeProgress, nativeRuntimeStatusSchema, cb);
  },
  runtimeMigrationStatus() {
    return invokeWithSchema(CH.system.runtimeMigrationStatus, {});
  },
  runtimeMigrationMove() {
    return invokeWithSchema(CH.system.runtimeMigrationMove, {});
  },
  runtimeMigrationStartFresh() {
    return invokeWithSchema(CH.system.runtimeMigrationStartFresh, {});
  },
  runtimeMigrationRemoveOldData(input) {
    return invokeWithSchema(CH.system.runtimeMigrationRemoveOldData, input, runtimeMigrationRemoveOldDataInputSchema);
  },
  onRuntimeMigrationProgress(cb) {
    return subscribe(EV.system.runtimeMigrationProgress, runtimeMigrationProgressSchema, cb);
  },
  notifyTurnComplete(input) {
    return invokeWithSchema(CH.system.notifyTurnComplete, input);
  },
  setTitleBarOverlay(input) {
    return invokeWithSchema(CH.system.setTitleBarOverlay, input);
  },
} satisfies SystemBridge;
