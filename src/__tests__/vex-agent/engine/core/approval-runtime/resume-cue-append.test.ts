/**
 * `appendApprovalResolvedCueOnce` — the cue that actually lands in the
 * transcript is chosen from the DURABLE row, under the same lock as the
 * exactly-once slot.
 *
 * Wording selection is unit-tested in `resume-cue-wording.test.ts`; this file
 * proves the append path reads the row at all, rather than defaulting to the
 * neutral text and leaving `selectResumeCue` decorative — the "test that
 * re-implements the logic under test" failure mode this repo has already paid
 * for once.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const lockResumeCueMessageIdWith = vi.fn();
const lockLifecycleRowWith = vi.fn();
const attachResumeCueMessageWith = vi.fn();
const appendEngineMessage = vi.fn();
const emitTranscriptAppend = vi.fn();

vi.mock("@vex-agent/db/repos/approval-intents.js", () => ({
  lockResumeCueMessageIdWith: (...a: unknown[]) => lockResumeCueMessageIdWith(...a),
  lockLifecycleRowWith: (...a: unknown[]) => lockLifecycleRowWith(...a),
  attachResumeCueMessageWith: (...a: unknown[]) => attachResumeCueMessageWith(...a),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (fn: (client: object) => Promise<unknown>) => fn({}),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendEngineMessage: (...a: unknown[]) => appendEngineMessage(...a),
  emitTranscriptAppend: (...a: unknown[]) => emitTranscriptAppend(...a),
  TRANSCRIPT_APPEND_EVENT_TYPE: "engine.transcript.append",
}));

const { appendApprovalResolvedCueOnce } = await import(
  "../../../../../vex-agent/engine/core/approval-runtime/resume-cue.js"
);
const { APPROVAL_RESOLVED_CUE, APPROVAL_RESOLVED_EXECUTED_CUE } = await import(
  "../../../../../vex-agent/engine/core/approval-runtime/helpers.js"
);

const CUE_ROW = {
  id: 42,
  role: "system",
  timestamp: "2026-07-29T10:00:00.000Z",
};

function appendedContent(): string {
  return String(appendEngineMessage.mock.calls[0]?.[1]);
}

describe("appendApprovalResolvedCueOnce", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockResumeCueMessageIdWith.mockResolvedValue(null);
    appendEngineMessage.mockResolvedValue(CUE_ROW);
  });

  it("appends the executed cue for a durably succeeded approval", async () => {
    lockLifecycleRowWith.mockResolvedValue({
      decision: "approved",
      executionStatus: "succeeded",
    });

    await appendApprovalResolvedCueOnce("session-1", "approval-1");

    expect(appendedContent()).toBe(APPROVAL_RESOLVED_EXECUTED_CUE);
    expect(attachResumeCueMessageWith).toHaveBeenCalledWith(
      expect.anything(),
      "approval-1",
      42,
    );
    expect(emitTranscriptAppend).toHaveBeenCalledTimes(1);
  });

  it("appends the neutral cue for an indeterminate dispatch", async () => {
    lockLifecycleRowWith.mockResolvedValue({
      decision: "approved",
      executionStatus: "indeterminate",
    });

    await appendApprovalResolvedCueOnce("session-1", "approval-1");

    expect(appendedContent()).toBe(APPROVAL_RESOLVED_CUE);
  });

  it("writes nothing when a cue is already recorded for the approval", async () => {
    lockResumeCueMessageIdWith.mockResolvedValue(7);

    await appendApprovalResolvedCueOnce("session-1", "approval-1");

    expect(appendEngineMessage).not.toHaveBeenCalled();
    expect(emitTranscriptAppend).not.toHaveBeenCalled();
  });
});
