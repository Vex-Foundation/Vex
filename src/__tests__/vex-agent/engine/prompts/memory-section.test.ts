/**
 * buildMemorySection — the consolidated `# Memory` turn-state section
 * (D-MEMSEC). Pins:
 *  - empty-state texts render ONLY on true zero counts (successful fetch),
 *  - fail-states (branch null) OMIT the affected lines while routing stays,
 *  - the Active Memory caps (12 entries / 3000 hot chars / 200 summary
 *    / 500 kinds-line chars) — assertions ported 1:1 from the deleted
 *    prompts/knowledge.test.ts before removing the formatter module,
 *  - BOTH knownKinds widths: top-5 slice for the state banner line vs the
 *    FULL list for the Active Memory block,
 *  - the three Memory Routing lines verbatim, always rendered.
 */

import { describe, it, expect } from "vitest";
import { buildMemorySection } from "@vex-agent/engine/prompts/memory-section.js";
import type { MemoryTurnContext } from "@vex-agent/memory/turn-context.js";
import type {
  ActiveKnowledgeListItem,
  KnownKind,
} from "@vex-agent/db/repos/knowledge.js";

function entry(overrides: Partial<ActiveKnowledgeListItem>): ActiveKnowledgeListItem {
  return {
    id: 1,
    kind: "memo",
    title: "test title",
    summary: "test summary",
    pinned: false,
    validUntil: "2026-04-13T12:00:00Z",
    updatedAt: "2026-04-06T12:00:00Z",
    ...overrides,
  };
}

function ctx(overrides: Partial<MemoryTurnContext> = {}): MemoryTurnContext {
  return {
    knowledge: { hotEntries: [], knownKinds: [], activeCount: 0 },
    sessionStats: {
      activeCount: 0,
      compactCount: 0,
      unresolvedOutstandingCount: 0,
      recentThemes: [],
    },
    ...overrides,
  };
}

function knowledgeCtx(
  hotEntries: readonly ActiveKnowledgeListItem[],
  knownKinds: readonly KnownKind[],
  activeCount = hotEntries.length,
): MemoryTurnContext {
  return ctx({ knowledge: { hotEntries, knownKinds, activeCount } });
}

const ROUTING_LINES = [
  "- Current state (balances, prices, gas, positions, quotes) → live tools (`wallet_balances`, `khalani_tokens_balances`, `agent_scan`).",
  "- Something earlier in THIS conversation/mission → `session_memory_search` (per-session narrative).",
  "- Cross-session long-term memory (durable lessons / strategies / observed preferences from earlier sessions, incl. fresh un-consolidated signals) → `long_memory_search`.",
] as const;

describe("buildMemorySection — structure + routing", () => {
  it("always starts with '# Memory' and ends with the routing block", () => {
    const section = buildMemorySection(ctx());
    expect(section.startsWith("# Memory")).toBe(true);
    const routingIdx = section.indexOf("## Memory Routing");
    expect(routingIdx).toBeGreaterThan(0);
    // Routing is the LAST sub-block (order anchor before the Tool Map).
    for (const line of ROUTING_LINES) {
      expect(section.indexOf(line)).toBeGreaterThan(routingIdx);
    }
  });

  it("renders the three routing lines verbatim", () => {
    const section = buildMemorySection(ctx());
    for (const line of ROUTING_LINES) {
      expect(section).toContain(line);
    }
  });

  it("routing stays even when BOTH branches failed (section = header + routing)", () => {
    const section = buildMemorySection(ctx({ knowledge: null, sessionStats: null }));
    expect(section).toContain("# Memory");
    expect(section).toContain("## Memory Routing");
    expect(section).not.toContain("[Session memories:");
    expect(section).not.toContain("[Long-term memory:");
    expect(section).not.toContain("## Active Memory");
  });
});

