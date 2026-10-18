/**
 * RuntimeBootstrap renderer tests: each phase of main's start as the three
 * rows show it, the model download as bytes + speed + percent, every failure
 * kind's branch with Try again and the logs folder, the automatic advance to
 * the migrations once ready, and the seq rule that keeps a stale status
 * reply from moving the screen backwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import type { NativeRuntimeStatus } from "@shared/schemas/system.js";

import { useUiStore } from "../../../stores/uiStore.js";
import {
  getStageVex,
  resetStageVex,
  stageVexEnd,
  stageVexView,
} from "../../../components/onboarding/stage-vex.js";
import { RuntimeBootstrap } from "../RuntimeBootstrap.js";

const listeners = new Set<(status: NativeRuntimeStatus) => void>();
const runtimeStatus = vi.fn();
const runtimeRetry = vi.fn();
const openLogsFolder = vi.fn();

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function emit(status: NativeRuntimeStatus): void {
  act(() => {
    for (const listener of listeners) listener(status);
  });
}

/** What Vex shows on the plate for this screen (the face's word). */
function face(): string {
  return stageVexView(getStageVex()).word;
}

function row(container: HTMLElement, step: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-step="${step}"]`);
  if (el === null) throw new Error(`no ${step} row`);
  return el;
}

beforeEach(() => {
  resetStageVex();
  // The launch is over: her face is the screen's, with no wake to wait for.
  stageVexEnd();
  listeners.clear();
  runtimeStatus.mockReset().mockResolvedValue(ok({ seq: 1, phase: "postgres", initializing: true }));
  runtimeRetry.mockReset();
  openLogsFolder.mockReset().mockResolvedValue(ok({ opened: true }));
  useUiStore.setState({ currentView: "runtimeBootstrap" });
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      system: {
        runtimeStatus,
        runtimeRetry,
        onRuntimeProgress: (cb: (status: NativeRuntimeStatus) => void) => {
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
  resetStageVex();
  Reflect.deleteProperty(window, "vex");
});

describe("RuntimeBootstrap - phases", () => {
  it("shows the first run creating the database, the later steps waiting", async () => {
    const view = render(<RuntimeBootstrap />);
    expect(view.container.querySelector('[data-vex-screen="runtimeBootstrap"]')).not.toBeNull();
    expect(view.getByRole("heading", { name: "Preparing local runtime" })).toBeTruthy();
    await waitFor(() => expect(row(view.container, "postgres").dataset["status"]).toBe("active"));
    expect(row(view.container, "postgres").textContent).toContain("Creating the local database (first run)");
    expect(row(view.container, "model").dataset["status"]).toBe("waiting");
    expect(row(view.container, "embeddings").dataset["status"]).toBe("waiting");
    // Vex works on the plate while a step is in flight.
    expect(face()).toBe("Working");
  });

  it("shows the model download as bytes, speed and percent", async () => {
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(listeners.size).toBe(1));
    emit({
      seq: 4,
      phase: "model",
      model: { state: "downloading", receivedBytes: 120_400_000, totalBytes: 333_590_944, bytesPerSecond: 8_200_000 },
    });
    const model = row(view.container, "model");
    expect(model.dataset["status"]).toBe("active");
    expect(model.textContent).toContain("120.4 MB of 333.6 MB · 8.2 MB/s");
    expect(model.textContent).toContain("36%");
    expect(within(model).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("36");
    expect(row(view.container, "postgres").dataset["status"]).toBe("ready");
    expect(row(view.container, "embeddings").dataset["status"]).toBe("waiting");
  });

  it("leaves the speed out until main has measured it", async () => {
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(listeners.size).toBe(1));
    emit({
      seq: 4,
      phase: "model",
      model: { state: "downloading", receivedBytes: 0, totalBytes: 333_590_944, bytesPerSecond: null },
    });
    expect(row(view.container, "model").textContent).toContain("0.0 MB of 333.6 MB");
    expect(row(view.container, "model").textContent).not.toContain("/s");
  });

  it("shows a model re-hash and then the embeddings server starting", async () => {
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(listeners.size).toBe(1));
    emit({ seq: 3, phase: "model", model: { state: "verifying" } });
    expect(row(view.container, "model").textContent).toContain("Verifying the model file");
    emit({ seq: 4, phase: "embeddings" });
    expect(row(view.container, "model").dataset["status"]).toBe("ready");
    expect(row(view.container, "embeddings").dataset["status"]).toBe("active");
    expect(row(view.container, "embeddings").textContent).toContain("Loading the model");
  });

  it("advances to the migrations on its own once ready", async () => {
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(listeners.size).toBe(1));
    emit({ seq: 5, phase: "ready" });
    expect(view.getByText("Local runtime ready")).toBeTruthy();
    for (const step of ["postgres", "model", "embeddings"]) {
      expect(row(view.container, step).dataset["status"]).toBe("ready");
    }
    expect(useUiStore.getState().currentView).toBe("runtimeBootstrap");
    await waitFor(() => expect(useUiStore.getState().currentView).toBe("migrations"), { timeout: 2_000 });
  });

  it("keeps a newer event over a status reply that crossed it", async () => {
    let answer: (value: unknown) => void = () => {};
    runtimeStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(listeners.size).toBe(1));
    emit({ seq: 4, phase: "embeddings" });
    await act(async () => {
      answer(ok({ seq: 2, phase: "postgres", initializing: false }));
      await Promise.resolve();
    });
    expect(row(view.container, "embeddings").dataset["status"]).toBe("active");
  });

  it("unsubscribes on unmount", async () => {
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(listeners.size).toBe(1));
    view.unmount();
    expect(listeners.size).toBe(0);
  });
});

describe("RuntimeBootstrap - failures", () => {
  it.each<[NativeRuntimeStatus & { phase: "failed" }, string, RegExp | null]>([
    [
      { seq: 3, phase: "failed", step: "model", kind: "disk_full", message: "Not enough disk space for the embeddings model (12 bytes free)." },
      "Not enough disk space",
      /about 400 MB free.*resumes where it stopped/,
    ],
    [
      { seq: 3, phase: "failed", step: "postgres", kind: "disk_full", message: "The disk is full." },
      "Not enough disk space",
      /could not write to the disk/,
    ],
    [
      { seq: 3, phase: "failed", step: "model", kind: "offline", message: "The embeddings model could not be downloaded: source 1: ENOTFOUND" },
      "Could not download the embeddings model",
      /internet connection.*huggingface\.co.*resumes where it stopped/,
    ],
    [
      { seq: 3, phase: "failed", step: "postgres", kind: "foreign_listener", message: "Not this install's database." },
      "Another database answered for this install",
      /stopped before reading or writing it/,
    ],
    [
      { seq: 3, phase: "failed", step: "postgres", kind: "port_collision", message: "No port." },
      "No free port for the local database",
      /Every port Vex tried/,
    ],
    [
      { seq: 3, phase: "failed", step: "embeddings", kind: "unhealthy", message: "llama-server restart budget exhausted" },
      "The embeddings server keeps stopping",
      /stopped restarting it/,
    ],
    [
      { seq: 3, phase: "failed", step: "postgres", kind: "unavailable", message: "The bundled Postgres is missing." },
      "Part of the local runtime is missing",
      /Reinstalling Vex/,
    ],
    [
      { seq: 3, phase: "failed", step: "embeddings", kind: "failed", message: "llama-server exited code=1" },
      "The embeddings server could not start",
      null,
    ],
  ])("%o: its own copy, the runtime's message, Try again and the logs", async (status, title, advice) => {
    runtimeStatus.mockResolvedValue(ok(status));
    const view = render(<RuntimeBootstrap />);
    await waitFor(() => expect(view.container.querySelector(`[data-runtime-failure="${status.kind}"]`)).not.toBeNull());
    const failure = view.container.querySelector<HTMLElement>("[data-runtime-failure]")!;
    expect(within(failure).getByRole("alert").textContent).toContain(title);
    expect(failure.textContent).toContain(status.message);
    if (advice !== null) expect(failure.textContent).toMatch(advice);
    expect(row(view.container, status.step).dataset["status"]).toBe("failed");
    // Vex shows the failure on the plate.
    expect(face()).toBe("Error");
    fireEvent.click(view.getByRole("button", { name: "Open logs folder" }));
    expect(openLogsFolder).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().currentView).toBe("runtimeBootstrap");
  });

  it("Try again asks main for another start and shows it", async () => {
    runtimeStatus.mockResolvedValue(
      ok({ seq: 3, phase: "failed", step: "model", kind: "offline", message: "offline" }),
    );
    runtimeRetry.mockResolvedValue(ok({ seq: 4, phase: "postgres", initializing: false }));
    const view = render(<RuntimeBootstrap />);
    const retry = await view.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);
    expect(runtimeRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(row(view.container, "postgres").dataset["status"]).toBe("active"));
    expect(view.container.querySelector("[data-runtime-failure]")).toBeNull();
    expect(row(view.container, "model").dataset["status"]).toBe("waiting");
  });
});
