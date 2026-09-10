import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyUniswapRevertError } from "@tools/uniswap/revert-mapping.js";
import { preSignRefusalResult } from "@vex-agent/tools/protocols/uniswap/handlers/swap/execute-failure.js";
import { captureExecution } from "@vex-agent/tools/protocols/runtime/capture.js";

const db = vi.hoisted(() => ({ complete: vi.fn(), record: vi.fn() }));
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  completeExecutionIntentWith: db.complete,
  recordExecution: db.record,
  getById: async () => ({ toolId: "uniswap.swap.execute", namespace: "uniswap" }),
}));
vi.mock("@vex-agent/db/client.js", () => ({
  withTransaction: async (callback: (client: unknown) => Promise<unknown>) => callback({}),
}));
beforeEach(() => vi.clearAllMocks());

describe("Uniswap refusal protocol_executions capture", () => {
  it.each([
    "0x8b063d7300000000000000000000000000000000000000000000000000000000000788b8000000000000000000000000000000000000000000000000000000000003c45c",
    `0x12345678${"ab".repeat(300)}`,
  ])("persists the full diagnostic on the existing intent through the real capture pipeline", async data => {
    const classification = classifyUniswapRevertError({ cause: { code: 3, data } });
    const result = preSignRefusalResult({ eventRole: "swap", classification, slippageBps: 100, executionId: 65 });
    await captureExecution("uniswap.swap.execute", "uniswap", null, {}, result, 10);
    expect(db.complete).toHaveBeenCalledOnce();
    expect(db.complete).toHaveBeenCalledWith({}, expect.objectContaining({ executionId: 65, success: false,
      result: expect.objectContaining({ status: "not_attempted", failureCode: classification.failureCode,
        failureReason: classification.failureReason, guidance: expect.any(String),
        revert: expect.objectContaining({ data, selector: data.slice(0, 10) }) }) }));
    expect(db.record).not.toHaveBeenCalled();
  });
});
