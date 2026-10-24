/**
 * IPC handler surface smoke tests — sender validation, payload validation,
 * read-only success paths, and mutation handler registration. One file
 * bundles the broad surface to keep CI run-time tight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestWebContents,
  createTrustedSender,
  type TestIpcEvent,
} from "../test-sender.js";

type Handler = (
  event: TestIpcEvent,
  raw: unknown,
) => Promise<unknown>;

const handlers = vi.hoisted(() => new Map<string, Handler>());
const mocks = vi.hoisted(() => ({
  // messages-db
  getMessageTail: vi.fn(),
  getMessageAround: vi.fn(),
  listMessages: vi.fn(),
  // usage-db
  getSessionTotals: vi.fn(),
  getLastTurn: vi.fn(),
  getContextWindow: vi.fn(),
  // compaction-db
  getCompactionStatus: vi.fn(),
  listCompactionHistory: vi.fn(),
  // memory-db
  listSessionMemories: vi.fn(),
  getMemoryStats: vi.fn(),
  // mission-runs-db
  getActiveRunForSession: vi.fn(),
  // approvals-db
  listPendingForSession: vi.fn(),
  listPendingAllApprovals: vi.fn(),
  getApprovalById: vi.fn(),
  getHistoryForSession: vi.fn(),
  // missions-db
  getDraftForSession: vi.fn(),
  // engine inference registry (S6 — sessions.getModel pricing-proxy fallback)
  resolveProvider: vi.fn(),
  // reasoning-capability catalog (D3/D7 — sessions.getModel primary source).
  // Defaults to `null` ("capability catalog unavailable") so the EXISTING
  // pricing-proxy-driven tests below keep exercising exactly the fallback
  // path they always have; individual tests override it to exercise the
  // primary catalog path.
  getModelReasoningCapability: vi.fn().mockResolvedValue(null),
  // F06: the models list reads the active backend's catalogue. Defaults to
  // a failed fetch, so the single-option tests below keep exercising the
  // `global_default` fallback they always have.
  loadProviderModelCatalog: vi.fn().mockRejectedValue(new Error("catalogue offline")),
  // F06: sessions.getModel reads the session's own pick; none by default.
  getSessionModelPick: vi.fn().mockResolvedValue({ ok: true, data: null }),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  app: { isPackaged: true },
}));

vi.mock("../../../database/messages-db.js", () => ({
  getMessageTail: mocks.getMessageTail,
  getMessageAround: mocks.getMessageAround,
  listMessages: mocks.listMessages,
}));

vi.mock("../../../database/usage-db.js", () => ({
  getSessionTotals: mocks.getSessionTotals,
  getLastTurn: mocks.getLastTurn,
  getContextWindow: mocks.getContextWindow,
}));

vi.mock("../../../database/compaction-db.js", () => ({
  getCompactionStatus: mocks.getCompactionStatus,
  listCompactionHistory: mocks.listCompactionHistory,
  getRetryableCompactJob: vi.fn(),
  probeCompactJobsReady: vi.fn(),
}));

vi.mock("../../../database/memory-db.js", () => ({
  listSessionMemories: mocks.listSessionMemories,
  getMemoryStats: mocks.getMemoryStats,
}));

vi.mock("../../../database/mission-runs-db.js", () => ({
  getActiveRunForSession: mocks.getActiveRunForSession,
}));

vi.mock("../../../database/approvals-db.js", () => ({
  listPendingForSession: mocks.listPendingForSession,
  listPendingAllApprovals: mocks.listPendingAllApprovals,
  getApprovalById: mocks.getApprovalById,
  getHistoryForSession: mocks.getHistoryForSession,
}));

vi.mock("../../../database/missions-db.js", () => ({
  getDraftForSession: mocks.getDraftForSession,
}));

vi.mock("../../../logger/index.js", () => ({ log: mocks.log }));

// S6: sessions.getModel probes the ENGINE inference config for reasoning
// support — mock the registry so the surface test never touches env/network.
vi.mock("@vex-agent/inference/registry.js", () => ({
  resolveProvider: mocks.resolveProvider,
}));

// D3/D7: sessions.getModel's PRIMARY reasoning source is the onboarding
// catalogue's reasoning-capability map — mock it too so this surface test
// never triggers a real `/models` fetch.
vi.mock("../../../onboarding/provider-model-catalog.js", () => ({
  getModelReasoningCapability: mocks.getModelReasoningCapability,
  loadProviderModelCatalog: mocks.loadProviderModelCatalog,
}));

vi.mock("../../../database/sessions-db.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSessionModelPick: mocks.getSessionModelPick,
}));

const { registerMessagesHandlers } = await import("../../messages.js");
const { registerUsageHandlers } = await import("../../usage.js");
const { registerCompactionHandlers } = await import("../../compaction.js");
const { registerMemoryHandlers } = await import("../../memory.js");
const { registerRuntimeHandlers } = await import("../../runtime.js");
const { registerMissionHandlers } = await import("../../mission.js");
const { registerApprovalsHandlers } = await import("../../approvals.js");
const { registerWalletsSessionHandlers } = await import("../../wallets-session.js");
const { registerModelsHandlers } = await import("../../models.js");
const { registerSessionsGetModelHandler } = await import("../../sessions/get-model.js");
const { CH } = await import("@shared/ipc/channels.js");

const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const SESSION = "00000000-0000-4000-8000-00000000fff1";

function untrustedSender(): TestIpcEvent {
  return {
    senderFrame: {
      url: "https://evil.example",
      parent: null,
      top: null as never,
    },
    sender: createTestWebContents(),
  };
}

beforeEach(() => {
  handlers.clear();
  vi.clearAllMocks();
  mocks.loadProviderModelCatalog.mockRejectedValue(new Error("catalogue offline"));
  mocks.getSessionModelPick.mockResolvedValue({ ok: true, data: null });
  registerMessagesHandlers();
  registerUsageHandlers();
  registerCompactionHandlers();
  registerMemoryHandlers();
  registerRuntimeHandlers();
  registerMissionHandlers();
  registerApprovalsHandlers();
  registerWalletsSessionHandlers();
  registerModelsHandlers();
  registerSessionsGetModelHandler();
});

afterEach(() => {
  handlers.clear();
  delete process.env.AGENT_PROVIDER;
  delete process.env.AGENT_MODEL;
  delete process.env.AGENT_CONTEXT_LIMIT;
});

type ResultShape = { ok: boolean; data?: unknown; error?: { code: string; domain: string } };

async function call(channel: string, payload: unknown): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn(trustedSender, { requestId: "test-corr", payload })) as ResultShape;
}

async function callUntrusted(channel: string, payload: unknown): Promise<ResultShape> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`Handler not registered: ${channel}`);
  return (await fn(untrustedSender(), {
    requestId: "test-corr",
    payload,
  })) as ResultShape;
}

describe("models handler", () => {
  it("returns unconfigured when AGENT_PROVIDER / AGENT_MODEL are absent", async () => {
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_MODEL;
    const result = await call(CH.models.listAvailable, {});
    expect(result.ok).toBe(true);
    expect((result.data as { source: string }).source).toBe("unconfigured");
    expect((result.data as { models: unknown[] }).models).toEqual([]);
    // Unconfigured never calls the reasoning-capability catalog — same
    // discipline as sessions.getModel's unconfigured branch below.
    expect(mocks.getModelReasoningCapability).not.toHaveBeenCalled();
  });

  it("returns global_default with single option when env present", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    const result = await call(CH.models.listAvailable, {});
    expect(result.ok).toBe(true);
    const data = result.data as { source: string; models: { modelId: string }[] };
    expect(data.source).toBe("global_default");
    expect(data.models).toHaveLength(1);
    expect(data.models[0]!.modelId).toBe("anthropic/claude-opus-4.7");
  });

  // E1: models.ts resolves `reasoning` via the SAME neutral resolver
  // sessions.getModel uses (reasoning-capability-resolver.ts) — no second
  // fallback chain, no separate catalog wiring.
  it("resolves the model's reasoning capability from the catalog", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    mocks.getModelReasoningCapability.mockResolvedValueOnce({
      reasoning: {
        supportedEfforts: ["high", "medium", "low", "none"],
        defaultEffort: "medium",
        defaultEnabled: true,
        mandatory: false,
      },
      supportsReasoningParameter: true,
    });
    const result = await call(CH.models.listAvailable, {});
    expect(result.ok).toBe(true);
    const data = result.data as { models: { reasoning: unknown }[] };
    expect(data.models[0]!.reasoning).toEqual({
      supportedEfforts: ["high", "medium", "low", "none"],
      defaultEffort: "medium",
      defaultEnabled: true,
      mandatory: false,
    });
  });

  // Fail-open: the catalog has no entry AND the pricing-proxy fallback is
  // unavailable (default `resolveProvider` mock resolves undefined/never
  // configured here) → reasoning stays null rather than throwing or
  // guessing a capability.
  it("fails open to reasoning: null when the capability catalog has no entry for the model", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "vendor/unknown-model";
    mocks.resolveProvider.mockResolvedValue(null);
    const result = await call(CH.models.listAvailable, {});
    expect(result.ok).toBe(true);
    const data = result.data as { models: { reasoning: unknown }[] };
    expect(data.models[0]!.reasoning).toBeNull();
  });
});

function catalogRow(modelId: string, prompt: string | null, contextLength: number | null) {
  return {
    modelId,
    displayName: modelId,
    providerId: modelId.slice(0, modelId.indexOf("/")),
    contextLength,
    pricingInputPerMillion: prompt,
    pricingOutputPerMillion: prompt === null ? null : "15",
  };
}

describe("models handler: the active backend's catalogue (F06)", () => {
  it("lists every row with the default FIRST and marked, exact prices kept", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-sonnet-4.5";
    mocks.loadProviderModelCatalog.mockResolvedValue({
      models: [
        catalogRow("openai/gpt-6-luna", "1.25", 1_050_000),
        catalogRow("anthropic/claude-sonnet-4.5", "3", 200_000),
        catalogRow("google/gemini-3.8-flash", "0.14375", null),
      ],
    });

    const result = await call(CH.models.listAvailable, {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      source: string;
      models: Array<{ modelId: string; isDefault: boolean; providerId: string; brand: string; pricingInputPerMillion: string | null; contextLength: number | null }>;
    };
    expect(data.source).toBe("catalog");
    expect(data.models.map((m) => [m.modelId, m.isDefault])).toEqual([
      ["anthropic/claude-sonnet-4.5", true],
      ["openai/gpt-6-luna", false],
      ["google/gemini-3.8-flash", false],
    ]);
    // The backend serves every row; the vendor is the brand.
    expect(data.models.every((m) => m.providerId === "openrouter")).toBe(true);
    expect(data.models[1]?.brand).toBe("openai");
    expect(data.models[2]?.pricingInputPerMillion).toBe("0.14375");
    expect(data.models[0]?.contextLength).toBe(200_000);
    expect(mocks.loadProviderModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ source: "openrouter" }),
    );
  });

  it("reads the Vex Inference allowlist in Vex Cloud mode", async () => {
    process.env.AGENT_PROVIDER = "vexcloud";
    process.env.AGENT_MODEL = "anthropic/claude-haiku-5.5";
    mocks.loadProviderModelCatalog.mockResolvedValue({
      models: [catalogRow("anthropic/claude-haiku-5.5", "1", 1_000_000)],
    });

    const result = await call(CH.models.listAvailable, {});
    const data = result.data as { models: Array<{ providerId: string }> };
    expect(mocks.loadProviderModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ source: "vexcloud" }),
    );
    expect(data.models[0]?.providerId).toBe("vexcloud");
  });

  it("still lists a default the catalogue no longer has, first", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "vendor/retired";
    mocks.loadProviderModelCatalog.mockResolvedValue({
      models: [catalogRow("openai/gpt-6-luna", "1.25", 1_050_000)],
    });

    const result = await call(CH.models.listAvailable, {});
    const data = result.data as { models: Array<{ modelId: string; isDefault: boolean; contextLength: number | null }> };
    expect(data.models[0]).toMatchObject({ modelId: "vendor/retired", isDefault: true, contextLength: null });
    expect(data.models).toHaveLength(2);
  });
});

describe("sessions.getModel: the session's own pick (F06)", () => {
  it("reports a pick made under the active backend as source session", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-sonnet-4.5";
    mocks.getSessionModelPick.mockResolvedValue({
      ok: true,
      data: { provider: "openrouter", modelId: "openai/gpt-6-luna", updatedAt: "2026-10-23T10:00:00.000Z" },
    });

    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.data).toMatchObject({
      source: "session",
      provider: "openrouter",
      modelId: "openai/gpt-6-luna",
      updatedAt: "2026-10-23T10:00:00.000Z",
    });
  });

  it("reports the default for a pick made under the other backend", async () => {
    process.env.AGENT_PROVIDER = "vexcloud";
    process.env.AGENT_MODEL = "anthropic/claude-haiku-5.5";
    mocks.getSessionModelPick.mockResolvedValue({
      ok: true,
      data: { provider: "openrouter", modelId: "openai/gpt-6-luna", updatedAt: "2026-10-23T10:00:00.000Z" },
    });

    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.data).toMatchObject({
      source: "global_default",
      modelId: "anthropic/claude-haiku-5.5",
      updatedAt: null,
    });
  });
});

// DRIFT PIN (S6 welcome-effort plan, risk item): both channels resolve
// reasoning capability through the SAME neutral resolver
// (reasoning-capability-resolver.ts) — this pins that models.listAvailable
// and sessions.getModel never diverge for the same configured model id.
describe("models.listAvailable and sessions.getModel drift pin", () => {
  it("return identical reasoning capability for the same model id", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    mocks.getModelReasoningCapability.mockResolvedValue({
      reasoning: {
        supportedEfforts: ["max", "high", "medium", "none"],
        defaultEffort: null,
        defaultEnabled: null,
        mandatory: false,
      },
      supportsReasoningParameter: true,
    });

    const modelsResult = await call(CH.models.listAvailable, {});
    const sessionResult = await call(CH.sessions.getModel, { sessionId: SESSION });

    expect(modelsResult.ok).toBe(true);
    expect(sessionResult.ok).toBe(true);
    const modelsReasoning = (
      modelsResult.data as { models: { reasoning: unknown }[] }
    ).models[0]!.reasoning;
    const sessionReasoning = (sessionResult.data as { reasoning: unknown }).reasoning;
    expect(modelsReasoning).toEqual(sessionReasoning);
  });
});

function providerWithReasoningPrice(reasoningPricePerM: number | null): {
  loadConfig: () => Promise<{ reasoningPricePerM: number | null }>;
} {
  return {
    loadConfig: async () => ({ reasoningPricePerM }),
  };
}

describe("sessions.getModel handler", () => {
  it("getModel returns global_default when env present", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    mocks.resolveProvider.mockResolvedValue(null);
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { source: string }).source).toBe("global_default");
  });

  it("getModel returns unconfigured when env absent", async () => {
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_MODEL;
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { source: string }).source).toBe("unconfigured");
    expect(
      (result.data as { supportsReasoning: boolean | null }).supportsReasoning,
    ).toBeNull();
  });

  // D3 fallback case 3 (capability catalog entry ABSENT — its own fetch
  // failed / mocked null by default above): falls back to the pre-S6
  // pricing-proxy probe for `supportsReasoning`; `reasoning` stays null.
  it("getModel reports supportsReasoning=true when the catalog prices reasoning (pricing-proxy fallback)", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    // Explicit no-entry default: an earlier test in this file (the drift
    // pin) leaves a PERSISTENT `mockResolvedValue` on this mock, which
    // `vi.clearAllMocks()` does not strip. Re-assert absence here so this
    // fallback test exercises the fallback regardless of run order.
    mocks.getModelReasoningCapability.mockResolvedValueOnce(null);
    mocks.resolveProvider.mockResolvedValue(providerWithReasoningPrice(15));
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(
      (result.data as { supportsReasoning: boolean | null }).supportsReasoning,
    ).toBe(true);
    expect((result.data as { reasoning: unknown }).reasoning).toBeNull();
  });

  it("getModel reports supportsReasoning=false when the catalog has no reasoning price (pricing-proxy fallback)", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "deepseek/deepseek-chat";
    // See the no-entry-default comment on the previous test.
    mocks.getModelReasoningCapability.mockResolvedValueOnce(null);
    mocks.resolveProvider.mockResolvedValue(providerWithReasoningPrice(null));
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(
      (result.data as { supportsReasoning: boolean | null }).supportsReasoning,
    ).toBe(false);
  });

  it("getModel degrades to supportsReasoning=null when both the catalog and the provider are unavailable", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    // See the no-entry-default comment two tests up.
    mocks.getModelReasoningCapability.mockResolvedValueOnce(null);
    mocks.resolveProvider.mockRejectedValue(new Error("vault locked"));
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { source: string }).source).toBe("global_default");
    expect(
      (result.data as { supportsReasoning: boolean | null }).supportsReasoning,
    ).toBeNull();
  });

  // D3 fallback case 1: capability entry present WITH normalized levels —
  // this is now the PRIMARY path; the pricing-proxy probe is never
  // consulted (resolveProvider stays unmocked/unset for this test).
  it("getModel resolves reasoning + supportsReasoning=true from the capability catalog when it has levels", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    mocks.getModelReasoningCapability.mockResolvedValueOnce({
      reasoning: {
        supportedEfforts: ["high", "medium", "low", "none"],
        defaultEffort: "medium",
        defaultEnabled: true,
        mandatory: false,
      },
      supportsReasoningParameter: true,
    });
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { supportsReasoning: boolean | null }).supportsReasoning).toBe(true);
    expect((result.data as { reasoning: { defaultEffort: string | null } }).reasoning).toEqual({
      supportedEfforts: ["high", "medium", "low", "none"],
      defaultEffort: "medium",
      defaultEnabled: true,
      mandatory: false,
    });
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  // D3 fallback case 2: capability entry present but WITHOUT levels
  // (`reasoning: null`) — boolean-only supportsReasoning from
  // `supportsReasoningParameter`, still never falling back to pricing.
  it("getModel resolves supportsReasoning=true with no selector when the capability entry has no levels", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "vendor/reasoning-flag-only";
    mocks.getModelReasoningCapability.mockResolvedValueOnce({
      reasoning: null,
      supportsReasoningParameter: true,
    });
    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { supportsReasoning: boolean | null }).supportsReasoning).toBe(true);
    expect((result.data as { reasoning: unknown }).reasoning).toBeNull();
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });

  it("getModel's unconfigured branch never calls the reasoning-capability catalog", async () => {
    delete process.env.AGENT_PROVIDER;
    delete process.env.AGENT_MODEL;
    await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(mocks.getModelReasoningCapability).not.toHaveBeenCalled();
  });

  // D7 verification pin: the handler AWAITS the bounded capability fetch —
  // a cold/slow catalog fetch delays the response instead of returning
  // "unknown" early and relying on a later renderer refetch to pick it up.
  it("D7: resolves only after the bounded capability fetch responds, and carries the resolved capability", async () => {
    vi.useFakeTimers();
    try {
      process.env.AGENT_PROVIDER = "openrouter";
      process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
      let resolveCapability!: (value: unknown) => void;
      mocks.getModelReasoningCapability.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCapability = resolve;
        }),
      );

      const pending = call(CH.sessions.getModel, { sessionId: SESSION });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);

      resolveCapability({
        reasoning: {
          supportedEfforts: ["high", "none"],
          defaultEffort: null,
          defaultEnabled: null,
          mandatory: false,
        },
        supportsReasoningParameter: true,
      });

      const result = await pending;
      expect(result.ok).toBe(true);
      expect((result.data as { reasoning: unknown }).reasoning).toEqual({
        supportedEfforts: ["high", "none"],
        defaultEffort: null,
        defaultEnabled: null,
        mandatory: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // Cleanup item (fix-wave): a caller abort must propagate instead of being
  // swallowed into the pricing-proxy fallback — `registerHandler` then
  // normalises it to the canonical `internal.cancelled` Result.
  it("propagates a caller abort from the capability fetch as internal.cancelled instead of falling back to the pricing probe", async () => {
    process.env.AGENT_PROVIDER = "openrouter";
    process.env.AGENT_MODEL = "anthropic/claude-opus-4.7";
    mocks.getModelReasoningCapability.mockRejectedValueOnce(
      Object.assign(new Error("Catalogue request cancelled"), { name: "AbortError" }),
    );

    const result = await call(CH.sessions.getModel, { sessionId: SESSION });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.cancelled");
    expect(mocks.resolveProvider).not.toHaveBeenCalled();
  });
});
