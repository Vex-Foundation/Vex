/**
 * PR-11 — turn-loop tool output overflow coverage.
 *
 * Verifies:
 *   - Small outputs (< 16 KiB) stay inline with no blob write.
 *   - Oversized outputs trigger a blob write and persist a stub with
 *     `metadata.payload.blob_key`.
 *   - A blob write failure falls back to inline persistence (no result
 *     dropped, even if the stub would have lost the pair-integrity
 *     guarantee).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAddMessage = vi.fn();
const mockAddEngineMessage = vi.fn();
const mockGetLiveMessages = vi.fn().mockResolvedValue([]);
const mockGetOperatorInstructionsAfter = vi.fn().mockResolvedValue([]);
const mockDispatchTool = vi.fn();
const mockIncrementIterations = vi.fn().mockResolvedValue(1);
const mockUpdateStatus = vi.fn();
const mockSetLastCheckpoint = vi.fn();
const mockEnqueueApproval = vi.fn();

const mockWriteBlob = vi.fn();
const mockGenerateBlobKey = vi.fn().mockReturnValue("tob-20260420-0000000000000001");

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  addMessageReturningId: vi.fn().mockResolvedValue({
    id: 1, role: "assistant", content: "", timestamp: new Date().toISOString(),
  }),
  getLiveMessages: (...a: unknown[]) => mockGetLiveMessages(...a),
  getOperatorInstructionsAfter: (...a: unknown[]) => mockGetOperatorInstructionsAfter(...a),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAddMessage(...a),
  appendEngineMessage: (...a: unknown[]) => mockAddEngineMessage(...a),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/mission-runs.js", () => ({
  incrementIterations: (...a: unknown[]) => mockIncrementIterations(...a),
  updateStatus: (...a: unknown[]) => mockUpdateStatus(...a),
  setLastCheckpoint: (...a: unknown[]) => mockSetLastCheckpoint(...a),
}));

vi.mock("@vex-agent/tools/dispatcher.js", () => ({
  dispatchTool: (...a: unknown[]) => mockDispatchTool(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  setRollingSummary: vi.fn(),
  archivePrefix: vi.fn(),
  forkToolMessageToArchive: vi.fn(),
  getSession: vi.fn().mockResolvedValue({ tokenCount: 0 }),
}));

// PR2 cutover: the legacy checkpoint module was removed. Turn-loop no longer auto-compacts on
// token threshold; compaction is agent-driven via `compact_now` or runtime
// forced fallback at `critical` band (covered in separate tests). For this
// overflow-focused test we only need to keep the dispatcher / messages /
// sessions mocks above to exercise the tool-output blob fallback path.

vi.mock("@vex-agent/engine/compact-jobs/forced-fallback.js", () => ({
  // Default to noop so overflow tests do not accidentally trigger a forced
  // compact write — the overflow assertions care about tool-result blob
  // persistence, not compaction.
  maybeRunForcedCompactFallback: vi.fn().mockResolvedValue({
    kind: "noop",
    reason: "no_compactable",
  }),
}));

vi.mock("@vex-agent/db/repos/approvals.js", () => ({
  enqueue: (...a: unknown[]) => mockEnqueueApproval(...a),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: vi.fn(),
}));

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: vi.fn().mockReturnValue({
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    }),
  }),
  queryWith: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockImplementation(async (_exec: unknown, sql: string) => {
    if (typeof sql === "string" && sql.includes("INSERT INTO messages") && sql.includes("RETURNING id, created_at")) {
      return { id: 1, created_at: new Date().toISOString() };
    }
    return null;
  }),
  executeWith: vi.fn().mockResolvedValue(1),
  withTransaction: vi.fn().mockImplementation(async (fn: (client: unknown) => Promise<unknown>) => {
    const stubClient = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    };
    return await fn(stubClient);
  }),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: vi.fn().mockResolvedValue({
    outcome: "claimed", previousStatus: "paused_wake",
    lease: { sessionId: "s", missionRunId: "r", ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
    wakeCancelledCount: 0,
  }),
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: { sessionId: "s", missionRunId: null, ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
  }),
  observeAndApplyControl: vi.fn().mockResolvedValue({ outcome: "no_request" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: vi.fn().mockReturnValue({
    lease: { sessionId: "s", missionRunId: null, ownerId: "test-owner", processKind: "electron_main", acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() },
    ownerId: "test-owner",
    release: vi.fn().mockResolvedValue(undefined),
    onLeaseLost: vi.fn(),
  }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/db/repos/tool-output-blobs.js", () => ({
  writeBlob: (...a: unknown[]) => mockWriteBlob(...a),
  generateBlobKey: (...a: unknown[]) => mockGenerateBlobKey(...a),
}));

vi.mock("../../../../vex-agent/engine/core/turn.js", () => ({
  executeTurn: vi.fn(),
  saveAssistantMessage: vi.fn(),
}));

const turnLoopModule = await import("../../../../vex-agent/engine/core/turn-loop.js");
const turnModule = await import("../../../../vex-agent/engine/core/turn.js");

const mockExecuteTurn = vi.mocked(turnModule.executeTurn);
const mockSaveAssistant = vi.mocked(turnModule.saveAssistantMessage);

function makeContext(sessionKind: "agent" | "mission" = "mission") {
  return {
    sessionId: "s1",
    sessionKind,
    sessionPermission: "full" as const,
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" as const },
    loadedDocuments: new Map<string, string>(),
  };
}

const provider = {
  id: "test",
  displayName: "test",
  loadConfig: vi.fn(),
  chatCompletion: vi.fn(),
  chatCompletionSimple: vi.fn(),
  chatCompletionStream: vi.fn(),
  getBalance: vi.fn(),
  calculateCost: vi.fn(),
};
const config = { provider: "test", model: "m", contextLimit: 1_000_000, maxOutputTokens: 512, inputPricePerM: 0, outputPricePerM: 0, priceCurrency: "USD" as const, cachePricePerM: null, cacheWritePricePerM: null, reasoningPricePerM: null, supportsReasoningEffort: false };
const loopConfig = { maxIterations: 1, timeoutMs: 60000, contextLimit: 1_000_000 };

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveAssistant.mockResolvedValue(undefined);
  mockWriteBlob.mockResolvedValue({
    blobKey: "tob-20260420-0000000000000001",
    sessionId: "s1",
    payload: { fullOutput: "x", shapeKind: "text", sizeBytes: 100 },
    expiresAt: "2026-04-20T13:00:00.000Z",
    createdAt: "2026-04-20T12:45:00.000Z",
  });
});

describe("turn-loop tool output overflow", () => {
  it("keeps small outputs inline and does NOT write a blob", async () => {
    const smallOutput = "small tool result";
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: smallOutput });

    await turnLoopModule.runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider,
      config,
      [],
      loopConfig,
    );

    expect(mockWriteBlob).not.toHaveBeenCalled();
    // Find the tool message persistence call.
    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    expect(toolSave).toBeDefined();
    expect((toolSave![1] as { content: string }).content).toBe(smallOutput);
  });

  it("writes a blob and persists a stub with metadata.payload.blob_key on overflow", async () => {
    const bigOutput = "x".repeat(20_000); // > 16 KiB
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: bigOutput });

    await turnLoopModule.runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider,
      config,
      [],
      loopConfig,
    );

    expect(mockWriteBlob).toHaveBeenCalledTimes(1);
    const blobCall = mockWriteBlob.mock.calls[0]!;
    expect(blobCall[0]).toBe("tob-20260420-0000000000000001");
    expect(blobCall[1]).toBe("s1");
    expect((blobCall[2] as { fullOutput: string }).fullOutput).toBe(bigOutput);

    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    expect(toolSave).toBeDefined();
    const persistedMessage = toolSave![1] as { content: string };
    const persistedMeta = toolSave![2] as { payload?: Record<string, unknown> };
    expect(persistedMessage.content).toContain("tool_output_overflow");
    expect(persistedMessage.content).toContain("tob-20260420-0000000000000001");
    expect(persistedMeta.payload).toMatchObject({
      overflow: true,
      blobKey: "tob-20260420-0000000000000001",
      sizeBytes: expect.any(Number),
    });
  });

  it("includes a bounded structured preview for oversized JSON outputs", async () => {
    const bigOutput = JSON.stringify({
      count: 8,
      items: Array.from({ length: 8 }, (_, index) => ({
        id: String(index),
        text: `tweet ${index}`,
      })),
      padding: "x".repeat(20_000),
    });
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "twitter_account", arguments: { action: "tweet_search" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: bigOutput });

    await turnLoopModule.runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider,
      config,
      [],
      loopConfig,
    );

    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    const persistedMessage = toolSave![1] as { content: string };
    expect(persistedMessage.content).toContain("preview=");
    expect(persistedMessage.content).toContain("itemsTotalCount");
    expect(persistedMessage.content).toContain("tweet 0");
    expect(persistedMessage.content).toContain("tweet 4");
    expect(persistedMessage.content).not.toContain("tweet 5");

    // P0-6: hints derived from the allowlisted `items` list are echoed into the
    // stub AND written to the blob payload.
    expect(persistedMessage.content).toContain("primary_path=items");
    expect(persistedMessage.content).toContain("field_hints=[id,text]");
    const blobPayload = mockWriteBlob.mock.calls[0]![2] as {
      primaryPath?: string;
      fieldHints?: string[];
    };
    expect(blobPayload.primaryPath).toBe("items");
    expect(blobPayload.fieldHints).toEqual(["id", "text"]);
  });

  it("writes hints from a record with NO allowlisted list (top-level keys)", async () => {
    const bigOutput = JSON.stringify({
      summary: "ok",
      total: 3,
      unknownRows: Array.from({ length: 3 }, (_, i) => ({ i })),
      padding: "x".repeat(20_000),
    });
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: bigOutput });

    await turnLoopModule.runTurnLoop(
      makeContext(), [], null, 0, provider, config, [], loopConfig,
    );

    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    const persistedMessage = toolSave![1] as { content: string };
    // No allowlisted list ⇒ no primary_path, but the record's shape is surfaced.
    expect(persistedMessage.content).not.toContain("primary_path=");
    expect(persistedMessage.content).toContain("field_hints=[summary,total,unknownRows,padding]");
    const blobPayload = mockWriteBlob.mock.calls[0]![2] as {
      primaryPath?: string;
      fieldHints?: string[];
    };
    expect(blobPayload.primaryPath).toBeUndefined();
    expect(blobPayload.fieldHints).toEqual(["summary", "total", "unknownRows", "padding"]);
  });

  it("writes primary_path=$ for a root-array overflow output", async () => {
    const bigOutput = JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({ id: i, label: `row ${i}`, pad: "x".repeat(800) })),
    );
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: bigOutput });

    await turnLoopModule.runTurnLoop(
      makeContext(), [], null, 0, provider, config, [], loopConfig,
    );

    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    const persistedMessage = toolSave![1] as { content: string };
    expect(persistedMessage.content).toContain("primary_path=$");
    expect(persistedMessage.content).toContain("field_hints=[id,label,pad]");
    expect(persistedMessage.content).toContain('path="$"');
    expect(persistedMessage.content).not.toContain("meta.universe");
    expect(persistedMessage.content).not.toContain('search="cash"');
  });

  it("emits NO hints for a non-JSON (text) overflow output", async () => {
    const bigOutput = "x".repeat(20_000); // text shape, no structure
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: bigOutput });

    await turnLoopModule.runTurnLoop(
      makeContext(), [], null, 0, provider, config, [], loopConfig,
    );

    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    const persistedMessage = toolSave![1] as { content: string };
    expect(persistedMessage.content).not.toContain("primary_path=");
    expect(persistedMessage.content).not.toContain("field_hints=");
    const blobPayload = mockWriteBlob.mock.calls[0]![2] as {
      primaryPath?: string;
      fieldHints?: string[];
    };
    expect(blobPayload.primaryPath).toBeUndefined();
    expect(blobPayload.fieldHints).toBeUndefined();
  });

  it("falls back to inline persistence when blob write fails", async () => {
    const bigOutput = "y".repeat(20_000);
    mockExecuteTurn.mockResolvedValueOnce({
      content: null,
      toolCalls: [{ id: "tc-1", name: "web_research", arguments: { query: "x" } }],
      promptTokens: 100,
    });
    mockDispatchTool.mockResolvedValueOnce({ success: true, output: bigOutput });
    mockWriteBlob.mockRejectedValueOnce(new Error("db down"));

    await turnLoopModule.runTurnLoop(
      makeContext(),
      [],
      null,
      0,
      provider,
      config,
      [],
      loopConfig,
    );

    const toolSave = mockAddMessage.mock.calls.find(
      ([, msg]) => (msg as { role?: string }).role === "tool",
    );
    const persistedMessage = toolSave![1] as { content: string };
    expect(persistedMessage.content).toBe(bigOutput);
  });
});
