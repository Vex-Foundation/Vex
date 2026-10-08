/**
 * TURN PHASE inputs in `useStreamPreviewSync` (U-3): the lease the engine
 * reports is recorded for the island, and a tool round that is still RUNNING
 * when the runner releases its lease is retired with it, so the turn clock
 * stops (the Kairos lease-release fix, extended to the unsettled round).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { StreamDeltaEvent } from "@shared/schemas/stream.js";

import { useStreamPreviewSync } from "../../streams.js";
import { useStreamStore } from "../../../../stores/streamStore.js";
import {
  SESSION_A,
  SESSION_B,
  emitControlState,
  emitDelta,
  flush,
  leaseReleased,
  makeWrapper,
  resetStreamEnv,
  setupStreamEnv,
  textDelta,
  toolCallDelta,
} from "./stream-sync-harness.js";

beforeEach(setupStreamEnv);
afterEach(resetStreamEnv);

function doneDelta(sessionId: string, streamId = "s1", sequence = 2): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence,
    deltaType: "done",
    delta: { kind: "done" },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

function mount(sessionId: string): () => void {
  const { unmount } = renderHook(() => useStreamPreviewSync(sessionId), {
    wrapper: makeWrapper(new QueryClient()),
  });
  return unmount;
}

describe("useStreamPreviewSync turn phase", () => {
  it("records the lease the engine reports, per session, and nothing else", () => {
    mount(SESSION_A);
    expect(useStreamStore.getState().leaseBySessionId[SESSION_A]).toBeUndefined();

    emitControlState(leaseReleased(SESSION_A, true));
    expect(useStreamStore.getState().leaseBySessionId[SESSION_A]).toBe(true);
    // Recording a lease never creates a preview.
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();

    emitControlState(leaseReleased(SESSION_B, true));
    expect(useStreamStore.getState().leaseBySessionId[SESSION_B]).toBeUndefined();

    emitControlState(leaseReleased(SESSION_A));
    expect(useStreamStore.getState().leaseBySessionId[SESSION_A]).toBe(false);
  });

  it("forgets the lease on unmount, so a stale value cannot outlive the subscription", () => {
    const unmount = mount(SESSION_A);
    emitControlState(leaseReleased(SESSION_A, true));
    unmount();
    expect(useStreamStore.getState().leaseBySessionId[SESSION_A]).toBeUndefined();
  });

  it("retires a tool round that is still running when the runner releases the lease", async () => {
    mount(SESSION_A);
    emitControlState(leaseReleased(SESSION_A, true));
    emitDelta(toolCallDelta(SESSION_A, "s1", "MissionStop"));
    emitDelta(doneDelta(SESSION_A));
    await flush();
    const running = useStreamStore.getState().bySessionId[SESSION_A];
    expect(running?.phase).toBe("done");
    expect(running?.toolName).toBe("MissionStop");

    // An active-lease event leaves the running round alone.
    emitControlState(leaseReleased(SESSION_A, true));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();

    emitControlState(leaseReleased(SESSION_A));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  it("still leaves a finished ANSWER to its append on release", async () => {
    mount(SESSION_A);
    emitDelta(textDelta(SESSION_A, "s1", "final answer"));
    emitDelta(doneDelta(SESSION_A));
    await flush();
    emitControlState(leaseReleased(SESSION_A));
    expect(useStreamStore.getState().bySessionId[SESSION_A]?.text).toBe("final answer");
  });

  it("leaves a finished round with no tool and no text to its append on release", async () => {
    mount(SESSION_A);
    emitDelta(doneDelta(SESSION_A, "s1", 0));
    await flush();
    emitControlState(leaseReleased(SESSION_A));
    expect(useStreamStore.getState().bySessionId[SESSION_A]?.phase).toBe("done");
  });
});
