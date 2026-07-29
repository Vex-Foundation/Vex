/**
 * `engine/runtime/mission-bus.ts` — the mission-update signal layer.
 *
 * Mirrors the control-bus contract: fan-out, idempotent unsubscribe, and the
 * isolation guarantee that one throwing listener cannot stop the others. The
 * bounded-payload shape is asserted here because it is the whole reason this
 * bus exists separately from the transcript stream: ids and enums cross to the
 * renderer, content never does.
 */

import { describe, it, expect, vi } from "vitest";

const { MissionUpdateBus, emitMissionUpdate, missionUpdateBus, MISSION_UPDATE_EVENT_TYPE } =
  await import("../../../../vex-agent/engine/runtime/mission-bus.js");

describe("MissionUpdateBus", () => {
  it("delivers an event to every subscriber", () => {
    const bus = new MissionUpdateBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    bus.emit({
      type: MISSION_UPDATE_EVENT_TYPE,
      sessionId: "session-1",
      missionId: "mission-1",
      kind: "accepted",
      occurredAt: "2026-07-29T10:00:00.000Z",
    });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("stops delivering after unsubscribe, and unsubscribe is idempotent", () => {
    const bus = new MissionUpdateBus();
    const listener = vi.fn();
    const off = bus.subscribe(listener);
    off();
    off();

    bus.emit({
      type: MISSION_UPDATE_EVENT_TYPE,
      sessionId: "session-1",
      missionId: null,
      kind: "approval_enqueued",
      occurredAt: "2026-07-29T10:00:00.000Z",
    });

    expect(listener).not.toHaveBeenCalled();
    expect(bus.size()).toBe(0);
  });

  it("isolates a throwing listener from the rest of the bus", () => {
    const bus = new MissionUpdateBus();
    const healthy = vi.fn();
    bus.subscribe(() => {
      throw new Error("misbehaving subscriber");
    });
    bus.subscribe(healthy);

    expect(() =>
      bus.emit({
        type: MISSION_UPDATE_EVENT_TYPE,
        sessionId: "session-1",
        missionId: "mission-1",
        kind: "draft_updated",
        occurredAt: "2026-07-29T10:00:00.000Z",
      }),
    ).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
  });
});

describe("emitMissionUpdate", () => {
  it("stamps type + occurredAt and carries ONLY bounded fields", () => {
    const received: unknown[] = [];
    const off = missionUpdateBus.subscribe((event) => received.push(event));
    try {
      emitMissionUpdate({
        sessionId: "session-1",
        missionId: "mission-1",
        kind: "readiness_changed",
      });
    } finally {
      off();
    }

    expect(received).toHaveLength(1);
    const event = received[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "kind",
      "missionId",
      "occurredAt",
      "sessionId",
      "type",
    ]);
    expect(event.type).toBe(MISSION_UPDATE_EVENT_TYPE);
    expect(event.kind).toBe("readiness_changed");
    expect(typeof event.occurredAt).toBe("string");
  });
});
