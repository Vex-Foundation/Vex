import { describe, it, expect, vi } from "vitest";

import { makeProtocolContext } from "../tools/_test-context.js";

vi.mock("@vex-agent/db/repos/executions.js", () => ({
  recordExecution: vi.fn().mockResolvedValue(1),
}));

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn().mockResolvedValue(1),
}));

const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");

describe("runtime approval gate", () => {
  it("blocks mutating tool in restricted permission → pendingApproval", async () => {
    // Use a mutating tool that is NOT prequote-gated (pendle.claim).
    // khalani.bridge + the swap executes are now prequote-gated (Stage 7/8c): with
    // no fresh quote they BLOCK at the prequote gate BEFORE the approval gate, so
    // they no longer surface `pendingApproval` here — the approval-gate behavior is
    // proven with an ungated mutating tool instead.
    const result = await executeProtocolTool(
      { toolId: "pendle.claim", params: { chain: "ethereum" } },
      makeProtocolContext(),
    );

    expect(result.success).toBe(false);
    expect(result.pendingApproval).toBe(true);
    expect(result.output).toContain("requires approval");
  });

  it("non-mutating tool passes in restricted permission", async () => {
    const result = await executeProtocolTool(
      { toolId: "khalani.tokens.search", params: { query: "USDC" } },
      makeProtocolContext(),
    );

    // Will fail at network level but NOT at approval gate
    expect(result.pendingApproval).toBeUndefined();
  });
});
