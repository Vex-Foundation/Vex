/**
 * Unit tests for the long_memory_search / get / history handlers (S3). The DB
 * repos and the embeddings client are mocked, so these tests exercise only the
 * handler control flow — embed → recall both stores → blend → inline cap +
 * truncate-with-steering → format — never a real database or embeddings service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_DIM = 8;
const TEST_PROVIDER_MODEL = "ai/embeddinggemma:300M-Q8_0";

// ── Mocks ─────────────────────────────────────────────────────────

const mockRecallLongMemoryTopK = vi.fn();
const mockGetById = vi.fn();
const mockGetLineageChain = vi.fn();
const mockGetActiveEntriesByIds = vi.fn();
vi.mock("@vex-agent/db/repos/knowledge.js", () => ({
  recallLongMemoryTopK: (...args: unknown[]) => mockRecallLongMemoryTopK(...args),
  getById: (...args: unknown[]) => mockGetById(...args),
  getLineageChain: (...args: unknown[]) => mockGetLineageChain(...args),
  getActiveEntriesByIds: (...args: unknown[]) => mockGetActiveEntriesByIds(...args),
}));

const mockRecallCandidatesTopK = vi.fn();
vi.mock("@vex-agent/db/repos/memory-candidates/index.js", () => ({
  recallCandidatesTopK: (...args: unknown[]) => mockRecallCandidatesTopK(...args),
}));

// S8 graph-expansion repos (default: empty graph — expansion adds nothing).
const mockListEntityIdsForEntries = vi.fn();
const mockListEntryIdsForEntities = vi.fn();
vi.mock("@vex-agent/db/repos/memory-entry-entities/index.js", () => ({
  listEntityIdsForEntries: (...args: unknown[]) => mockListEntityIdsForEntries(...args),
  listEntryIdsForEntities: (...args: unknown[]) => mockListEntryIdsForEntities(...args),
}));

const mockListActiveEdgesForEntities = vi.fn();
vi.mock("@vex-agent/db/repos/memory-edges/index.js", () => ({
  listActiveEdgesForEntities: (...args: unknown[]) => mockListActiveEdgesForEntities(...args),
}));

const mockEmbedQuery = vi.fn();
vi.mock("@vex-agent/embeddings/client.js", () => ({
  embedQuery: (...args: unknown[]) => mockEmbedQuery(...args),
}));

const mockLoadEmbeddingConfig = vi.fn(() => ({
  baseUrl: "http://localhost:12434/engines/llama.cpp/v1",
  model: TEST_PROVIDER_MODEL,
  dim: TEST_DIM,
  provider: "local",
}));
vi.mock("@vex-agent/embeddings/config.js", () => ({
  loadEmbeddingConfig: () => mockLoadEmbeddingConfig(),
}));

const mockMemLog = vi.fn();
vi.mock("@vex-agent/memory/observability/logger.js", () => ({
  memLog: Object.assign((...args: unknown[]) => mockMemLog(...args), {
    warn: (...args: unknown[]) => mockMemLog(...args),
    error: (...args: unknown[]) => mockMemLog(...args),
  }),
}));

import { handleLongMemorySearch } from "@vex-agent/tools/internal/long-memory/search.js";
import { handleLongMemoryGet } from "@vex-agent/tools/internal/long-memory/get.js";
import { handleLongMemoryHistory } from "@vex-agent/tools/internal/long-memory/history.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { LONG_MEMORY_INLINE_CHARS_CAP } from "@vex-agent/memory/long-memory-retrieval-policy.js";

// ── Helpers ───────────────────────────────────────────────────────

function ctx(): InternalToolContext {
  return { sessionId: "session-1", loadedDocuments: new Map<string, string>() } as unknown as InternalToolContext;
}

function vector(): number[] {
  return Array.from({ length: TEST_DIM }, (_, i) => i / TEST_DIM);
}

/** A long-memory recall candidate (shape of recallLongMemoryTopK rows). */
function knowledgeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    kind: "risk_rule",
    title: "Position sizing rule",
    summary: "Keep risk under 2% per trade.",
    contentMd: "Full body.",
    similarity: 0.8,
    confidence: 0.9,
    status: "active",
    pinned: false,
    validUntil: null,
    validFrom: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-06-01T00:00:00.000Z"),
    sourceRefs: {},
    tags: ["risk"],
    source: "observed",
    maturityState: "established",
    ...overrides,
  };
}

