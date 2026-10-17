/**
 * Settings "Local runtime": the panel's states over a stand-in `window.vex`
 * (the real TanStack hooks and the real runtime-status hook run on top).
 *
 * Pins:
 *   - the three status rows follow main's progress event live, through a
 *     restart (idle, then each step, then ready), and a failure shows main's
 *     own reason;
 *   - versions and sizes come from runtimeInfo, with "Unknown" for a version
 *     a binary could not give, "Reading…" before and an honest line on error;
 *   - Restart calls main once, is disabled while a start is under way, and
 *     says how it ended (done, refused with main's reason);
 *   - the open-logs link is the shared one;
 *   - Reset: the confirm stays disabled until the exact phrase is typed, sends
 *     what was typed, shows "restarting" on success, keeps the dialog open
 *     with main's reason on a refusal, and Cancel never calls main.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Result } from "@shared/ipc/result.js";
import type {
  LocalRuntimeInfo,
  NativeRuntimeStatus,
  RuntimeResetResult,
  RuntimeRestartResult,
} from "@shared/schemas/system.js";
import { LocalRuntimeSection } from "../LocalRuntimeSection.js";

const INFO: LocalRuntimeInfo = {
  release: "native-runtime-2026.10.17-1",
  versions: { postgres: "18.6", pgvector: "0.8.7", llamaCpp: null },
  sizes: {
    database: { bytes: 52_345_678, files: 1_234, complete: true },
    model: { bytes: 333_590_944, files: 2, complete: true },
  },
};

let progressListeners: Array<(status: NativeRuntimeStatus) => void> = [];
const system = {
  runtimeStatus: vi.fn<() => Promise<Result<NativeRuntimeStatus>>>(),
  onRuntimeProgress: vi.fn((cb: (status: NativeRuntimeStatus) => void) => {
    progressListeners.push(cb);
    return () => {
      progressListeners = progressListeners.filter((listener) => listener !== cb);
    };
  }),
  runtimeInfo: vi.fn<() => Promise<Result<LocalRuntimeInfo>>>(),
  runtimeRestart: vi.fn<() => Promise<Result<RuntimeRestartResult>>>(),
  runtimeReset: vi.fn<(input: { confirmation: string }) => Promise<Result<RuntimeResetResult>>>(),
};
const support = { openLogsFolder: vi.fn(async () => ({ ok: true, data: { opened: true } })) };

function emit(status: NativeRuntimeStatus): void {
  act(() => {
    for (const listener of progressListeners) listener(status);
  });
}

function renderSection(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LocalRuntimeSection />
    </QueryClientProvider>,
  );
}

function rowStatus(step: string): string | null {
  return document.querySelector(`[data-step="${step}"]`)?.getAttribute("data-status") ?? null;
}

function fact(key: string): string {
  return document.querySelector(`[data-vex-local-runtime-fact="${key}"] dd`)?.textContent ?? "";
}

beforeEach(() => {
  progressListeners = [];
  vi.clearAllMocks();
  system.runtimeStatus.mockResolvedValue({ ok: true, data: { seq: 4, phase: "ready" } });
  system.runtimeInfo.mockResolvedValue({ ok: true, data: INFO });
  system.runtimeRestart.mockResolvedValue({ ok: true, data: { kind: "restarted", status: { seq: 12, phase: "ready" } } });
  system.runtimeReset.mockResolvedValue({ ok: true, data: { kind: "reset", deletedBytes: 52_345_678, relaunching: true } });
  Object.defineProperty(window, "vex", { configurable: true, value: { system, support } });
});

afterEach(() => {
  cleanup();
});

describe("LocalRuntimeSection", () => {
  it("shows the live status, the versions and the sizes", async () => {
    renderSection();
    await waitFor(() => expect(rowStatus("embeddings")).toBe("ready"));
    expect(rowStatus("postgres")).toBe("ready");
    expect(rowStatus("model")).toBe("ready");
    await waitFor(() => expect(fact("release")).toBe("native-runtime-2026.10.17-1"));
    expect(fact("postgres")).toBe("18.6");
    expect(fact("pgvector")).toBe("0.8.7");
    expect(fact("llamaCpp")).toBe("Unknown");
    expect(fact("database")).toBe("52.3 MB");
    expect(fact("model")).toBe("333.6 MB");
  });

  it("says it is reading, then says so honestly when the details cannot be read", async () => {
    let answer: (value: Result<LocalRuntimeInfo>) => void = () => {};
    system.runtimeInfo.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderSection();
    expect(screen.getAllByText("Reading…")).toHaveLength(2);
    answer({
      ok: false,
      error: {
        code: "permissions.denied",
        domain: "system",
        message: "Vex is not running its bundled local runtime.",
        retryable: false,
        userActionable: false,
        redacted: true,
        correlationId: "c",
      },
    });
    await waitFor(() => expect(screen.getAllByText("Could not read the runtime's details.")).toHaveLength(2));
  });

  it("follows a restart step by step and reports it done", async () => {
    let finish: (value: Result<RuntimeRestartResult>) => void = () => {};
    system.runtimeRestart.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    renderSection();
    const restart = await screen.findByRole("button", { name: "Restart runtime" });
    await waitFor(() => expect((restart as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(restart);
    await waitFor(() => expect(system.runtimeRestart).toHaveBeenCalledTimes(1));
    await screen.findByRole("button", { name: "Restarting…" });

    emit({ seq: 5, phase: "idle" });
    expect(rowStatus("postgres")).toBe("waiting");
    emit({ seq: 6, phase: "postgres", initializing: false });
    expect(rowStatus("postgres")).toBe("active");
    emit({ seq: 7, phase: "model", model: { state: "checking" } });
    expect(rowStatus("postgres")).toBe("ready");
    expect(rowStatus("model")).toBe("active");
    emit({ seq: 8, phase: "embeddings" });
    emit({ seq: 9, phase: "ready" });
    expect(rowStatus("embeddings")).toBe("ready");

    finish({ ok: true, data: { kind: "restarted", status: { seq: 9, phase: "ready" } } });
    await screen.findByText("The local runtime restarted.");
    // The sizes are measured again after a restart.
    await waitFor(() => expect(system.runtimeInfo).toHaveBeenCalledTimes(2));
  });

  it("disables Restart while a start is under way", async () => {
    system.runtimeStatus.mockResolvedValue({ ok: true, data: { seq: 2, phase: "model", model: { state: "verifying" } } });
    renderSection();
    const restart = await screen.findByRole("button", { name: "Restart runtime" });
    await waitFor(() => expect(rowStatus("model")).toBe("active"));
    expect((restart as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows main's reason for a refused restart, and a failed runtime's own reason", async () => {
    system.runtimeRestart.mockResolvedValue({
      ok: true,
      data: { kind: "refused", reason: "busy", message: "The database is being updated. Try again when it finishes." },
    });
    renderSection();
    const restart = await screen.findByRole("button", { name: "Restart runtime" });
    await waitFor(() => expect((restart as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(restart);
    await screen.findByText("The database is being updated. Try again when it finishes.");

    emit({ seq: 20, phase: "failed", step: "postgres", kind: "disk_full", message: "The disk is full." });
    expect(screen.getByText("The disk is full.")).not.toBeNull();
    expect(rowStatus("postgres")).toBe("failed");
    // A failed runtime can be restarted.
    expect((screen.getByRole("button", { name: "Restart runtime" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("opens the logs folder through the shared link", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Open logs folder" }));
    expect(support.openLogsFolder).toHaveBeenCalledTimes(1);
  });

  it("keeps the reset disabled until the exact phrase is typed, then sends what was typed", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Reset local data…" }));
    const dialog = await screen.findByRole("dialog", { name: "Reset local data?" });
    expect(dialog.textContent).toContain("Keeps your wallets, the vault, your settings and the embeddings model.");
    expect(dialog.textContent).toContain("This cannot be undone.");
    const confirm = screen.getByRole("button", { name: "Reset and restart" }) as HTMLButtonElement;
    const input = screen.getByLabelText("Confirmation");
    expect(confirm.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "reset" } });
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText("That does not match yet.")).not.toBeNull();
    fireEvent.click(confirm);
    expect(system.runtimeReset).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "RESET" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(system.runtimeReset).toHaveBeenCalledWith({ confirmation: "RESET" }));
    await screen.findByText("Local data deleted. Vex is restarting…");
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the dialog open with main's reason when the reset is refused", async () => {
    system.runtimeReset.mockResolvedValue({
      ok: true,
      data: { kind: "refused", reason: "still_running", message: "A database process still holds the local data, so nothing was deleted." },
    });
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Reset local data…" }));
    await screen.findByRole("dialog", { name: "Reset local data?" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset and restart" }));
    await screen.findByText("A database process still holds the local data, so nothing was deleted.");
    expect(screen.queryByText("Local data deleted. Vex is restarting…")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Reset local data?" })).not.toBeNull();
  });

  it("closes on Cancel without calling main, and forgets what was typed", async () => {
    renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Reset local data…" }));
    await screen.findByRole("dialog", { name: "Reset local data?" });
    fireEvent.change(screen.getByLabelText("Confirmation"), { target: { value: "RESET" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset local data?" })).toBeNull());
    expect(system.runtimeReset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reset local data…" }));
    await screen.findByRole("dialog", { name: "Reset local data?" });
    expect((screen.getByLabelText("Confirmation") as HTMLInputElement).value).toBe("");
  });
});
