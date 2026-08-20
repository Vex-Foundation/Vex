/**
 * updateActions (M13) — the two-step contract (Codex review #1 blocker).
 *
 * Asserts: download requires an `available` status + a passing gate;
 * `restartAndInstallNow` is the ONLY path to `quitAndInstall`, requires a
 * `downloaded` status + gate, and is idempotent; cancel resets; checkNow
 * persists `lastCheckedAt` and maps failures to a redacted error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = {
  checkForUpdates: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
};
class FakeCancellationToken {
  cancel = vi.fn();
}

vi.mock("electron-updater", () => ({
  default: { autoUpdater, CancellationToken: FakeCancellationToken },
}));

const openExternal = vi.fn().mockResolvedValue(undefined);
vi.mock("electron", () => ({
  shell: { openExternal: (...args: unknown[]) => openExternal(...args) },
}));

let currentStatus: unknown = { kind: "idle", currentVersion: "1.0.0" };
const setStatus = vi.fn((s: unknown) => {
  currentStatus = s;
});
vi.mock("../statusCache.js", () => ({
  getCurrentStatus: () => currentStatus,
  setStatus: (s: unknown) => setStatus(s),
  currentVersion: () => "1.0.0",
}));

const canRestartForUpdate = vi.fn();
const prepareForUpdateRestart = vi.fn();
let restartInProgress = false;
vi.mock("../safeRestart.js", () => ({
  canRestartForUpdate: () => canRestartForUpdate(),
  prepareForUpdateRestart: () => prepareForUpdateRestart(),
  isUpdateRestartInProgress: () => restartInProgress,
}));

vi.mock("../sanitize.js", () => ({
  errorStatus: (_e: unknown, v: string) => ({
    kind: "error",
    currentVersion: v,
    message: "Update failed.",
    retryable: true,
  }),
  publicUpdateError: (
    code: string,
    correlationId: string,
    message?: string,
  ) => ({
    code,
    domain: "updater",
    message: message ?? code,
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId,
  }),
}));

const prefUpdate = vi.fn().mockResolvedValue({});
vi.mock("../../preferences/store.js", () => ({
  preferencesStore: { update: (p: unknown) => prefUpdate(p) },
}));

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const actions = await import("../updateActions.js");

const AVAILABLE = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "normal",
} as const;
const AVAILABLE_CRITICAL_WITH_CONTEXT = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.2.0",
  severity: "critical",
  releaseDate: "2026-01-01",
  summary: "Security fix",
} as const;
const DOWNLOADED = {
  kind: "downloaded",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  currentStatus = { kind: "idle", currentVersion: "1.0.0" };
  restartInProgress = false;
  canRestartForUpdate.mockResolvedValue({ ok: true });
  autoUpdater.checkForUpdates.mockResolvedValue(null);
  autoUpdater.downloadUpdate.mockResolvedValue([]);
  actions.__resetUpdateActionsForTests();
});

describe("getStatus", () => {
  it("returns the cached status", async () => {
    currentStatus = DOWNLOADED;
    await expect(actions.getStatus()).resolves.toEqual({
      ok: true,
      data: DOWNLOADED,
    });
  });
});

describe("startUpdateNow (step 1: download only)", () => {
  it("refuses when no update is available", async () => {
    currentStatus = { kind: "idle", currentVersion: "1.0.0" };
    const r = await actions.startUpdateNow("req");
    expect(r.ok).toBe(false);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("downloads when available and the gate passes", async () => {
    currentStatus = AVAILABLE;
    const r = await actions.startUpdateNow("req");
    expect(r).toEqual({ ok: true, data: { started: true } });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "downloading", percent: 0 }),
    );
  });

  it("blocks (no download) when the gate fails", async () => {
    currentStatus = AVAILABLE;
    canRestartForUpdate.mockResolvedValue({ ok: false, message: "busy" });
    const r = await actions.startUpdateNow("req");
    expect(r.ok).toBe(false);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "blockedByOperation",
        reason: "busy",
        blockedAction: "download",
        severity: "normal",
        wasDownloaded: false,
      }),
    );
  });

  it("preserves severity/releaseDate/summary from `available` on a download block", async () => {
    currentStatus = AVAILABLE_CRITICAL_WITH_CONTEXT;
    canRestartForUpdate.mockResolvedValue({ ok: false, message: "busy" });
    await actions.startUpdateNow("req");
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "blockedByOperation",
        blockedAction: "download",
        severity: "critical",
        releaseDate: "2026-01-01",
        summary: "Security fix",
        wasDownloaded: false,
      }),
    );
  });

  it("is idempotent while a download is in flight", async () => {
    currentStatus = AVAILABLE;
    autoUpdater.downloadUpdate.mockReturnValue(new Promise(() => {}));
    await actions.startUpdateNow("a");
    const second = await actions.startUpdateNow("b");
    expect(second).toEqual({ ok: true, data: { started: true } });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight token after a successful download (a later download can start)", async () => {
    currentStatus = AVAILABLE;
    let resolveDownload!: (paths: string[]) => void;
    autoUpdater.downloadUpdate.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDownload = resolve;
      }),
    );
    await actions.startUpdateNow("a");
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    // Finish the download; the .then() must clear the in-flight token.
    resolveDownload([]);
    await Promise.resolve();
    await Promise.resolve();

    // A fresh available status -> a brand new download must start.
    currentStatus = AVAILABLE;
    autoUpdater.downloadUpdate.mockResolvedValueOnce([]);
    await actions.startUpdateNow("b");
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
  });
});

describe("restartAndInstallNow (step 2: explicit restart)", () => {
  it("refuses when nothing is downloaded", async () => {
    currentStatus = AVAILABLE;
    const r = await actions.restartAndInstallNow("req");
    expect(r.ok).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("installs when downloaded and the gate passes", async () => {
    currentStatus = DOWNLOADED;
    const r = await actions.restartAndInstallNow("req");
    expect(r).toEqual({ ok: true, data: { restarting: true } });
    expect(prepareForUpdateRestart).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "installing" }),
    );
  });

  it("blocks (no install) when the gate fails", async () => {
    currentStatus = DOWNLOADED;
    canRestartForUpdate.mockResolvedValue({
      ok: false,
      message: "migration running",
    });
    const r = await actions.restartAndInstallNow("req");
    expect(r.ok).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "blockedByOperation",
        reason: "migration running",
        blockedAction: "install",
        severity: "normal",
        wasDownloaded: true,
      }),
    );
  });

  it("is idempotent when a restart is already in progress", async () => {
    currentStatus = DOWNLOADED;
    restartInProgress = true;
    const r = await actions.restartAndInstallNow("req");
    expect(r).toEqual({ ok: true, data: { restarting: true } });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("Try again - recovery FROM blockedByOperation (Codex final-review blocker)", () => {
  const BLOCKED_DOWNLOAD = {
    kind: "blockedByOperation",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    reason: "busy",
    blockedAction: "download",
    severity: "normal",
    wasDownloaded: false,
  } as const;
  const BLOCKED_INSTALL = {
    kind: "blockedByOperation",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    reason: "migration running",
    blockedAction: "install",
    severity: "normal",
    wasDownloaded: true,
  } as const;

  it("startUpdateNow retries a blocked DOWNLOAD and downloads once the gate passes", async () => {
    currentStatus = BLOCKED_DOWNLOAD;
    canRestartForUpdate.mockResolvedValue({ ok: true });
    const r = await actions.startUpdateNow("retry");
    expect(r).toEqual({ ok: true, data: { started: true } });
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "downloading" }),
    );
  });

  it("startUpdateNow stays blocked on a DOWNLOAD retry while the gate still fails", async () => {
    currentStatus = BLOCKED_DOWNLOAD;
    canRestartForUpdate.mockResolvedValue({ ok: false, message: "still busy" });
    const r = await actions.startUpdateNow("retry");
    expect(r.ok).toBe(false);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "blockedByOperation",
        blockedAction: "download",
        reason: "still busy",
      }),
    );
  });

  it("restartAndInstallNow retries a blocked INSTALL and installs once the gate passes", async () => {
    currentStatus = BLOCKED_INSTALL;
    canRestartForUpdate.mockResolvedValue({ ok: true });
    const r = await actions.restartAndInstallNow("retry");
    expect(r).toEqual({ ok: true, data: { restarting: true } });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "installing" }),
    );
  });

  it("restartAndInstallNow stays blocked on an INSTALL retry while the gate still fails", async () => {
    currentStatus = BLOCKED_INSTALL;
    canRestartForUpdate.mockResolvedValue({ ok: false, message: "still busy" });
    const r = await actions.restartAndInstallNow("retry");
    expect(r.ok).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "blockedByOperation",
        blockedAction: "install",
        reason: "still busy",
      }),
    );
  });

  it("does not cross wires: a DOWNLOAD-blocked status cannot be install-retried", async () => {
    currentStatus = BLOCKED_DOWNLOAD; // blockedAction is "download", not "install"
    const r = await actions.restartAndInstallNow("retry");
    expect(r.ok).toBe(false);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("does not cross wires: an INSTALL-blocked status cannot be download-retried", async () => {
    currentStatus = BLOCKED_INSTALL; // blockedAction is "install", not "download"
    const r = await actions.startUpdateNow("retry");
    expect(r.ok).toBe(false);
    expect(autoUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});

describe("cancelDownload / checkNow / openReleaseNotes", () => {
  it("cancelDownload cancels the token and returns to available", async () => {
    currentStatus = AVAILABLE;
    autoUpdater.downloadUpdate.mockReturnValue(new Promise(() => {}));
    await actions.startUpdateNow("req");
    const r = await actions.cancelDownload();
    expect(r).toEqual({ ok: true, data: { cancelled: true } });
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "available", latestVersion: "1.1.0" }),
    );
  });

  it("checkNow runs a check and persists lastCheckedAt", async () => {
    const r = await actions.checkNow("req");
    expect(r.ok).toBe(true);
    expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(prefUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        updater: expect.objectContaining({ lastCheckedAt: expect.any(String) }),
      }),
    );
  });

  it("checkNow maps a thrown check to update.check_failed (redacted)", async () => {
    autoUpdater.checkForUpdates.mockRejectedValue(
      new Error("https://feed.example/latest.yml unreachable"),
    );
    const r = await actions.checkNow("req");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("update.check_failed");
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("openReleaseNotes opens the Vex releases page", async () => {
    const r = await actions.openReleaseNotes("req");
    expect(r).toEqual({ ok: true, data: { opened: true } });
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://projectvex.ai/releases");
  });
});

describe("silentCheck (ambient auto-check)", () => {
  it("persists lastCheckedAt and returns true on success", async () => {
    autoUpdater.checkForUpdates.mockResolvedValue(null);
    await expect(actions.silentCheck()).resolves.toBe(true);
    expect(prefUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        updater: expect.objectContaining({ lastCheckedAt: expect.any(String) }),
      }),
    );
  });

  it("swallows a failure (no error status set) and returns false", async () => {
    autoUpdater.checkForUpdates.mockRejectedValue(new Error("no feed"));
    await expect(actions.silentCheck()).resolves.toBe(false);
    expect(setStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("restores the prior status when a failure leaves status stuck at 'checking'", async () => {
    currentStatus = { kind: "idle", currentVersion: "1.0.0" };
    autoUpdater.checkForUpdates.mockImplementation(async () => {
      // Simulate the checking-for-update event flipping status, then the
      // (suppressed) error leaving it there.
      currentStatus = { kind: "checking", currentVersion: "1.0.0" };
      throw new Error("no feed");
    });
    await expect(actions.silentCheck()).resolves.toBe(false);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "idle" }),
    );
  });
});