/** A dual-trace candidate recall row (shape of recallCandidatesTopK rows). */
function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    kind: "trade_lesson",
    title: "Fresh signal",
    summary: "A fresh un-consolidated observation.",
    contentMd: "",
    tags: [],
    evidenceRefs: [],
    source: "observed",
    retrievalUntil: null,
    similarity: 0.7,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEmbedQuery.mockResolvedValue({ embedding: vector(), providerModel: TEST_PROVIDER_MODEL });
  mockRecallLongMemoryTopK.mockResolvedValue([knowledgeRow()]);
  mockRecallCandidatesTopK.mockResolvedValue([candidateRow()]);
  // Empty graph by default: expansion (ON by default — F3) finds nothing.
  mockListEntityIdsForEntries.mockResolvedValue([]);
  mockListActiveEdgesForEntities.mockResolvedValue([]);
  mockListEntryIdsForEntities.mockResolvedValue([]);
  mockGetActiveEntriesByIds.mockResolvedValue([]);
});

// ── search: blended union ─────────────────────────────────────────

describe("long_memory_search — blended recall", () => {
  it("embeds the query and returns a blended union tagged by source", async () => {
    const res = await handleLongMemorySearch({ query: "risk preferences" }, ctx());
    expect(res.success).toBe(true);
    expect(mockEmbedQuery).toHaveBeenCalledTimes(1);

    const data = JSON.parse(res.output);
    const sources = data.results.map((r: { source: string }) => r.source);
    expect(sources).toContain("long_memory");
    expect(sources).toContain("memory_candidate");
    // Confirmed knowledge (observed, sim 0.8 + boosts) ranks above the candidate
    // (sim 0.7 × 0.6).
    expect(data.results[0].source).toBe("long_memory");
  });

  it("passes the providerModel + embedding length as the recall filter for BOTH stores", async () => {
    await handleLongMemorySearch({ query: "x" }, ctx());
    const kFilter = mockRecallLongMemoryTopK.mock.calls[0]![1] as Record<string, unknown>;
    expect(kFilter.embeddingModel).toBe(TEST_PROVIDER_MODEL);
    expect(kFilter.embeddingDim).toBe(TEST_DIM);
    expect(kFilter.includeExpired).toBe(false);

    const cFilter = mockRecallCandidatesTopK.mock.calls[0]![1] as Record<string, unknown>;
    expect(cFilter.embeddingModel).toBe(TEST_PROVIDER_MODEL);
    expect(cFilter.embeddingDim).toBe(TEST_DIM);
  });

  it("marks candidate results notConsolidated", async () => {
    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);
    const cand = data.results.find((r: { source: string }) => r.source === "memory_candidate");
    expect(cand.notConsolidated).toBe(true);
  });
});

describe("long_memory_search — include_candidates flag", () => {
  it("returns only long_memory results when include_candidates is false", async () => {
    const res = await handleLongMemorySearch({ query: "x", include_candidates: false }, ctx());
    expect(mockRecallCandidatesTopK).not.toHaveBeenCalled();
    const data = JSON.parse(res.output);
    expect(data.results.every((r: { source: string }) => r.source === "long_memory")).toBe(true);
    expect(data.candidateCount).toBe(0);
  });
});

