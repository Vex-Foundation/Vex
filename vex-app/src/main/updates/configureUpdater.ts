/**
 * Main-process `electron-updater` configuration (M13).
 *
 * Policy (skill vex-user-triggered-updates §"Non-negotiable rules"):
 *   - check runs on app start + window focus + a periodic 5-minute tick and
 *     on manual request — never
 *     auto-downloads or auto-installs;
 *   - download starts only via `updates.startUpdateNow()`;
 *   - restart/install happens only via `updates.restartAndInstallNow()`.
 *
 * This module owns the autoUpdater event stream and funnels every transition
 * through the sanitized status cache. `update-downloaded` ONLY sets
 * `downloaded` — it NEVER auto-restarts (two-step UX). It deliberately does NOT
 * import `updateActions` (keeps the dependency graph acyclic).
 */

import { app } from "electron";
import electronUpdater from "electron-updater";
import type { ProgressInfo, UpdateInfo } from "electron-updater";
import {
  availableStatus,
  downloadingStatus,
  errorStatus,
  filteredUpdaterLogger,
} from "./sanitize.js";
import { isSilentCheckActive } from "./auto-check-state.js";
import {
  clearUpdateRestartInProgress,
  isUpdateRestartInProgress,
} from "./safeRestart.js";
import { currentVersion, getCurrentStatus, setStatus } from "./statusCache.js";

const { autoUpdater } = electronUpdater;

let configured = false;
const removers: Array<() => void> = [];

export function configureUpdater(): void {
  if (configured) return;
  configured = true;

  autoUpdater.logger = filteredUpdaterLogger;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.autoRunAppAfterInstall = true;

  // Dev feed is OPT-IN. In plain dev we never auto-resolve a feed (no error
  // spam, no surprise downloads). To exercise the flow locally, drop a
  // `dev-app-update.yml` and run with VEX_UPDATER_DEV_FEED=1.
  if (!app.isPackaged && process.env.VEX_UPDATER_DEV_FEED === "1") {
    autoUpdater.forceDevUpdateConfig = true;
  }

  const onChecking = (): void => {
    // A SILENT (ambient) check transitions to `checking` ONLY from the quiet
    // states (idle/current). Everything else is preserved:
    //  - `available`: the transient `checking` renders no toast, so flipping
    //    would flash the visible toast away and back for no reason;
    //  - `error`: a silent retry from a broken feed must not cycle
    //    error -> checking -> error, which the renderer reads as a FRESH
    //    error and re-toasts a dismissed banner every retry (nag);
    //  - `downloading`/`downloaded`/`installing`/`blockedByOperation`: the
    //    scheduler's safe-state guard races its awaited preference read - a
    //    download started in that gap must never be clobbered.
    // A manual (non-silent) check always reflects the live "checking" state.
    if (isSilentCheckActive()) {
      const kind = getCurrentStatus().kind;
      if (kind !== "idle" && kind !== "current") return;
    }
    setStatus({ kind: "checking", currentVersion: currentVersion() });
  };
  /**
   * During a SILENT check, an availability result must not clobber an
   * in-progress or actionable download state: a user can start a download
   * while the ambient check's HTTP round-trip is still in flight, and the
   * late `update-available`/`update-not-available` event would otherwise
   * rewind `downloading` back to `available`/`current`.
   */
  const silentResultMustYield = (): boolean => {
    if (!isSilentCheckActive()) return false;
    const kind = getCurrentStatus().kind;
    return (
      kind === "downloading" ||
      kind === "downloaded" ||
      kind === "installing" ||
      kind === "blockedByOperation"
    );
  };
  const onAvailable = (info: UpdateInfo): void => {
    if (silentResultMustYield()) return;
    setStatus(availableStatus(info, currentVersion()));
  };
  const onNotAvailable = (): void => {
    if (silentResultMustYield()) return;
    setStatus({
      kind: "current",
      currentVersion: currentVersion(),
      checkedAt: new Date().toISOString(),
    });
  };
  const onProgress = (info: ProgressInfo): void => {
    setStatus(downloadingStatus(info, currentVersion()));
  };
  const onDownloaded = (info: UpdateInfo): void => {
    // TWO-STEP: only mark downloaded. The restart is a SEPARATE explicit user
    // action (`restartAndInstallNow`). Never auto-restart here.
    const latestVersion =
      typeof info.version === "string" && info.version.length > 0
        ? info.version
        : currentVersion();
    setStatus({ kind: "downloaded", currentVersion: currentVersion(), latestVersion });
  };
  const onError = (error: Error): void => {
    // Ambient auto-check failures (e.g. no feed configured yet) must not nag
    // with an error banner; only manual check / download / install errors do.
    if (isSilentCheckActive()) return;
    setStatus(errorStatus(error, currentVersion()));
    // A failed quitAndInstall()/install() emits `error` while a restart is in
    // progress (the app stays open). Release the restart flag so
    // restartAndInstallNow() is not permanently idempotent and the user can
    // retry, rather than getting a silent ok({restarting:true}) no-op.
    if (isUpdateRestartInProgress()) clearUpdateRestartInProgress();
  };

  autoUpdater.on("checking-for-update", onChecking);
  autoUpdater.on("update-available", onAvailable);
  autoUpdater.on("update-not-available", onNotAvailable);
  autoUpdater.on("download-progress", onProgress);
  autoUpdater.on("update-downloaded", onDownloaded);
  autoUpdater.on("error", onError);

  removers.push(
    () => autoUpdater.removeListener("checking-for-update", onChecking),
    () => autoUpdater.removeListener("update-available", onAvailable),
    () => autoUpdater.removeListener("update-not-available", onNotAvailable),
    () => autoUpdater.removeListener("download-progress", onProgress),
    () => autoUpdater.removeListener("update-downloaded", onDownloaded),
    () => autoUpdater.removeListener("error", onError),
  );
}

/**
 * Idempotent teardown of the listeners this module added. Used ONLY by app
 * quit cleanup (globalCleanup in index.ts) — NOT by the update restart path,
 * which intentionally keeps listeners active through quitAndInstall() so a
 * synchronous install() `error` is still delivered.
 */
export function removeUpdaterEventListeners(): void {
  for (const remove of removers) remove();
  removers.length = 0;
  configured = false;
}
