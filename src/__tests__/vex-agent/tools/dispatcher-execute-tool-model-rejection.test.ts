/**
 * A0.3 — `execute_tool` is closed to the MODEL, open to the approval resume.
 *
 * Discovered manifests are injected as real functions the model calls by name,
 * so the two-level `execute_tool` envelope is now an internal calling
 * convention with one live caller: the cold approval resume, whose stored call
 * is canonicalized to `execute_tool` so it survives a restart. That caller is
 * host-built and never carries `modelOriginated`, which is set in exactly one
 * place (`turn-loop-tool-batch/execute.ts`) and can never come from tool args.
 *
 * THE ORDERING IS A PROPERTY, not an accident: the refusal runs BEFORE the
 * plan-acceptance gate and therefore before `routeToolCall`'s mission
 * auto-retry-unsafe stamp. A call the model may not make at all must not
 * durably mark a run auto-retry-unsafe or be recorded as a plan-gate denial.
 */

import assert from "node:assert/strict";

import { describe, it, expect, vi, beforeEach } from "vitest";

const markAutoRetryUnsafe = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  markAutoRetryUnsafe: (...a: unknown[]) => markAutoRetryUnsafe(...a),
}));

const checkPlanAcceptanceDeny = vi.fn().mockResolvedValue(null);
vi.mock("@vex-agent/tools/dispatcher/plan-acceptance-gate.js", () => ({
  checkPlanAcceptanceDeny: (...a: unknown[]) => checkPlanAcceptanceDeny(...a),
}));

const executeProtocolTool = vi
  .fn()
  .mockResolvedValue({ success: true, output: "executed" });
vi.mock("@vex-agent/tools/protocols/runtime.js", () => ({
  executeProtocolTool: (...a: unknown[]) => executeProtocolTool(...a),
  discoverProtocolCapabilities: vi.fn().mockResolvedValue({ success: true, tools: [] }),
}));

const { dispatchTool } = await import("@vex-agent/tools/dispatcher.js");
const { makeTestContext } = await import("./_test-context.js");

const EXECUTE_CALL = {
  name: "execute_tool",
  args: { toolId: "dexscreener.search", params: { query: "VEX" } },
  toolCallId: "tc-1",
};

const modelContext = makeTestContext({
  modelOriginated: true,
  missionRunId: "run-1",
  planMode: true,
});
const resumedContext = makeTestContext({ approved: true, missionRunId: "run-1" });

beforeEach(() => {
  vi.clearAllMocks();
  checkPlanAcceptanceDeny.mockResolvedValue(null);
});

describe("dispatcher — model-originated execute_tool", () => {
  it("refuses it and names ToolSearch + direct calls as the way forward", async () => {
    const result = await dispatchTool(EXECUTE_CALL, modelContext);

    expect(result.success).toBe(false);
    expect(result.output).toContain("execute_tool is not callable");
    expect(result.output).toContain("ToolSearch");
    // The refusal states the CALLING CONVENTION, not a name transform: there is
    // no `.`-to-`__` derivation any more (publicName is an authored table
    // entry), so a refusal that showed one would teach the model to fabricate
    // names the catalog rejects.
    expect(result.output).toContain("no toolId, no params wrapper");
    expect(executeProtocolTool).not.toHaveBeenCalled();
  });

  it("refuses BEFORE the plan-acceptance gate and BEFORE the auto-retry-unsafe stamp", async () => {
    await dispatchTool(EXECUTE_CALL, modelContext);

    expect(checkPlanAcceptanceDeny).not.toHaveBeenCalled();
    expect(markAutoRetryUnsafe).not.toHaveBeenCalled();
  });

  it("cannot be forged from tool arguments", async () => {
    const result = await dispatchTool(
      { ...EXECUTE_CALL, args: { ...EXECUTE_CALL.args, modelOriginated: false } },
      modelContext,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("execute_tool is not callable");
  });

  it("leaves the model's DIRECT injected calls alone — only execute_tool is refused", async () => {
    const result = await dispatchTool(
      { name: "discover_tools", args: { query: "swap" }, toolCallId: "tc-2" },
      modelContext,
    );

    expect(result.output).not.toContain("execute_tool is not callable");
  });
});

describe("dispatcher — non-model execute_tool (the approval resume)", () => {
  it("still executes: the resume lane is exactly what the envelope canonicalizes to", async () => {
    const result = await dispatchTool(EXECUTE_CALL, resumedContext);

    expect(result.success).toBe(true);
    expect(executeProtocolTool).toHaveBeenCalledTimes(1);
    const [firstCall] = executeProtocolTool.mock.calls;
    assert.ok(firstCall);
    expect(firstCall[0]).toEqual({
      toolId: "dexscreener.search",
      params: { query: "VEX" },
    });
  });
});
