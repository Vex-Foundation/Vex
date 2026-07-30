/**
 * MEASURED OBJECT === SENT OBJECT (the hard Stage-4 requirement).
 *
 * `buildTurnEnvelope` is not reproducible — the turn-state segment embeds
 * `Current time UTC`, so two builds of identical inputs differ. The C8 byte
 * ceiling therefore measures an envelope OBJECT and hands THAT OBJECT to
 * `executeTurn`. If `executeTurn` rebuilt instead, the ceiling would be a
 * statement about a request that was never issued — and the whole point of
 * bypassing the barrier safely would be lost.
 *
 * These tests assert REFERENCE IDENTITY, not deep equality. Deep equality would
 * pass for a rebuild that happened to land in the same millisecond, which is
 * exactly the flaky false-negative this guard must not have.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProviderMessage } from "../../../../vex-agent/inference/types.js";

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: vi.fn(),
  addEngineMessage: vi.fn(),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));
vi.mock("@vex-agent/db/repos/usage.js", () => ({ logUsage: vi.fn() }));
vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));
vi.mock("@vex-agent/tools/protocols/catalog.js", () => ({
  PROTOCOL_TOOLS: [],
  PROTOCOL_NAMESPACE_ALLOWLIST: [],
}));

const { executeTurn } = await import("../../../../vex-agent/engine/core/turn.js");
const { buildTurnEnvelope } = await import(
  "../../../../vex-agent/engine/core/turn-envelope.js"
);

function makeContext() {
  return {
    sessionId: "session-1",
    sessionKind: "agent" as const,
    sessionPermission: "restricted" as const,
    missionId: null,
    missionRunId: null,
    selectedEvmWallet: null,
    selectedSolanaWallet: null,
    walletPolicy: { kind: "none" as const },
    loadedDocuments: new Map<string, string>(),
  };
}

function makeConfig() {
  return {
    provider: "openrouter",
    model: "anthropic/claude-sonnet-4",
    contextLimit: 128000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
  };
}

function makeProvider() {
  return {
    chatCompletion: vi.fn().mockResolvedValue({
      content: "ok",
      toolCalls: null,
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    }),
    chatCompletionSimple: vi.fn(),
    calculateCost: vi.fn().mockReturnValue({
      totalCost: 0,
      currency: "USD",
      breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
    }),
  };
}

const TAPE = [{ role: "user" as const, content: "hello", timestamp: "t1" }];

describe("executeTurn — prebuilt envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the EXACT array instance it was given (reference identity)", async () => {
    const prebuilt = buildTurnEnvelope(makeContext() as never, TAPE as never, null);
    const provider = makeProvider();

    await executeTurn(
      makeContext() as never,
      TAPE as never,
      null,
      provider as never,
      makeConfig() as never,
      [],
      {},
      undefined,
      prebuilt,
    );

    const [sentMessages] = provider.chatCompletion.mock.calls[0]!;
    expect(sentMessages).toBe(prebuilt.providerMessages);
  });

  it("does NOT rebuild — a sentinel injected into the prebuilt envelope reaches the provider", async () => {
    const prebuilt = buildTurnEnvelope(makeContext() as never, TAPE as never, null);
    const sentinel: ProviderMessage = {
      role: "system",
      content: "SENTINEL-ONLY-IN-THE-MEASURED-OBJECT",
    };
    prebuilt.providerMessages.splice(1, 0, sentinel);

    const provider = makeProvider();
    await executeTurn(
      makeContext() as never,
      TAPE as never,
      null,
      provider as never,
      makeConfig() as never,
      [],
      {},
      undefined,
      prebuilt,
    );

    const [sentMessages] = provider.chatCompletion.mock.calls[0]! as [ProviderMessage[]];
    expect(sentMessages).toContain(sentinel);
    expect(sentMessages.some((m) => m.content.includes("SENTINEL"))).toBe(true);
  });

  it("WITHOUT a prebuilt envelope it still builds its own (every existing caller unchanged)", async () => {
    const provider = makeProvider();

    await executeTurn(
      makeContext() as never,
      TAPE as never,
      null,
      provider as never,
      makeConfig() as never,
      [],
    );

    const [sentMessages] = provider.chatCompletion.mock.calls[0]! as [ProviderMessage[]];
    expect(sentMessages.length).toBeGreaterThan(0);
    expect(sentMessages[0]!.cacheHint).toBe("static_prefix");
  });

  it("two independent builds are NOT interchangeable — which is why identity matters", async () => {
    // Documents the non-reproducibility this whole mechanism exists for.
    const a = buildTurnEnvelope(makeContext() as never, TAPE as never, null);
    const b = buildTurnEnvelope(makeContext() as never, TAPE as never, null);

    expect(a.providerMessages).not.toBe(b.providerMessages);
    const turnStateOf = (e: typeof a) =>
      e.providerMessages[e.providerMessages.length - 1]!.content;
    expect(turnStateOf(a)).toContain("Current time UTC:");
    expect(turnStateOf(b)).toContain("Current time UTC:");
  });
});
