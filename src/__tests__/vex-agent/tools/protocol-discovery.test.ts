import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { discoverProtocolCapabilities } from "../../../vex-agent/tools/protocols/runtime.js";
import {
  PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST,
} from "../../../vex-agent/tools/protocols/catalog.js";
import { toModelDiscoveryResult } from "../../../vex-agent/tools/dispatcher/protocol-route.js";
import type { ProtocolDiscoveryResult } from "../../../vex-agent/tools/protocols/types.js";

describe("protocol discovery", () => {
  // Snapshot env-gating keys so each test sees a deterministic baseline.
  // Tests that exercise env-gating delete the relevant key explicitly.
  const ENV_KEYS = [
    "JUPITER_API_KEY",
    "POLYMARKET_API_KEY",
    "EMBEDDING_BASE_URL",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIM",
    "EMBEDDING_PROVIDER",
  ] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    process.env.JUPITER_API_KEY = "test-jupiter-key";
    delete process.env.EMBEDDING_BASE_URL;
    delete process.env.EMBEDDING_MODEL;
    delete process.env.EMBEDDING_DIM;
    delete process.env.EMBEDDING_PROVIDER;
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });
  // ── Basic discovery ──────────────────────────────────────────────

  it("returns tools with no filters", async () => {
    const result = await discoverProtocolCapabilities({});
    expect(result.success).toBe(true);
    expect(result.count).toBeGreaterThan(0);
    expect(result.totalCount).toBeGreaterThanOrEqual(result.count);
    expect(result.hasMore).toBe(result.totalCount > result.count);
  });

  it("returns tools with toolId, description, params", async () => {
    const result = await discoverProtocolCapabilities({});
    for (const tool of result.tools) {
      expect(tool.toolId).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(Array.isArray(tool.params)).toBe(true);
    }
  });

  // ── Namespace filter ─────────────────────────────────────────────

  it("filters by khalani namespace", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "khalani" });
    expect(result.count).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.namespace).toBe("khalani");
    }
  });

  it("rejects unknown namespaces", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "removed-namespace" });
    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  // Agent Scan plan v3 §11.2 (FIX3-W7, Codex final-review round 2 finding 2 /
  // C30): the hidden Uniswap fallback must not be discoverable pre-reveal —
  // NOT just hidden from the LLM tool list, but genuinely unreachable through
  // the discover_tools/execute_tool meta-tool path (the sanctioned path is the
  // `swap_quote_uniswap`/`swap_execute_uniswap` internal aliases, which check
  // the session reveal state themselves and never go through this namespace
  // resolution). `uniswap` stays a KNOWN namespace (isKnownProtocolNamespace)
  // but is not ADVERTISED — same "reserved" contract as an unregistered one,
  // proven with its own message rather than reusing the unknown-namespace test.
  it("rejects namespace='uniswap' as reserved — the hidden pair is not directly discoverable", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "uniswap" });
    expect(result.success).toBe(false);
    expect(result.count).toBe(0);
    expect(result.warnings.join(" ")).toMatch(/reserved/i);
  });

  it("never surfaces a uniswap.* toolId via a generic query, at any limit", async () => {
    const result = await discoverProtocolCapabilities({ query: "swap", limit: 200 });
    expect(result.tools.some((t) => t.toolId.startsWith("uniswap."))).toBe(false);
  });

  it("returns kyberswap tools when filtering by kyberswap namespace", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "kyberswap" });
    expect(result.count).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.namespace).toBe("kyberswap");
    }
  });

  // ── Mutating tools — surfaced by default ─────────────────────────
  // Pre-refactor a discovery-side `includeMutating` filter hid mutating
  // tools by default. That filter was cosmetic — the real safety gate
  // lives at execute time (`runtime.ts`: mutating + !approved + !full
  // loopMode → pendingApproval). Hiding mutating tools at discovery
  // prevented agents from finding them, so the filter was removed.
  // Mutating tools now appear in discover_tools with the `mutating`
  // flag visible per item.

  it("surfaces mutating tools by default — includes khalani.bridge", async () => {
    // Explicit limit > 5 because DEFAULT_DISCOVERY_LIMIT=5 may not include
    // the mutating tool depending on manifest order.
    const result = await discoverProtocolCapabilities({ namespace: "khalani", limit: 50 });
    const hasMutating = result.tools.some(t => t.mutating);
    expect(hasMutating).toBe(true);
    const bridge = result.tools.find(t => t.toolId === "khalani.bridge");
    expect(bridge).toBeDefined();
    expect(bridge!.mutating).toBe(true);
  });

  // ── Query matching ───────────────────────────────────────────────

  it("matches by toolId substring", async () => {
    const result = await discoverProtocolCapabilities({ query: "tokens.search" });
    expect(result.count).toBeGreaterThan(0);
    expect(result.tools[0].toolId).toContain("tokens.search");
  });

  it("matches by description keyword", async () => {
    const result = await discoverProtocolCapabilities({ query: "balance" });
    expect(result.count).toBeGreaterThan(0);
  });

  it("matches case-insensitively", async () => {
    const result = await discoverProtocolCapabilities({ query: "BRIDGE" });
    expect(result.count).toBeGreaterThan(0);
  });

  it("returns empty for non-matching query", async () => {
    const result = await discoverProtocolCapabilities({ query: "zzz_nonexistent_xyz" });
    expect(result.count).toBe(0);
  });

  // ── Limit ────────────────────────────────────────────────────────

  it("respects limit", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "khalani", limit: 3 });
    expect(result.count).toBeLessThanOrEqual(3);
    expect(result.tools).toHaveLength(result.count);
    expect(result.totalCount).toBeGreaterThanOrEqual(result.count);
  });

  it("returns all when limit exceeds count", async () => {
    // Both calls need explicit limits that exceed actual khalani tool count;
    // DEFAULT_DISCOVERY_LIMIT=5 caps allResult independently of totalCount.
    const allResult = await discoverProtocolCapabilities({ namespace: "khalani", limit: 100 });
    const bigLimitResult = await discoverProtocolCapabilities({ namespace: "khalani", limit: 200 });
    expect(bigLimitResult.count).toBe(allResult.count);
    expect(bigLimitResult.totalCount).toBe(allResult.totalCount);
  });

  // ── Discovery item shape ─────────────────────────────────────────
  //
  // `lifecycle` (always "active" for advertised tools) stays off the
  // model-visible row. `exampleParams` was dropped with it in P0-7 and put back
  // by W7 (SPEC §1.7): it is the manifest's own WORKED CALL, it costs under 1%
  // of the row, and its absence is what produced the live
  // `missing required parameter query` failure on dexscreener.search.

  it("discovery items omit lifecycle but carry the manifest's worked example", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "khalani", limit: 50 });
    expect(result.tools.length).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool).not.toHaveProperty("lifecycle");
      expect(tool.toolId).toBeTruthy();
      expect(Array.isArray(tool.params)).toBe(true);
      expect(tool.exampleParams).toBeDefined();
    }
  });

  // ── Warnings ─────────────────────────────────────────────────────

  it("only advertises known active namespaces in generic discovery results", async () => {
    const result = await discoverProtocolCapabilities({});
    const namespaces = new Set(result.tools.map((tool) => tool.namespace));
    for (const namespace of namespaces) {
      expect(PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).toContain(namespace);
    }
  });

  it("returns dexscreener tools when filtering by dexscreener namespace", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "dexscreener", limit: 50 });
    expect(result.count).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.namespace).toBe("dexscreener");
    }
  });

  // ── Combined filters ─────────────────────────────────────────────

  it("combines namespace + query", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "khalani",
      query: "order",
    });
    expect(result.count).toBeGreaterThan(0);
    for (const tool of result.tools) {
      expect(tool.namespace).toBe("khalani");
    }
  });

  it("combines namespace + query — mutating tools surfaced", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "khalani",
      query: "bridge",
    });
    expect(result.count).toBeGreaterThanOrEqual(1);
    const bridge = result.tools.find(t => t.toolId === "khalani.bridge");
    expect(bridge).toBeDefined();
    expect(bridge!.mutating).toBe(true);
  });

  it("matches community takeover query to dexscreener", async () => {
    const result = await discoverProtocolCapabilities({ query: "community takeover" });
    expect(result.success).toBe(true);
    expect(result.tools[0]?.toolId).toBe("dexscreener.communityTakeovers");
  });

  // ── Defense in depth: only advertised namespaces leak ────────────

  it("free-text discovery only ever returns advertised namespaces", async () => {
    // Run a few diverse queries — every result must belong to advertised set.
    const queries = ["", "bridge", "swap", "token", "market"];
    for (const query of queries) {
      const result = await discoverProtocolCapabilities({ query, limit: 200 });
      for (const tool of result.tools) {
        expect(PROTOCOL_ADVERTISED_NAMESPACE_ALLOWLIST as readonly string[]).toContain(tool.namespace);
      }
    }
  });

  // ── Env-gating contract (audit follow-up) ────────────────────────

  it("hides env-gated tools when their requiresEnv is missing", async () => {
    delete process.env.JUPITER_API_KEY;
    const result = await discoverProtocolCapabilities({ namespace: "solana", limit: 100 });
    // All solana tools require JUPITER_API_KEY → namespace returns nothing.
    expect(result.count).toBe(0);
  });

  it("returns env-gated tools when their requiresEnv is present", async () => {
    const result = await discoverProtocolCapabilities({ namespace: "solana", limit: 100 });
    expect(result.count).toBeGreaterThan(0);
  });

  // ── Facet-driven discovery (audit follow-up) ─────────────────────

  // ── Pressure advisory (PR3-final) ────────────────────────────────
  //
  // At pressure band ≥ barrier, mutating tools get `unavailable_at_pressure: true`
  // in the output row. Soft companion to the dispatcher hard-deny + Tool Map
  // omission that already restrict mutating-tool execution at the same bands.
  // Absent flag === "available at the current band" — keeps payloads minimal.

  it("does NOT flag mutating tools at normal band", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "khalani",
      limit: 50,
      contextUsageBand: "normal",
    });
    const bridge = result.tools.find((t) => t.toolId === "khalani.bridge");
    expect(bridge).toBeDefined();
    expect(bridge!.mutating).toBe(true);
    expect(bridge!.unavailable_at_pressure).toBeUndefined();
  });

  it("does NOT flag mutating tools at warning band", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "khalani",
      limit: 50,
      contextUsageBand: "warning",
    });
    const bridge = result.tools.find((t) => t.toolId === "khalani.bridge");
    expect(bridge).toBeDefined();
    expect(bridge!.unavailable_at_pressure).toBeUndefined();
  });

  it("flags mutating tools at barrier band", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "khalani",
      limit: 50,
      contextUsageBand: "barrier",
    });
    const bridge = result.tools.find((t) => t.toolId === "khalani.bridge");
    expect(bridge).toBeDefined();
    expect(bridge!.unavailable_at_pressure).toBe(true);
  });

  it("flags mutating tools at critical band, but NOT non-mutating ones in the same batch", async () => {
    const result = await discoverProtocolCapabilities({
      namespace: "khalani",
      limit: 50,
      contextUsageBand: "critical",
    });
    // Every mutating row tagged.
    const mutating = result.tools.filter((t) => t.mutating);
    expect(mutating.length).toBeGreaterThan(0);
    for (const t of mutating) {
      expect(t.unavailable_at_pressure).toBe(true);
    }
    // Every non-mutating row NOT tagged — flag is mutating-only advisory.
    const nonMutating = result.tools.filter((t) => !t.mutating);
    for (const t of nonMutating) {
      expect(t.unavailable_at_pressure).toBeUndefined();
    }
  });
});

