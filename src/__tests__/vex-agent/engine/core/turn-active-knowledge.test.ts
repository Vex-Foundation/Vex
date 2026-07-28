/**
 * Drift test — guards that what tool descriptions and policy decisions claim
 * about Active Memory and the Memory Layers actually appears in the final
 * provider messages sent to the inference provider.
 *
 * STRUCTURE+CACHE rewrite: the Active-Knowledge prefetch moved from
 * `executeTurn` into the memory façade (`memory.getTurnContext`, called once
 * in `buildTurnPromptStack`), and the rendered content now lives in the
 * `# Memory` section of the TURN-STATE segment (the trailing system message,
 * cacheHint "turn_state") instead of messages[0]. The drift-guard intent is
 * preserved: repo limits (12/30) are pinned, repo content must reach the
 * prompt that the provider actually receives, and a repo failure must not
 * crash the turn.
 *
 * Seam: façade (mocked repos) → buildMemorySection → executeTurn's
 * providerMessages turn-state segment.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAddMessage = vi.fn();
const mockLogUsage = vi.fn();
const mockUpdateTokenCount = vi.fn();
const mockListActive = vi.fn().mockResolvedValue([]);
const mockListKinds = vi.fn().mockResolvedValue([]);

vi.mock("@vex-agent/db/repos/messages.js", () => ({
  addMessage: (...a: unknown[]) => mockAddMessage(...a),
  addEngineMessage: vi.fn(),
  getLiveMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("@vex-agent/db/repos/usage.js", () => ({
  logUsage: (...a: unknown[]) => mockLogUsage(...a),
}));

vi.mock("@vex-agent/db/repos/sessions.js", () => ({
  updateTokenCount: (...a: unknown[]) => mockUpdateTokenCount(...a),
  getSession: vi.fn(),
}));

vi.mock("@vex-agent/db/repos/knowledge.js", () => ({
  listActiveForHotContext: (...a: unknown[]) => mockListActive(...a),
  listKnownKinds: (...a: unknown[]) => mockListKinds(...a),
  countActiveHotContextEntries: vi.fn().mockResolvedValue(0),
}));

vi.mock("@vex-agent/db/repos/session-memories/index.js", () => ({
  getSessionMemoryStats: vi.fn().mockResolvedValue({
    activeCount: 0,
    compactCount: 0,
    recentThemes: [],
    unresolvedOutstandingCount: 0,
  }),
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

const { executeTurn } = await import("@vex-agent/engine/core/turn.js");
const { getTurnContext } = await import("@vex-agent/memory/turn-context.js");
const { buildMemorySection } = await import("@vex-agent/engine/prompts/memory-section.js");

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

function makeProvider() {
  return {
    chatCompletion: vi.fn().mockResolvedValue({
      content: "ok",
      toolCalls: null,
      usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, reasoningTokens: 0 },
    }),
    calculateCost: vi.fn().mockReturnValue({
      totalCost: 0.001,
      currency: "USD",
      breakdown: { promptCost: 0, completionCost: 0, cachedSavings: 0, reasoningCost: 0 },
    }),
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

/**
 * Run the production seam: façade → memory section → executeTurn, and
 * return the TURN-STATE segment of the captured provider messages (the
 * trailing system message — where the `# Memory` section now lives).
 */
async function runTurnAndGetTurnState(
  provider: ReturnType<typeof makeProvider>,
): Promise<string> {
  const memoryCtx = await getTurnContext({ sessionId: "session-1" });
  const memorySection = buildMemorySection(memoryCtx);
  await executeTurn(
    makeContext(), [], null, provider as any, makeConfig() as any, [],
    { memorySection },
  );
  const [providerMessages] = provider.chatCompletion.mock.calls[0]!;
  const last = providerMessages[providerMessages.length - 1];
  expect(last.role).toBe("system");
  expect(last.cacheHint).toBe("turn_state");
  return last.content as string;
}

function getStaticPrompt(provider: ReturnType<typeof makeProvider>): string {
  const [providerMessages] = provider.chatCompletion.mock.calls[0]!;
  return providerMessages[0].content as string;
}

