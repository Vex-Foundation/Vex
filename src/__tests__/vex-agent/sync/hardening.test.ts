import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Pre-engine hardening tests — real runtime gate verification.
 *
 * Uses a mock protocol handler injected via catalog mock to test
 * executeProtocolTool() end-to-end without network calls.
 */

// ── DB Mocks ────────────────────────────────────────────────────

const mockRecordExecution = vi.fn().mockResolvedValue(1);
vi.mock("@vex-agent/db/repos/executions.js", () => ({
  recordExecution: (...args: unknown[]) => mockRecordExecution(...args),
  getById: vi.fn().mockResolvedValue(null),
  // Durable-intent lifecycle (general infra: Kyber/Uniswap staged swaps,
  // Khalani/Relay staged bridges via runtime/capture.ts's `completeExecutionIntent`
  // call) — inert for the fake tool under test, but the mocked module must
  // still export them -- Vitest throws on access to an undefined mock export.
  createExecutionIntent: vi.fn().mockResolvedValue(1),
  completeExecutionIntent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/sync.js", () => ({
  getJobsForNamespace: vi.fn().mockResolvedValue([]),
  enqueueRun: vi.fn().mockResolvedValue(1),
}));

const mockRecordCaptureItems = vi.fn().mockResolvedValue([100]);
vi.mock("@vex-agent/db/repos/capture-items.js", () => ({
  recordCaptureItems: (...args: unknown[]) => mockRecordCaptureItems(...args),
  getByExecution: vi.fn().mockResolvedValue([]),
}));

const mockInsertActivity = vi.fn().mockResolvedValue(1);
const mockGetByExecution = vi.fn().mockResolvedValue([]);
vi.mock("@vex-agent/db/repos/activity.js", () => ({
  insertActivity: (...args: unknown[]) => mockInsertActivity(...args),
  getByExecution: (...args: unknown[]) => mockGetByExecution(...args),
}));

const mockUpsertPosition = vi.fn().mockResolvedValue(undefined);
vi.mock("@vex-agent/db/repos/open-positions.js", () => ({
  upsertPosition: (...args: unknown[]) => mockUpsertPosition(...args),
  closePosition: vi.fn().mockResolvedValue(true),
}));

// ── Catalog mock — inject fake mutating handler ─────────────────

const fakeHandler = vi.fn();

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [{
    toolId: "test.fake.mutate",
    namespace: "test",
    lifecycle: "active",
    description: "Fake mutating tool for testing",
    mutating: true,
    params: [],
    exampleParams: {},
  }],
  PROTOCOL_NAMESPACE_ALLOWLIST: ["test"],
  getProtocolHandler: (toolId: string) => toolId === "test.fake.mutate" ? fakeHandler : undefined,
  getProtocolManifest: (toolId: string) => toolId === "test.fake.mutate" ? {
    toolId: "test.fake.mutate", namespace: "test", lifecycle: "active",
    description: "Fake", mutating: true, params: [],
  } : undefined,
}));

const { executeProtocolTool } = await import("../../../vex-agent/tools/protocols/runtime.js");

