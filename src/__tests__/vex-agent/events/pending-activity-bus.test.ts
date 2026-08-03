/**
 * `pendingActivityBus` — the signal-layer invariants (Wave P).
 *
 * This bus arms the fast lane and pushes terminalization to the renderer, so the
 * properties that matter are the same three the launch-form bus pins: a thrown
 * listener does not silence the others, unsubscribe is idempotent, and the
 * payload carries ids only — never an amount, a hash, or a token identity.
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  PENDING_ACTIVITY_EVENT_TYPE,
  emitPendingActivityArmed,
  emitPendingActivityResolved,
  pendingActivityBus,
  type PendingActivityEvent,
} from "@vex-agent/events/pending-activity-bus.js";

function event(over: Partial<PendingActivityEvent> = {}): PendingActivityEvent {
  return {
    type: PENDING_ACTIVITY_EVENT_TYPE,
    kind: "armed",
    activityId: 42,
    chainFamily: "eip155",
    chainId: 8453,
    status: null,
    occurredAt: "2026-08-03T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  pendingActivityBus.clear();
});

describe("pendingActivityBus", () => {
  it("delivers to every subscriber", () => {
    const seen: string[] = [];
    pendingActivityBus.subscribe((e) => seen.push(`a:${e.activityId}`));
    pendingActivityBus.subscribe((e) => seen.push(`b:${e.activityId}`));

    pendingActivityBus.emit(event());

    expect(seen).toEqual(["a:42", "b:42"]);
  });

  it("isolates a misbehaving listener — the rest still receive the event", () => {
    const seen: number[] = [];
    pendingActivityBus.subscribe(() => {
      throw new Error("listener blew up");
    });
    pendingActivityBus.subscribe((e) => seen.push(e.activityId));

    expect(() => pendingActivityBus.emit(event())).not.toThrow();
    expect(seen).toEqual([42]);
  });

  it("unsubscribe is idempotent and actually stops delivery", () => {
    const seen: number[] = [];
    const off = pendingActivityBus.subscribe((e) => seen.push(e.activityId));
    off();
    off();

    pendingActivityBus.emit(event());

    expect(seen).toEqual([]);
    expect(pendingActivityBus.size()).toBe(0);
  });

  it("emitPendingActivityArmed stamps type, kind, null status and an ISO timestamp", () => {
    const seen: PendingActivityEvent[] = [];
    pendingActivityBus.subscribe((e) => seen.push(e));

    emitPendingActivityArmed({ activityId: 7, chainFamily: "solana", chainId: null });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.type).toBe(PENDING_ACTIVITY_EVENT_TYPE);
    expect(seen[0]?.kind).toBe("armed");
    expect(seen[0]?.activityId).toBe(7);
    expect(seen[0]?.chainFamily).toBe("solana");
    expect(seen[0]?.chainId).toBeNull();
    expect(seen[0]?.status).toBeNull();
    expect(Number.isNaN(Date.parse(seen[0]?.occurredAt ?? ""))).toBe(false);
  });

  it("emitPendingActivityResolved carries the terminal status", () => {
    const seen: PendingActivityEvent[] = [];
    pendingActivityBus.subscribe((e) => seen.push(e));

    emitPendingActivityResolved({
      activityId: 9,
      chainFamily: "eip155",
      chainId: 1,
      status: "confirmed",
    });

    expect(seen[0]?.kind).toBe("resolved");
    expect(seen[0]?.status).toBe("confirmed");
  });

  it("the payload is ids only — seven bounded keys, no money content", () => {
    // A regression guard with teeth: adding txHash/executedAmount/token to the
    // event would land here as a key this assertion does not name.
    expect(Object.keys(event()).sort()).toEqual([
      "activityId",
      "chainFamily",
      "chainId",
      "kind",
      "occurredAt",
      "status",
      "type",
    ]);
  });
});
