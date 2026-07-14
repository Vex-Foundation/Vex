/**
 * Controller integration: agent push → ack gate → store transition, and the
 * always-available EXIT. The bridge is stubbed on `window.vex.hyperliquid`; the
 * store is the real uiStore (its transient `workspaceMode` flag is the contract
 * under test).
 */

import type { JSX, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HyperliquidWorkspaceModeEvent } from "@shared/schemas/hyperliquid.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { useHypervexingWorkspace } from "../useHypervexingWorkspace.js";

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
let pushEvent: ((event: HyperliquidWorkspaceModeEvent) => void) | null = null;
const acknowledgeRisk = vi.fn();
const exitWorkspace = vi.fn().mockResolvedValue({ ok: true, data: {} });
const getWorkspaceMode = vi.fn().mockResolvedValue({
  ok: true,
  data: { mode: "normal", acknowledged: true },
});

function installBridge(): void {
  pushEvent = null;
  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      hyperliquid: {
        onWorkspaceMode: (cb: (event: HyperliquidWorkspaceModeEvent) => void) => {
          pushEvent = cb;
          return () => {
            pushEvent = null;
          };
        },
        acknowledgeRisk,
        exitWorkspace,
        getWorkspaceMode,
      },
    },
  });
}

function wrapper({ children }: { readonly children: ReactNode }): JSX.Element {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  acknowledgeRisk.mockReset().mockResolvedValue({
    ok: true,
    data: { hyperliquid: { riskAcknowledgedAt: "2026-01-01T00:00:00.000Z" } },
  });
  exitWorkspace.mockClear();
  getWorkspaceMode.mockClear().mockResolvedValue({
    ok: true,
    data: { mode: "normal", acknowledged: true },
  });
  installBridge();
  useUiStore.setState({ workspaceMode: "normal", activeSessionId: SESSION_ID });
});

afterEach(() => {
  useUiStore.setState({ workspaceMode: "normal", activeSessionId: null });
  Reflect.deleteProperty(window as object, "vex");
});

function emit(
  mode: "hypervexing" | "normal",
  acknowledged: boolean,
  sessionId: string = SESSION_ID,
): void {
  act(() => {
    pushEvent?.({ sessionId, mode, requestedBy: "agent", acknowledged });
  });
}

describe("useHypervexingWorkspace", () => {
  it("activates the mode directly when the agent pushes an acknowledged request", () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", true);
    expect(result.current.workspaceMode).toBe("hypervexing");
    expect(result.current.ackPending).toBe(false);
  });

  it("gates on the ack dialog when the request is not acknowledged (mode stays normal)", () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", false);
    expect(result.current.ackPending).toBe(true);
    expect(result.current.workspaceMode).toBe("normal");
  });

  it("confirmAck persists the ack, then activates the mode", async () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", false);
    act(() => {
      result.current.confirmAck();
    });
    await waitFor(() => expect(result.current.workspaceMode).toBe("hypervexing"));
    expect(acknowledgeRisk).toHaveBeenCalledTimes(1);
    expect(result.current.ackPending).toBe(false);
  });

  it("cancelAck closes the gate and stays normal (and tells main)", () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", false);
    act(() => {
      result.current.cancelAck();
    });
    expect(result.current.ackPending).toBe(false);
    expect(result.current.workspaceMode).toBe("normal");
    expect(exitWorkspace).toHaveBeenCalledTimes(1);
    expect(exitWorkspace).toHaveBeenCalledWith({ sessionId: SESSION_ID });
  });

  it("exit waits for main's pushed normal state and never diverges optimistically", async () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", true);
    expect(result.current.workspaceMode).toBe("hypervexing");
    await act(async () => {
      await result.current.exit();
    });
    expect(result.current.workspaceMode).toBe("hypervexing");
    expect(exitWorkspace).toHaveBeenCalledTimes(1);
    expect(exitWorkspace).toHaveBeenCalledWith({ sessionId: SESSION_ID });
    emit("normal", true);
    expect(result.current.workspaceMode).toBe("normal");
  });

  it("an agent 'normal' push exits the mode", () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", true);
    expect(result.current.workspaceMode).toBe("hypervexing");
    emit("normal", true);
    expect(result.current.workspaceMode).toBe("normal");
  });

  it("ignores a push for a DIFFERENT session (no cross-session morph)", () => {
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", true, "00000000-0000-4000-8000-00000000dead");
    expect(result.current.workspaceMode).toBe("normal");
    expect(result.current.ackPending).toBe(false);
  });

  it("reconciles into an already-hypervexing session on mount read", async () => {
    getWorkspaceMode.mockResolvedValue({
      ok: true,
      data: { mode: "hypervexing", acknowledged: true },
    });
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    await waitFor(() => expect(result.current.workspaceMode).toBe("hypervexing"));
  });

  it("a late 'normal' mount read never overrides a fresher live push", async () => {
    let resolveRead: ((value: unknown) => void) | null = null;
    getWorkspaceMode.mockImplementation(
      () => new Promise((resolve) => { resolveRead = resolve; }),
    );
    const { result } = renderHook(() => useHypervexingWorkspace(), { wrapper });
    emit("hypervexing", true);
    expect(result.current.workspaceMode).toBe("hypervexing");
    await act(async () => {
      resolveRead?.({ ok: true, data: { mode: "normal", acknowledged: true } });
      await Promise.resolve();
    });
    expect(result.current.workspaceMode).toBe("hypervexing");
  });
});
