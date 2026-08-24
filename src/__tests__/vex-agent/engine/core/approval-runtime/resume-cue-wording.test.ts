/**
 * Approval resume cue — the wording must never outrun the evidence.
 *
 * This is a prompt-contract test, and the rules/90 money-path discipline is
 * the reason it exists: the ONE state that earns "the transaction executed" is
 * a durably recorded `approved` + `succeeded` pair. `indeterminate` — the
 * honest terminal state for a dispatch nobody could prove — must never get it,
 * because telling the agent a transaction happened when it may not have is how
 * a duplicate on-chain action gets authored.
 *
 * `selectResumeCue` is exercised directly (not re-implemented here): the test
 * asserts the wording the engine actually chooses for a given durable row.
 */

import { describe, it, expect } from "vitest";

const { selectResumeCue } = await import(
  "../../../../../vex-agent/engine/core/approval-runtime/resume-cue.js"
);
const { APPROVAL_RESOLVED_CUE, APPROVAL_RESOLVED_EXECUTED_CUE } = await import(
  "../../../../../vex-agent/engine/core/approval-runtime/helpers.js"
);

describe("selectResumeCue", () => {
  it("claims execution ONLY for a durable approved + succeeded pair", () => {
    expect(
      selectResumeCue({ decision: "approved", executionStatus: "succeeded" }),
    ).toBe(APPROVAL_RESOLVED_EXECUTED_CUE);
  });

  it("the executed cue states execution and points at verification", () => {
    expect(APPROVAL_RESOLVED_EXECUTED_CUE).toContain("executed successfully");
    expect(APPROVAL_RESOLVED_EXECUTED_CUE).toContain("do not repeat it");
    expect(APPROVAL_RESOLVED_EXECUTED_CUE).toContain("AgentScan");
  });

  it("the neutral cue never claims the action ran", () => {
    expect(APPROVAL_RESOLVED_CUE).not.toMatch(/executed|succeeded|transaction/i);
  });

  it.each([
    ["indeterminate dispatch", { decision: "approved", executionStatus: "indeterminate" }],
    ["failed dispatch", { decision: "approved", executionStatus: "failed" }],
    ["still dispatching", { decision: "approved", executionStatus: "dispatching" }],
    ["never dispatched", { decision: "approved", executionStatus: "not_started" }],
    ["rejected", { decision: "rejected", executionStatus: "not_started" }],
    ["rejected with stop", { decision: "rejected_stop", executionStatus: "not_started" }],
    ["undecided", { decision: null, executionStatus: "not_started" }],
  ])("falls back to the neutral cue: %s", (_label, lifecycle) => {
    expect(selectResumeCue(lifecycle)).toBe(APPROVAL_RESOLVED_CUE);
  });

  it("falls back to the neutral cue when the row is missing", () => {
    expect(selectResumeCue(null)).toBe(APPROVAL_RESOLVED_CUE);
  });
});
