/**
 * The engine notice for a cooling Vex Inference withdrawal this app did not
 * start (`emitVexInferenceForeignWithdrawalNotice`): carried to the session
 * that last ran Vex Inference, as the low-balance notice is, and only logged
 * when no session has. Bounded fields only (id, raw wei, address, time).
 */

import { describe, expect, it } from "vitest";

import {
  emitVexInferenceForeignWithdrawalNotice,
  InferenceNoticeBus,
  noteVexInferenceTurn,
  resetVexInferenceTurnForTests,
  type InferenceNoticeEvent,
} from "@vex-agent/inference/inference-notice-bus.js";

const INPUT = {
  withdrawalId: "wd_foreign",
  amountWei: "6000000000000000000000",
  destination: "0x2222222222222222222222222222222222222222",
  releaseAt: "2026-10-22T00:00:00.000Z",
};

describe("the foreign withdrawal notice", () => {
  it("without a Vex Inference session it is only logged", () => {
    resetVexInferenceTurnForTests();
    const bus = new InferenceNoticeBus();
    const seen: InferenceNoticeEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    expect(emitVexInferenceForeignWithdrawalNotice(INPUT, bus)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("goes to the session that last ran Vex Inference, with the withdrawal's facts only", () => {
    resetVexInferenceTurnForTests();
    noteVexInferenceTurn("session-1", null);
    const bus = new InferenceNoticeBus();
    const seen: InferenceNoticeEvent[] = [];
    bus.subscribe((event) => seen.push(event));
    expect(emitVexInferenceForeignWithdrawalNotice(INPUT, bus)).toBe(true);
    expect(seen).toEqual([
      {
        type: "engine.inference.notice",
        kind: "vex_inference_foreign_withdrawal",
        sessionId: "session-1",
        missionRunId: null,
        provider: "vexcloud",
        ...INPUT,
        occurredAt: expect.any(String),
      },
    ]);
    resetVexInferenceTurnForTests();
  });
});
