/**
 * Safe-restart gate for the user-triggered updater (M13).
 *
 * `quitAndInstall` must never interrupt work that an abrupt restart could
 * corrupt (skill §"Safe restart gate"). Two signals:
 *   - agent/mission execution — a DB-backed query (`hasActiveAgentWork`), the
 *     only correct signal since runs outlive the IPC handler that starts them;
 *   - local destructive ops (local runtime / db migration) — the in-memory
 *     `critical-ops` registry.
 *
 * `prepareForUpdateRestart()` is intentionally lightweight: it only flags the
 * restart, then the caller invokes `quitAndInstall`. It deliberately does NOT
 * remove updater event listeners (electron-updater can emit `error`
 * synchronously from install(), and Node throws on a listener-less 'error'
 * event); they are torn down by the normal quit cleanup. The heavy teardown
 * (drain workers -> stop the local runtime, its data kept -> lock secrets)
 * is done by the existing `will-quit` ->
 * `globalCleanup` path that `quitAndInstall`'s `app.quit()` triggers;
 * electron-updater spawns the detached installer in `install()` BEFORE
 * `app.quit()`, so it survives the subsequent hard exit. We deliberately do
 * NOT pre-drain `globalCleanup` or reset the local runtime's data here.
 */

import { hasActiveAgentWork } from "../database/mission-runs-db.js";
import {
  CRITICAL_OP,
  activeCriticalOps,
  criticalOpInFlight,
} from "./critical-ops.js";

export type RestartGate = { ok: true } | { ok: false; message: string };

let updateRestartInProgress = false;

export function isUpdateRestartInProgress(): boolean {
  return updateRestartInProgress;
}

/**
 * Clear the in-progress flag. Called from the updater `error` listener when a
 * restart was underway: if `quitAndInstall()`/`install()` fails (e.g. a missing
 * installer path) the app stays open, so the flag must be released or
 * `restartAndInstallNow()` would short-circuit forever and the user could never
 * retry.
 */
export function clearUpdateRestartInProgress(): void {
  updateRestartInProgress = false;
}

export async function canRestartForUpdate(): Promise<RestartGate> {
  const agentWork = await hasActiveAgentWork();
  if (agentWork.active) {
    return { ok: false, message: agentWork.reason };
  }
  if (criticalOpInFlight()) {
    return { ok: false, message: criticalOpReason(activeCriticalOps()) };
  }
  return { ok: true };
}

export function prepareForUpdateRestart(): void {
  updateRestartInProgress = true;
  // Do NOT remove updater event listeners here: electron-updater can emit
  // `error` synchronously from install()/quitAndInstall() (e.g. a missing
  // installer path), and Node throws on an EventEmitter 'error' with no
  // listener. Listeners are torn down by the normal quit cleanup
  // (globalCleanup -> removeUpdaterEventListeners) AFTER quitAndInstall.
}

const CRITICAL_OP_REASONS: Record<string, string> = {
  [CRITICAL_OP.localRuntime]:
    "The local database is still starting. Wait for it to finish, then update.",
  [CRITICAL_OP.dbMigration]:
    "A database migration is still running. Wait for it to finish, then update.",
  [CRITICAL_OP.secretVaultOp]:
    "A wallet or secret-vault operation is still in progress. Wait for it to finish, then update.",
};

function criticalOpReason(labels: readonly string[]): string {
  for (const label of labels) {
    const reason = CRITICAL_OP_REASONS[label];
    if (reason) return reason;
  }
  return "An operation is still running. Finish it before updating.";
}

/** Test-only: reset the in-progress flag. */
export function __resetSafeRestartForTests(): void {
  updateRestartInProgress = false;
}