describe("long_memory_search — expand_graph (S8, default ON)", () => {
  /** Wire a 1-hop graph: entry 1 → entity e1 —edge→ entity e2 → entry 2. */
  function wireOneHopGraph(): void {
    mockListEntityIdsForEntries.mockResolvedValue([{ entryId: 1, entityId: "e1" }]);
    mockListActiveEdgesForEntities.mockResolvedValue([
      { sourceEntityId: "e1", targetEntityId: "e2" },
    ]);
    mockListEntryIdsForEntities.mockResolvedValue([
      { entryId: 2, entityId: "e2", entityName: "SOL" },
    ]);
    mockGetActiveEntriesByIds.mockResolvedValue([
      {
        id: 2,
        kind: "trade_lesson",
        title: "Neighbor via SOL",
        summary: "Reached through the graph.",
        source: "observed",
        maturityState: "established",
        activationStrength: 1,
        validUntil: null,
      },
    ]);
  }

  it("expands by default (F3): an empty graph adds nothing and changes nothing", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    const defaultOn = await handleLongMemorySearch({ query: "x" }, ctx());
    expect(mockListEntityIdsForEntries).toHaveBeenCalledTimes(1); // graph consulted by default
    const explicitlyOff = await handleLongMemorySearch({ query: "x", expand_graph: false }, ctx());
    const a = JSON.parse(defaultOn.output);
    const b = JSON.parse(explicitlyOff.output);
    expect(a.results.length).toBe(b.results.length);
    expect(a.truncated).toBe(false);
  });

  it("does not touch the graph repos when expand_graph is false", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    await handleLongMemorySearch({ query: "x", expand_graph: false }, ctx());
    expect(mockListEntityIdsForEntries).not.toHaveBeenCalled();
    expect(mockListActiveEdgesForEntities).not.toHaveBeenCalled();
    expect(mockGetActiveEntriesByIds).not.toHaveBeenCalled();
  });

  it("appends a 1-hop neighbor BELOW the direct hit, marked via_graph(entity), and logs graph_expanded", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    wireOneHopGraph();

    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);

    expect(data.results).toHaveLength(2);
    expect(data.results[0].id).toBe(1);
    expect(data.results[0].via).toBeUndefined();
    expect(data.results[1].id).toBe(2);
    expect(data.results[1].via).toBe("via_graph(SOL)");
    // Strictly below the seed (D-EXPAND: graph enriches, never dominates).
    expect(data.results[1].score).toBeLessThan(data.results[0].score);

    const expanded = mockMemLog.mock.calls.filter(
      (c) => c[0] === "search" && c[1] === "graph_expanded",
    );
    expect(expanded).toHaveLength(1);
    expect(expanded[0]![2]).toEqual({ expandedCount: 1, seedCount: 1 });
  });

  it("detailed format carries the marker too, with empty contentMd (bounded pointer)", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    wireOneHopGraph();
    const res = await handleLongMemorySearch({ query: "x", response_format: "detailed" }, ctx());
    const data = JSON.parse(res.output);
    const neighbor = data.results[1];
    expect(neighbor.via).toBe("via_graph(SOL)");
    expect(neighbor.contentMd).toBe("");
  });

  it("never evicts a direct result: a full inline cap leaves zero slots for expansion", async () => {
    // 12 direct hits (above the inline cap of 10) → expansion has no free slot
    // and must not even fan out to the graph.
    const many = Array.from({ length: 12 }, (_, i) =>
      knowledgeRow({ id: i + 1, similarity: 0.9 - i * 0.01 }),
    );
    mockRecallLongMemoryTopK.mockResolvedValue(many);
    mockRecallCandidatesTopK.mockResolvedValue([]);
    wireOneHopGraph();

    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);
    expect(data.count).toBe(10);
    expect(data.results.every((r: { via?: string }) => r.via === undefined)).toBe(true);
    expect(mockListEntityIdsForEntries).not.toHaveBeenCalled(); // zero slots → graph untouched
    expect(data.droppedCount).toBe(2);
    expect(data.droppedDirect).toBe(2);
    expect(data.droppedExpansion).toBe(0);
  });

  it("splits droppedCount into direct vs expansion and logs graph_expansion_truncated", async () => {
    // 1 direct hit + 7 graph neighbors: MAX_RESULTS (5) caps the expansion →
    // 2 expansion drops, 0 direct drops.
    mockRecallCandidatesTopK.mockResolvedValue([]);
    mockListEntityIdsForEntries.mockResolvedValue([{ entryId: 1, entityId: "e1" }]);
    mockListActiveEdgesForEntities.mockResolvedValue([
      { sourceEntityId: "e1", targetEntityId: "e2" },
    ]);
    const refs = Array.from({ length: 7 }, (_, i) => ({
      entryId: 100 + i,
      entityId: "e2",
      entityName: "SOL",
    }));
    mockListEntryIdsForEntities.mockResolvedValue(refs);
    mockGetActiveEntriesByIds.mockResolvedValue(
      refs.map((r) => ({
        id: r.entryId,
        kind: "trade_lesson",
        title: `Neighbor ${r.entryId}`,
        summary: "s",
        source: "observed",
        maturityState: "established",
        activationStrength: 1,
        validUntil: null,
      })),
    );

    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);
    expect(data.count).toBe(6); // 1 direct + 5 expansion (GRAPH_EXPANSION_MAX_RESULTS)
    expect(data.truncated).toBe(true);
    expect(data.droppedCount).toBe(2);
    expect(data.droppedDirect).toBe(0);
    expect(data.droppedExpansion).toBe(2);

    const truncated = mockMemLog.mock.calls.filter(
      (c) => c[0] === "search" && c[1] === "graph_expansion_truncated",
    );
    expect(truncated).toHaveLength(1);
    expect(truncated[0]![2]).toEqual({ count: 2 });
    // Direct truncation did NOT fire.
    expect(
      mockMemLog.mock.calls.filter((c) => c[0] === "search" && c[1] === "truncated"),
    ).toHaveLength(0);
  });

  it("fails open: a graph repo error never fails the search", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    mockListEntityIdsForEntries.mockRejectedValue(new Error("graph db down"));
    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output);
    expect(data.results).toHaveLength(1); // the direct hit still serves
    const warned = mockMemLog.mock.calls.filter(
      (c) => c[0] === "search" && c[1] === "graph_expansion_failed",
    );
    expect(warned).toHaveLength(1);
  });

  it("tells the model the result set is degraded when expansion fails (0R.15)", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    mockListEntityIdsForEntries.mockRejectedValue(new Error("graph db down"));
    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output);
    // The fail-open is unchanged (direct hits still serve) — but it is no
    // longer SILENT: the narrower set is marked as a degradation.
    expect(data.results).toHaveLength(1);
    expect(data.expansionDegraded).toBe(true);
    expect(typeof data.expansionNote).toBe("string");
    expect(data.expansionNote).toContain("graph expansion");
  });

  it("does not mark a healthy expansion as degraded", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);
    expect(data.expansionDegraded).toBeUndefined();
    expect(data.expansionNote).toBeUndefined();
  });

  it("does not mark a search that never attempted expansion", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    mockListEntityIdsForEntries.mockRejectedValue(new Error("graph db down"));
    const res = await handleLongMemorySearch({ query: "x", expand_graph: false }, ctx());
    const data = JSON.parse(res.output);
    expect(mockListEntityIdsForEntries).not.toHaveBeenCalled();
    expect(data.expansionDegraded).toBeUndefined();
  });
});