describe("pre-engine hardening — runtime gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertActivity.mockResolvedValue(1);
    mockGetByExecution.mockResolvedValue(null);
  });

  // ── Failed execution: audit yes, projections no ───────────────

  it("failed mutating execution → recordExecution YES, insertActivity NO", async () => {
    fakeHandler.mockResolvedValueOnce({
      success: false,
      output: "Trade failed: insufficient balance",
      data: { _tradeCapture: { type: "swap", chain: "solana", status: "executed" } },
    });

    const result = await executeProtocolTool(
      { toolId: "test.fake.mutate", params: {} },
      { sessionPermission: "full", approved: true, sessionId: "test-fail" },
    );

    expect(result.success).toBe(false);

    // Audit: protocol_executions captures failure
    expect(mockRecordExecution).toHaveBeenCalledTimes(1);
    expect(mockRecordExecution.mock.calls[0][2]).toBe("test-fail"); // sessionId
    expect(mockRecordExecution.mock.calls[0][5]).toBe(false); // success

    // Projections: NOT touched (gate: result.success)
    expect(mockInsertActivity).not.toHaveBeenCalled();
    expect(mockUpsertPosition).not.toHaveBeenCalled();
  });

  // ── Successful execution: audit yes, projections yes ──────────

  it("successful mutating execution → recordExecution YES, insertActivity YES", async () => {
    fakeHandler.mockResolvedValueOnce({
      success: true,
      output: "Swap executed",
      data: {
        txHash: "0xabc",
        _tradeCapture: {
          type: "swap", chain: "solana", status: "executed",
          inputToken: "SOL", outputToken: "USDC",
          walletAddress: "0xWallet",
        },
      },
    });

    const result = await executeProtocolTool(
      { toolId: "test.fake.mutate", params: {} },
      { sessionPermission: "full", approved: true, sessionId: "test-success" },
    );

    expect(result.success).toBe(true);

    // Audit: protocol_executions captures success
    expect(mockRecordExecution).toHaveBeenCalledTimes(1);
    expect(mockRecordExecution.mock.calls[0][2]).toBe("test-success");
    expect(mockRecordExecution.mock.calls[0][5]).toBe(true);

    // Projections: activity IS populated
    expect(mockInsertActivity).toHaveBeenCalledTimes(1);
  });

  it("successful mutating execution strips undefined before audit and projection", async () => {
    fakeHandler.mockResolvedValueOnce({
      success: true,
      output: "Swap executed",
      data: {
        txHash: "0xabc",
        optionalTopLevel: undefined,
        nested: { keep: "yes", drop: undefined },
        values: ["first", undefined],
        _tradeCapture: {
          type: "swap", chain: "solana", status: "executed",
          inputToken: "SOL", outputToken: "MTGA",
          inputTokenAddress: "So11111111111111111111111111111111111111112",
          outputTokenAddress: "Gddas2JVfZ3YXjWoNmDtFJGBvtM4EqCLbL4hFjPMpump",
          inputAmount: "600000", outputAmount: "617251087",
          walletAddress: "0xWallet",
          tradeSide: "buy", instrumentKey: "solana:Gddas2JVfZ3YXjWoNmDtFJGBvtM4EqCLbL4hFjPMpump",
          inputValueUsd: "0.05", valuationSource: "jupiter_exact",
          inputValueNative: "0.0006",
          outputValueNative: undefined,
          meta: { keep: "meta", drop: undefined, values: [undefined, "ok"] },
        },
      },
    });

    const result = await executeProtocolTool(
      { toolId: "test.fake.mutate", params: { dryRun: false, optionalParam: undefined } },
      { sessionPermission: "full", approved: true, sessionId: "test-sanitize" },
    );

    expect(result.success).toBe(true);
    expect(mockRecordExecution).toHaveBeenCalledTimes(1);

    const recordCall = mockRecordExecution.mock.calls[0];
    const storedParams = recordCall[3] as Record<string, unknown>;
    const storedResult = recordCall[4] as Record<string, unknown>;
    const storedCapture = recordCall[6] as Record<string, unknown>;

    expect("optionalParam" in storedParams).toBe(false);
    expect("optionalTopLevel" in storedResult).toBe(false);
    expect(storedResult.nested).toEqual({ keep: "yes" });
    expect(storedResult.values).toEqual(["first", null]);
    expect("outputValueNative" in storedCapture).toBe(false);
    expect(storedCapture.meta).toEqual({ keep: "meta", values: [null, "ok"] });

    expect(mockRecordCaptureItems).toHaveBeenCalledTimes(1);
    const captureItems = mockRecordCaptureItems.mock.calls[0][1] as Array<{ tradeCapture: Record<string, unknown> }>;
    expect("outputValueNative" in captureItems[0].tradeCapture).toBe(false);

    expect(mockInsertActivity).toHaveBeenCalledTimes(1);
    const activityRow = mockInsertActivity.mock.calls[0][0] as Record<string, unknown>;
    expect(activityRow.inputValueNative).toBe("0.0006");
    expect(activityRow.outputValueNative).toBeNull();
  });

  // ── sessionId propagation ─────────────────────────────────────

  it("sessionId from context reaches recordExecution", async () => {
    fakeHandler.mockResolvedValueOnce({
      success: true,
      output: "OK",
      data: { _tradeCapture: { type: "swap", chain: "ethereum", status: "executed" } },
    });

    await executeProtocolTool(
      { toolId: "test.fake.mutate", params: {} },
      { sessionPermission: "full", approved: true, sessionId: "session-xyz-789" },
    );

    expect(mockRecordExecution).toHaveBeenCalledTimes(1);
    expect(mockRecordExecution.mock.calls[0][2]).toBe("session-xyz-789");
  });

  // ── Thrown handler: audit yes, projections no ─────────────────

  it("thrown handler → audit captures failure, projections untouched", async () => {
    fakeHandler.mockRejectedValueOnce(new Error("Network timeout"));

    const result = await executeProtocolTool(
      { toolId: "test.fake.mutate", params: {} },
      { sessionPermission: "full", approved: true, sessionId: "test-throw" },
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Network timeout");

    // Audit: captures the thrown failure
    expect(mockRecordExecution).toHaveBeenCalledTimes(1);
    expect(mockRecordExecution.mock.calls[0][5]).toBe(false);

    // Projections: NOT touched
    expect(mockInsertActivity).not.toHaveBeenCalled();
  });

  // ── spot projection retired ────────────────────────────────────

  describe("spot projection retired", () => {
    it("a spot sell is a no-op (PnL-lot projection removed; agent_activity is the trade-truth store)", async () => {
      const { projectPosition } = await import("../../../vex-agent/sync/position-projector.js");

      await projectPosition({
        id: 1, namespace: "solana", activityType: "swap", productType: "spot",
        tradeSide: "sell", chain: "solana", executionId: 100, walletAddress: "0xW",
        inputToken: "SOL", inputAmount: "500", outputToken: null, outputAmount: null,
        valueUsd: null, captureStatus: "executed", positionKey: null,
        instrumentKey: "solana:SOL", externalRefs: {}, meta: {},
        createdAt: new Date().toISOString(),
      } as any);

      expect(mockUpsertPosition).not.toHaveBeenCalled();
    });
  });

  // ── captureStatus pipeline ────────────────────────────────────

  describe("captureStatus pipeline", () => {
    it("populateActivity passes captureStatus from tradeCapture.status", async () => {
      const { populateActivity } = await import("../../../vex-agent/sync/activity-populator.js");

      await populateActivity(
        42, null, "solana.perps.close", "solana",
        { type: "perps", chain: "solana", status: "closed", walletAddress: "0xW", positionKey: "PK1" },
        { signature: "sig123" },
      );

      expect(mockInsertActivity).toHaveBeenCalledTimes(1);
      const row = mockInsertActivity.mock.calls[0][0];
      expect(row.captureStatus).toBe("closed");
    });
  });
});
