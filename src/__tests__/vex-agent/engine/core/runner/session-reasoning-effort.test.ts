/**
 * Kairos E-1: a chat session's reasoning effort is stable across the turns
 * nobody typed. An interactive turn that carries a composer pick persists it
 * (migration 174); a wake continuation, approval resume or form resume runs at
 * that persisted pick instead of the provider default.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLeaseHandle } from "../../../../helpers/lease-guard.js";
import type { InferenceConfig } from "@vex-agent/inference/types.js";

const mockResolveProvider = vi.fn();
const mockHydrate = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockGetEffort = vi.fn();
const mockSetEffort = vi.fn();
const mockAppendMessage = vi.fn();

vi.mock("@vex-agent/db/repos/session-reasoning-effort.js", () => ({
  getSessionReasoningEffort: (...a: unknown[]) => mockGetEffort(...a),
  setSessionReasoningEffort: (...a: unknown[]) => mockSetEffort(...a),
}));

vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: () => mockResolveProvider(),
}));

vi.mock("@vex-agent/engine/events/index.js", () => ({
  appendMessage: (...a: unknown[]) => mockAppendMessage(...a),
  appendEngineMessage: vi.fn().mockResolvedValue(undefined),
  emitTranscriptAppend: vi.fn(),
}));

vi.mock("../../../../../vex-agent/engine/core/hydrate.js", () => ({
  hydrateEngineSession: (...a: unknown[]) => mockHydrate(...a),
}));

vi.mock("../../../../../vex-agent/engine/core/turn-loop.js", () => ({
  runTurnLoop: (...a: unknown[]) => mockRunTurnLoop(...a),
}));

vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  enqueue: vi.fn().mockResolvedValue(null),
  cancelForSession: vi.fn().mockResolvedValue(0),
  getPendingForSession: vi.fn().mockResolvedValue(null),
}));

vi.mock("@vex-agent/tools/registry.js", () => ({
  getOpenAITools: vi.fn().mockReturnValue([]),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimSessionLease: vi.fn().mockResolvedValue({
    outcome: "claimed",
    lease: {
      sessionId: "session-1",
      missionRunId: null,
      ownerId: "agent-turn-owner",
      processKind: "electron_main",
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(),
    },
  }),
  withSessionControlLock: async (_sessionId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn() }),
  gateOnOperatorStopWithClient: vi.fn().mockResolvedValue({ kind: "clear" }),
}));

vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: () => fakeLeaseHandle({ ownerId: "agent-turn-owner", sessionId: "session-1" }),
}));

vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { continueAgentSessionUnderLease, processAgentTurn, withSessionReasoningEffort } = await import(
  "../../../../../vex-agent/engine/core/runner/agent.js"
);

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "openrouter",
    model: "deepseek/deepseek-v4.1-flash",
    contextLimit: 128_000,
    maxOutputTokens: 4_096,
    inputPricePerM: 0,
    outputPricePerM: 0,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: true,
    reasoningSupport: { efforts: ["none", "low", "medium", "high"] },
    ...overrides,
  };
}

function hydrated() {
  return {
    context: {
      sessionId: "session-1",
      sessionKind: "agent",
      sessionPermission: "full",
      missionId: null,
      missionRunId: null,
      loadedDocuments: new Map(),
    },
    messages: [],
    summary: null,
    tokenCount: 0,
  };
}

/** The reasoning effort on the config the turn loop was handed (positional arg 6). */
function loopEffort(): unknown {
  const call = mockRunTurnLoop.mock.calls[0];
  if (call === undefined) throw new Error("runTurnLoop was never called");
  const value: unknown = call[5];
  if (typeof value !== "object" || value === null) throw new Error("no config");
  return Reflect.get(value, "reasoningEffort");
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProvider.mockResolvedValue({ loadConfig: async () => config() });
  mockHydrate.mockResolvedValue(hydrated());
  mockRunTurnLoop.mockResolvedValue({ text: "done", toolCallsMade: 0, pendingApprovals: [], stopReason: null });
  mockGetEffort.mockResolvedValue(null);
  mockSetEffort.mockResolvedValue(undefined);
  mockAppendMessage.mockResolvedValue(undefined);
});

describe("withSessionReasoningEffort", () => {
  it("keeps a turn's own pick and never reads the persisted one", async () => {
    const out = await withSessionReasoningEffort(config({ reasoningEffort: "high" }), "session-1");
    expect(out.reasoningEffort).toBe("high");
    expect(mockGetEffort).not.toHaveBeenCalled();
  });

  it("inherits the persisted pick when the turn carries none", async () => {
    mockGetEffort.mockResolvedValue("low");
    const input = config();
    const out = await withSessionReasoningEffort(input, "session-1");
    expect(out.reasoningEffort).toBe("low");
    expect(input.reasoningEffort).toBeUndefined();
  });

  it("clamps an inherited pick the current model no longer supports, never upwards", async () => {
    mockGetEffort.mockResolvedValue("max");
    const out = await withSessionReasoningEffort(config(), "session-1");
    expect(out.reasoningEffort).toBe("high");
  });

  it("a failed read never fails the turn; it runs on the provider default", async () => {
    mockGetEffort.mockRejectedValue(new Error("db down"));
    const out = await withSessionReasoningEffort(config(), "session-1");
    expect(out.reasoningEffort).toBeUndefined();
  });

  it("leaves a session that never picked on the provider default", async () => {
    const out = await withSessionReasoningEffort(config(), "session-1");
    expect(out.reasoningEffort).toBeUndefined();
  });
});

describe("chat turn persists the pick; wake continuation inherits it", () => {
  it("an interactive turn with a pick persists it and runs at it", async () => {
    await processAgentTurn("session-1", "hello", undefined, { reasoningEffort: "medium" });
    expect(mockSetEffort).toHaveBeenCalledWith("session-1", "medium");
    expect(loopEffort()).toBe("medium");
  });

  it("an interactive turn without a pick writes nothing", async () => {
    await processAgentTurn("session-1", "hello");
    expect(mockSetEffort).not.toHaveBeenCalled();
  });

  it("a wake continuation runs at the session's persisted pick, not the provider default", async () => {
    mockGetEffort.mockResolvedValue("low");
    await continueAgentSessionUnderLease(
      "session-1",
      fakeLeaseHandle({ ownerId: "wake-executor-wake-1", sessionId: "session-1" }),
    );
    expect(mockGetEffort).toHaveBeenCalledWith("session-1");
    expect(loopEffort()).toBe("low");
  });
});
