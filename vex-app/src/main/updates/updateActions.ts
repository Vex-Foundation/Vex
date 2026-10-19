/**
 * Business actions behind the `vex.updater.*` IPC surface (M13).
 *
 * Two-step UX: `startUpdateNow` consents to DOWNLOAD only; `restartAndInstallNow`
 * is the SEPARATE explicit restart action. `update-downloaded` (in
 * configureUpdater) never auto-restarts. Every action returns a redacted
 * `Result`; the renderer never receives installer paths/URLs/tokens.
 */

import { shell } from "electron";
import electronUpdater from "electron-updater";
import { err, ok, type Result } from "@shared/ipc/result.js";
import type {
  ReleaseNotesOpened,
  UpdateCancelled,
  UpdateRestarting,
  UpdateStarted,
  UpdateStatus,
} from "@shared/schemas/updater.js";
import { log } from "../logger/index.js";
import { RUNTIME_QUIT_DEADLINE_MS } from "../lifecycle/quit-stage.js";
import { preferencesStore } from "../preferences/store.js";
import { stopNativeRuntime } from "../runtime/native/native-runtime.js";
import { getRuntimeMode } from "../runtime/runtime-mode.js";
import { setSilentCheckActive } from "./auto-check-state.js";
import { errorStatus, publicUpdateError } from "./sanitize.js";
import {
  canRestartForUpdate,
  isUpdateRestartInProgress,
  prepareForUpdateRestart,
} from "./safeRestart.js";
import { currentVersion, getCurrentStatus, setStatus } from "./statusCache.js";

const { autoUpdater, CancellationToken } = electronUpdater;

let downloadInFlight: InstanceType<typeof CancellationToken> | null = null;

// Built in main; the renderer never constructs updater URLs. The Vex
// releases page is also covered by the external-link allowlist in
// windows/main-window.ts (host "projectvex.ai", pathPrefix "/releases").
const RELEASE_NOTES_URL = "https://projectvex.ai/releases";

export async function getStatus(): Promise<Result<UpdateStatus>> {
  return ok(getCurrentStatus());
}

export async function checkNow(
  correlationId: string,
): Promise<Result<UpdateStatus>> {
  try {
    // `checkForUpdates()` resolves null when no feed/update; the autoUpdater
    // events fired during the check have already updated the status cache.
    await autoUpdater.checkForUpdates();
    void preferencesStore
      .update({ updater: { lastCheckedAt: new Date().toISOString() } })
      .catch((cause) =>
        log.warn("[updates] failed to persist updater.lastCheckedAt", cause),
      );
    return ok(getCurrentStatus());
  } catch (error) {
    log.warn(`[updates] checkForUpdates failed correlationId=${correlationId}`);
    setStatus(errorStatus(error, currentVersion()));
    return err(publicUpdateError("update.check_failed", correlationId));
  }
}

/**
 * Ambient (auto) check used by the start/focus scheduler. Unlike `checkNow` it
 * NEVER surfaces an error: a failure (e.g. no feed configured yet) is swallowed
 * (logged), and the updater `error` event is suppressed for its duration via
 * the silent-check flag. The update-available / not-available events still
 * drive the status cache, so a REAL update still raises the banner. Returns
 * true when a check completed, false on failure.
 */
export async function silentCheck(): Promise<boolean> {
  const priorStatus = getCurrentStatus();
  setSilentCheckActive(true);
  try {
    await autoUpdater.checkForUpdates();
    void preferencesStore
      .update({ updater: { lastCheckedAt: new Date().toISOString() } })
      .catch((cause) =>
        log.warn("[updates] failed to persist updater.lastCheckedAt", cause),
      );
    return true;
  } catch {
    log.info("[updates] ambient auto-check failed (swallowed)");
    // The `checking-for-update` event already flipped status to `checking`,
    // and the suppressed `error` left it there. Restore the prior quiet status
    // so future ambient checks aren't disabled (checking is non-quiet) — but
    // only if still `checking`, to avoid clobbering a real available/current
    // event that may have arrived first.
    if (getCurrentStatus().kind === "checking") {
      setStatus(priorStatus);
    }
    return false;
  } finally {
    setSilentCheckActive(false);
  }
}