describe("buildMemorySection — fail-state vs empty-state (fail ≠ empty)", () => {
  it("true-zero session stats render the memory empty-state guidance", () => {
    const section = buildMemorySection(ctx());
    expect(section).toContain(
      "[Session memories: 0 chunks, 0 compact(s) done. Skip session_memory_search — nothing to find.",
    );
  });

  it("sessionStats === null (fetch FAILED) omits line (1) — no 'Skip session_memory_search' lie", () => {
    const section = buildMemorySection(ctx({ sessionStats: null }));
    expect(section).not.toContain("[Session memories:");
    expect(section).not.toContain("Skip session_memory_search");
  });

  it("true-zero long-memory renders the long-memory empty-state guidance verbatim", () => {
    const section = buildMemorySection(ctx());
    expect(section).toContain(
      "[Long-term memory: empty. Durable cross-session memory has no entries yet. " +
        "Use long_memory_suggest to propose durable lessons: persona, observed strategies, lessons from failures, observed user preferences. " +
        "Skip long_memory_search — nothing to find.]",
    );
  });

  it("knowledge === null (fetch FAILED) omits lines (2)+(3) — no 'Skip long_memory_search' lie", () => {
    const section = buildMemorySection(ctx({ knowledge: null }));
    expect(section).not.toContain("[Long-term memory:");
    expect(section).not.toContain("Skip long_memory_search");
    expect(section).not.toContain("## Active Memory");
    // Session-memory line + routing still render.
    expect(section).toContain("[Session memories:");
    expect(section).toContain("## Memory Routing");
  });

  it("populated session stats render counts, outstanding and themes", () => {
    const section = buildMemorySection(
      ctx({
        sessionStats: {
          activeCount: 4,
          compactCount: 2,
          unresolvedOutstandingCount: 3,
          recentThemes: ["kyber_route_debug", "wallet_allowance"],
        },
      }),
    );
    expect(section).toContain("[Session memories: 4 chunk(s) across 2 compact(s).");
    expect(section).toContain("3 outstanding item(s) unresolved.");
    expect(section).toContain("Recent themes: kyber_route_debug, wallet_allowance.");
    expect(section).toContain("Tool: session_memory_search(semantic_intent, k≤5).]");
  });
});

describe("buildMemorySection — two knownKinds widths (banner top-5 vs block full)", () => {
  it("banner line slices to top-5 while the Active Memory block lists the FULL set", () => {
    const knownKinds: KnownKind[] = Array.from({ length: 8 }, (_, i) => ({
      kind: `kind_${i + 1}`,
      count: 100 - i,
    }));
    const section = buildMemorySection(knowledgeCtx([], knownKinds, 42));

    // Banner: exactly the first five.
    expect(section).toContain(
      "Top kinds: kind_1 (100), kind_2 (99), kind_3 (98), kind_4 (97), kind_5 (96).",
    );
    expect(section).not.toContain("Top kinds: kind_1 (100), kind_2 (99), kind_3 (98), kind_4 (97), kind_5 (96), kind_6");

    // Block: full list (under the 500-char cap).
    const blockIdx = section.indexOf("Known kinds (reuse before creating new):");
    expect(blockIdx).toBeGreaterThan(0);
    const block = section.slice(blockIdx);
    for (const k of knownKinds) {
      expect(block).toContain(`${k.kind} (${k.count})`);
    }
  });

  it("banner shows entry count + recall tool when long-memory is non-empty", () => {
    const section = buildMemorySection(knowledgeCtx([], [{ kind: "memo", count: 3 }], 17));
    expect(section).toContain("[Long-term memory: 17 entries. Top kinds: memo (3).");
    expect(section).toContain("Tool: long_memory_search(semantic_intent, k≤15).]");
  });
});

// ── Active Memory block — assertions ported from prompts/knowledge.test.ts ──

