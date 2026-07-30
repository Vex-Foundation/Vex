/**
 * Branch B's size-budget guard.
 *
 * The invariant under test is the one that makes the insert tail's
 * "retry until it lands" contract correct: a snapshot handed to the freeze
 * contains ONLY chunks the embeddings provider can accept. Before this, the
 * live acceptance run froze a 747-token chunk and the row retried forever.
 *
 * Also pinned: exactly ONE repair request (never one per chunk, never a loop),
 * the valid chunks from the first answer survive it, and the repair's cost is
 * added to the branch's recorded cost.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildBudgetValidChunksSnapshot } from "@vex-agent/engine/compaction/chunks-budget-guard.js";
import { exceedsEmbeddingDocumentBudget } from "@vex-agent/embeddings/document-size-budget.js";
import type { BranchInferenceProvider } from "@vex-agent/engine/compaction/branch-provider-call.js";

const OVERSIZED_TEXT = "the kyberswap quote timed out again. ".repeat(81);

function chunk(theme: string, happened: string) {
  return {
    theme,
    entities: [],
    protocols: ["kyberswap"],
    error_classes: [],
    chains: ["solana"],
    tasks: [],
    happened_md: happened,
    did_md: "",
    tried_md: "",
    outstanding_items: [],
  };
}

/** A provider that answers a scripted sequence and counts its calls. */
function scriptedProvider(answers: readonly unknown[]) {
  const prompts: string[] = [];
  const factory = async (): Promise<BranchInferenceProvider> => ({
    loadConfig: async () => ({ model: "test/model" }),
    chatCompletionSimple: async (messages) => {
      const last = messages[messages.length - 1];
      prompts.push(typeof last?.content === "string" ? last.content : "");
      const answer = answers[prompts.length - 1] ?? answers[answers.length - 1];
      return {
        content: JSON.stringify(answer),
        usage: { cost: 0.0002 },
      };
    },
  });
  return { factory, prompts, calls: () => prompts.length };
}

function input() {
  return {
    preparationId: 7,
    sessionId: "session-1",
    frozenSummary: null,
    prefix: [],
    targetGeneration: 3,
  };
}

describe("buildBudgetValidChunksSnapshot", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
  });

  it("makes no repair call when every chunk already fits", async () => {
    const provider = scriptedProvider([
      { chunks: [chunk("user_prefers_solana_routes", "the user asked to avoid bridges")] },
    ]);
    const built = await buildBudgetValidChunksSnapshot(input(), {
      makeProvider: provider.factory,
    });

    expect(provider.calls()).toBe(1);
    expect(built.repairAttempted).toBe(false);
    expect(built.snapshot.chunks).toHaveLength(1);
    expect(built.costUsd).toBeCloseTo(0.0002, 10);
  });

  it("never freezes the oversized chunk that stalled the live run", async () => {
    const provider = scriptedProvider([
      {
        chunks: [
          chunk("user_prefers_solana_routes", "the user asked to avoid bridges"),
          chunk("kyber_quote_timeout_pattern", OVERSIZED_TEXT),
        ],
      },
      { chunks: [chunk("kyber_quote_timeout_pattern", "the quote timed out twice")] },
    ]);
    const built = await buildBudgetValidChunksSnapshot(input(), {
      makeProvider: provider.factory,
    });

    // EXACTLY one repair request — a per-chunk loop would show more calls.
    expect(provider.calls()).toBe(2);
    expect(built.repairAttempted).toBe(true);
    for (const frozen of built.snapshot.chunks) {
      expect(exceedsEmbeddingDocumentBudget(frozen.theme, frozen.bodyMd)).toBe(false);
    }
  });

  it("keeps the valid chunks from the first answer and adds the repair's cost", async () => {
    const provider = scriptedProvider([
      {
        chunks: [
          chunk("user_prefers_solana_routes", "the user asked to avoid bridges"),
          chunk("kyber_quote_timeout_pattern", OVERSIZED_TEXT),
        ],
      },
      { chunks: [chunk("kyber_quote_timeout_pattern", "the quote timed out twice")] },
    ]);
    const built = await buildBudgetValidChunksSnapshot(input(), {
      makeProvider: provider.factory,
    });

    const themes = built.snapshot.chunks.map((c) => c.theme);
    expect(themes).toContain("user_prefers_solana_routes");
    expect(themes).toContain("kyber_quote_timeout_pattern");
    // Both calls were paid for; recording only one would under-report the
    // branch's spend.
    expect(built.costUsd).toBeCloseTo(0.0004, 10);
  });

  it("carries the oversized material into the repair request and nothing else", async () => {
    const provider = scriptedProvider([
      {
        chunks: [
          chunk("user_prefers_solana_routes", "the user asked to avoid bridges"),
          chunk("kyber_quote_timeout_pattern", OVERSIZED_TEXT),
        ],
      },
      { chunks: [chunk("kyber_quote_timeout_pattern", "the quote timed out twice")] },
    ]);
    await buildBudgetValidChunksSnapshot(input(), { makeProvider: provider.factory });

    const repairPrompt = provider.prompts[1] ?? "";
    expect(repairPrompt).toContain("kyber_quote_timeout_pattern");
    expect(repairPrompt).not.toContain("user_prefers_solana_routes");
  });

  it("fails the attempt when the repair is still oversized, and freezes nothing", async () => {
    const provider = scriptedProvider([
      { chunks: [chunk("kyber_quote_timeout_pattern", OVERSIZED_TEXT)] },
      { chunks: [chunk("kyber_quote_timeout_pattern", OVERSIZED_TEXT)] },
    ]);

    await expect(
      buildBudgetValidChunksSnapshot(input(), { makeProvider: provider.factory }),
    ).rejects.toThrow(/compaction_chunks_oversized_after_repair/);
    // One repair round, then failure — not a retry loop inside the attempt.
    expect(provider.calls()).toBe(2);
  });
});