describe("long_memory_search — truncation with steering (no silent drop)", () => {
  it("truncates to the inline cap, emits search.truncated, and adds a steering hint", async () => {
    // 12 knowledge entries (above the inline cap of 10), all active/observed.
    const many = Array.from({ length: 12 }, (_, i) =>
      knowledgeRow({ id: i + 1, similarity: 0.9 - i * 0.01 }),
    );
    mockRecallLongMemoryTopK.mockResolvedValue(many);
    mockRecallCandidatesTopK.mockResolvedValue([]);

    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);

    expect(data.count).toBe(10);
    expect(data.truncated).toBe(true);
    expect(data.droppedCount).toBe(2);
    expect(data.steering).toMatch(/refine your query/);

    const truncatedEvents = mockMemLog.mock.calls.filter(
      (c) => c[0] === "search" && c[1] === "truncated",
    );
    expect(truncatedEvents).toHaveLength(1);
    expect(truncatedEvents[0]![2]).toEqual({ count: 2 });
  });

  it("does not emit search.truncated when the set fits inline", async () => {
    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    const data = JSON.parse(res.output);
    expect(data.truncated).toBe(false);
    const truncatedEvents = mockMemLog.mock.calls.filter(
      (c) => c[0] === "search" && c[1] === "truncated",
    );
    expect(truncatedEvents).toHaveLength(0);
  });

  it("does not apply the chars cap to a concise response (concise omits contentMd)", async () => {
    // 5 entries, each contentMd alone busts the 50KB chars cap; concise must
    // still return all 5 (under the count cap) because it never sends contentMd.
    const big = "x".repeat(LONG_MEMORY_INLINE_CHARS_CAP);
    const rows = Array.from({ length: 5 }, (_, i) =>
      knowledgeRow({ id: i + 1, similarity: 0.9 - i * 0.01, contentMd: big }),
    );
    mockRecallLongMemoryTopK.mockResolvedValue(rows);
    mockRecallCandidatesTopK.mockResolvedValue([]);
    const res = await handleLongMemorySearch({ query: "x", response_format: "concise" }, ctx());
    const data = JSON.parse(res.output);
    expect(data.count).toBe(5);
    expect(data.truncated).toBe(false);
  });
});

