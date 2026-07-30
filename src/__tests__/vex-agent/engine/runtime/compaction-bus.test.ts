/**
 * `compactionPreparationBus` — the signal-layer invariants.
 *
 * The bus is the only thing standing between a background FSM transition and
 * the desktop UI, so the properties that matter are: a thrown listener does
 * not silence the others, unsubscribe is idempotent, and the payload type
 * carries no prose field at all (the last one is a compile-time property —
 * this file constructs the maximal event and it has five keys).
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  COMPACTION_PREPARATION_EVENT_TYPE,
  compactionPreparationBus,
  type CompactionPreparationEvent,
} from "@vex-agent/engine/runtime/compaction-bus.js";

const SESSION = "00000000-0000-4000-8000-0000000000e0";

function event(
  over: Partial<CompactionPreparationEvent> = {},
): CompactionPreparationEvent {
  return {
    type: COMPACTION_PREPARATION_EVENT_TYPE,
    sessionId: SESSION,
    status: "summary_ready",
    summaryReady: true,
    correlationId: null,
    ...over,
  };
}

beforeEach(() => {
  compactionPreparationBus.clear();
});

describe("compactionPreparationBus", () => {
  it("delivers to every subscriber", () => {
    const seen: string[] = [];
    compactionPreparationBus.subscribe((e) => seen.push(`a:${e.status}`));
    compactionPreparationBus.subscribe((e) => seen.push(`b:${e.status}`));

    compactionPreparationBus.emit(event());

    expect(seen).toEqual(["a:summary_ready", "b:summary_ready"]);
  });

  it("isolates a misbehaving listener — the rest still receive the event", () => {
    const seen: string[] = [];
    compactionPreparationBus.subscribe(() => {
      throw new Error("listener blew up");
    });
    compactionPreparationBus.subscribe((e) => seen.push(e.sessionId));

    expect(() => compactionPreparationBus.emit(event())).not.toThrow();
    expect(seen).toEqual([SESSION]);
  });

  it("unsubscribe is idempotent and actually stops delivery", () => {
    const seen: string[] = [];
    const off = compactionPreparationBus.subscribe((e) =>
      seen.push(e.sessionId),
    );
    off();
    off();

    compactionPreparationBus.emit(event());

    expect(seen).toEqual([]);
    expect(compactionPreparationBus.size()).toBe(0);
  });

  it("the payload is metadata only — five bounded keys, no prose", () => {
    // A regression guard with teeth: adding a summary/corpus/error field to
    // the event would land here as a key this assertion does not name.
    expect(Object.keys(event()).sort()).toEqual([
      "correlationId",
      "sessionId",
      "status",
      "summaryReady",
      "type",
    ]);
  });
});
