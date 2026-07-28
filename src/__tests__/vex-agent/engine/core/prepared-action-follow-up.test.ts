import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchTool = vi.fn();
const persistBatchTranscript = vi.fn().mockResolvedValue(undefined);
const enqueueApprovalIntent = vi.fn().mockResolvedValue("approval-1");

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
vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", () => ({
  BATCH_ABORTED_BY_COMPACT_OUTPUT: "aborted",
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
  mapBatchOutcome: (args: {
    batchStopReason: string | null;
    approvalId: string | null;
    toolCallsExecuted: number;
    lastText: string | null;
  }) => args.batchStopReason === "approval_required"
    ? {
        kind: "approval_break",
        pendingApprovalId: args.approvalId,
        toolCallsExecuted: args.toolCallsExecuted,
        lastText: args.lastText,
      }
    : args.batchStopReason
      ? {
          kind: "engine_stop",
          stopReason: args.batchStopReason,
          text: args.lastText,
          toolCallsExecuted: args.toolCallsExecuted,
          lastText: args.lastText,
        }
      : {
        kind: "normal_complete",
        toolCallsExecuted: args.toolCallsExecuted,
        lastText: args.lastText,
      },
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);

const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const trustedPreview = {
  toolName: "wallet_send_confirm",
  criticalArgs: {
    network: "solana",
    chain: null,
    to: "3SnLmaqoEczS2ft7RLQ1BRhtsLuAauWnx9K7pDjSRQrp",
    amount: "32.813008",
    token: "ANSEM",
  },
};

function prepareResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    output: "prepared",
    actionKind: "approval_prepare",
    preparedActionFollowUp: {
      toolName: "wallet_send_confirm",
      args: { network: "solana", intentId: INTENT_ID },
      expiresAt: EXPIRES_AT,
      approvalPreview: trustedPreview,
    },
    ...overrides,
  };
}

