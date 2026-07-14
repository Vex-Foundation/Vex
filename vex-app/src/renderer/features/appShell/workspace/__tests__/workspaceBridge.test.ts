/**
 * Bridge adapter — the ONE place the renderer touches the main workspace
 * surface. Every access is optional-chained so a missing/partial
 * `window.vex.hyperliquid` (older preload, a shell test with a partial stub)
 * never crashes the renderer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestWorkspaceExit,
  subscribeWorkspaceMode,
} from "../workspaceBridge.js";

function setBridge(value: unknown): void {
  Object.defineProperty(window, "vex", { configurable: true, value });
}

afterEach(() => {
  Reflect.deleteProperty(window as object, "vex");
});

describe("subscribeWorkspaceMode", () => {
  it("returns a no-op unsubscribe and never throws when the bridge is absent", () => {
    setBridge(undefined);
    const off = subscribeWorkspaceMode(() => {});
    expect(typeof off).toBe("function");
    expect(() => off()).not.toThrow();
  });

  it("tolerates a partial hyperliquid stub with no onWorkspaceMode", () => {
    setBridge({ hyperliquid: {} });
    expect(() => subscribeWorkspaceMode(() => {})).not.toThrow();
  });

  it("wires through to the real bridge and forwards its unsubscribe", () => {
    const unsubscribe = vi.fn();
    const onWorkspaceMode = vi.fn(() => unsubscribe);
    setBridge({ hyperliquid: { onWorkspaceMode } });

    const callback = vi.fn();
    const off = subscribeWorkspaceMode(callback);
    expect(onWorkspaceMode).toHaveBeenCalledWith(callback);
    off();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("requestWorkspaceExit", () => {
  it("resolves without throwing when the bridge is absent", async () => {
    setBridge(undefined);
    await expect(requestWorkspaceExit("00000000-0000-4000-8000-000000000001")).resolves.toBe(false);
  });

  it("returns false on IPC rejection so the workspace does not diverge", async () => {
    const exitWorkspace = vi.fn().mockRejectedValue(new Error("offline"));
    setBridge({ hyperliquid: { exitWorkspace } });
    await expect(requestWorkspaceExit("00000000-0000-4000-8000-000000000001")).resolves.toBe(false);
    expect(exitWorkspace).toHaveBeenCalledTimes(1);
  });
  it("returns true only when main accepts the exit request", async () => {
    const exitWorkspace = vi.fn().mockResolvedValue({ ok: true, data: {} });
    setBridge({ hyperliquid: { exitWorkspace } });
    await expect(requestWorkspaceExit("00000000-0000-4000-8000-000000000001")).resolves.toBe(true);
    expect(exitWorkspace).toHaveBeenCalledWith({ sessionId: "00000000-0000-4000-8000-000000000001" });
  });
});
