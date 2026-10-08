/**
 * Kairos E-1: every background model call sends the aux reasoning effort
 * (`AUX_REASONING_EFFORT`, default the lowest the model supports), never the
 * provider default or a chat pick. One stub provider per caller records the
 * config it was handed; no network, no DB (the stub config carries no
 * `provider`, so the session endpoint re-resolution is skipped).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { callJudge, type JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import { extractEntities } from "@vex-agent/memory/manager/entity-extraction.js";
import { runRegimeTick, type RegimeWorkerDeps } from "@vex-agent/engine/regime/regime-worker.js";
import { callChunkerLLM } from "@vex-agent/engine/compact-jobs/chunker-call.js";
import { callBranchProvider } from "@vex-agent/engine/compaction/branch-provider-call.js";
import type { CompactJob } from "@vex-agent/db/repos/compact-jobs/index.js";
import type { JudgeContext } from "@vex-agent/memory/manager/context-builder.js";

interface StubConfig {
  readonly model: string;
  readonly supportsReasoningEffort: boolean;
  readonly reasoningSupport: { readonly efforts: readonly string[] };
  readonly reasoningEffort?: string;
}

const LOADED: StubConfig = {
  model: "deepseek/deepseek-v4.1-flash",
  supportsReasoningEffort: true,
  reasoningSupport: { efforts: ["none", "low", "medium", "high"] },
  // A stale chat pick on the shared config must not leak into a background call.
  reasoningEffort: "high",
};

function recordingProvider(content: string, seen: unknown[]): () => Promise<JudgeProvider> {
  return async () => ({
    loadConfig: async () => ({ ...LOADED }),
    chatCompletionSimple: async (_messages, config) => {
      seen.push(config);
      return { content, usage: { cost: 0 } };
    },
  });
}

function effortOf(seen: readonly unknown[]): unknown {
  const first = seen[0];
  if (typeof first !== "object" || first === null) return "no-config";
  return Reflect.get(first, "reasoningEffort");
}

function judgeCtx(): JudgeContext {
  return {
    sessionId: "session-aux-effort",
    candidate: {
      kind: "strategy_lesson",
      title: "t",
      summary: "s",
      contentMd: "",
      importance: 7,
      confidence: 0.7,
      eventTime: null,
      observedAt: null,
      recordedAt: "2026-06-10T12:00:00.000Z",
      availableAtDecisionTime: null,
    },
    transcript: "[user] scale in slowly.",
    signals: {
      nearDupTopK: [],
      conflictFlag: false,
      conflictKnowledgeId: null,
      evidenceStrengthCeiling: "moderate",
      recurrenceCount: 2,
      anchorExists: true,
      isUserAffirmed: false,
      isGeneralization: true,
    },
    userAffirmationDetected: false,
    knownKinds: [],
    similarCandidates: [],
  };
}

function compactJob(): CompactJob {
  return {
    id: 1,
    sessionId: "session-aux-effort",
    checkpointGeneration: 3,
    status: "pending",
    agentSummary: "a summary",
    preserveMd: null,
    threadThemesHints: [],
    sourceStartMessageId: 1,
    sourceEndMessageId: 2,
    attemptCount: 0,
    maxAttempts: 5,
    nextAttemptAt: "2026-09-29T00:00:00.000Z",
    lockedAt: null,
    lockedBy: null,
    heartbeatAt: null,
    lastError: null,
    chunksInserted: 0,
    chunksRejectedByExclusion: 0,
    chunksRejectedByRedaction: 0,
    inferenceProvider: null,
    inferenceModel: null,
    inferenceCompletedAt: null,
    costUsd: null,
    createdAt: "2026-09-29T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

beforeEach(() => {
  vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
  vi.stubEnv("AGENT_MODEL", "deepseek/deepseek-v4.1-flash");
  vi.stubEnv("TAVILY_API_KEY", "test-tavily-key");
  vi.stubEnv("RETTIWT_API_KEY", "test-rettiwt-key");
  vi.stubEnv("AUX_REASONING_EFFORT", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("background calls send the aux reasoning effort", () => {
  it("memory judge", async () => {
    const seen: unknown[] = [];
    const verdict = JSON.stringify({
      verdict: "promote",
      rubric: { grounding: 3, durability: 3, novelty: 3, generalizability: 4, processNotOutcome: 4 },
      sourceTier: "observed",
      regimeTags: ["bull"],
    });
    await callJudge(judgeCtx(), recordingProvider(verdict, seen));
    expect(effortOf(seen)).toBe("none");
  });

  it("entity extraction", async () => {
    const seen: unknown[] = [];
    await extractEntities(
      { kind: "trade_lesson", title: "t", summary: "s", contentMd: "c", regimeTags: [] },
      recordingProvider(JSON.stringify({ entities: [], edges: [] }), seen),
    );
    expect(effortOf(seen)).toBe("none");
  });

  it("regime worker", async () => {
    const seen: unknown[] = [];
    const deps: RegimeWorkerDeps = {
      searchWeb: async () => [{ title: "t", snippet: "s" }],
      searchTweets: async () => [{ text: "tw", likes: 100, retweets: 5 }],
      makeProvider: recordingProvider(
        JSON.stringify({ trendLabel: "bull", volLabel: "high", confidence: "high", rationale: "r" }),
        seen,
      ),
      getLatestSnapshot: async () => null,
      insertSnapshot: async (input) => ({
        id: 1,
        trendLabel: input.trendLabel,
        volLabel: input.volLabel,
        confidence: input.confidence,
        source: input.source,
        rationale: input.rationale ?? null,
        createdAt: "2026-09-29T00:00:00.000Z",
      }),
      now: () => new Date("2026-09-29T00:00:00.000Z"),
    };
    await runRegimeTick(deps);
    expect(effortOf(seen)).toBe("none");
  });

  it("compaction chunker", async () => {
    const seen: unknown[] = [];
    await callChunkerLLM(
      compactJob(),
      [{ role: "user", content: "hello", tool_call_id: null }],
      recordingProvider(JSON.stringify({ chunks: [] }), seen),
    );
    expect(effortOf(seen)).toBe("none");
  });

  it("compaction summary branch", async () => {
    const seen: unknown[] = [];
    const makeJudge = recordingProvider(JSON.stringify({ ok: true }), seen);
    const judge = await makeJudge();
    await callBranchProvider({
      label: "compaction_summary",
      sessionId: "session-aux-effort",
      systemPrompt: "s",
      prefix: [{ role: "user", content: "earlier turn" }],
      instruction: "u",
      timeoutMs: 5_000,
      schema: z.object({ ok: z.boolean() }),
      makeProvider: async () => ({
        loadConfig: () => judge.loadConfig(),
        chatCompletionSimple: (messages, config, responseFormat, signal) =>
          judge.chatCompletionSimple(messages, config, responseFormat, signal),
      }),
      preparationId: 1,
    });
    expect(effortOf(seen)).toBe("none");
  });

  it("honours an explicit AUX_REASONING_EFFORT, clamped to the model", async () => {
    vi.stubEnv("AUX_REASONING_EFFORT", "minimal");
    const seen: unknown[] = [];
    await extractEntities(
      { kind: "trade_lesson", title: "t", summary: "s", contentMd: "c", regimeTags: [] },
      recordingProvider(JSON.stringify({ entities: [], edges: [] }), seen),
    );
    expect(effortOf(seen)).toBe("none");
  });

  it("AUX_REASONING_EFFORT=provider sends no effort at all", async () => {
    vi.stubEnv("AUX_REASONING_EFFORT", "provider");
    const seen: unknown[] = [];
    await extractEntities(
      { kind: "trade_lesson", title: "t", summary: "s", contentMd: "c", regimeTags: [] },
      recordingProvider(JSON.stringify({ entities: [], edges: [] }), seen),
    );
    expect(effortOf(seen)).toBeUndefined();
  });
});