describe("long_memory_search — response shapes", () => {
  it("concise omits content/summary detail", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    const res = await handleLongMemorySearch({ query: "x", response_format: "concise" }, ctx());
    const data = JSON.parse(res.output);
    const item = data.results[0];
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("similarity");
    expect(item).toHaveProperty("score");
    expect(item).not.toHaveProperty("contentMd");
    expect(item).not.toHaveProperty("summary");
  });

  it("detailed adds summary, content, tags, maturity, source tier", async () => {
    mockRecallCandidatesTopK.mockResolvedValue([]);
    const res = await handleLongMemorySearch({ query: "x", response_format: "detailed" }, ctx());
    const data = JSON.parse(res.output);
    const item = data.results[0];
    expect(item).toHaveProperty("summary");
    expect(item).toHaveProperty("contentMd");
    expect(item).toHaveProperty("tags");
    expect(item).toHaveProperty("maturityState");
    expect(item).toHaveProperty("sourceTier");
  });
});

describe("long_memory_search — empty + failure paths", () => {
  it("returns a clean nothing-found steering message when no memory matches", async () => {
    mockRecallLongMemoryTopK.mockResolvedValue([]);
    mockRecallCandidatesTopK.mockResolvedValue([]);
    const res = await handleLongMemorySearch({ query: "nothing" }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/No long-term memory matched/);
  });

  it("fails loud on an embedding outage (no fallback)", async () => {
    mockEmbedQuery.mockRejectedValue(new Error("sidecar down"));
    const res = await handleLongMemorySearch({ query: "x" }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/embedding service unavailable/);
    expect(mockRecallLongMemoryTopK).not.toHaveBeenCalled();
  });

  it("rejects an empty query at the boundary", async () => {
    const res = await handleLongMemorySearch({ query: "" }, ctx());
    expect(res.success).toBe(false);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });

  it("rejects an unknown param with a steering message (no silent drop)", async () => {
    // A removed/typo'd param like `scope` must be REJECTED, not silently ignored,
    // so the agent gets actionable feedback (final-gate fix).
    const res = await handleLongMemorySearch({ query: "x", scope: "all" }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/unknown parameter/i);
    expect(res.output).toMatch(/scope/);
    expect(mockEmbedQuery).not.toHaveBeenCalled();
  });
});

// ── get ───────────────────────────────────────────────────────────

