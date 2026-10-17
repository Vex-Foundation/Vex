/**
 * The production wiring of Settings' "Local runtime" section: what it reads
 * (`readLocalRuntimeInfo`) and the two actions (`local-runtime-maintenance.ts`)
 * bound to the process-wide runtime, the real filesystem and the engine's
 * database readiness.
 */

import { promises as fs } from "node:fs";
import type { LocalRuntimeInfo, RuntimeResetResult, RuntimeRestartResult } from "@shared/schemas/system.js";
import { recycleEngineDbAfterRestart } from "../../database/engine-db-readiness.js";
import { log } from "../../logger/index.js";
import { activeCriticalOps, beginCriticalOp, CRITICAL_OP } from "../../updates/critical-ops.js";
import { nativeStartGate } from "../migration/native-start-gate.js";
import { getRuntimeMode } from "../runtime-mode.js";
import { modelsDir, pgDataDir, RUNTIME_DIR } from "../runtime-paths.js";
import { readRuntimeState, writeRuntimeState } from "../runtime-state.js";
import { measureDirectory } from "./dir-size.js";
import { createLocalRuntimeMaintenance, type LocalRuntimeMaintenance } from "./local-runtime-maintenance.js";
import { acquireNativeRuntimeHold } from "./native-runtime.js";
import { nativeRuntimeProgress } from "./native-runtime-progress.js";
import { bundledVersions, NATIVE_RUNTIME_RELEASE } from "./runtime-versions.js";

/** Alive, or alive but another user's (EPERM): either way it holds what it holds. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

let maintenance: LocalRuntimeMaintenance | null = null;

function production(): LocalRuntimeMaintenance {
  maintenance ??= createLocalRuntimeMaintenance({
    runtimeDir: RUNTIME_DIR,
    isNative: () => getRuntimeMode() === "native",
    acquireHold: acquireNativeRuntimeHold,
    activeCriticalOps,
    startGateOpen: () => nativeStartGate().isOpen(),
    beginLocalRuntimeOp: () => beginCriticalOp(CRITICAL_OP.localRuntime),
    currentStatus: () => nativeRuntimeProgress.current(),
    reconnectEngineDb: recycleEngineDbAfterRestart,
    readState: readRuntimeState,
    writeState: writeRuntimeState,
    measure: (dir) => measureDirectory(dir),
    fs: {
      lstat: (file) => fs.lstat(file),
      realpath: (file) => fs.realpath(file),
      readFile: (file) => fs.readFile(file, "utf8"),
      rm: (file) => fs.rm(file, { recursive: true, force: true }),
    },
    processAlive,
    log: {
      info: (line) => log.info(line),
      warn: (line) => log.warn(line),
      error: (line) => log.error(line),
    },
  });
  return maintenance;
}

export function restartLocalRuntime(): Promise<RuntimeRestartResult> {
  return production().restart();
}

export function resetLocalData(): Promise<RuntimeResetResult> {
  return production().reset();
}

/** The release, the binaries' versions and the two data sizes, measured off the main thread's critical path. */
export async function readLocalRuntimeInfo(): Promise<LocalRuntimeInfo> {
  const [versions, database, model] = await Promise.all([
    bundledVersions(),
    measureDirectory(pgDataDir(RUNTIME_DIR)),
    measureDirectory(modelsDir(RUNTIME_DIR)),
  ]);
  return { release: NATIVE_RUNTIME_RELEASE, versions, sizes: { database, model } };
}
