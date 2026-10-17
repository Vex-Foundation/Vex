/**
 * RuntimeMigration renderer tests: what each status offers (Move my data,
 * Try again for an offline source, the unreadable state with the logs), the
 * typed confirmation in front of Start fresh, the move's rows with the copy
 * as bytes of the estimate, a failure stanza per reason (disk full with what
 * it needs), the hand-off to the runtime screen once the data is in the
 * native cluster, and joining a move a reload found in progress.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  RuntimeMigrationProgress,
  RuntimeMigrationResult,
  RuntimeMigrationStatus,
} from "@shared/schemas/runtime-migration.js";

import { useUiStore } from "../../../stores/uiStore.js";
import { DONE_AUTO_ADVANCE_MS, RuntimeMigration } from "../RuntimeMigration.js";
import { failureCopy } from "../migration/copy.js";
import { formatBytes, migrationRows } from "../migration/rows.js";
import { matchesStartFreshPhrase } from "../migration/StartFresh.js";

const listeners = new Set<(progress: RuntimeMigrationProgress) => void>();
const runtimeMigrationStatus = vi.fn();
const runtimeMigrationMove = vi.fn();
const runtimeMigrationStartFresh = vi.fn();
const openLogsFolder = vi.fn();

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function emit(progress: RuntimeMigrationProgress): void {
  act(() => {
    for (const listener of listeners) listener(progress);
  });
}

function row(container: HTMLElement, step: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-step="${step}"]`);
  if (el === null) throw new Error(`no ${step} row`);
  return el;
}

const PENDING: RuntimeMigrationStatus = { kind: "pending", resumeStep: null, lastFailure: null };

beforeEach(() => {
  listeners.clear();
  runtimeMigrationStatus.mockReset().mockResolvedValue(ok(PENDING));
  runtimeMigrationMove.mockReset();
  runtimeMigrationStartFresh.mockReset();
  openLogsFolder.mockReset().mockResolvedValue(ok({ opened: true }));
  useUiStore.setState({ currentView: "runtimeMigration" });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      system: {
        runtimeMigrationStatus,
        runtimeMigrationMove,
        runtimeMigrationStartFresh,
        onRuntimeMigrationProgress: (cb: (progress: RuntimeMigrationProgress) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      },
      support: { openLogsFolder },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, "vex");
});

describe("RuntimeMigration - what it offers", () => {
  it("explains the change and offers Move my data, with Start fresh as the quiet second choice", async () => {
    const view = render(<RuntimeMigration />);
    expect(view.container.querySelector('[data-vex-screen="runtimeMigration"]')).not.toBeNull();
    expect(view.getByRole("heading", { name: "Move your data" })).toBeTruthy();
    await view.findByRole("button", { name: "Move my data" });
    expect(view.container.textContent).toContain("Vex no longer needs Docker");
    expect(view.getByRole("button", { name: "Start fresh instead" }).getAttribute("data-vex-button")).toBe("quiet");
    expect(listeners.size).toBe(1);
  });

  it("says an earlier attempt stopped and resumes after its last step", async () => {
    runtimeMigrationStatus.mockResolvedValue(
      ok({
        kind: "pending",
        resumeStep: "dumped",
        lastFailure: { reason: "restore_failed", message: "pg_restore failed: boom", at: "2026-10-17T10:00:00.000Z" },
      }),
    );
    const view = render(<RuntimeMigration />);
    await view.findByRole("button", { name: "Move my data" });
    expect(view.container.textContent).toContain("The last attempt did not finish");
    expect(view.container.textContent).toContain("pg_restore failed: boom");
    expect(view.container.textContent).toContain("picks up after the last step it finished");
  });

  it("with Docker off asks for it once and offers Try again (a re-check), not the move", async () => {
    runtimeMigrationStatus.mockResolvedValue(
      ok({ kind: "pending_source_offline", detail: "Cannot connect", resumeStep: null, lastFailure: null }),
    );
    const view = render(<RuntimeMigration />);
    await view.findByRole("button", { name: "Try again" });
    expect(view.container.textContent).toContain("Docker is not running");
    expect(view.queryByRole("button", { name: "Move my data" })).toBeNull();
    runtimeMigrationStatus.mockResolvedValue(ok(PENDING));
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await view.findByRole("button", { name: "Move my data" });
    expect(runtimeMigrationStatus).toHaveBeenCalledTimes(2);
    expect(runtimeMigrationMove).not.toHaveBeenCalled();
  });

  it("shows an unreadable state with its message and the logs, and starts nothing", async () => {
    runtimeMigrationStatus.mockResolvedValue(ok({ kind: "state_unreadable", message: "Unexpected token } in JSON" }));
    const view = render(<RuntimeMigration />);
    await view.findByText("Vex could not read its runtime state");
    expect(view.container.textContent).toContain("Unexpected token } in JSON");
    fireEvent.click(view.getByRole("button", { name: "Open logs folder" }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
    expect(view.queryByRole("button", { name: "Move my data" })).toBeNull();
    expect(runtimeMigrationMove).not.toHaveBeenCalled();
    expect(runtimeMigrationStartFresh).not.toHaveBeenCalled();
  });

  it("hands off to the runtime screen at once when there is nothing to move", async () => {
    runtimeMigrationStatus.mockResolvedValue(ok({ kind: "not_needed" }));
    render(<RuntimeMigration />);
    await waitFor(() => expect(useUiStore.getState().currentView).toBe("runtimeBootstrap"));
  });
});

describe("RuntimeMigration - start fresh", () => {
  it("arms only once the phrase is typed", async () => {
    runtimeMigrationStartFresh.mockResolvedValue(ok({ kind: "started_fresh" }));
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Start fresh instead" }));
    expect(view.container.textContent).toContain("it stays only in Docker");
    const confirm = view.getByRole("button", { name: "Start fresh without my data" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    const input = view.getByLabelText('Type "start fresh" to confirm');
    fireEvent.change(input, { target: { value: "start" } });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "  Start Fresh " } });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirm);
    await view.findByText("A new local database is ready");
    expect(runtimeMigrationStartFresh).toHaveBeenCalledTimes(1);
    expect(runtimeMigrationMove).not.toHaveBeenCalled();
  });

  it("Cancel folds the confirmation away", async () => {
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Start fresh instead" }));
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.container.querySelector("[data-start-fresh]")).toBeNull();
    expect(runtimeMigrationStartFresh).not.toHaveBeenCalled();
  });

  it("matches the phrase loosely in case and spacing only", () => {
    expect(matchesStartFreshPhrase("start fresh")).toBe(true);
    expect(matchesStartFreshPhrase(" START FRESH ")).toBe(true);
    expect(matchesStartFreshPhrase("startfresh")).toBe(false);
    expect(matchesStartFreshPhrase("start fresh!")).toBe(false);
  });
});

describe("RuntimeMigration - the move", () => {
  it("walks the rows with the copy as bytes of the estimate, then hands off to the runtime screen", async () => {
    const run = deferred<{ ok: true; data: RuntimeMigrationResult }>();
    runtimeMigrationMove.mockReturnValue(run.promise);
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Move my data" }));
    expect(runtimeMigrationMove).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(row(view.container, "source").dataset["status"]).toBe("waiting"));

    emit({ seq: 1, phase: "preparing" });
    emit({ seq: 2, phase: "starting_source" });
    expect(row(view.container, "source").textContent).toContain("Starting the old database in Docker");
    emit({ seq: 3, phase: "dumping", bytesWritten: 12_300_000, estimatedBytes: 45_600_000 });
    expect(row(view.container, "source").dataset["status"]).toBe("ready");
    expect(row(view.container, "copy").dataset["status"]).toBe("active");
    expect(row(view.container, "copy").textContent).toContain("12.3 MB of about 45.6 MB");
    // An older event (a replay crossing a newer one) never moves it back.
    emit({ seq: 2, phase: "starting_source" });
    expect(row(view.container, "copy").dataset["status"]).toBe("active");
    emit({ seq: 4, phase: "verifying" });
    expect(row(view.container, "restore").dataset["status"]).toBe("ready");
    expect(row(view.container, "verify").dataset["status"]).toBe("active");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await act(async () => {
      run.resolve(ok({ kind: "migrated", oldStackStopped: true, message: "Copied." }));
      await run.promise;
    });
    expect(view.container.textContent).toContain("Your data is moved");
    expect(row(view.container, "finish").dataset["status"]).toBe("ready");
    expect(useUiStore.getState().currentView).toBe("runtimeMigration");
    act(() => {
      vi.advanceTimersByTime(DONE_AUTO_ADVANCE_MS);
    });
    expect(useUiStore.getState().currentView).toBe("runtimeBootstrap");
  });

  it("says so when the old database could not be stopped", async () => {
    runtimeMigrationMove.mockResolvedValue(ok({ kind: "migrated", oldStackStopped: false, message: "Copied." }));
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Move my data" }));
    await view.findByText("Your data is moved");
    expect(view.container.textContent).toContain("could not be stopped");
  });

  it("joins a move a reload found in progress, starting from its latest step", async () => {
    runtimeMigrationStatus.mockResolvedValue(
      ok({ kind: "in_progress", op: "migrate", progress: { seq: 9, phase: "restoring" } }),
    );
    runtimeMigrationMove.mockReturnValue(new Promise(() => {}));
    const view = render(<RuntimeMigration />);
    await waitFor(() => expect(runtimeMigrationMove).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(row(view.container, "restore").dataset["status"]).toBe("active"));
    expect(view.queryByRole("button", { name: "Move my data" })).toBeNull();
  });

  it("shows a full disk with what it needs against what is free, Try again and the logs", async () => {
    runtimeMigrationMove.mockResolvedValue(
      ok({
        kind: "failed",
        reason: "disk_full",
        message: "Copying the data needs 2400000000 bytes free; 800000000 are.",
        requiredBytes: 2_400_000_000,
        availableBytes: 800_000_000,
      }),
    );
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Move my data" }));
    await view.findByText("Not enough disk space");
    expect(view.container.querySelector('[data-migration-failure="disk_full"]')).not.toBeNull();
    expect(view.container.textContent).toContain("needs 2.40 GB free on this disk; 800.0 MB is available");
    expect(view.getByRole("button", { name: "Open logs folder" })).toBeTruthy();
    runtimeMigrationMove.mockResolvedValue(ok({ kind: "migrated", oldStackStopped: true, message: "Copied." }));
    fireEvent.click(view.getByRole("button", { name: "Try again" }));
    await view.findByText("Your data is moved");
    expect(runtimeMigrationMove).toHaveBeenCalledTimes(2);
  });

  it("marks the step a failed move stopped at", async () => {
    const run = deferred<{ ok: true; data: RuntimeMigrationResult }>();
    runtimeMigrationMove.mockReturnValue(run.promise);
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Move my data" }));
    await waitFor(() => expect(listeners.size).toBe(1));
    emit({ seq: 5, phase: "verifying" });
    await act(async () => {
      run.resolve(
        ok({ kind: "failed", reason: "verify_failed", message: "3 difference(s).", requiredBytes: null, availableBytes: null }),
      );
      await run.promise;
    });
    expect(row(view.container, "verify").dataset["status"]).toBe("failed");
    expect(view.container.textContent).toContain("The copy did not match the original");
    expect(view.getByRole("button", { name: "Start fresh instead" })).toBeTruthy();
  });

  it("re-asks main when the move finds nothing to move", async () => {
    runtimeMigrationMove.mockResolvedValue(
      ok({ kind: "failed", reason: "not_pending", message: "Nothing.", requiredBytes: null, availableBytes: null }),
    );
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Move my data" }));
    runtimeMigrationStatus.mockResolvedValue(ok({ kind: "not_needed" }));
    await waitFor(() => expect(useUiStore.getState().currentView).toBe("runtimeBootstrap"));
  });

  it("an IPC failure is a failure with Try again, never a dead end", async () => {
    runtimeMigrationMove.mockResolvedValue({ ok: false, error: { code: "internal.unexpected", message: "IPC gone" } });
    const view = render(<RuntimeMigration />);
    fireEvent.click(await view.findByRole("button", { name: "Move my data" }));
    await view.findByText("The move stopped unexpectedly");
    expect(view.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("migration copy and rows", () => {
  it("has a human title for every failure reason", () => {
    const reasons = [
      "source_offline", "source_volume_missing", "source_unavailable", "source_empty", "disk_full", "dump_failed",
      "dump_corrupt", "native_unavailable", "native_start_failed", "native_cluster_busy", "restore_failed",
      "verify_failed", "state_unreadable", "busy", "not_pending", "unexpected",
    ] as const;
    for (const reason of reasons) {
      const copy = failureCopy(reason, null);
      expect(copy.title.length, reason).toBeGreaterThan(0);
      expect(copy.title, reason).not.toMatch(/_/);
    }
  });

  it("formats bytes as MB below a gigabyte and GB above", () => {
    expect(formatBytes(45_600_000)).toBe("45.6 MB");
    expect(formatBytes(2_400_000_000)).toBe("2.40 GB");
  });

  it("drops the estimate it does not have", () => {
    const rows = migrationRows({ kind: "active", progress: { seq: 1, phase: "dumping", bytesWritten: 1_000_000, estimatedBytes: 0 } });
    expect(rows.find((r) => r.step === "copy")?.detail).toBe("1.0 MB copied");
  });
});
