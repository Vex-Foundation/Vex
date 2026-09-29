/**
 * Runtime measurement around a single `dispatchTool` call.
 *
 * Records one `tool_dispatch_timings` row per dispatch that actually ran, in
 * the background: the write is never awaited and can never fail the call. The
 * row carries only correlation ids, the tool NAME, the result's action kind,
 * timing and an outcome enum - never the call's arguments or its result.
 *
 * The wrapper adds no ordering of its own: the caller's Stop / deadline /
 * approval checks sit exactly where they were, and a throwing dispatch is
 * rethrown unchanged after its row is queued.
 */

import {
  insertToolDispatchTiming,
  recordInBackground,
} from "@vex-agent/db/repos/runtime-timings.js";
import type { ToolResult } from "@vex-agent/tools/types.js";

export interface ToolDispatchTelemetry {
  readonly turnRunId: string;
  readonly iteration: number;
}

export async function dispatchWithTiming(
  telemetry: ToolDispatchTelemetry | undefined,
  sessionId: string,
  call: { readonly id: string; readonly name: string },
  dispatch: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (telemetry === undefined) return dispatch();

  const startedAt = new Date();
  const startMs = performance.now();
  const record = (
    outcome: "success" | "failure" | "error",
    actionKind: string | null,
  ): void => {
    const durationMs = performance.now() - startMs;
    recordInBackground("tool_dispatch", () =>
      insertToolDispatchTiming({
        sessionId,
        turnRunId: telemetry.turnRunId,
        iteration: telemetry.iteration,
        toolCallId: call.id,
        toolName: call.name,
        actionKind,
        startedAt,
        durationMs,
        outcome,
      }),
    );
  };

  let result: ToolResult;
  try {
    result = await dispatch();
  } catch (err) {
    record("error", null);
    throw err;
  }
  record(result.success ? "success" : "failure", result.actionKind ?? null);
  return result;
}
