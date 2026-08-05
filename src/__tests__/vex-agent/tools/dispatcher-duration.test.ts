/**
 * `dispatchTool` stamps `durationMs` — wall clock measured INSIDE the
 * dispatcher, so it covers routing + handler execution + in-handler retries.
 *
 * Contract pinned here:
 *  - success return carries a non-negative integer `durationMs`;
 *  - handler-thrown failure return carries one too (the failure still cost
 *    wall clock, and the transcript row should say how much);
 *  - the two early-deny gates (pressure band, plan acceptance) return WITHOUT
 *    the field — nothing was executed, so there is no duration to report and
 *    `0` would be a lie the UI would render as "took 0ms".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { makeTestContext } from "./_test-context.js";

const routeToolCall = vi.fn();
const checkPressureDeny = vi.fn();
const checkPlanAcceptanceDeny = vi.fn();

vi.mock("../../../vex-agent/tools/dispatcher/protocol-route.js", () => ({
  routeToolCall: (...args: unknown[]) => routeToolCall(...args),
}));
vi.mock("../../../vex-agent/tools/dispatcher/pressure-gate.js", () => ({
  checkPressureDeny: (...args: unknown[]) => checkPressureDeny(...args),
}));
vi.mock("../../../vex-agent/tools/dispatcher/plan-acceptance-gate.js", () => ({
  checkPlanAcceptanceDeny: (...args: unknown[]) => checkPlanAcceptanceDeny(...args),
}));
vi.mock("../../../vex-agent/tools/dispatcher/mutating-targets.js", () => ({
  dispatchTargetIsMutating: vi.fn(() => false),
}));
vi.mock("../../../vex-agent/tools/dispatcher/internal-loaders.js", () => ({
  INTERNAL_TOOL_LOADERS: {},
}));

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");

const CALL = { name: "web_research", args: { query: "x" }, toolCallId: "tc-1" };
const CONTEXT: InternalToolContext = makeTestContext({ sessionId: "s1" });

beforeEach(() => {
  vi.clearAllMocks();
  checkPressureDeny.mockReturnValue(undefined);
  checkPlanAcceptanceDeny.mockResolvedValue(undefined);
});

describe("dispatchTool durationMs", () => {
  it("stamps a non-negative integer duration on the success path", async () => {
    routeToolCall.mockResolvedValue({ success: true, output: "ok" });

    const result = await dispatchTool(CALL, CONTEXT);

    expect(result.success).toBe(true);
    expect(typeof result.durationMs).toBe("number");
    expect(Number.isInteger(result.durationMs)).toBe(true);
    expect(result.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("stamps a duration on the handler-thrown failure path", async () => {
    routeToolCall.mockRejectedValue(new Error("boom"));

    const result = await dispatchTool(CALL, CONTEXT);

    expect(result.success).toBe(false);
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs!).toBeGreaterThanOrEqual(0);
  });

  it("omits duration entirely when the pressure gate denies before execution", async () => {
    checkPressureDeny.mockReturnValue({ success: false, output: "denied by pressure" });

    const result = await dispatchTool(CALL, { ...CONTEXT, contextUsageBand: "critical" });

    expect(routeToolCall).not.toHaveBeenCalled();
    expect("durationMs" in result).toBe(false);
  });

  it("omits duration entirely when the plan-acceptance gate denies before execution", async () => {
    checkPlanAcceptanceDeny.mockResolvedValue({ success: false, output: "plan not accepted" });

    const result = await dispatchTool(CALL, CONTEXT);

    expect(routeToolCall).not.toHaveBeenCalled();
    expect("durationMs" in result).toBe(false);
  });
});
