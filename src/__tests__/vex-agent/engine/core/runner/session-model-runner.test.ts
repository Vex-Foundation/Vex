/**
 * F06: a chat session runs on its own model, across the turns nobody typed.
 *
 * Pinned against the real runner entry points with the world mocked:
 *  - precedence: the turn's pick, else the persisted pick, else the default;
 *  - an interactive pick is persisted under the lease and runs at once;
 *  - a wake continuation and a gated resume run on the persisted pick;
 *  - the session window is clamped to the default (summarizer) model's;
 *  - a pick made under the OTHER backend runs the default and raises the
 *    `session_model_fallback` notice (never silent);
 *  - a pick the ACTIVE backend no longer lists fails loudly by name, and an
 *    interactive turn that names one appends and writes nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeLeaseHandle } from "../../../../helpers/lease-guard.js";
import type { InferenceConfig } from "@vex-agent/inference/types.js";
import type { InferenceNoticeEvent } from "@vex-agent/inference/inference-notice-bus.js";

const mockResolveProvider = vi.fn();
const mockHydrate = vi.fn();
const mockRunTurnLoop = vi.fn();
const mockGetModel = vi.fn();
const mockSetModel = vi.fn();
const mockAppendMessage = vi.fn();
const mockClearEndpointState = vi.fn();

vi.mock("@vex-agent/db/repos/session-model.js", () => ({
  getSessionModel: (...a: unknown[]) => mockGetModel(...a),
  setSessionModel: (...a: unknown[]) => mockSetModel(...a),
}));

vi.mock("@vex-agent/db/repos/session-reasoning-effort.js", () => ({
  getSessionReasoningEffort: vi.fn().mockResolvedValue(null),
  setSessionReasoningEffort: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@vex-agent/inference/openrouter/endpoint-failover.js", () => ({
  clearSessionEndpointState: (...a: unknown[]) => mockClearEndpointState(...a),
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

const { continueAgentSessionUnderLease, processAgentTurn } = await import(
  "../../../../../vex-agent/engine/core/runner/agent.js"
);
const { runStopGatedSessionTurn } = await import(
  "../../../../../vex-agent/engine/core/runner/gated-session-turn.js"
);
const { loadSessionInferenceConfig, SessionModelUnavailableError } = await import(
  "../../../../../vex-agent/engine/core/runner/session-model.js"
);
const { inferenceNoticeBus } = await import("@vex-agent/inference/inference-notice-bus.js");

const DEFAULT_MODEL = "anthropic/claude-haiku-5.5";
const PICKED_MODEL = "openai/gpt-6-luna";

function config(model: string, contextLimit: number): InferenceConfig {
  return {
    provider: "vexcloud",
    model,
    contextLimit,
    maxOutputTokens: 4_096,
    inputPricePerM: 0,
    outputPricePerM: 0,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };
}

/** Catalogue windows: the picked model is wider than the default. */
const WINDOWS: Record<string, number> = {
  [DEFAULT_MODEL]: 200_000,
  [PICKED_MODEL]: 1_000_000,
  "google/gemini-3.8-flash": 64_000,
};

function provider(id: "openrouter" | "vexcloud" = "vexcloud") {
  const loadConfig = vi.fn(async (options?: { readonly model?: string }) => {
    const model = options?.model ?? DEFAULT_MODEL;
    const window = WINDOWS[model];
    return window === undefined ? null : config(model, window);
  });
  return { id, displayName: id, loadConfig };
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

/** The config the turn loop was handed (positional arg 6). */
function loopConfig(): InferenceConfig {
  const call = mockRunTurnLoop.mock.calls[0];
  if (call === undefined) throw new Error("runTurnLoop was never called");
  return call[5] as InferenceConfig;
}

function pick(provider: "openrouter" | "vexcloud", modelId: string) {
  return { provider, modelId, updatedAt: "2026-10-23T10:00:00.000Z" };
}

let notices: InferenceNoticeEvent[] = [];
let unsubscribe: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveProvider.mockResolvedValue(provider());
  mockHydrate.mockResolvedValue(hydrated());
  mockRunTurnLoop.mockResolvedValue({ text: "done", toolCallsMade: 0, pendingApprovals: [], stopReason: null });
  mockGetModel.mockResolvedValue(null);
  mockSetModel.mockResolvedValue(undefined);
  mockAppendMessage.mockResolvedValue(undefined);
  notices = [];
  unsubscribe = inferenceNoticeBus.subscribe((event) => notices.push(event));
});

afterEach(() => {
  unsubscribe();
});

