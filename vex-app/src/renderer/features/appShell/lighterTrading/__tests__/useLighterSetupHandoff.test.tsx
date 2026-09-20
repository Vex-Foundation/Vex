import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LighterSetupHandoffEvent } from "@shared/schemas/lighter-setup-handoff.js";
import { useLighterAnalysisStore } from "../../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import { useLighterSetupHandoff } from "../useLighterSetupHandoff.js";

const ACTIVE_SESSION = "00000000-0000-4000-8000-0000000000a1";
let listener: ((event: LighterSetupHandoffEvent) => void) | null = null;
const unsubscribe = vi.fn();

function event(
  patch: Partial<LighterSetupHandoffEvent> = {},
): LighterSetupHandoffEvent {
  return {
    type: "engine.lighter.setup",
    sessionId: ACTIVE_SESSION,
    environment: "core",
    kind: "requested",
    occurredAt: "2026-09-20T13:00:00.000Z",
    ...patch,
  };
}

beforeEach(() => {
  listener = null;
  unsubscribe.mockReset();
  window.localStorage.clear();
  useUiStore.setState({
    activeSessionId: ACTIVE_SESSION,
    runtimeMode: "agent",
    lighterSetupRequested: false,
  });
  useLighterAnalysisStore.getState().saveDesk({
    environment: "rhc",
    marketId: 7,
  });

  Object.defineProperty(window, "vex", {
    configurable: true,
    value: {
      engine: {
        onLighterSetupRequested: (
          next: (value: LighterSetupHandoffEvent) => void,
        ) => {
          listener = next;
          return unsubscribe;
        },
      },
    },
  });
});

describe("useLighterSetupHandoff", () => {
  it("switches to the exact environment and arms the existing setup modal", () => {
    renderHook(() => useLighterSetupHandoff());

    act(() => listener?.(event()));

    expect(useUiStore.getState()).toMatchObject({
      runtimeMode: "lighter",
      lighterSetupRequested: true,
    });
    expect(useLighterAnalysisStore.getState().desk).toMatchObject({
      environment: "core",
      marketId: null,
    });
  });

  it("ignores a stale event from another session", () => {
    renderHook(() => useLighterSetupHandoff());

    act(() => {
      listener?.(event({
        sessionId: "00000000-0000-4000-8000-0000000000b2",
      }));
    });

    expect(useUiStore.getState()).toMatchObject({
      runtimeMode: "agent",
      lighterSetupRequested: false,
    });
    expect(useLighterAnalysisStore.getState().desk).toMatchObject({
      environment: "rhc",
      marketId: 7,
    });
  });

  it("unsubscribes when the shell unmounts", () => {
    const rendered = renderHook(() => useLighterSetupHandoff());
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
