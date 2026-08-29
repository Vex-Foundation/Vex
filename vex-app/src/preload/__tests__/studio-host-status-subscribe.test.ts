/**
 * THE PRELOAD BOUNDARY for `EV.studio.hostStatus` (stage B0).
 *
 * Mirrors `market-subscribe.test.ts`. The drop assertions are the security
 * contract, not a nicety: this is the last place an off-contract payload from a
 * misbehaving main can be stopped before it becomes renderer state, and the
 * `.strict()` extra-key case is what proves an endpoint path cannot be smuggled
 * in beside the fields the renderer expects.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

import type { StudioHostStatus } from "../../shared/schemas/studio.js";

const listeners = new Map<string, Array<(event: unknown, raw: unknown) => void>>();

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, handler: (event: unknown, raw: unknown) => void) => {
      const existing = listeners.get(channel) ?? [];
      existing.push(handler);
      listeners.set(channel, existing);
    },
    removeListener: (
      channel: string,
      handler: (event: unknown, raw: unknown) => void,
    ) => {
      const existing = listeners.get(channel) ?? [];
      listeners.set(
        channel,
        existing.filter((item) => item !== handler),
      );
    },
    invoke: vi.fn(),
  },
}));

const { EV } = await import("../../shared/ipc/channels.js");
const { studio } = await import("../shell/studio.js");

const VALID: StudioHostStatus = {
  state: "running",
  cause: null,
  connectionCount: 2,
  maxConnections: 16,
  atCapacity: false,
};

function emit(raw: unknown): void {
  for (const handler of listeners.get(EV.studio.hostStatus) ?? []) {
    handler({}, raw);
  }
}

beforeEach(() => {
  listeners.clear();
});

describe("vex.studio.onHostStatus", () => {
  it("delivers a valid payload", () => {
    const cb = vi.fn();
    studio.onHostStatus(cb);

    emit(VALID);

    expect(cb).toHaveBeenCalledWith(VALID);
  });

  it("DROPS an extra key, so an endpoint cannot ride along", () => {
    const cb = vi.fn();
    studio.onHostStatus(cb);

    emit({ ...VALID, endpoint: "/run/user/1000/vex-studio-abc.sock" });

    expect(cb).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["a string", "running"],
    ["an unknown state", { ...VALID, state: "confused" }],
    ["an unknown cause", { ...VALID, state: "unavailable", cause: "gremlins" }],
    ["a prose cause", { ...VALID, state: "unavailable", cause: "Vex is starting." }],
    ["a cause without unavailable", { ...VALID, cause: "starting" }],
    ["unavailable without a cause", { ...VALID, state: "unavailable" }],
    ["a drifted bound", { ...VALID, maxConnections: 32 }],
    ["a negative count", { ...VALID, connectionCount: -1 }],
    ["a missing field", { state: "running", cause: null }],
  ])("DROPS %s", (_label, payload) => {
    const cb = vi.fn();
    studio.onHostStatus(cb);

    emit(payload);

    expect(cb).not.toHaveBeenCalled();
  });

  it("returns an idempotent unsubscribe that removes the listener", () => {
    const cb = vi.fn();
    const off = studio.onHostStatus(cb);

    off();
    off();
    emit(VALID);

    expect(cb).not.toHaveBeenCalled();
    expect(listeners.get(EV.studio.hostStatus) ?? []).toHaveLength(0);
  });
});