export async function startUpdateNow(
  correlationId: string,
): Promise<Result<UpdateStarted>> {
  // Idempotent: a download already running is a successful start.
  if (downloadInFlight !== null) return ok({ started: true });

  const status = getCurrentStatus();
  // Accept the fresh `available` state OR a "Try again" retry from
  // `blockedByOperation` whose blocked step was the download — otherwise the
  // recovery CTA is a dead end. The gate is re-checked live below either way.
  if (
    status.kind !== "available" &&
    !(
      status.kind === "blockedByOperation" && status.blockedAction === "download"
    )
  ) {
    return err(
      publicUpdateError(
        "update.apply_failed",
        correlationId,
        "No update is available to download.",
      ),
    );
  }

  const gate = await canRestartForUpdate();
  if (!gate.ok) {
    setStatus({
      kind: "blockedByOperation",
      currentVersion: currentVersion(),
      latestVersion: status.latestVersion,
      reason: gate.message,
      blockedAction: "download",
      severity: status.severity,
      ...(status.releaseDate !== undefined
        ? { releaseDate: status.releaseDate }
        : {}),
      ...(status.summary !== undefined ? { summary: status.summary } : {}),
      wasDownloaded: false,
    });
    return err(
      publicUpdateError("update.apply_failed", correlationId, gate.message),
    );
  }

  try {
    const token = new CancellationToken();
    downloadInFlight = token;
    setStatus({
      kind: "downloading",
      currentVersion: currentVersion(),
      latestVersion: status.latestVersion,
      percent: 0,
    });
    // Fire-and-forget: the IPC ack is non-blocking; progress + completion
    // arrive via the autoUpdater event stream. The token ref keeps the
    // operation cancellable and alive; both settle paths clear it so a later
    // check -> download (e.g. a newer version after the user defers a restart)
    // is not blocked by a permanently-stuck in-flight token.
    void autoUpdater
      .downloadUpdate(token)
      .then(() => {
        if (downloadInFlight === token) downloadInFlight = null;
      })
      .catch((error: unknown) => {
        if (downloadInFlight === token) {
          downloadInFlight = null;
          log.warn(
            `[updates] downloadUpdate failed correlationId=${correlationId}`,
          );
          setStatus(errorStatus(error, currentVersion()));
        }
      });
    return ok({ started: true });
  } catch (error) {
    downloadInFlight = null;
    setStatus(errorStatus(error, currentVersion()));
    return err(publicUpdateError("update.download_failed", correlationId));
  }
}

export async function cancelDownload(): Promise<Result<UpdateCancelled>> {
  downloadInFlight?.cancel();
  downloadInFlight = null;
  const status = getCurrentStatus();
  if (status.kind === "downloading") {
    setStatus({
      kind: "available",
      currentVersion: currentVersion(),
      latestVersion: status.latestVersion,
      severity: "normal",
    });
  }
  return ok({ cancelled: true });
}

export async function restartAndInstallNow(
  correlationId: string,
): Promise<Result<UpdateRestarting>> {
  // Idempotent under double-click / hostile renderer: a restart already
  // underway (or `installing`) is a successful no-op.
  if (isUpdateRestartInProgress()) return ok({ restarting: true });

  const status = getCurrentStatus();
  if (status.kind === "installing") return ok({ restarting: true });
  // Accept `downloaded` OR a "Try again" retry from `blockedByOperation` whose
  // blocked step was the install and whose artifact is already on disk —
  // otherwise the recovery CTA is a dead end. The gate is re-checked live below.
  if (
    status.kind !== "downloaded" &&
    !(
      status.kind === "blockedByOperation" &&
      status.blockedAction === "install" &&
      status.wasDownloaded
    )
  ) {
    return err(
      publicUpdateError(
        "update.apply_failed",
        correlationId,
        "No downloaded update is ready to install.",
      ),
    );
  }

  const gate = await canRestartForUpdate();
  if (!gate.ok) {
    setStatus({
      kind: "blockedByOperation",
      currentVersion: currentVersion(),
      latestVersion: status.latestVersion,
      reason: gate.message,
      blockedAction: "install",
      // `downloaded` doesn't carry severity/releaseDate/summary (only
      // `available` does), so there's nothing to preserve here beyond the
      // default UX-normal severity — this is a UX convention, not a security
      // signal (sanitize.ts).
      severity: "normal",
      wasDownloaded: true,
    });
    return err(
      publicUpdateError("update.apply_failed", correlationId, gate.message),
    );
  }

  setStatus({
    kind: "installing",
    currentVersion: currentVersion(),
    latestVersion: status.latestVersion,
  });
  prepareForUpdateRestart();
  // The one deliberate pre-drain (see safeRestart.ts): the installer does not
  // wait for main's ordered quit. NSIS force-kills processes running from the
  // install dir ~1.3 s in, Squirrel.Mac swaps the bundle under running
  // children, an AppImage mount disappears with main. So the bundled Postgres
  // gets its fast stop FIRST, bounded by the quit's runtime slot; past the
  // bound the install proceeds and WAL recovery is the backstop.
  if (getRuntimeMode() === "native") {
    await Promise.race([
      stopNativeRuntime().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, RUNTIME_QUIT_DEADLINE_MS)),
    ]);
  }
  // Windows: true => silent installer after explicit Vex UI consent; second
  // arg re-runs the app after install where supported.
  autoUpdater.quitAndInstall(process.platform === "win32", true);
  return ok({ restarting: true });
}

export async function openReleaseNotes(
  correlationId: string,
): Promise<Result<ReleaseNotesOpened>> {
  try {
    await shell.openExternal(RELEASE_NOTES_URL);
    return ok({ opened: true });
  } catch {
    log.warn(`[updates] openExternal failed correlationId=${correlationId}`);
    return err(
      publicUpdateError(
        "update.check_failed",
        correlationId,
        "Couldn't open the release notes page.",
      ),
    );
  }
}

/** Test-only: reset module state. */
export function __resetUpdateActionsForTests(): void {
  downloadInFlight = null;
}
