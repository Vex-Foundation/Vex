/**
 * Runtime measurement inside a tool batch: one `tool_dispatch_timings` row per
 * call that actually dispatched, recorded in the background.
 *
 * What is pinned here:
 *   - one row per dispatched call, with the outcome taken from the result's
 *     success flag (or `error` when the dispatch threw - rethrown unchanged);
 *   - calls that never dispatched (Stop, deadline, approval break) get no row;
 *   - the prepared-action follow-up's confirm dispatch gets its own row;
 *   - without `telemetry` nothing is recorded and the batch behaves identically;
 *   - a row never carries the call's arguments or its result content.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolDispatchTimingRecord } from "@vex-agent/db/repos/runtime-timings.js";
import type { EngineContext } from "@vex-agent/engine/types/engine-context.js";

import { requireValue } from "../../../helpers/require-value.js";

const dispatchTool = vi.fn();
const persistBatchTranscript = vi.fn().mockResolvedValue(undefined);
const enqueueApprovalIntent = vi.fn();
const insertToolDispatchTiming = vi
  .fn<(record: ToolDispatchTimingRecord) => Promise<void>>()
  .mockResolvedValue(undefined);
const recordInBackground = vi.fn(
  (_label: string, write: () => Promise<void>): void => {
    void write();
  },
);

vi.mock("@vex-agent/db/repos/runtime-timings.js", () => ({
  insertToolDispatchTiming: (record: ToolDispatchTimingRecord) =>
    insertToolDispatchTiming(record),
  recordInBackground: (label: string, write: () => Promise<void>) =>
    recordInBackground(label, write),
}));
vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...args: unknown[]) => dispatchTool(...args),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/execute.js", () => ({
  buildToolContext: (context: Record<string, unknown>) => ({
    ...context,
    approved: false,
    contextUsageBand: "normal",
  }),
}));
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/approval-stop.js", () => ({
  assertApprovalActionKind: (result: { actionKind?: string }) => {
    if (!result.actionKind) throw new Error("missing actionKind");
    return result.actionKind;
  },
  enqueueApprovalIntent: (...args: unknown[]) => enqueueApprovalIntent(...args),
}));
// Only the DB write is stubbed - the real synthetic outputs and the real
// `mapBatchOutcome` stay in play.
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", async (
  importOriginal,
) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);

const TELEMETRY = { turnRunId: "turn-run-1", iteration: 3 } as const;
const SECRET_ARG = "0xsecret-recipient-address";
const SECRET_OUTPUT = "result body with amount twelve-thousand";

function context(permission: "restricted" | "full" = "full"): EngineContext {
  return {
    sessionId: "session-1",
    sessionKind: "agent",
    sessionPermission: permission,
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    loadedDocuments: new Map(),
    walletPolicy: { kind: "none" },
  };
}

function toolCalls(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `call-${i}`,
    name: `tool_${i}`,
    arguments: { to: SECRET_ARG },
  }));
}

async function runBatch(args: {
  telemetry?: typeof TELEMETRY;
  abortSignal?: AbortSignal;
  deadlines?: { turnTimeoutAtMs: number; missionDeadlineAtMs: number | null };
  calls?: ReturnType<typeof toolCalls>;
  permission?: "restricted" | "full";
}) {
  return processTurnToolBatch({
    context: context(args.permission),
    turnResult: {
      content: null,
      reasoning: null,
      toolCalls: args.calls ?? toolCalls(3),
    },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 100_000,
    lastTextSoFar: null,
    ...(args.telemetry !== undefined ? { telemetry: args.telemetry } : {}),
    ...(args.abortSignal !== undefined ? { abortSignal: args.abortSignal } : {}),
    ...(args.deadlines !== undefined ? { deadlines: args.deadlines } : {}),
  });
}

function rows(): ToolDispatchTimingRecord[] {
  return insertToolDispatchTiming.mock.calls.map((call) => call[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  persistBatchTranscript.mockResolvedValue(undefined);
  insertToolDispatchTiming.mockResolvedValue(undefined);
  dispatchTool.mockResolvedValue({ success: true, output: SECRET_OUTPUT });
});

describe("processTurnToolBatch - tool dispatch timing", () => {
  it("records one row per dispatched call with the result's outcome", async () => {
    dispatchTool
      .mockResolvedValueOnce({ success: true, output: SECRET_OUTPUT, actionKind: "read" })
      .mockResolvedValueOnce({ success: false, output: SECRET_OUTPUT })
      .mockResolvedValueOnce({ success: true, output: SECRET_OUTPUT });

    const outcome = await runBatch({ telemetry: TELEMETRY });

    expect(outcome.kind).toBe("normal_complete");
    expect(recordInBackground).toHaveBeenCalledTimes(3);
    expect(rows().map((r) => [r.toolCallId, r.toolName, r.outcome, r.actionKind]))
      .toEqual([
        ["call-0", "tool_0", "success", "read"],
        ["call-1", "tool_1", "failure", null],
        ["call-2", "tool_2", "success", null],
      ]);
    for (const row of rows()) {
      expect(row).toMatchObject({
        sessionId: "session-1",
        turnRunId: "turn-run-1",
        iteration: 3,
      });
      expect(row.startedAt).toBeInstanceOf(Date);
      expect(row.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records `error` for a dispatch that throws and rethrows it unchanged", async () => {
    const boom = new Error("dispatcher exploded");
    dispatchTool.mockRejectedValueOnce(boom);

    await expect(runBatch({ telemetry: TELEMETRY })).rejects.toBe(boom);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      toolCallId: "call-0",
      toolName: "tool_0",
      outcome: "error",
      actionKind: null,
    });
  });

  it("records no row for calls drained by an operator Stop before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();

    await runBatch({ telemetry: TELEMETRY, abortSignal: controller.signal });

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(recordInBackground).not.toHaveBeenCalled();
  });

  it("records only the in-flight call when a Stop lands during it", async () => {
    const controller = new AbortController();
    dispatchTool.mockImplementationOnce(async () => {
      controller.abort();
      return { success: true, output: SECRET_OUTPUT };
    });

    const outcome = await runBatch({
      telemetry: TELEMETRY,
      abortSignal: controller.signal,
    });

    expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
    expect(rows().map((r) => r.toolCallId)).toEqual(["call-0"]);
  });

  it("records no row for calls drained by an expired deadline", async () => {
    await runBatch({
      telemetry: TELEMETRY,
      deadlines: { turnTimeoutAtMs: Date.now() - 1, missionDeadlineAtMs: null },
    });

    expect(dispatchTool).not.toHaveBeenCalled();
    expect(recordInBackground).not.toHaveBeenCalled();
  });

  it("times the approval-gated call but never the calls after the approval break", async () => {
    dispatchTool.mockResolvedValueOnce({
      success: true,
      output: SECRET_OUTPUT,
      pendingApproval: true,
      actionKind: "user_wallet_broadcast",
    });
    enqueueApprovalIntent.mockResolvedValueOnce({
      kind: "enqueued",
      approvalId: "approval-1",
    });

    const outcome = await runBatch({ telemetry: TELEMETRY, permission: "restricted" });

    expect(outcome.kind).toBe("approval_break");
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      toolCallId: "call-0",
      outcome: "success",
      actionKind: "user_wallet_broadcast",
    });
  });

  it("times the prepared-action follow-up's confirm dispatch as its own row", async () => {
    dispatchTool
      .mockResolvedValueOnce({
        success: true,
        output: "prepared",
        actionKind: "approval_prepare",
        preparedActionFollowUp: {
          toolName: "WalletSendConfirm",
          args: {
            walletFamily: "solana",
            intentId: "intent-00000000-0000-4000-8000-000000000001",
          },
          expiresAt: "2030-01-01T00:00:00.000Z",
          approvalPreview: {
            toolName: "WalletSendConfirm",
            criticalArgs: {
              network: "solana",
              chain: null,
              to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
              amount: "32.813008",
              token: "ANSEM",
            },
          },
        },
      })
      .mockResolvedValueOnce({ success: true, output: "transfer confirmed" });

    const outcome = await runBatch({
      telemetry: TELEMETRY,
      calls: [{ id: "prepare-call", name: "WalletSendPrepare", arguments: { to: SECRET_ARG } }],
    });

    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 2 });
    expect(rows().map((r) => [r.toolName, r.outcome])).toEqual([
      ["WalletSendPrepare", "success"],
      ["WalletSendConfirm", "success"],
    ]);
    const followUp = requireValue(rows()[1]);
    expect(followUp.toolCallId).toMatch(/^prepared-follow-up-/);
    expect(followUp.iteration).toBe(3);
  });

  it("records nothing and behaves identically when telemetry is absent", async () => {
    const results = [
      { success: true, output: SECRET_OUTPUT, actionKind: "read" },
      { success: false, output: SECRET_OUTPUT },
      { success: true, output: SECRET_OUTPUT },
    ];
    for (const r of results) dispatchTool.mockResolvedValueOnce(r);
    const withTelemetry = await runBatch({ telemetry: TELEMETRY });
    const persistedWith = requireValue(persistBatchTranscript.mock.calls[0])[0];

    vi.clearAllMocks();
    persistBatchTranscript.mockResolvedValue(undefined);
    for (const r of results) dispatchTool.mockResolvedValueOnce(r);
    const without = await runBatch({});
    const persistedWithout = requireValue(persistBatchTranscript.mock.calls[0])[0];

    expect(recordInBackground).not.toHaveBeenCalled();
    expect(insertToolDispatchTiming).not.toHaveBeenCalled();
    expect(without).toEqual(withTelemetry);
    expect(persistedWithout).toEqual(persistedWith);
    expect(dispatchTool).toHaveBeenCalledTimes(3);
  });

  it("never puts call arguments or result content in a row", async () => {
    dispatchTool.mockResolvedValueOnce({
      success: true,
      output: SECRET_OUTPUT,
      data: { to: SECRET_ARG, amount: "secret-amount" },
      actionKind: "read",
    });

    await runBatch({ telemetry: TELEMETRY, calls: toolCalls(1) });

    expect(rows()).toHaveLength(1);
    const row = requireValue(rows()[0]);
    expect(Object.keys(row).sort()).toEqual([
      "actionKind",
      "durationMs",
      "iteration",
      "outcome",
      "sessionId",
      "startedAt",
      "toolCallId",
      "toolName",
      "turnRunId",
    ]);
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(SECRET_ARG);
    expect(serialised).not.toContain(SECRET_OUTPUT);
    expect(serialised).not.toContain("secret-amount");
  });
});
