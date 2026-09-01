/**
 * Pure update-toast projection: which statuses notify, the per-state copy,
 * severity (which replaced the ARIA role), progress, action rows, dismissal
 * and Escape semantics - the contract `UpdateToastSurface` binds to the
 * notification model.
 */

import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "@shared/schemas/updater.js";
import {
  actionsFor,
  bodyFor,
  escapeActionFor,
  isDismissible,
  isToastKind,
  progressFor,
  severityFor,
  titleFor,
  toastIdentity,
  type ToastableUpdateStatus,
} from "../update-toast-model.js";

const AVAILABLE = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "normal",
} as ToastableUpdateStatus;

const CRITICAL = {
  kind: "available",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  severity: "critical",
} as ToastableUpdateStatus;

const DOWNLOADING = {
  kind: "downloading",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  percent: 40,
} as ToastableUpdateStatus;

const DOWNLOADED = {
  kind: "downloaded",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
} as ToastableUpdateStatus;

const BLOCKED = {
  kind: "blockedByOperation",
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  reason: "A database migration is still running.",
  blockedAction: "download",
  severity: "normal",
  wasDownloaded: false,
} as ToastableUpdateStatus;

const ERROR = {
  kind: "error",
  currentVersion: "1.0.0",
  message: "Update failed. Check your connection and try again.",
  retryable: true,
} as ToastableUpdateStatus;

const EVERY_STATE = [AVAILABLE, CRITICAL, DOWNLOADING, DOWNLOADED, BLOCKED, ERROR];