describe("loadSessionInferenceConfig", () => {
  it("a session that never picked runs on the default", async () => {
    const out = await loadSessionInferenceConfig(provider(), "session-1");
    expect(out.model).toBe(DEFAULT_MODEL);
  });

  it("the turn's own pick wins over the persisted one", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", "google/gemini-3.8-flash"));
    const out = await loadSessionInferenceConfig(provider(), "session-1", {
      provider: "vexcloud",
      modelId: PICKED_MODEL,
    });
    expect(out.model).toBe(PICKED_MODEL);
    expect(mockGetModel).not.toHaveBeenCalled();
  });

  it("a persisted pick on the active backend is used", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", "google/gemini-3.8-flash"));
    const out = await loadSessionInferenceConfig(provider(), "session-1");
    expect(out.model).toBe("google/gemini-3.8-flash");
    // Narrower than the summarizer: left as the model's own.
    expect(out.contextLimit).toBe(64_000);
  });

  it("clamps a wider session model to the default (summarizer) window", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", PICKED_MODEL));
    const out = await loadSessionInferenceConfig(provider(), "session-1");
    expect(out.model).toBe(PICKED_MODEL);
    expect(out.contextLimit).toBe(200_000);
  });

  it("a pick made under the other backend runs the default and says so", async () => {
    mockGetModel.mockResolvedValue(pick("openrouter", "deepseek/deepseek-v4-flash"));
    const out = await loadSessionInferenceConfig(provider("vexcloud"), "session-1");

    expect(out.model).toBe(DEFAULT_MODEL);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "session_model_fallback",
        sessionId: "session-1",
        provider: "vexcloud",
        model: DEFAULT_MODEL,
        pickedProvider: "openrouter",
        pickedModel: "deepseek/deepseek-v4-flash",
      }),
    ]);
  });

  it("a pick the active backend no longer lists fails loudly by name, with no notice", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", "vendor/retired"));
    const failure = loadSessionInferenceConfig(provider(), "session-1");

    await expect(failure).rejects.toBeInstanceOf(SessionModelUnavailableError);
    await expect(failure).rejects.toMatchObject({
      code: "session_model_unavailable",
      modelId: "vendor/retired",
      reason: "delisted",
    });
    expect(notices).toEqual([]);
  });

  it("a turn's own pick for another backend is refused, not substituted", async () => {
    await expect(
      loadSessionInferenceConfig(provider("vexcloud"), "session-1", {
        provider: "openrouter",
        modelId: PICKED_MODEL,
      }),
    ).rejects.toMatchObject({ reason: "backend_changed", modelId: PICKED_MODEL });
  });

  it("a failed pick read never fails the turn; it runs on the default", async () => {
    mockGetModel.mockRejectedValue(new Error("db down"));
    const out = await loadSessionInferenceConfig(provider(), "session-1");
    expect(out.model).toBe(DEFAULT_MODEL);
  });
});

describe("the runner entry points run on the session's model", () => {
  it("an interactive pick is persisted under the lease and runs at once", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", "google/gemini-3.8-flash"));
    await processAgentTurn("session-1", "hello", undefined, {
      model: { provider: "vexcloud", modelId: PICKED_MODEL },
    });

    expect(mockSetModel).toHaveBeenCalledWith("session-1", "vexcloud", PICKED_MODEL);
    expect(loopConfig().model).toBe(PICKED_MODEL);
    // Moving off the previous pick drops its in-memory failover state.
    expect(mockClearEndpointState).toHaveBeenCalledWith("session-1", "google/gemini-3.8-flash");
  });

  it("an interactive turn without a pick writes nothing and runs the persisted one", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", "google/gemini-3.8-flash"));
    await processAgentTurn("session-1", "hello");
    expect(mockSetModel).not.toHaveBeenCalled();
    expect(loopConfig().model).toBe("google/gemini-3.8-flash");
  });

  it("an interactive pick the backend does not list appends and writes nothing", async () => {
    await expect(
      processAgentTurn("session-1", "hello", undefined, {
        model: { provider: "vexcloud", modelId: "vendor/retired" },
      }),
    ).rejects.toBeInstanceOf(SessionModelUnavailableError);
    expect(mockAppendMessage).not.toHaveBeenCalled();
    expect(mockSetModel).not.toHaveBeenCalled();
    expect(mockRunTurnLoop).not.toHaveBeenCalled();
  });

  it("a wake continuation runs on the persisted pick, not the default", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", PICKED_MODEL));
    await continueAgentSessionUnderLease(
      "session-1",
      fakeLeaseHandle({ ownerId: "wake-executor-wake-1", sessionId: "session-1" }),
    );
    expect(mockGetModel).toHaveBeenCalledWith("session-1");
    expect(loopConfig().model).toBe(PICKED_MODEL);
  });

  it("a gated resume runs on the persisted pick, not the default", async () => {
    mockGetModel.mockResolvedValue(pick("vexcloud", PICKED_MODEL));
    await runStopGatedSessionTurn({
      sessionId: "session-1",
      runnerLease: fakeLeaseHandle({ ownerId: "approval-resume", sessionId: "session-1" }),
      logScope: "test",
    });
    expect(loopConfig().model).toBe(PICKED_MODEL);
  });
});