function context(permission: "restricted" | "full") {
  return {
    sessionId: "session-1",
    sessionKind: "agent",
    sessionPermission: permission,
    missionId: null,
    missionRunId: null,
    loadedDocuments: new Map(),
    walletPolicy: { kind: "none" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function run(
  permission: "restricted" | "full",
  controls: { abortSignal?: AbortSignal } = {},
) {
  return processTurnToolBatch({
    context: context(permission),
    turnResult: {
      content: "Preparing transfer.",
      toolCalls: [
        {
          id: "prepare-call",
          name: "wallet_send_prepare",
          arguments: {
            network: "solana",
            to: "model-recipient-must-not-feed-preview",
            amount: "999999",
          },
        },
      ],
    },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 128_000,
    lastTextSoFar: null,
    ...controls,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enqueueApprovalIntent.mockResolvedValue("approval-1");
  persistBatchTranscript.mockResolvedValue(undefined);
});

describe("prepared-action follow-up handoff", () => {
  it("restricted sessions persist prepare, synthesize confirm, and immediately enqueue its trusted preview", async () => {
    dispatchTool
      .mockResolvedValueOnce(prepareResult())
      .mockResolvedValueOnce({
        success: false,
        output: "approval required",
        pendingApproval: true,
        actionKind: "user_wallet_broadcast",
      });

    const outcome = await run("restricted");
    expect(outcome).toMatchObject({
      kind: "approval_break",
      pendingApprovalId: "approval-1",
      toolCallsExecuted: 2,
    });
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(dispatchTool.mock.calls[1]![0]).toMatchObject({
      name: "wallet_send_confirm",
      args: { network: "solana", intentId: INTENT_ID },
    });
    expect(enqueueApprovalIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedPreview,
        trustedExpiresAt: EXPIRES_AT,
        toolCall: expect.objectContaining({ name: "wallet_send_confirm" }),
      }),
    );
    expect(persistBatchTranscript).toHaveBeenCalledTimes(2);
    expect(persistBatchTranscript.mock.calls[0]![0]).toMatchObject({
      content: "Preparing transfer.",
      executedCalls: [expect.objectContaining({ name: "wallet_send_prepare" })],
      executedResults: [expect.objectContaining({ output: "prepared" })],
    });
    // Second persist is the synthetic confirm call — stamped system-originated
    // so an auditor can never mistake it for model output (see turn.ts
    // `saveAssistantMessage` provenance stamp + transcript-provenance test).
    expect(persistBatchTranscript.mock.calls[1]![0]).toMatchObject({
      content: null,
      executedCalls: [expect.objectContaining({ name: "wallet_send_confirm" })],
      executedResults: [],
      systemOriginated: true,
    });
  });

  it("full-permission sessions execute confirm immediately and persist its paired result", async () => {
    dispatchTool
      .mockResolvedValueOnce(prepareResult())
      .mockResolvedValueOnce({ success: true, output: "transfer confirmed" });

    const outcome = await run("full");
    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 2 });
    expect(enqueueApprovalIntent).not.toHaveBeenCalled();
    expect(persistBatchTranscript.mock.calls[1]![0]).toMatchObject({
      content: null,
      executedCalls: [expect.objectContaining({ name: "wallet_send_confirm" })],
      executedResults: [
        expect.objectContaining({ output: "transfer confirmed", success: true }),
      ],
      systemOriginated: true,
    });
  });

  it("does not synthesize confirm after operator Stop wins the handoff boundary", async () => {
    const controller = new AbortController();
    dispatchTool.mockImplementationOnce(async () => {
      controller.abort();
      return prepareResult();
    });

    const outcome = await run("full", { abortSignal: controller.signal });

    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      kind: "engine_stop",
      stopReason: "user_stopped",
      toolCallsExecuted: 1,
    });
    expect(persistBatchTranscript).toHaveBeenCalledOnce();
    expect(persistBatchTranscript).toHaveBeenCalledWith(
      expect.objectContaining({
        executedCalls: [expect.objectContaining({ name: "wallet_send_prepare" })],
      }),
    );
  });

  it.each(["restricted", "full"] as const)(
    "hands off validated EVM transfers in %s sessions",
    async (permission) => {
      const evmPreview = {
        toolName: "wallet_send_confirm",
        criticalArgs: {
          network: "eip155",
          chain: "base",
          to: "0xfedcba0987654321fedcba0987654321fedcba09",
          amount: "1.5",
          token: null,
        },
      };
      dispatchTool
        .mockResolvedValueOnce(
          prepareResult({
            preparedActionFollowUp: {
              toolName: "wallet_send_confirm",
              args: { network: "eip155", intentId: INTENT_ID },
              expiresAt: EXPIRES_AT,
              approvalPreview: evmPreview,
            },
          }),
        )
        .mockResolvedValueOnce(
          permission === "restricted"
            ? {
                success: false,
                output: "approval required",
                pendingApproval: true,
                actionKind: "user_wallet_broadcast",
              }
            : { success: true, output: "transfer confirmed" },
        );

      const outcome = await run(permission);
      expect(dispatchTool.mock.calls[1]![0]).toMatchObject({
        name: "wallet_send_confirm",
        args: { network: "eip155", intentId: INTENT_ID },
      });
      if (permission === "restricted") {
        expect(outcome.kind).toBe("approval_break");
        expect(enqueueApprovalIntent).toHaveBeenCalledWith(
          expect.objectContaining({ trustedPreview: evmPreview }),
        );
      } else {
        expect(outcome.kind).toBe("normal_complete");
        expect(enqueueApprovalIntent).not.toHaveBeenCalled();
      }
    },
  );

  it("rejects unknown mappings without dispatching a second tool", async () => {
    dispatchTool.mockResolvedValueOnce(
      prepareResult({
        preparedActionFollowUp: {
          ...prepareResult().preparedActionFollowUp,
          toolName: "swap",
        },
      }),
    );

    const outcome = await run("restricted");
    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 1 });
    expect(dispatchTool).toHaveBeenCalledOnce();
    expect(persistBatchTranscript.mock.calls[0]![0]).toMatchObject({
      executedResults: [
        expect.objectContaining({
          success: false,
          output: expect.stringContaining("rejected by the trusted registry"),
        }),
      ],
    });
  });

  it("rejects recursive chains after one follow-up and never dispatches a third tool", async () => {
    dispatchTool
      .mockResolvedValueOnce(prepareResult())
      .mockResolvedValueOnce(prepareResult());

    const outcome = await run("full");
    expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 2 });
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(persistBatchTranscript.mock.calls[1]![0]).toMatchObject({
      executedResults: [
        expect.objectContaining({
          success: false,
          output: expect.stringContaining("Recursive"),
        }),
      ],
    });
  });
});
