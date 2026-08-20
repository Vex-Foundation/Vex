/**
 * Preload market subscription boundary test (T1).
 *
 * The `EV.market.vex` payload is untrusted at the preload boundary: an
 * off-contract broadcast (main bug or a hostile shape) must be DROPPED before
 * it reaches the renderer callback. This drives `subscribe`'s Zod gate through
 * the real `vex.market.onVexUpdate` bridge against a faked `ipcRenderer`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

type IpcListener = (event: unknown, ...args: unknown[]) => void;
const listeners = new Map<string, Set<IpcListener>>();

vi.mock("electron", () => ({
  ipcRenderer: {
    on: (channel: string, listener: IpcListener) => {
      const set = listeners.get(channel) ?? new Set<IpcListener>();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener: (channel: string, listener: IpcListener) => {
      listeners.get(channel)?.delete(listener);
    },
    invoke: vi.fn(),
  },
}));

const { market } = await import("../shell/market.js");
const { EV } = await import("../../shared/ipc/channels.js");

function emit(channel: string, payload: unknown): void {
  for (const listener of listeners.get(channel) ?? []) listener({}, payload);
}

const VALID_SNAPSHOT = {
  priceUsd: 0.000543,
  priceChange: { h1: -1.73, h24: 113 },
  marketCap: 543068,
  fdv: 543068,
  liquidityUsd: 75189.01,
  volumeH24: 464284.04,
  txnsH24: { buys: 1235, sells: 856 },
  holderCount: 354,
  sparkline: [[1783170000, 0.00055]],
  updatedAt: 1783172700000,
  stale: false,
};

afterEach(() => {
  listeners.clear();
  vi.clearAllMocks();
});

describe("vex.market.onVexUpdate - payload validation at the preload boundary", () => {
  it("delivers a valid snapshot to the callback", () => {
    const cb = vi.fn();
    const off = market.onVexUpdate(cb);
    emit(EV.market.vex, VALID_SNAPSHOT);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0]).toMatchObject({ priceUsd: 0.000543 });
    off();
  });

  it("drops off-contract payloads (wrong types, null, extra keys) - callback never runs", () => {
    const cb = vi.fn();
    const off = market.onVexUpdate(cb);
    emit(EV.market.vex, null);
    emit(EV.market.vex, { priceUsd: "not-a-number" });
    emit(EV.market.vex, { ...VALID_SNAPSHOT, priceUsd: Number.NaN });
    emit(EV.market.vex, { ...VALID_SNAPSHOT, injected: true }); // strict schema
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it("unsubscribe removes the listener (idempotent cleanup)", () => {
    const cb = vi.fn();
    const off = market.onVexUpdate(cb);
    off();
    off(); // idempotent
    emit(EV.market.vex, VALID_SNAPSHOT);
    expect(cb).not.toHaveBeenCalled();
  });
});