describe("buildMemorySection — Active Memory block (ported drift-pins)", () => {
  it("omits the '# Active Memory' block when both entries and known kinds are empty", () => {
    const section = buildMemorySection(knowledgeCtx([], [], 0));
    expect(section).not.toContain("## Active Memory");
  });

  it("renders Known kinds only when entries are empty", () => {
    const section = buildMemorySection(knowledgeCtx([], [{ kind: "memo", count: 3 }], 3));
    expect(section).toContain("## Active Memory");
    expect(section).toContain("Known kinds (reuse before creating new):");
    expect(section).toContain("memo (3)");
    expect(section).not.toContain("Pinned");
    expect(section).not.toContain("Recent:");
  });

  it("renders entries only when known kinds are empty", () => {
    const section = buildMemorySection(knowledgeCtx([entry({})], []));
    expect(section).toContain("## Active Memory");
    expect(section).toContain("Recent:");
    expect(section).toContain("test title");
    expect(section).not.toContain("Known kinds");
  });

  it("renders Pinned section before Recent section", () => {
    const pinned = entry({ id: 1, kind: "risk_rule", title: "no leverage", pinned: true, validUntil: null });
    const recent = entry({ id: 2, kind: "memo", title: "recent obs", pinned: false });
    const section = buildMemorySection(knowledgeCtx([pinned, recent], []));
    const pinnedIdx = section.indexOf("Pinned");
    const recentIdx = section.indexOf("Recent");
    expect(pinnedIdx).toBeGreaterThan(0);
    expect(recentIdx).toBeGreaterThan(pinnedIdx);
    expect(section).toContain("no leverage");
    expect(section).toContain("recent obs");
  });

  it("caps entries at ACTIVE_KNOWLEDGE_ENTRY_LIMIT (12)", () => {
    const entries = Array.from({ length: 25 }, (_, i) =>
      entry({ id: i + 1, title: `entry ${i + 1}`, pinned: false }),
    );
    const section = buildMemorySection(knowledgeCtx(entries, []));
    const entryLines = section.split("\n").filter((l) => l.startsWith("- ["));
    expect(entryLines.length).toBeLessThanOrEqual(12);
  });

  it("truncates long summaries to 200 chars with ellipsis", () => {
    const longSummary = "a".repeat(500);
    const section = buildMemorySection(knowledgeCtx([entry({ summary: longSummary })], []));
    expect(section).toContain("…");
    expect(section).not.toContain("a".repeat(500));
  });

  it("respects total chars cap on hot context block (3000)", () => {
    const entries = Array.from({ length: 12 }, (_, i) =>
      entry({ id: i + 1, summary: "x".repeat(180), title: `t${i}` }),
    );
    const section = buildMemorySection(knowledgeCtx(entries, []));
    const blockIdx = section.indexOf("## Active Memory");
    const routingIdx = section.indexOf("## Memory Routing");
    const block = section.slice(blockIdx, routingIdx);
    expect(block.length).toBeLessThan(5000);
  });

  it("known kinds line caps at chars cap (500)", () => {
    const knownKinds: KnownKind[] = Array.from({ length: 60 }, (_, i) => ({
      kind: `very_long_kind_name_number_${i}`,
      count: i + 1,
    }));
    const section = buildMemorySection(knowledgeCtx([], knownKinds, 60));
    const knownKindsLineMatch = section.match(/Known kinds[^\n]*\n([^\n]+)/);
    expect(knownKindsLineMatch).not.toBeNull();
    const line = knownKindsLineMatch?.[1] ?? "";
    expect(line.length).toBeLessThanOrEqual(500);
  });

  it("formats known kinds as 'kind (count), kind (count)'", () => {
    const section = buildMemorySection(
      knowledgeCtx([], [
        { kind: "pumpfun_entry_pattern", count: 12 },
        { kind: "risk_rule", count: 3 },
      ], 15),
    );
    expect(section).toContain("pumpfun_entry_pattern (12), risk_rule (3)");
  });

  it("entry line includes id and kind in brackets", () => {
    const section = buildMemorySection(
      knowledgeCtx([entry({ id: 42, kind: "strategy_rule", title: "title" })], []),
    );
    expect(section).toContain("[strategy_rule]");
    expect(section).toContain("(id:42");
  });

  it("pinned entries do not show expiry hint", () => {
    const section = buildMemorySection(
      knowledgeCtx([entry({ id: 1, pinned: true, validUntil: null })], []),
    );
    expect(section).not.toContain("expires");
  });

  it("footer mentions the three read-side tools (search, get, history)", () => {
    const section = buildMemorySection(knowledgeCtx([entry({})], []));
    expect(section).toContain("long_memory_search");
    expect(section).toContain("long_memory_get");
    expect(section).toContain("long_memory_history");
  });
});
