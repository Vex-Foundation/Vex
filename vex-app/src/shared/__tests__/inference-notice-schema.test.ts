/**
 * The bridge's strict schema for `EV.engine.inferenceNotice` accepts the
 * foreign withdrawal notice the engine emits and refuses an extra field
 * (the bridge drops what fails, so a widened payload never reaches a window).
 */

import { describe, expect, it } from "vitest";
import { inferenceNoticeEventSchema } from "../schemas/inference-notice.js";

const NOTICE = {
  type: "engine.inference.notice",
  kind: "vex_inference_foreign_withdrawal",
  sessionId: "session-1",
  missionRunId: null,
  provider: "vexcloud",
  withdrawalId: "wd_foreign",
  amountWei: "6000000000000000000000",
  destination: "0x2222222222222222222222222222222222222222",
  releaseAt: "2026-10-22T00:00:00.000Z",
  occurredAt: "2026-10-21T12:00:00.000Z",
} as const;

describe("the foreign withdrawal notice on the wire", () => {
  it("parses the engine's shape", () => {
    expect(inferenceNoticeEventSchema.safeParse(NOTICE).success).toBe(true);
  });

  it("refuses an extra field and a malformed amount", () => {
    expect(inferenceNoticeEventSchema.safeParse({ ...NOTICE, bearer: "x" }).success).toBe(false);
    expect(inferenceNoticeEventSchema.safeParse({ ...NOTICE, amountWei: "6000.5" }).success).toBe(false);
  });
});
