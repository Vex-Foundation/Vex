/**
 * The `aborted` terminal delta — a REAL end-of-stream signal.
 *
 * Every other way a stream ends is followed by a `transcriptAppend` that tells
 * the renderer its live preview is now redundant. An abort persists no
 * assistant row, so that signal never comes and the preview survives until the
 * orphan idle timer.
 *
 * The tempting substitute is the control event's `leaseActive:false` — and it
 * is WRONG: that fires on every normal chat completion too, so clearing on it
 * erases a live preview before the assistant row has been refetched, which is
 * the very gap the clear was meant to close. Hence a delta on the stream's own
 * chain, correlated by `streamId`.
 */

import { describe, it, expect } from "vitest";
import {
  toStreamAbortedEvent,
  toStreamDeltaEvent,
  STREAM_DELTA_EVENT_TYPE,
} from "../../../../vex-agent/engine/events/stream-bus.js";

const SESSION = "00000000-0000-4000-8000-00000000000a";

describe("toStreamAbortedEvent", () => {
  it("is a terminal delta on the SAME stream, bounded to its discriminant", () => {
    const event = toStreamAbortedEvent(SESSION, "s1", 4);
    expect(event.type).toBe(STREAM_DELTA_EVENT_TYPE);
    expect(event.sessionId).toBe(SESSION);
    expect(event.streamId).toBe("s1");
    expect(event.deltaType).toBe("aborted");
    // No reason string, no provider text — a consumer needs to know THIS
    // stream ended, not why.
    expect(event.delta).toEqual({ kind: "aborted" });
  });

  it("continues the stream's monotonic sequence rather than restarting it", () => {
    // The turn runner emits it at `lastSequence + 1`, so ordering against the
    // deltas of the same stream stays well-defined.
    const last = toStreamDeltaEvent(SESSION, "s1", 3, {
      type: "content",
      text: "half a sen",
    });
    const aborted = toStreamAbortedEvent(SESSION, "s1", last.sequence + 1);
    expect(aborted.sequence).toBe(4);
  });

  it("carries a distinct streamId per turn so a consumer cannot clear a newer stream", () => {
    const first = toStreamAbortedEvent(SESSION, "s1", 1);
    const second = toStreamAbortedEvent(SESSION, "s2", 1);
    expect(first.streamId).not.toBe(second.streamId);
  });
});

describe("emit-site wiring", () => {
  it("the TURN LOOP owns the emit, gated on nothing being persisted", async () => {
    // Source-level pin on WHERE the decision lives. It cannot live in
    // `turn.ts` (at stream exit): whether an aborted stream ends with a
    // persisted `chat_stopped` row is decided by the loop AFTERWARDS, and a
    // persisted row brings its own `transcriptAppend` that retires the
    // preview. Emitting at stream exit cleared the preview before that row
    // arrived — the swap gap, reopened on the stop-with-partial-content path.
    const { readFileSync } = await import("node:fs");
    const turn = readFileSync(
      new URL("../../../../vex-agent/engine/core/turn.ts", import.meta.url),
      "utf8",
    );
    expect(turn).not.toContain("toStreamAbortedEvent");

    const loop = readFileSync(
      new URL("../../../../vex-agent/engine/core/turn-loop.ts", import.meta.url),
      "utf8",
    );
    const abortBranch = loop.slice(loop.indexOf("if (turnResult.inferenceAborted) {"));
    // The emit sits in the ELSE of the content check — i.e. only when nothing
    // was persisted for this stream.
    const contentCheck = abortBranch.indexOf("if (turnResult.content) {");
    const elseBranch = abortBranch.indexOf("} else {", contentCheck);
    const emit = abortBranch.indexOf("toStreamAbortedEvent(", contentCheck);
    expect(contentCheck).toBeGreaterThanOrEqual(0);
    expect(emit).toBeGreaterThan(elseBranch);
  });
});