describe("long_memory_get", () => {
  /** A full active entry as knowledgeRepo.getById returns it. */
  function activeEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: 5,
      kind: "risk_rule",
      title: "T",
      summary: "S",
      contentMd: "BODY",
      tags: [],
      sourceRefs: {},
      confidence: null,
      status: "active",
      pinned: false,
      validUntil: null,
      source: "observed",
      maturityState: "established",
      supersedesId: null,
      supersededBy: null,
      statusReason: null,
      changeSummary: null,
      whatFailed: null,
      ...overrides,
    };
  }

  it("concise (default): omits contentMd from output but still loads the body into context", async () => {
    mockGetById.mockResolvedValue(activeEntry());
    const context = ctx();
    // No response_format → server-side default is now 'concise' (no double-emission).
    const res = await handleLongMemoryGet({ id: 5 }, context);
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output);
    expect(data.id).toBe(5);
    // Concise keeps the navigation/lineage metadata…
    expect(data.kind).toBe("risk_rule");
    expect(data.title).toBe("T");
    expect(data.summary).toBe("S");
    expect(data.status).toBe("active");
    expect(data.supersedesId).toBeNull();
    expect(data.supersededBy).toBeNull();
    // …but the body is NOT inlined in the tool output (it goes through loadedDocuments only).
    expect(res.output).not.toContain("BODY");
    expect(data).not.toHaveProperty("contentMd");
    expect(data).not.toHaveProperty("tags");
    // The body is still injected into context — single source of the content.
    expect(context.loadedDocuments.get("long_memory:5")).toBe("BODY");
  });

  it("detailed (opt-in): inlines contentMd in the output and still loads the body into context", async () => {
    mockGetById.mockResolvedValue(activeEntry());
    const context = ctx();
    const res = await handleLongMemoryGet({ id: 5, response_format: "detailed" }, context);
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output);
    expect(data.id).toBe(5);
    // Detailed re-inlines the full body + metadata bag.
    expect(res.output).toContain("BODY");
    expect(data.contentMd).toBe("BODY");
    expect(data).toHaveProperty("tags");
    // Body still injected regardless of format.
    expect(context.loadedDocuments.get("long_memory:5")).toBe("BODY");
  });

  it("steers to the successor when the entry was superseded", async () => {
    mockGetById.mockResolvedValue({
      id: 5,
      status: "superseded",
      supersededBy: 9,
      contentMd: "x",
    });
    const res = await handleLongMemoryGet({ id: 5 }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/entry 9/);
  });

  it("returns a not-found steering message for a missing id", async () => {
    mockGetById.mockResolvedValue(null);
    const res = await handleLongMemoryGet({ id: 404 }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/not found/);
  });
});

// ── history ───────────────────────────────────────────────────────

describe("long_memory_history", () => {
  it("returns the lineage chain merged with the entry's reinforcement fields", async () => {
    mockGetLineageChain.mockResolvedValue({
      requestedId: 5,
      headId: 9,
      headStatus: "active",
      chain: [
        { id: 5, kind: "k", title: "old", status: "superseded", supersedesId: null },
        { id: 9, kind: "k", title: "new", status: "active", supersedesId: 5 },
      ],
    });
    mockGetById.mockResolvedValue({
      id: 5,
      firstPromotedAt: "2026-05-01T00:00:00.000Z",
      lastReinforcedAt: "2026-06-01T00:00:00.000Z",
      outcomeVersion: 3,
      maturityState: "reinforced",
    });

    const res = await handleLongMemoryHistory({ id: 5 }, ctx());
    expect(res.success).toBe(true);
    const data = JSON.parse(res.output);
    expect(data.chainLength).toBe(2);
    expect(data.headId).toBe(9);
    expect(data.reinforcement.firstPromotedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(data.reinforcement.lastReinforcedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(data.reinforcement.outcomeVersion).toBe(3);
  });

  it("returns a not-found steering message when the chain is empty", async () => {
    mockGetLineageChain.mockResolvedValue(null);
    const res = await handleLongMemoryHistory({ id: 404 }, ctx());
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/not found/);
  });
});
