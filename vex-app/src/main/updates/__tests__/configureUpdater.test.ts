/**
 * configureUpdater event wiring (M13). Verifies the two-step contract at the
 * event layer (`update-downloaded` sets `downloaded` only, never auto-restart),
 * the restart-flag recovery (Codex final review #3 follow-up): an updater
 * `error` raised while a restart is in progress clears the flag so
 * `restartAndInstallNow()` is not permanently idempotent after a failed
 * install, and the silent-check `available` clobber fix (updater redesign
 * Part A item 4): a SILENT ambient check's `checking-for-update` must not
 * flip a visible `available` status to the (non-rendering) `checking` state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: Record<string, (...args: unknown[]) => void> = {};
const autoUpdater: Record<string, unknown> = {
  on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
    listeners[event] = fn;
  }),
  removeListener: vi.fn(),
};

vi.mock("electron-updater", () => ({ default: { autoUpdater } }));
vi.mock("electron", () => ({ app: { isPackaged: true } }));

const setStatus = vi.fn();
let currentStatusForTest: { kind: string } = {
  kind: "idle",
};
vi.mock("../statusCache.js", () => ({
  setStatus: (s: unknown) => setStatus(s),
  currentVersion: () => "1.0.0",
  getCurrentStatus: () => currentStatusForTest,
}));

vi.mock("../sanitize.js", () => ({
  availableStatus: () => ({ kind: "available" }),
  downloadingStatus: () => ({ kind: "downloading" }),
  errorStatus: () => ({
    kind: "error",
    currentVersion: "1.0.0",
    message: "x",
    retryable: true,
  }),
  filteredUpdaterLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let restartInProgress = false;
const clearUpdateRestartInProgress = vi.fn(() => {
  restartInProgress = false;
});
vi.mock("../safeRestart.js", () => ({
  isUpdateRestartInProgress: () => restartInProgress,
  clearUpdateRestartInProgress: () => clearUpdateRestartInProgress(),
}));

let silentActive = false;
vi.mock("../auto-check-state.js", () => ({
  isSilentCheckActive: () => silentActive,
}));

const { configureUpdater, removeUpdaterEventListeners } = await import(
  "../configureUpdater.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  restartInProgress = false;
  silentActive = false;
  currentStatusForTest = { kind: "idle" };
  for (const key of Object.keys(listeners)) delete listeners[key];
  // Reset the module-level `configured` guard so each test re-registers.
  removeUpdaterEventListeners();
});

describe("configureUpdater event wiring", () => {
  it("update-downloaded sets `downloaded` only (no auto-restart)", () => {
    configureUpdater();
    listeners["update-downloaded"]?.({ version: "1.1.0" });
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "downloaded", latestVersion: "1.1.0" }),
    );
  });

  it("error during an in-progress restart clears the restart flag", () => {
    configureUpdater();
    restartInProgress = true;
    listeners["error"]?.(new Error("install failed"));
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
    expect(clearUpdateRestartInProgress).toHaveBeenCalledTimes(1);
  });

  it("error with no restart in progress does not clear the flag", () => {
    configureUpdater();
    restartInProgress = false;
    listeners["error"]?.(new Error("check failed"));
    expect(clearUpdateRestartInProgress).not.toHaveBeenCalled();
  });

  it("suppresses the error banner while an ambient (silent) check is active", () => {
    configureUpdater();
    silentActive = true;
    listeners["error"]?.(new Error("no feed configured"));
    // onError returns early: no status set, restart flag untouched.
    expect(setStatus).not.toHaveBeenCalled();
    expect(clearUpdateRestartInProgress).not.toHaveBeenCalled();
  });

  describe("checking-for-update vs a visible `available` status", () => {
    it("does NOT clobber `available` while a silent check is active", () => {
      configureUpdater();
      silentActive = true;
      currentStatusForTest = { kind: "available" };
      listeners["checking-for-update"]?.();
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("still transitions to `checking` for a MANUAL (non-silent) check even from `available`", () => {
      configureUpdater();
      silentActive = false;
      currentStatusForTest = { kind: "available" };
      listeners["checking-for-update"]?.();
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "checking" }),
      );
    });

    it("still transitions to `checking` during a silent check from the quiet `idle`", () => {
      configureUpdater();
      silentActive = true;
      currentStatusForTest = { kind: "idle" };
      listeners["checking-for-update"]?.();
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "checking" }),
      );
    });

    it("does NOT clobber `error` during a silent retry - a broken feed must not re-toast a dismissed banner", () => {
      configureUpdater();
      silentActive = true;
      currentStatusForTest = { kind: "error" };
      listeners["checking-for-update"]?.();
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("does NOT clobber `downloading` during a silent check (the scheduler's guard races its async preference read)", () => {
      configureUpdater();
      silentActive = true;
      currentStatusForTest = { kind: "downloading" };
      listeners["checking-for-update"]?.();
      expect(setStatus).not.toHaveBeenCalled();
    });
  });

  describe("silent availability results yield to an active download", () => {
    it("a late `update-available` from a silent check does not rewind `downloading`", () => {
      configureUpdater();
      silentActive = true;
      currentStatusForTest = { kind: "downloading" };
      listeners["update-available"]?.({ version: "9.9.9" });
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("a late `update-not-available` from a silent check does not rewind `downloaded`", () => {
      configureUpdater();
      silentActive = true;
      currentStatusForTest = { kind: "downloaded" };
      listeners["update-not-available"]?.();
      expect(setStatus).not.toHaveBeenCalled();
    });

    it("a MANUAL check's `update-available` still lands normally", () => {
      configureUpdater();
      silentActive = false;
      currentStatusForTest = { kind: "idle" };
      listeners["update-available"]?.({ version: "9.9.9" });
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "available" }),
      );
    });
  });
});
