/**
 * Ambient updater auto-check: check for a new version on app start, on window
 * focus, and on a periodic 5-minute timer while the app runs (owner decision
 * 2026-08-05: surface a new release as fast as possible - the check is a few
 * small release-metadata requests, and the banner is the only effect). This NEVER
 * downloads - auto-download stays off (`autoDownload=false`); it only
 * surfaces availability so the banner can appear. Allowed by skill
 * vex-user-triggered-updates: "checkForUpdates() may run on app start/focus,
 * but must not download."
 *
 * Guards (Codex review):
 *  - feed gate: skip entirely unless a feed is resolvable (packaged app, or dev
 *    with VEX_UPDATER_DEV_FEED=1) — no error spam in plain dev;
 *  - safe-state guard: only check from idle/current/error/available — never
 *    clobber an in-progress or blocked state (checking/downloading/
 *    downloaded/installing/blockedByOperation). `available` is included
 *    (correctness fix) so a NEWER release can still surface even while the
 *    current one sits snoozed in the renderer's per-version "Later" state —
 *    the renderer's snooze compares against `latestVersion`, so a fresh
 *    `available` for a different version un-snoozes itself automatically.
 *    `configureUpdater.ts`'s `checking-for-update` handler avoids the
 *    resulting flicker by not clobbering a visible `available` toast with
 *    the transient (non-rendering) `checking` state during a silent check;
 *  - focus debounce: short in-memory window so focus bursts don't hammer prefs;
 *  - success throttle: persisted `lastCheckedAt`, ≤ once per SUCCESS_THROTTLE;
 *  - failure backoff: in-memory, exponential (10m doubling, 2h cap), so a
 *    broken feed backs off instead of retrying forever on a fixed clock.
 */

import { app } from "electron";
import { log } from "../logger/index.js";
import { preferencesStore } from "../preferences/store.js";
import { getCurrentStatus } from "./statusCache.js";
import { silentCheck } from "./updateActions.js";

const FOCUS_DEBOUNCE_MS = 60 * 1000;
/** Sits just under the periodic interval so every periodic tick may check. */
const SUCCESS_THROTTLE_MS = 4 * 60 * 1000;
/** Doubles per consecutive failure (10m, 20m, 40m, ...), capped below. */
const FAILURE_BACKOFF_BASE_MS = 10 * 60 * 1000;
const FAILURE_BACKOFF_MAX_MS = 2 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3 * 1000;
const PERIODIC_INTERVAL_MS = 5 * 60 * 1000;

let lastAttemptAt = 0;
let lastFailureAt = 0;
let consecutiveFailures = 0;

function feedConfigured(): boolean {
  return app.isPackaged || process.env.VEX_UPDATER_DEV_FEED === "1";
}

/**
 * Only run an ambient check from a state where re-checking is safe: the
 * quiet states (idle/current/error) AND `available` (see the module
 * docstring for why `available` is included). Never run from an in-progress
 * or already-blocked state (checking/downloading/downloaded/installing/
 * blockedByOperation) — an ambient re-check must not clobber those.
 */
function canRunAmbientCheck(): boolean {
  const kind = getCurrentStatus().kind;
  return (
    kind === "idle" ||
    kind === "current" ||
    kind === "error" ||
    kind === "available"
  );
}

export async function maybeAutoCheck(
  reason: "startup" | "focus" | "periodic",
): Promise<void> {
  if (!feedConfigured()) return;

  const now = Date.now();
  if (now - lastAttemptAt < FOCUS_DEBOUNCE_MS) return;
  lastAttemptAt = now;

  if (!canRunAmbientCheck()) return;
  const backoffMs = Math.min(
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1),
    FAILURE_BACKOFF_MAX_MS,
  );
  if (now - lastFailureAt < backoffMs) return;

  try {
    const prefs = await preferencesStore.load();
    const raw = prefs.updater.lastCheckedAt;
    const last = raw ? Date.parse(raw) : 0;
    if (Number.isFinite(last) && last > 0 && now - last < SUCCESS_THROTTLE_MS) {
      return;
    }
  } catch (cause) {
    log.warn("[updates] auto-check throttle read failed", cause);
    return;
  }

  // Re-check AFTER the awaited preference read: a download can start inside
  // that gap, and an ambient check must never proceed over it (race fix,
  // Codex review 2026-08-05).
  if (!canRunAmbientCheck()) return;

  log.info(`[updates] ambient auto-check (${reason})`);
  const ok = await silentCheck();
  if (ok) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures += 1;
    lastFailureAt = Date.now();
  }
}

/**
 * Wire the start + focus + periodic ambient checks. Returns a teardown that
 * removes the focus listener and cancels both timers.
 */
export function installUpdaterAutoCheck(): () => void {
  const onFocus = (): void => {
    void maybeAutoCheck("focus");
  };
  app.on("browser-window-focus", onFocus);

  // Deferred so the first check never competes with window paint. `unref` so
  // the timer can't keep the process alive on a fast quit.
  const startupTimer = setTimeout(() => {
    void maybeAutoCheck("startup");
  }, STARTUP_DELAY_MS);
  if (typeof startupTimer.unref === "function") startupTimer.unref();

  // Periodic tick so a release surfaces even when the window never regains
  // focus. Every guard above still applies: safe-state, success throttle,
  // failure backoff - a tick is an ATTEMPT, not an unconditional check.
  const periodicTimer = setInterval(() => {
    void maybeAutoCheck("periodic");
  }, PERIODIC_INTERVAL_MS);
  if (typeof periodicTimer.unref === "function") periodicTimer.unref();

  return () => {
    app.removeListener("browser-window-focus", onFocus);
    clearTimeout(startupTimer);
    clearInterval(periodicTimer);
  };
}

/** Test-only: reset the in-memory throttles. */
export function __resetAutoCheckForTests(): void {
  lastAttemptAt = 0;
  lastFailureAt = 0;
  consecutiveFailures = 0;
}
