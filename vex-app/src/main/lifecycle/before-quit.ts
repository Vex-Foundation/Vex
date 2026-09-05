/**
 * Mission-safe quit framework (per user mandate + plan §H).
 *
 * Phase 1: framework only — no active missions yet. Phase 2 modules
 * register a check via registerActiveMissionCheck(); before-quit consults
 * them synchronously (cached state) plus may kick off an async deep check
 * which, if confirmed active, emits a confirmation dialog and re-quits.
 *
 * Critical: Electron does NOT await async listeners on `before-quit`.
 * `event.preventDefault()` MUST be called synchronously, BEFORE any await,
 * or the quit proceeds while the async check is still running.
 */

import { app, BrowserWindow, dialog } from "electron";
import { globalCleanup } from "./cleanup-registry.js";
import { QUIT_TOTAL_DEADLINE_MS, runQuitStage } from "./quit-stage.js";
import { log } from "../logger/index.js";

/**
 * Synchronous fast-path: returns boolean immediately based on cached state.
 * Phase 2 stores active mission count in a synchronously-readable atom
 * (e.g., a number kept in sync with mission lifecycle events).
 */
type SyncMissionCheck = () => boolean;

/**
 * Optional deep async verification — only invoked after the sync check has
 * already preempted the quit. Used to confirm the cached state matches DB.
 */
type AsyncMissionCheck = () => Promise<boolean>;

const syncChecks = new Set<SyncMissionCheck>();
const asyncChecks = new Set<AsyncMissionCheck>();

export function registerActiveMissionCheck(args: {
  readonly sync: SyncMissionCheck;
  readonly async?: AsyncMissionCheck;
}): () => void {
  syncChecks.add(args.sync);
  if (args.async) asyncChecks.add(args.async);
  return () => {
    syncChecks.delete(args.sync);
    if (args.async) asyncChecks.delete(args.async);
  };
}

function anyMissionActiveSync(): boolean {
  for (const check of syncChecks) {
    if (check()) return true;
  }
  return false;
}

async function anyMissionActiveDeep(): Promise<boolean> {
  for (const check of asyncChecks) {
    if (await check()) return true;
  }
  return false;
}

let confirmedQuit = false;

export function installBeforeQuitHook(): void {
  app.on("before-quit", (event) => {
    if (confirmedQuit) return;

    // Synchronous decision — must run before any await.
    if (!anyMissionActiveSync()) return;

    event.preventDefault();

    // Defer the user-facing dialog + deep check to the next tick. Use the
    // currently focused window as parent (must already exist — synchronously
    // checked). If no window exists, drop the dialog and just allow quit.
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    if (!parent || parent.isDestroyed()) {
      // No UI to confirm against — accept quit.
      confirmedQuit = true;
      app.quit();
      return;
    }

    // Deferred async work — MUST handle errors locally. If a check or dialog
    // throws after we've already preventDefault()'d the quit, the app would
    // otherwise hang forever waiting for the next quit attempt.
    void (async () => {
      try {
        const stillActive = (await anyMissionActiveDeep()) || anyMissionActiveSync();
        if (!stillActive) {
          confirmedQuit = true;
          app.quit();
          return;
        }

        const result = await dialog.showMessageBox(parent, {
          type: "warning",
          title: "Mission active",
          message: "An autonomous mission is currently running.",
          detail:
            "Mission state will be persisted and can be resumed on next launch. Quit anyway?",
          buttons: ["Cancel", "Quit and persist mission"],
          defaultId: 0,
          cancelId: 0,
        });
        if (result.response === 1) {
          confirmedQuit = true;
          app.quit();
        }
      } catch (err) {
        // Fail-open on quit: a broken check must not strand the user
        // unable to close the app. Log and accept quit.
        log.error("[before-quit] deferred check/dialog failed; accepting quit", err);
        confirmedQuit = true;
        app.quit();
      }
    })();
  });

  app.on("will-quit", (event) => {
    if (globalCleanup.size() === 0) return;
    event.preventDefault();
    void (async () => {
      try {
        // THE BACKSTOP THAT GUARANTEES THE PROCESS LEAVES. Every task inside
        // the registry already carries its own deadline; this bounds the whole
        // set, so a participant that escapes its own budget still cannot hold
        // `will-quit` open forever. `runQuitStage` names whatever it abandons
        // and never rejects, so `app.exit(0)` is reached on every path.
        await runQuitStage("globalCleanup.runAll", QUIT_TOTAL_DEADLINE_MS, () =>
          globalCleanup.runAll(),
        );
      } catch (err) {
        log.error("[will-quit] cleanup failed", err);
      } finally {
        app.exit(0);
      }
    })();
  });
}