// ── Model-copy vs result split for embedding fields (P0-7) ──────────
//
// `embeddingModel`/`embeddingDim` are internal retrieval mechanics consumed
// only by telemetry. The dispatcher serializes a model-facing COPY that omits
// them; the original result object (read by telemetry/logging) keeps them.
// `toModelDiscoveryResult` is the pure projection that performs that split.

describe("toModelDiscoveryResult — embedding-field split", () => {
  function baseResult(
    retrieval: ProtocolDiscoveryResult["retrieval"],
  ): ProtocolDiscoveryResult {
    return {
      success: true,
      count: 1,
      totalCount: 1,
      hasMore: false,
      tools: [
        {
          toolId: "khalani.bridge",
          namespace: "khalani",
          description: "bridge tokens",
          mutating: true,
          actionKind: "user_wallet_broadcast",
          params: [],
          required: [],
          exampleParams: {},
          score: 0.9,
          whyMatched: ["description"],
        },
      ],
      warnings: [],
      retrieval,
    };
  }

  it("strips embeddingModel/embeddingDim from the model copy's retrieval", () => {
    const result = baseResult({
      method: "dense",
      denseFailed: false,
      embeddingModel: "test-embed-model",
      embeddingDim: 768,
      candidateCount: 12,
    });

    const modelResult = toModelDiscoveryResult(result);

    // Model copy: retrieval present, mechanics removed, signal fields kept.
    expect(modelResult.retrieval).toBeDefined();
    expect(modelResult.retrieval).not.toHaveProperty("embeddingModel");
    expect(modelResult.retrieval).not.toHaveProperty("embeddingDim");
    expect(modelResult.retrieval?.method).toBe("dense");
    expect(modelResult.retrieval?.denseFailed).toBe(false);
    expect(modelResult.retrieval?.candidateCount).toBe(12);
  });

  it("leaves the original result object intact for telemetry", () => {
    const result = baseResult({
      method: "dense",
      denseFailed: false,
      embeddingModel: "test-embed-model",
      embeddingDim: 768,
      candidateCount: 12,
    });

    toModelDiscoveryResult(result);

    // Original untouched — telemetry still reads both embedding fields.
    expect(result.retrieval?.embeddingModel).toBe("test-embed-model");
    expect(result.retrieval?.embeddingDim).toBe(768);
  });

  it("preserves an absent retrieval block (catalog/lexical with no embedding)", () => {
    const result = baseResult(undefined);
    const modelResult = toModelDiscoveryResult(result);
    expect(modelResult.retrieval).toBeUndefined();
    expect(modelResult).not.toHaveProperty("retrieval");
  });

  it("does not surface embedding fields when retrieval has none set", () => {
    // catalog/lexical retrieval present but embedding fields unset.
    const result = baseResult({
      method: "lexical",
      denseFailed: true,
      candidateCount: 5,
    });
    const modelResult = toModelDiscoveryResult(result);
    expect(modelResult.retrieval).not.toHaveProperty("embeddingModel");
    expect(modelResult.retrieval).not.toHaveProperty("embeddingDim");
    expect(modelResult.retrieval?.method).toBe("lexical");
  });
});
