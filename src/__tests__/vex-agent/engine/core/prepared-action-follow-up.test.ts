import { createHash } from "node:crypto";
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
const APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT = "approval_skipped_by_user_stop";

vi.mock("@vex-agent/engine/core/turn-loop-tool-batch/results.js", () => ({
  BATCH_ABORTED_BY_COMPACT_OUTPUT: "aborted",
  BATCH_ABORTED_BY_USER_STOP_OUTPUT: "batch_aborted_by_user_stop",
  APPROVAL_AUTO_REJECTED_RUN_TERMINAL_OUTPUT: "approval_auto_rejected",
  APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT: "approval_skipped_by_user_stop",
  persistBatchTranscript: (...args: unknown[]) => persistBatchTranscript(...args),
  mapBatchOutcome: (args: {
    batchStopReason: string | null;
    approvalId: string | null;
    toolCallsExecuted: number;
    lastText: string | null;
  }) => {
    if (args.batchStopReason === "approval_required") {
      return {
        kind: "approval_break",
        pendingApprovalId: args.approvalId,
        toolCallsExecuted: args.toolCallsExecuted,
        lastText: args.lastText,
      };
    }
    if (args.batchStopReason !== null) {
      return {
        kind: "engine_stop",
        stopReason: args.batchStopReason,
        toolCallsExecuted: args.toolCallsExecuted,
        lastText: args.lastText,
      };
    }
    return {
      kind: "normal_complete",
      toolCallsExecuted: args.toolCallsExecuted,
      lastText: args.lastText,
    };
  },
}));

const { processTurnToolBatch } = await import(
  "../../../../vex-agent/engine/core/turn-loop-tool-batch.js"
);

const INTENT_ID = "intent-00000000-0000-4000-8000-000000000001";
const LIGHTER_INTENT_ID = "lighter-exec-00000000-0000-4000-8000-000000000001";
const LIGHTER_ONBOARDING_INTENT_ID =
  "lighter-onboard-00000000-0000-4000-8000-000000000001";
const EXPIRES_AT = "2030-01-01T00:00:00.000Z";
const LIGHTER_KEY_PUBLIC_KEY = "ab".repeat(40);
const LIGHTER_KEY_FINGERPRINT = createHash("sha256")
  .update(Buffer.from(LIGHTER_KEY_PUBLIC_KEY, "hex"))
  .digest("hex");
const trustedPreview = {
  toolName: "WalletSendConfirm",
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
      toolName: "WalletSendConfirm",
      args: { walletFamily: "solana", intentId: INTENT_ID },
      expiresAt: EXPIRES_AT,
      approvalPreview: trustedPreview,
    },
    ...overrides,
  };
}

function lighterPrepareResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    output: "lighter create prepared",
    actionKind: "approval_prepare",
    preparedActionFollowUp: {
      toolName: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId: LIGHTER_INTENT_ID },
      },
      expiresAt: EXPIRES_AT,
      approvalPreview: {
        toolName: "order.create",
        namespace: "lighter",
        criticalArgs: {
          orderSummary:
            "Buy 1 ETH at limit price 3000 (est. notional 3000) on Robinhood Chain Lighter (rhc); "
            + "good-till-time; expires 2030-01-01T00:00:00.000Z. API acceptance is not final execution.",
          marketSymbol: "ETH",
          baseAmountDisplay: "1",
          priceDisplay: "3000",
          notionalDisplay: "3000",
          orderExpiryIso: "2030-01-01T00:00:00.000Z",
          toolId: "lighter.order.create",
          intentId: LIGHTER_INTENT_ID,
          environment: "rhc",
          accountIndex: 42,
          apiKeyIndex: 7,
          marketIndex: 0,
          side: "buy",
          baseAmountInteger: "10000",
          priceInteger: "300000",
          orderType: "limit",
          timeInForce: "good-till-time",
          reduceOnly: false,
          previewId: "lighter-preview-1",
          matchHash: "a".repeat(64),
        },
      },
    },
    ...overrides,
  };
}

