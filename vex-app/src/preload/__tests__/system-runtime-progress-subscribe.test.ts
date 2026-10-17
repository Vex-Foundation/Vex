/**
 * THE PRELOAD BOUNDARY for `EV.system.runtimeProgress`.
 *
 * Mirrors `studio-host-status-subscribe.test.ts`: an off-contract status from
 * main is dropped here, before it becomes the runtime screen's state.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeRuntimeStatus } from "../../shared/schemas/system.js";

const listeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>();

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    },
    removeListener: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      listeners.set(channel, (listeners.get(channel) ?? []).filter((item) => item !== handler));
    },
    invoke: vi.fn(),
  },
}));

const { EV } = await import("../../shared/ipc/channels.js");
const { system } = await import("../shell/system.js");

const DOWNLOADING: NativeRuntimeStatus = {
  seq: 4,
  phase: "model",
  model: { state: "downloading", receivedBytes: 1_000, totalBytes: 333_590_944, bytesPerSecond: 2_500_000 },
};
const FAILED: NativeRuntimeStatus = {
  seq: 5,
  phase: "failed",
  step: "model",
  kind: "disk_full",
  message: "Not enough disk space for the embeddings model (12 bytes free).",
};

function emit(raw: unknown): void {
  for (const handler of listeners.get(EV.system.runtimeProgress) ?? []) handler({}, raw);
}

beforeEach(() => {
  listeners.clear();
});

describe("vex.system.onRuntimeProgress", () => {
  it.each([
    ["a download", DOWNLOADING],
    ["a failure", FAILED],
    ["ready", { seq: 9, phase: "ready" }],
  ])("delivers %s", (_label, payload) => {
    const cb = vi.fn();
    system.onRuntimeProgress(cb);
    emit(payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it.each([
    ["an extra key", { ...DOWNLOADING, path: "/Users/someone/.vex/runtime" }],
    ["an unknown phase", { seq: 1, phase: "booting" }],
    ["an unknown failure kind", { ...FAILED, kind: "gremlins" }],
    ["a failure without its step", { seq: 5, phase: "failed", kind: "failed", message: "x" }],
    ["negative bytes", { ...DOWNLOADING, model: { ...DOWNLOADING.model, receivedBytes: -1 } }],
    ["a missing seq", { phase: "ready" }],
  ])("DROPS %s", (_label, payload) => {
    const cb = vi.fn();
    system.onRuntimeProgress(cb);
    emit(payload);
    expect(cb).not.toHaveBeenCalled();
  });

  it("returns an idempotent unsubscribe that removes the listener", () => {
    const cb = vi.fn();
    const off = system.onRuntimeProgress(cb);
    off();
    off();
    emit(DOWNLOADING);
    expect(cb).not.toHaveBeenCalled();
    expect(listeners.get(EV.system.runtimeProgress) ?? []).toHaveLength(0);
  });
});
