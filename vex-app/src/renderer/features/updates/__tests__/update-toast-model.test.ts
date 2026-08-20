/**
 * Pure update-toast projection: which statuses toast, the per-state copy,
 * action rows, roles, and Escape semantics - the contract the sticky
 * surface renders from.
 */

import { describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@shared/schemas/updater.js";
import {
  buildUpdateToastEntry,
  escapeActionFor,
  isToastKind,
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

  it("available offers Release notes / Later / Update now; critical drops Later and escalates to role=alert", () => {
    const normal = buildUpdateToastEntry(AVAILABLE, false, () => {});
    expect(normal.actions.map((a) => a.id)).toEqual([
      "release-notes",
      "later",
      "update-now",
    ]);
    expect(normal.role).toBe("status");
    const critical = buildUpdateToastEntry(CRITICAL, false, () => {});
    expect(critical.actions.map((a) => a.id)).toEqual([
      "release-notes",
      "update-now",
    ]);
    expect(critical.role).toBe("alert");
    expect(critical.title).toContain("Critical update");
  });

  it("busy disables the mutating action but never the snooze/link actions", () => {
    const entry = buildUpdateToastEntry(AVAILABLE, true, () => {});
    const byId = new Map(entry.actions.map((a) => [a.id, a]));
    expect(byId.get("update-now")?.disabled).toBe(true);
    expect(byId.get("later")?.disabled).toBeUndefined();
    expect(byId.get("release-notes")?.disabled).toBeUndefined();
  });

  it("downloading carries its percent as progress and offers only Cancel", () => {
    const entry = buildUpdateToastEntry(DOWNLOADING, false, () => {});
    expect(entry.progress).toBe(40);
    expect(entry.actions.map((a) => a.id)).toEqual(["cancel"]);
    expect(entry.text).toContain("40% complete.");
  });

  it("downloaded offers Later + Restart & install", () => {
    const entry = buildUpdateToastEntry(DOWNLOADED, false, () => {});
    expect(entry.actions.map((a) => a.label)).toEqual([
      "Later",
      "Restart & install",
    ]);
  });

  it("blocked surfaces the reason verbatim with a single Try again", () => {
    const entry = buildUpdateToastEntry(BLOCKED, false, () => {});
    expect(entry.text).toBe("A database migration is still running.");
    expect(entry.actions.map((a) => a.id)).toEqual(["try-again"]);
  });

  it("error carries the dismiss X (accessible name preserved) that routes to dismiss-error", () => {
    const onAction = vi.fn();
    const entry = buildUpdateToastEntry(ERROR, false, onAction);
    expect(entry.dismiss?.label).toBe("Dismiss update notification");
    entry.dismiss?.onDismiss();
    expect(onAction).toHaveBeenCalledWith("dismiss-error");
    expect(entry.actions.map((a) => a.id)).toEqual([
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

  it("the entry id tracks the state kind, so a progress tick updates in place while a state change remounts", () => {
    const a = buildUpdateToastEntry(DOWNLOADING, false, () => {});
    const b = buildUpdateToastEntry(
      { ...DOWNLOADING, percent: 90 } as ToastableUpdateStatus,
      false,
      () => {},
    );
    expect(a.id).toBe(b.id);
    const c = buildUpdateToastEntry(DOWNLOADED, false, () => {});
    expect(c.id).not.toBe(a.id);
  });
});
