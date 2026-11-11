/**
 * THE FLOW RHYTHM (`flowRhythm.ts`; VEX Cloud's spec 10.10 `layoutRows`):
 * the later row owns the gap, the larger edge wins, hidden rows add none.
 */

import { describe, expect, it } from "vitest";
import { FLOW_GAP, flowRhythm, type FlowFacts } from "../../SessionTranscript/flowRhythm.js";
import type { TranscriptEntry } from "../../transcriptRowModel.js";

const ISO = "2026-11-09T10:00:00.000Z";

const user = (id: number): TranscriptEntry => ({ id, variant: "user", label: null, content: "ask", createdAt: ISO });
const answer = (id: number, reasoning: string | null = null): TranscriptEntry => ({
  id,
  variant: "assistant",
  label: null,
  content: "answer",
  createdAt: ISO,
  reasoning,
});
const notice = (id: number): TranscriptEntry => ({ id, variant: "notice", label: null, content: "n", createdAt: ISO });
const call = (id: number, content = ""): TranscriptEntry => ({
  id,
  variant: "tool",
  toolKind: "call",
  label: null,
  content,
  createdAt: ISO,
  reasoning: null,
  toolActs: [{ toolCallId: `c${String(id)}`, toolName: "wallet_balances", toolArgs: null, output: null }],
});

function facts(overrides: Partial<FlowFacts> = {}): FlowFacts {
  return {
    headed: () => false,
    shut: () => false,
    startsDay: () => false,
    continues: () => false,
    ...overrides,
  };
}

describe("flowRhythm", () => {
  it("names Cloud's three gaps", () => {
    expect(FLOW_GAP).toEqual({ row: 6, text: 12, fold: 16 });
  });

  it("gives the first row no gap, 6 between messages and lines, 12 around text", () => {
    const flow = flowRhythm([user(1), notice(2), answer(3), user(4)], facts());
    expect(flow.map((row) => row.gap)).toEqual([0, 6, 12, 12]);
  });

  it("stands a trace card 6 from a message, 12 from text, and 16 around a folded head", () => {
    expect(flowRhythm([user(1), call(2)], facts()).map((r) => r.gap)).toEqual([0, 6]);
    expect(flowRhythm([answer(1), call(2)], facts()).map((r) => r.gap)).toEqual([0, 12]);
    const headed = facts({ headed: (row) => row.id === 2, shut: (row) => row.id !== 1 });
    expect(flowRhythm([user(1), call(2), answer(3)], headed).map((r) => r.gap)).toEqual([0, 16, 16]);
  });

  it("hides a folded row of steps and lets the edges around it meet", () => {
    const shut = facts({ headed: (row) => row.id === 2, shut: (row) => row.id !== 1 });
    const flow = flowRhythm([user(1), answer(2, "thought"), call(3), user(4)], shut);
    expect(flow[2]).toEqual({ dayGap: null, gap: 0, hidden: true });
    // The answer's text edge (12) meets the next message's 6.
    expect(flow[3]?.gap).toBe(12);
  });

  it("joins a row that continues the steps above, and puts the day line in the flow", () => {
    const joined = flowRhythm([call(1), call(2)], facts({ continues: (row) => row.id === 2 }));
    expect(joined.map((r) => r.gap)).toEqual([0, 0]);
    const days = flowRhythm([answer(1), user(2)], facts({ startsDay: (row) => row.id === 2 }));
    expect(days[1]).toEqual({ dayGap: 12, gap: 6, hidden: false });
  });

  it("keeps a call row's prose and its steps one row: text on top, steps below", () => {
    const flow = flowRhythm([user(1), call(2, "Checking."), user(3)], facts());
    // Text first (12 under the message), steps last (the next message 6 under).
    expect(flow.map((r) => r.gap)).toEqual([0, 12, 6]);
  });
});