describe("update-toast-model", () => {
  it("only the five prompt-worthy kinds toast; current/checking/idle stay silent", () => {
    const silent: UpdateStatus[] = [
      { kind: "current", currentVersion: "1.0.0" },
      { kind: "checking", currentVersion: "1.0.0" },
      { kind: "idle", currentVersion: "1.0.0" },
    ] as UpdateStatus[];
    for (const s of silent) expect(isToastKind(s)).toBe(false);
    for (const s of [AVAILABLE, DOWNLOADING, DOWNLOADED, BLOCKED, ERROR]) {
      expect(isToastKind(s)).toBe(true);
    }
  });

  it("available offers Release notes / Later / Update now; critical drops Later", () => {
    expect(actionsFor(AVAILABLE, false).map((a) => a.id)).toEqual([
      "release-notes",
      "later",
      "update-now",
    ]);
    expect(actionsFor(CRITICAL, false).map((a) => a.id)).toEqual([
      "release-notes",
      "update-now",
    ]);
    expect(titleFor(CRITICAL)).toContain("Critical update");
  });

  it("severity carries what the retired ARIA role carried: critical is assertive, ordinary is polite", () => {
    // The announcer routes error and warning to the assertive live region and
    // info to the polite one, so this IS the alert/status split.
    expect(severityFor(AVAILABLE)).toBe("info");
    expect(severityFor(CRITICAL)).toBe("warning");
    expect(severityFor(DOWNLOADING)).toBe("info");
    expect(severityFor(DOWNLOADED)).toBe("info");
    // A blocked step is the updater deferring to a financial or destructive
    // operation, not a failure.
    expect(severityFor(BLOCKED)).toBe("warning");
    expect(severityFor(ERROR)).toBe("error");
  });

  it("busy disables the mutating action but never the snooze or link actions", () => {
    const byId = new Map(actionsFor(AVAILABLE, true).map((a) => [a.id, a]));
    expect(byId.get("update-now")?.disabled).toBe(true);
    expect(byId.get("later")?.disabled).toBe(false);
    expect(byId.get("release-notes")?.disabled).toBe(false);
    expect(actionsFor(DOWNLOADING, true)[0]?.disabled).toBe(true);
    expect(actionsFor(DOWNLOADING, false)[0]?.disabled).toBe(false);
  });

  it("only the mutating action is ranked primary, so only it closes the toast when it runs", () => {
    const primaries = (status: ToastableUpdateStatus): readonly string[] =>
      actionsFor(status, false)
        .filter((a) => a.rank === "primary")
        .map((a) => a.id);
    expect(primaries(AVAILABLE)).toEqual(["update-now"]);
    expect(primaries(DOWNLOADED)).toEqual(["restart"]);
    expect(primaries(BLOCKED)).toEqual(["try-again"]);
    expect(primaries(ERROR)).toEqual(["try-again"]);
    // Cancel must NOT close: the download is still running until the status
    // says otherwise, and the toast is where the user watches it stop.
    expect(primaries(DOWNLOADING)).toEqual([]);
  });

  it("downloading carries its percent ONLY as progress, never in the sentence", () => {
    // The regression this guards: a percent inside the message makes every
    // tick a message change, and the announcer speaks message changes.
    expect(progressFor(DOWNLOADING)).toEqual({ total: 100, worked: 40 });
    expect(bodyFor(DOWNLOADING)).not.toContain("40");
    expect(bodyFor(DOWNLOADING)).toBe(
      bodyFor({ ...DOWNLOADING, percent: 91 } as ToastableUpdateStatus),
    );
    expect(actionsFor(DOWNLOADING, false).map((a) => a.id)).toEqual(["cancel"]);
    for (const state of EVERY_STATE) {
      if (state.kind === "downloading") continue;
      expect(progressFor(state)).toBeNull();
    }
  });

  it("downloaded offers Later + Restart & install", () => {
    expect(actionsFor(DOWNLOADED, false).map((a) => a.label)).toEqual([
      "Later",
      "Restart & install",
    ]);
  });

  it("blocked surfaces the reason verbatim with a single Try again", () => {
    expect(bodyFor(BLOCKED)).toBe("A database migration is still running.");
    expect(actionsFor(BLOCKED, false).map((a) => a.id)).toEqual(["try-again"]);
  });

  it("error surfaces its sanitized message with Open download page + Try again", () => {
    expect(bodyFor(ERROR)).toBe(
      "Update failed. Check your connection and try again.",
    );
    expect(actionsFor(ERROR, false).map((a) => a.id)).toEqual([
      "release-notes",
      "try-again",
    ]);
  });

  it("Escape means snooze for non-critical available and downloaded, dismiss for error, nothing otherwise", () => {
    expect(escapeActionFor(AVAILABLE)).toBe("later");
    expect(escapeActionFor(DOWNLOADED)).toBe("later");
    expect(escapeActionFor(ERROR)).toBe("dismiss-error");
    expect(escapeActionFor(CRITICAL)).toBeNull();
    expect(escapeActionFor(DOWNLOADING)).toBeNull();
    expect(escapeActionFor(BLOCKED)).toBeNull();
  });

  it("dismissible is exactly the states Escape acts on, in every state", () => {
    for (const state of EVERY_STATE) {
      expect(isDismissible(state)).toBe(escapeActionFor(state) !== null);
    }
    // Stated positively too, so a change to escapeActionFor cannot quietly
    // make a running download dismissable and keep this test green.
    expect(isDismissible(DOWNLOADING)).toBe(false);
    expect(isDismissible(BLOCKED)).toBe(false);
    expect(isDismissible(CRITICAL)).toBe(false);
    expect(isDismissible(AVAILABLE)).toBe(true);
  });

  it("identity holds across a progress tick and changes on state or version", () => {
    expect(toastIdentity(DOWNLOADING)).toBe(
      toastIdentity({ ...DOWNLOADING, percent: 90 } as ToastableUpdateStatus),
    );
    expect(toastIdentity(DOWNLOADED)).not.toBe(toastIdentity(DOWNLOADING));
    expect(
      toastIdentity({ ...AVAILABLE, latestVersion: "2.0.0" } as ToastableUpdateStatus),
    ).not.toBe(toastIdentity(AVAILABLE));
  });
});
