/**
 * Channel constant format check.
 *
 * Catches the lead-dev gate from puzzle 01 §Lead-dev: every channel
 * string must follow `vex:<domain>:<action>` (or `vex:event:...`,
 * `vex:stream:...`, or the literal `vex:cancel`). Adding a new
 * `CH.foo.bar` constant with the wrong shape fails this test before
 * the renderer sees it.
 */

import { describe, expect, it } from "vitest";
import { CH, EV } from "../channels.js";

// Domain segment is camelCase (single lowercase word for most domains;
// `longMemory` introduced the two-word form in the S9 rewire).
const REQUEST_PATTERN = /^vex:[a-z][a-zA-Z]*:[a-zA-Z]+$/;
const EVENT_PATTERN = /^vex:event:[a-z]+:[a-zA-Z]+$/;

function collectStrings(group: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const value of Object.values(group)) {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "object" && value !== null) {
      out.push(...collectStrings(value as Record<string, unknown>));
    }
  }
  return out;
}

describe("CH / EV channel constants", () => {
  it("every CH.* request constant matches vex:<domain>:<action>", () => {
    const requests = collectStrings(CH).filter((c) => c !== CH.cancel);
    expect(requests.length).toBeGreaterThan(0);
    for (const channel of requests) {
      expect(channel, channel).toMatch(REQUEST_PATTERN);
    }
  });

  it("CH.cancel uses the dedicated cancellation channel", () => {
    expect(CH.cancel).toBe("vex:cancel");
  });

  it("every EV.* event constant matches vex:event:<domain>:<topic>", () => {
    const events = collectStrings(EV);
    expect(events.length).toBeGreaterThan(0);
    for (const channel of events) {
      expect(channel, channel).toMatch(EVENT_PATTERN);
    }
  });

  it("ships EV.engine.transcriptAppend with the canonical channel name", () => {
    // `setupTranscriptBridge` (in
    // `main/agent/transcript-bridge.ts`) is its publishing path. The
    // renderer subscribes through `window.vex.engine.onTranscriptAppend`,
    // which validates the payload through `transcriptAppendEventSchema`
    // before invoking the callback.
    expect(EV.engine.transcriptAppend).toBe("vex:event:engine:transcriptAppend");
    expect(EV.engine.transcriptAppend).toMatch(EVENT_PATTERN);
  });

  it("ships EV.engine.streamDelta with the canonical channel name", () => {
    // `setupStreamBridge` (in `main/agent/stream-bridge.ts`) publishes the
    // ephemeral, sanitized token/tool/usage preview here. The renderer
    // subscribes via `window.vex.engine.onStreamDelta`, which re-validates
    // through `streamDeltaEventSchema` before invoking the callback.
    expect(EV.engine.streamDelta).toBe("vex:event:engine:streamDelta");
    expect(EV.engine.streamDelta).toMatch(EVENT_PATTERN);
  });

  it("CH.messages/runtime/mission/approvals/wallets/models/usage namespaces exist", () => {
    expect(typeof CH.messages.getTail).toBe("string");
    expect(typeof CH.runtime.getState).toBe("string");
    expect(typeof CH.mission.getDraft).toBe("string");
    expect(typeof CH.approvals.listPending).toBe("string");
    expect(typeof CH.wallets.listSessionWallets).toBe("string");
    expect(typeof CH.models.listAvailable).toBe("string");
    expect(typeof CH.usage.getSessionTotals).toBe("string");
    expect(typeof CH.usage.getContextWindow).toBe("string");
    expect(typeof CH.compaction.getStatus).toBe("string");
    expect(typeof CH.compaction.listHistory).toBe("string");
    expect(typeof CH.longMemory.list).toBe("string");
    expect(typeof CH.memoryInspector.listCandidates).toBe("string");
    expect(typeof CH.memoryInspector.listDecisions).toBe("string");
    expect(typeof CH.memoryInspector.jobsSummary).toBe("string");
    expect(typeof CH.memory.listSession).toBe("string");
    expect(typeof CH.memory.getStats).toBe("string");
    expect(typeof CH.sessions.getModel).toBe("string");
    expect(CH.sessions.exportMarkdown).toBe("vex:sessions:exportMarkdown");
  });

  it("channels are unique (no duplicate values across namespaces)", () => {
    const all = [CH.cancel, ...collectStrings(CH).filter((c) => c !== CH.cancel), ...collectStrings(EV)];
    const seen = new Set<string>();
    for (const channel of all) {
      expect(seen.has(channel), `Duplicate channel: ${channel}`).toBe(false);
      seen.add(channel);
    }
  });
});
