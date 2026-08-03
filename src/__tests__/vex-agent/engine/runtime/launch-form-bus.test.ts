/**
 * `launchFormBus` — the signal-layer invariants.
 *
 * This bus is the only thing standing between the agent drafting a launch and
 * the modal appearing on the user's screen, so the properties that matter are:
 * a thrown listener does not silence the others, unsubscribe is idempotent, and
 * the payload carries ids only — never the token the agent proposed.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  LAUNCH_FORM_EVENT_TYPE,
  emitLaunchFormRequested,
  launchFormBus,
  type LaunchFormEvent,
} from "@vex-agent/engine/runtime/launch-form-bus.js";

const SESSION = "00000000-0000-4000-8000-0000000000f1";
const INTENT = "00000000-0000-4000-8000-0000000000f2";

function event(over: Partial<LaunchFormEvent> = {}): LaunchFormEvent {
  return {
    type: LAUNCH_FORM_EVENT_TYPE,
    sessionId: SESSION,
    intentId: INTENT,
    kind: "requested",
    occurredAt: "2026-08-02T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  launchFormBus.clear();
});

describe("launchFormBus", () => {
  it("delivers to every subscriber", () => {
    const seen: string[] = [];
    launchFormBus.subscribe((e) => seen.push(`a:${e.intentId}`));
    launchFormBus.subscribe((e) => seen.push(`b:${e.intentId}`));

    launchFormBus.emit(event());

    expect(seen).toEqual([`a:${INTENT}`, `b:${INTENT}`]);
  });

  it("isolates a misbehaving listener — the rest still receive the event", () => {
    const seen: string[] = [];
    launchFormBus.subscribe(() => {
      throw new Error("listener blew up");
    });
    launchFormBus.subscribe((e) => seen.push(e.sessionId));

    expect(() => launchFormBus.emit(event())).not.toThrow();
    expect(seen).toEqual([SESSION]);
  });

  it("unsubscribe is idempotent and actually stops delivery", () => {
    const seen: string[] = [];
    const off = launchFormBus.subscribe((e) => seen.push(e.sessionId));
    off();
    off();

    launchFormBus.emit(event());

    expect(seen).toEqual([]);
    expect(launchFormBus.size()).toBe(0);
  });

  it("emitLaunchFormRequested stamps type, kind and an ISO timestamp", () => {
    const seen: LaunchFormEvent[] = [];
    launchFormBus.subscribe((e) => seen.push(e));

    emitLaunchFormRequested({ sessionId: SESSION, intentId: INTENT });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe(LAUNCH_FORM_EVENT_TYPE);
    expect(seen[0]?.kind).toBe("requested");
    expect(seen[0]?.sessionId).toBe(SESSION);
    expect(seen[0]?.intentId).toBe(INTENT);
    expect(Number.isNaN(Date.parse(seen[0]?.occurredAt ?? ""))).toBe(false);
  });

  it("the payload is metadata only — five bounded keys, no token content", () => {
    // A regression guard with teeth: adding name/symbol/description/prebuy to
    // the event would land here as a key this assertion does not name.
    expect(Object.keys(event()).sort()).toEqual([
      "intentId",
      "kind",
      "occurredAt",
      "sessionId",
      "type",
    ]);
  });
});