describe("turn — Active Memory drift guard (façade + memory-section seam)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListActive.mockResolvedValue([]);
    mockListKinds.mockResolvedValue([]);
  });

  // ── Active Memory block injection ────────────────────────────

  it("turn state does NOT include '# Active Memory' when both repo lists are empty", async () => {
    const provider = makeProvider();
    const turnState = await runTurnAndGetTurnState(provider);
    expect(turnState).not.toContain("## Active Memory");
    // Routing doctrine is invariant and now renders once in the STATIC
    // `# Memory & Learning` layer, so it is deliberately absent from the turn
    // state; the `# Memory` header still anchors the volatile section.
    expect(turnState).not.toContain("## Memory Routing");
    expect(turnState).toContain("# Memory");
  });

  it("turn state includes '# Active Memory' when repo returns hot-context entries", async () => {
    mockListActive.mockResolvedValue([
      {
        id: 42,
        kind: "pumpfun_entry_pattern",
        title: "low-holder pump entry",
        summary: "Tokens with under 50 holders show short-term continuation",
        pinned: false,
        validUntil: "2026-04-13T12:00:00Z",
        updatedAt: "2026-04-06T12:00:00Z",
      },
    ]);
    const provider = makeProvider();
    const turnState = await runTurnAndGetTurnState(provider);
    expect(turnState).toContain("## Active Memory");
    expect(turnState).toContain("pumpfun_entry_pattern");
    expect(turnState).toContain("low-holder pump entry");
  });

  it("turn state includes 'Known kinds' section when repo returns kind taxonomy", async () => {
    mockListKinds.mockResolvedValue([
      { kind: "pumpfun_entry_pattern", count: 12 },
      { kind: "risk_rule", count: 3 },
    ]);
    const provider = makeProvider();
    const turnState = await runTurnAndGetTurnState(provider);
    expect(turnState).toContain("Known kinds");
    expect(turnState).toContain("pumpfun_entry_pattern (12)");
    expect(turnState).toContain("risk_rule (3)");
  });

  // ── Memory & Learning drift guards (static prefix) ───────────
  //
  // P3 decomposition: the old `## 5. Memory Layers` sub-section of tool-usage.ts
  // became the standalone `# Memory & Learning` static layer (memory-policy.ts).
  // Allowed-delta B in the P3 rubric — same policy, single home.

  it("static prefix always includes the Memory & Learning section (P3 — was tool-usage §5 Memory Layers)", async () => {
    const provider = makeProvider();
    await runTurnAndGetTurnState(provider);
    const staticPrompt = getStaticPrompt(provider);
    expect(staticPrompt).toContain("# Memory & Learning");
  });

  it("Memory & Learning section explicitly says persisted memory is English-only (decision #23)", async () => {
    const provider = makeProvider();
    await runTurnAndGetTurnState(provider);
    const staticPrompt = getStaticPrompt(provider);
    const memIdx = staticPrompt.indexOf("# Memory & Learning");
    expect(memIdx).toBeGreaterThan(0);
    const memSection = staticPrompt.slice(memIdx);
    expect(memSection).toMatch(/English-by-contract|ENGLISH-ONLY|English-only/);
  });

  it("reuse-existing-kinds rule survived the cutover (decision #7 — on long_memory_suggest's kind param)", async () => {
    const provider = makeProvider();
    await runTurnAndGetTurnState(provider);
    const { getToolDef } = await import(
      "../../../../vex-agent/tools/registry.js"
    );
    const suggestDef = getToolDef("long_memory_suggest");
    const kindDescription = suggestDef?.parameters.properties?.kind?.description ?? "";
    expect(kindDescription.toLowerCase()).toContain("reuse an existing kind");
  });

  // ── Fetch limits (pinned through the façade) ─────────────────

  it("façade calls listActiveForHotContext with limit 12 and listKnownKinds with limit 30", async () => {
    const provider = makeProvider();
    await runTurnAndGetTurnState(provider);
    expect(mockListActive).toHaveBeenCalledWith({ limit: 12 });
    expect(mockListKinds).toHaveBeenCalledWith({ limit: 30 });
  });

  // ── Fail-soft ────────────────────────────────────────────────

  it("does not crash the turn when the knowledge repo throws (fail-soft, lines omitted)", async () => {
    mockListActive.mockRejectedValueOnce(new Error("DB unavailable"));
    const provider = makeProvider();
    const turnState = await runTurnAndGetTurnState(provider);
    // Turn proceeded; the failed branch's lines are OMITTED (no fake
    // empty-state guidance), routing remains.
    expect(provider.chatCompletion).toHaveBeenCalled();
    expect(turnState).not.toContain("[Long-term memory:");
    expect(turnState).not.toContain("Skip long_memory_search");
    expect(turnState).not.toContain("## Memory Routing");
  });
});
