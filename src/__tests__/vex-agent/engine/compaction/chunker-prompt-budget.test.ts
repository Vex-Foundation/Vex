/**
 * Both chunker prompts state the embedding size budget.
 *
 * The prompt is where the fix starts: the validator downstream refuses an
 * oversized chunk, but only the prompt makes compliance the model's default
 * instead of luck. An edit that drops the budget line would silently return the
 * pipeline to paying for a repair round on every preparation — or, on the
 * legacy path, to failing the job — so the line is pinned here, on the number
 * itself rather than on prose.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildChunksSystemPrompt } from "@vex-agent/engine/compaction/chunks-call.js";
import { callChunkerLLM } from "@vex-agent/engine/compact-jobs/chunker-call.js";
import { MEMORY_CHUNK_MODEL_BUDGET_CHARS } from "@vex-agent/embeddings/document-size-budget.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import type { CompactJob } from "@vex-agent/db/repos/compact-jobs/index.js";
import type { ArchivedPrefixRow } from "@vex-agent/engine/compact-jobs/archived-prefix.js";

describe("chunker prompt size budget", () => {
  it("states the per-chunk budget in the preparation chunker prompt", () => {
    const prompt = buildChunksSystemPrompt();
    expect(prompt).toContain(String(MEMORY_CHUNK_MODEL_BUDGET_CHARS));
    expect(prompt).toContain("SIZE BUDGET");
    // Splitting, never truncating — a truncated memory stores a lie.
    expect(prompt).toMatch(/SPLIT/);
  });

  describe("legacy chunker prompt", () => {
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

    it("states the same budget, from the same owner", async () => {
      let systemPrompt = "";
      const provider = async (): Promise<JudgeProvider> => ({
        loadConfig: async () => ({ model: "test/model" }),
        chatCompletionSimple: async (
          messages: ReadonlyArray<{ role: string; content: string }>,
        ) => {
          systemPrompt = messages[0]?.content ?? "";
          return { content: JSON.stringify({ chunks: [] }) };
        },
      });

      await callChunkerLLM(
        {
          id: 1,
          sessionId: "session-1",
          checkpointGeneration: 3,
          agentSummary: "a summary",
          preserveMd: null,
          threadThemesHints: [],
          sourceStartMessageId: 1,
          sourceEndMessageId: 2,
          attemptCount: 0,
        } as unknown as CompactJob,
        [{ role: "user", content: "hello" } as unknown as ArchivedPrefixRow],
        provider,
      );

      expect(systemPrompt).toContain(String(MEMORY_CHUNK_MODEL_BUDGET_CHARS));
      expect(systemPrompt).toContain("SIZE BUDGET");
    });
  });
});
