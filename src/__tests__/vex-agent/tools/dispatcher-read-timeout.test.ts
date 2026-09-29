/**
 * Kairos T-3: the dispatcher-level read timeout.
 *
 * Pinned here:
 *  - an allowlisted read that runs past its cap returns a typed
 *    `tool_timeout` failure at the cap, and the handler's signal is aborted;
 *  - web research uses the extended cap;
 *  - a tool NOT on the allowlist (a broadcast, an approval prepare, an unknown
 *    tool) is never wrapped: it runs to completion however long it takes;
 *  - `0` disables the cap;
 *  - an operator Stop during a wrapped read is reported as the Stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { makeTestContext } from "./_test-context.js";

const routeToolCall = vi.fn<(call: unknown, context: InternalToolContext) => Promise<ToolResult>>();

vi.mock("../../../vex-agent/tools/dispatcher/protocol-route.js", () => ({
  routeToolCall: (call: unknown, context: InternalToolContext) => routeToolCall(call, context),
}));
vi.mock("../../../vex-agent/tools/dispatcher/pressure-gate.js", () => ({
  checkPressureDeny: () => undefined,
}));
vi.mock("../../../vex-agent/tools/dispatcher/plan-acceptance-gate.js", () => ({
  checkPlanAcceptanceDeny: async () => undefined,
}));

const { dispatchTool } = await import("../../../vex-agent/tools/dispatcher.js");
const { TOOL_ABORTED_BY_USER_STOP_OUTPUT } = await import(
  "../../../vex-agent/engine/core/turn-loop-tool-batch/results.js"
);

const CONTEXT: InternalToolContext = makeTestContext({ sessionId: "s1" });

/** Resolves after `ms`, or rejects with an AbortError when the signal fires. */
function slowRead(ms: number, seen: AbortSignal[] = []) {
  return (_call: unknown, context: InternalToolContext): Promise<ToolResult> =>
    new Promise((resolve, reject) => {
      const signal = context.abortSignal;
      if (signal !== undefined) seen.push(signal);
      const timer = setTimeout(() => resolve({ success: true, output: "late answer" }), ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AGENT_TOOL_READ_TIMEOUT_MS", "50");
  vi.stubEnv("AGENT_TOOL_READ_EXTENDED_TIMEOUT_MS", "150");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dispatchTool read timeout (T-3)", () => {
  it("returns a typed tool_timeout for an allowlisted read that overruns, and aborts it", async () => {
    const seen: AbortSignal[] = [];
    routeToolCall.mockImplementation(slowRead(1_000, seen));

    const started = Date.now();
    const result = await dispatchTool(
      { name: "UnitsConvert", args: {}, toolCallId: "tc-1" },
      CONTEXT,
    );
    const elapsed = Date.now() - started;

    expect(result.success).toBe(false);
    expect(result.failure).toEqual({ kind: "tool_timeout", timeoutMs: 50 });
    expect(result.output).toContain("tool_timeout");
    expect(result.actionKind).toBe("read");
    expect(elapsed).toBeLessThan(500);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.aborted).toBe(true);
  });

  it("gives web research the extended cap", async () => {
    routeToolCall.mockImplementation(slowRead(100));

    const result = await dispatchTool(
      { name: "WebResearch", args: {}, toolCallId: "tc-1" },
      CONTEXT,
    );

    expect(result).toMatchObject({ success: true, output: "late answer" });
  });

  it("an allowlisted read that answers in time is returned unchanged", async () => {
    routeToolCall.mockResolvedValue({ success: true, output: "fast" });

    const result = await dispatchTool(
      { name: "UnitsConvert", args: {}, toolCallId: "tc-1" },
      CONTEXT,
    );

    expect(result).toMatchObject({ success: true, output: "fast" });
    expect(result.failure).toBeUndefined();
  });

  it.each(["WalletSendConfirm", "WalletSendPrepare", "SwapExecute", "ToolSearch", "SomeFutureTool"])(
    "never wraps %s: it runs to completion past the read cap",
    async (name) => {
      const seen: AbortSignal[] = [];
      routeToolCall.mockImplementation(slowRead(120, seen));

      const result = await dispatchTool({ name, args: {}, toolCallId: "tc-1" }, CONTEXT);

      expect(result).toMatchObject({ success: true, output: "late answer" });
      expect(result.failure).toBeUndefined();
      // Not wrapped: the handler never received a derived signal at all.
      expect(seen).toHaveLength(0);
    },
  );

  it("a cap of 0 disables the timeout", async () => {
    vi.stubEnv("AGENT_TOOL_READ_TIMEOUT_MS", "0");
    routeToolCall.mockImplementation(slowRead(100));

    const result = await dispatchTool(
      { name: "UnitsConvert", args: {}, toolCallId: "tc-1" },
      CONTEXT,
    );

    expect(result).toMatchObject({ success: true, output: "late answer" });
  });

  it("an operator Stop during a wrapped read is reported as the Stop, not a timeout", async () => {
    vi.stubEnv("AGENT_TOOL_READ_TIMEOUT_MS", "5000");
    routeToolCall.mockImplementation(slowRead(5_000));
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 20);

    const result = await dispatchTool(
      { name: "UnitsConvert", args: {}, toolCallId: "tc-1" },
      { ...CONTEXT, abortSignal: stop.signal },
    );

    expect(result.success).toBe(false);
    expect(result.output).toBe(TOOL_ABORTED_BY_USER_STOP_OUTPUT);
    expect(result.failure).toBeUndefined();
  });
});