function lighterRhcKeyRegistrationPrepareResult() {
  return {
    success: true,
    output: "RHC key registration prepared",
    actionKind: "approval_prepare",
    preparedActionFollowUp: {
      toolName: "execute_tool",
      args: {
        toolId: "lighter.key.register",
        params: { intentId: LIGHTER_ONBOARDING_INTENT_ID },
      },
      expiresAt: EXPIRES_AT,
      approvalPreview: {
        toolName: "key.register",
        namespace: "lighter",
        criticalArgs: {
          toolId: "lighter.key.register",
          intentId: LIGHTER_ONBOARDING_INTENT_ID,
          environment: "rhc",
          walletAddress: "0x1111111111111111111111111111111111111111",
          ethereumChainId: 4663,
          lighterChainId: 466324,
          accountIndex: 10231,
          apiKeyIndex: 6,
          registrationNonce: "0",
          publicKey: LIGHTER_KEY_PUBLIC_KEY,
          publicKeyFingerprint: LIGHTER_KEY_FINGERPRINT,
          vaultCredentialId: "lighter/rhc/account-10231/api-key-6",
          summary: "Register this exact encrypted RHC trading key.",
          authorityNote: "Registers one local credential; later actions stay separately gated.",
          signatureNote: "Signs one exact human-readable EIP-191 message locally.",
          scopeNote: "Does not authorize a deposit, order, transfer, or withdrawal.",
        },
      },
    },
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

async function run(permission: "restricted" | "full", abortSignal?: AbortSignal) {
  return processTurnToolBatch({
    abortSignal,
    context: context(permission),
    turnResult: {
      content: "Preparing transfer.",
      reasoning: null,
      toolCalls: [
        {
          id: "prepare-call",
          name: "WalletSendPrepare",
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
  });
}

async function runLighterInjectedPrepare(permission: "restricted" | "full") {
  return processTurnToolBatch({
    context: context(permission),
    turnResult: {
      content: "Preparing Lighter order.",
      reasoning: null,
      toolCalls: [
        {
          id: "lighter-prepare-call",
          name: "lighter__order__create__prepare",
          arguments: {
            environment: "rhc",
          },
        },
      ],
    },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 128_000,
    lastTextSoFar: null,
  });
}

async function runLighterRhcKeyRegistrationPrepare() {
  return processTurnToolBatch({
    context: context("restricted"),
    turnResult: {
      content: "Preparing secure RHC trading access.",
      reasoning: null,
      toolCalls: [{
        id: "lighter-key-prepare-call",
        name: "lighter__key__register__prepare",
        arguments: { environment: "rhc" },
      }],
    },
    liveMessages: [],
    currentTokenCount: 0,
    contextLimit: 128_000,
    lastTextSoFar: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The enqueue transaction now returns a discriminated outcome so the batch
  // can tell "parked for approval" from "auto-rejected onto a dead run".
  enqueueApprovalIntent.mockResolvedValue({
    kind: "enqueued",
    approvalId: "approval-1",
  });
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
      name: "WalletSendConfirm",
      args: { walletFamily: "solana", intentId: INTENT_ID },
    });
    expect(enqueueApprovalIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedPreview,
        trustedExpiresAt: EXPIRES_AT,
        toolCall: expect.objectContaining({ name: "WalletSendConfirm" }),
      }),
    );
    expect(persistBatchTranscript).toHaveBeenCalledTimes(2);
    expect(persistBatchTranscript.mock.calls[0]![0]).toMatchObject({
      content: "Preparing transfer.",
      executedCalls: [expect.objectContaining({ name: "WalletSendPrepare" })],
      executedResults: [expect.objectContaining({ output: "prepared" })],
    });
    // Second persist is the synthetic confirm call — stamped system-originated
    // so an auditor can never mistake it for model output (see turn.ts
    // `saveAssistantMessage` provenance stamp + transcript-provenance test).
    expect(persistBatchTranscript.mock.calls[1]![0]).toMatchObject({
      content: null,
      executedCalls: [expect.objectContaining({ name: "WalletSendConfirm" })],
      executedResults: [],
      systemOriginated: true,
    });
  });

  it("restricted sessions accept injected Lighter prepare and enqueue the trusted create approval", async () => {
    dispatchTool
      .mockResolvedValueOnce(lighterPrepareResult())
      .mockResolvedValueOnce({
        success: false,
        output: "approval required",
        pendingApproval: true,
        actionKind: "external_post",
      });

    const outcome = await runLighterInjectedPrepare("restricted");

    expect(outcome).toMatchObject({
      kind: "approval_break",
      pendingApprovalId: "approval-1",
      toolCallsExecuted: 2,
    });
    expect(dispatchTool).toHaveBeenCalledTimes(2);
    expect(dispatchTool.mock.calls[0]![0]).toMatchObject({
      name: "lighter__order__create__prepare",
    });
    expect(dispatchTool.mock.calls[1]![0]).toMatchObject({
      name: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId: LIGHTER_INTENT_ID },
      },
    });
    expect(dispatchTool.mock.calls[1]![1]).not.toHaveProperty(
      "modelOriginated",
      true,
    );
    expect(enqueueApprovalIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        trustedPreview: expect.objectContaining({
          toolName: "order.create",
          namespace: "lighter",
          criticalArgs: expect.objectContaining({
            toolId: "lighter.order.create",
            intentId: LIGHTER_INTENT_ID,
            matchHash: "a".repeat(64),
          }),
        }),
        trustedExpiresAt: EXPIRES_AT,
        toolCall: expect.objectContaining({ name: "execute_tool" }),
      }),
    );
    expect(persistBatchTranscript.mock.calls[0]![0]).toMatchObject({
      content: "Preparing Lighter order.",
      executedCalls: [expect.objectContaining({ name: "lighter__order__create__prepare" })],
      executedResults: [expect.objectContaining({ output: "lighter create prepared" })],
    });
  });

  it("turns an exact RHC key-registration prepare into a separate trusted approval", async () => {
    dispatchTool
      .mockResolvedValueOnce(lighterRhcKeyRegistrationPrepareResult())
      .mockResolvedValueOnce({
        success: false,
        output: "approval required",
        pendingApproval: true,
        actionKind: "external_post",
      });

    const outcome = await runLighterRhcKeyRegistrationPrepare();

    expect(outcome).toMatchObject({
      kind: "approval_break",
      pendingApprovalId: "approval-1",
      toolCallsExecuted: 2,
    });
    expect(dispatchTool.mock.calls[1]![0]).toMatchObject({
      name: "execute_tool",
      args: {
        toolId: "lighter.key.register",
        params: { intentId: LIGHTER_ONBOARDING_INTENT_ID },
      },
    });
    expect(dispatchTool.mock.calls[1]![1]).not.toHaveProperty("modelOriginated", true);
    expect(enqueueApprovalIntent).toHaveBeenCalledWith(expect.objectContaining({
      trustedExpiresAt: EXPIRES_AT,
      trustedPreview: expect.objectContaining({
        toolName: "key.register",
        namespace: "lighter",
        criticalArgs: expect.objectContaining({
          environment: "rhc",
          ethereumChainId: 4663,
          lighterChainId: 466324,
          accountIndex: 10231,
          vaultCredentialId: "lighter/rhc/account-10231/api-key-6",
        }),
      }),
      toolCall: expect.objectContaining({ name: "execute_tool" }),
    }));
    expect(persistBatchTranscript.mock.calls[0]![0]).toMatchObject({
      executedResults: [expect.objectContaining({
        success: true,
        output: "RHC key registration prepared",
      })],
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
      executedCalls: [expect.objectContaining({ name: "WalletSendConfirm" })],
      executedResults: [
        expect.objectContaining({ output: "transfer confirmed", success: true }),
      ],
      systemOriginated: true,
    });
  });

  it.each(["restricted", "full"] as const)(
    "hands off validated EVM transfers in %s sessions",
    async (permission) => {
      const evmPreview = {
        toolName: "WalletSendConfirm",
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
              toolName: "WalletSendConfirm",
              args: { walletFamily: "eip155", intentId: INTENT_ID },
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
        name: "WalletSendConfirm",
        args: { walletFamily: "eip155", intentId: INTENT_ID },
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

  // ── Codex Wave-1 defect 7: post-dispatch Stop, money path ─────
  // `WalletSendPrepare → WalletSendConfirm` is the one place the runtime
  // dispatches a SECOND tool on its own initiative, and the confirm leg is the
  // one that signs. A Stop that arrives while the prepare is in flight must
  // reach a decision point BEFORE that second dispatch.
  describe("operator Stop between prepare and confirm", () => {
    it("does NOT dispatch the signing confirm when the Stop landed during the prepare", async () => {
      const controller = new AbortController();
      dispatchTool.mockImplementationOnce(() => {
        controller.abort(); // operator hits Stop while prepare is in flight
        return Promise.resolve(prepareResult());
      });

      const outcome = await run("full", controller.signal);

      expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
      // The signing leg never ran.
      expect(dispatchTool).toHaveBeenCalledTimes(1);
      expect(enqueueApprovalIntent).not.toHaveBeenCalled();
      // The prepare DID run, so it is persisted truthfully and paired.
      expect(persistBatchTranscript).toHaveBeenCalledTimes(1);
      expect(persistBatchTranscript.mock.calls[0]![0]).toMatchObject({
        executedCalls: [expect.objectContaining({ name: "WalletSendPrepare" })],
        executedResults: [expect.objectContaining({ output: "prepared" })],
      });
    });

    it("does NOT dispatch the confirm when the Stop lands during the prepare transcript write", async () => {
      // The caller's check happens before a DB write; that write is a real
      // window, so the follow-up module re-checks immediately before signing.
      const controller = new AbortController();
      dispatchTool.mockResolvedValueOnce(prepareResult());
      persistBatchTranscript.mockImplementationOnce(() => {
        controller.abort();
        return Promise.resolve(undefined);
      });

      const outcome = await run("full", controller.signal);

      expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
      expect(dispatchTool).toHaveBeenCalledTimes(1);
    });

    it("never parks an approval for a confirm whose Stop landed while it was in flight", async () => {
      // The confirm dispatch is allowed to finish (it may already have moved
      // funds), but its "approval required" answer must NOT become a live,
      // approvable wallet action on a run the operator just ended.
      const controller = new AbortController();
      dispatchTool
        .mockResolvedValueOnce(prepareResult())
        .mockImplementationOnce(() => {
          controller.abort();
          return Promise.resolve({
            success: false,
            output: "approval required",
            pendingApproval: true,
            actionKind: "user_wallet_broadcast",
          });
        });

      const outcome = await run("restricted", controller.signal);

      expect(outcome).toMatchObject({ kind: "engine_stop", stopReason: "user_stopped" });
      expect(dispatchTool).toHaveBeenCalledTimes(2);
      expect(enqueueApprovalIntent).not.toHaveBeenCalled();
      // Pairing preserved: the synthetic confirm gets a truthful result row.
      expect(persistBatchTranscript).toHaveBeenCalledTimes(2);
      expect(persistBatchTranscript.mock.calls[1]![0]).toMatchObject({
        executedCalls: [expect.objectContaining({ name: "WalletSendConfirm" })],
        executedResults: [
          expect.objectContaining({
            success: false,
            output: APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT,
          }),
        ],
        systemOriginated: true,
      });
    });

    it("keeps the normal handoff intact when no Stop is pending", async () => {
      const controller = new AbortController();
      dispatchTool
        .mockResolvedValueOnce(prepareResult())
        .mockResolvedValueOnce({ success: true, output: "transfer confirmed" });

      const outcome = await run("full", controller.signal);

      expect(outcome).toMatchObject({ kind: "normal_complete", toolCallsExecuted: 2 });
      expect(dispatchTool).toHaveBeenCalledTimes(2);
      expect(enqueueApprovalIntent).not.toHaveBeenCalled();
    });
  });
});
