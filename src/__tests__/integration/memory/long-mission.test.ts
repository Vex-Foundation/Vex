/**
 * PR4 — initial eval harness.
 *
 * Synthetic mission scenarios that exercise the per-session memory layer end-
 * to-end against the real Postgres + EmbeddingGemma stack provisioned by
 * `globalSetup.ts`. Chunker LLM is mocked at `@vex-agent/inference/openrouter.js`
 * (executor calls `provider.chatCompletionSimple` after `provider.loadConfig`);
 * each scenario sets `currentChunkerResponse` to the JSON the chunker should
 * "return" for that run.
 *
 * Scenarios in this file:
 *
 *   - cross-session leak guard — session B's `session_memory_search` must NEVER
 *     surface session A's chunks even with identical themes and matching
 *     embedding model/dim.
 *
 *   - knowledge source filter — Active Memory hot-context surface
 *     returns only `observed` + `user_confirmed`; recall returns all four
 *     tiers when queried explicitly.
 *
 *   - stale-claim defense — two `workerId`s race on the same compact_job;
 *     only one's `markCompleted` returns true. The losing worker sees
 *     `false` and must not retry.
 *
 *   - single-compact session — `executeCompactNow` + Track 2 worker land
 *     a chunk that becomes recallable via `session_memory_search` against the same
 *     session. End-to-end proof of the new memory tier.
 *
 *   - outstanding-item resolution survives compact — a chunk with multiple
 *     outstanding items has one resolved; the resolution sticks across a
 *     subsequent compact cycle (next compact does NOT re-emit the resolved
 *     item as unresolved).
 *
 * PR4.2 appends the remaining memory-eval regressions that belong in this
 * integration file: multi-compact, long autonomous, provider retry,
 * transcript-side redaction, live-state exclusion, redaction output, and theme
 * fallback. The PL/EN scenario is obsolete after the English-only chunker
 * contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const chunkerMockHandle = vi.hoisted(() => {
  let response: { chunks: ReadonlyArray<unknown> } = { chunks: [] };
  let remainingFailures: Error[] = [];
  let lastMessages: ReadonlyArray<{ role: string; content: string }> = [];
  return {
    setChunkerResponse(next: { chunks: ReadonlyArray<unknown> }): void {
      response = next;
    },
    setFailures(next: readonly Error[]): void {
      remainingFailures = [...next];
    },
    getChunkerResponse(): { chunks: ReadonlyArray<unknown> } {
      return response;
    },
    takeFailure(): Error | null {
      return remainingFailures.shift() ?? null;
    },
    setLastMessages(next: ReadonlyArray<{ role: string; content: string }>): void {
      lastMessages = [...next];
    },
    getLastUserPrompt(): string {
      return lastMessages.find((m) => m.role === "user")?.content ?? "";
    },
    reset(): void {
      response = { chunks: [] };
      remainingFailures = [];
      lastMessages = [];
    },
  };
});

vi.mock("@vex-agent/inference/openrouter.js", () => ({
  OpenRouterProvider: vi.fn().mockImplementation(function () {
    return {
      loadConfig: vi.fn().mockResolvedValue({
        provider: "openrouter",
        model: "test-model",
        contextLimit: 128_000,
        maxOutputTokens: 4096,
        inputPricePerM: 0,
        outputPricePerM: 0,
        priceCurrency: "USD",
      }),
      chatCompletionSimple: vi.fn().mockImplementation(
        async (messages: ReadonlyArray<{ role: string; content: string }>) => {
          chunkerMockHandle.setLastMessages(messages);
          const failure = chunkerMockHandle.takeFailure();
          if (failure) throw failure;
          return {
            content: JSON.stringify(chunkerMockHandle.getChunkerResponse()),
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          };
        },
      ),
    };
  }),
}));

import { randomUUID } from "node:crypto";

import { executeCompactNow } from "@vex-agent/engine/compact-jobs/service.js";
import { startCompactJobsExecutor } from "@vex-agent/engine/compact-jobs/executor.js";
import { resetCompactMutexForTests } from "@vex-agent/engine/compact-jobs/state.js";
import {
  claimNextDueJob,
  enqueueJob,
  getById as getJobById,
  markCompleted,
  type NewCompactJob,
} from "@vex-agent/db/repos/compact-jobs/index.js";
import {
  getSessionMemoryStats,
  insertMemories,
  markOutstandingResolved,
  recallTopK as recallMemories,
  type NewSessionMemory,
} from "@vex-agent/db/repos/session-memories/index.js";
import * as knowledgeRepo from "@vex-agent/db/repos/knowledge.js";
import { computeContentHash } from "@vex-agent/knowledge/content-hash.js";
import { execute, query, queryOne } from "@vex-agent/db/client.js";
import {
  embedText,
  insertMessage,
  makeSession,
  randVector,
  resetDb,
} from "../setup/fixtures.js";

const EMBEDDING_DIM = 8;
const TEST_EMBEDDING_MODEL = "test-model";

function newMemory(
  sessionId: string,
  overrides: Partial<NewSessionMemory> & { theme: string; happenedMd: string },
): NewSessionMemory {
  const seed = sessionId + "|" + overrides.theme + "|" + overrides.happenedMd;
  return {
    sessionId,
    checkpointGeneration: overrides.checkpointGeneration ?? 1,
    theme: overrides.theme,
    themeSource: overrides.themeSource ?? "chunker",
    entities: overrides.entities ?? [],
    protocols: overrides.protocols ?? [],
    errorClasses: overrides.errorClasses ?? [],
    chains: overrides.chains ?? [],
    tasks: overrides.tasks ?? [],
    happenedMd: overrides.happenedMd,
    didMd: overrides.didMd ?? "",
    triedMd: overrides.triedMd ?? "",
    outstandingTexts: overrides.outstandingTexts ?? [],
    sourceStartMessageId: overrides.sourceStartMessageId ?? null,
    sourceEndMessageId: overrides.sourceEndMessageId ?? null,
    inferenceModel: overrides.inferenceModel ?? "test-llm",
    embeddingModel: TEST_EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIM,
    embedding: overrides.embedding ?? randVector(EMBEDDING_DIM, seed),
  };
}

function newJob(sessionId: string, gen: number, overrides: Partial<NewCompactJob> = {}): NewCompactJob {
  return {
    sessionId,
    checkpointGeneration: gen,
    agentSummary: overrides.agentSummary ?? `Summary gen ${gen}`,
    preserveMd: overrides.preserveMd ?? null,
    threadThemesHints: overrides.threadThemesHints ?? [],
    sourceStartMessageId: overrides.sourceStartMessageId ?? 999_999,
    sourceEndMessageId: overrides.sourceEndMessageId ?? 999_999,
  };
}

async function seedConversation(sessionId: string, length = 14): Promise<void> {
  for (let i = 0; i < length; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    await insertMessage(sessionId, role, `turn ${i}: realistic conversation content for compact`);
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
}

async function processJobToCompletion(jobId: number, timeoutMs = 10_000): Promise<void> {
  const handle = startCompactJobsExecutor({ pollIntervalMs: 50 });
  try {
    await waitFor(async () => (await getJobById(jobId))?.status === "completed", timeoutMs);
  } finally {
    await handle.stop();
  }
}

function chunk(overrides: {
  theme: string;
  happenedMd: string;
  didMd?: string;
  triedMd?: string;
  entities?: string[];
  protocols?: string[];
  errorClasses?: string[];
  chains?: string[];
  tasks?: string[];
  outstandingItems?: string[];
}): Record<string, unknown> {
  return {
    theme: overrides.theme,
    entities: overrides.entities ?? [],
    protocols: overrides.protocols ?? [],
    error_classes: overrides.errorClasses ?? [],
    chains: overrides.chains ?? [],
    tasks: overrides.tasks ?? [],
    happened_md: overrides.happenedMd,
    did_md: overrides.didMd ?? "",
    tried_md: overrides.triedMd ?? "",
    outstanding_items: overrides.outstandingItems ?? [],
  };
}

// ── Scenario 1: cross-session leak guard ─────────────────────────

describe("PR4 eval — cross-session leak guard", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("session B's session_memory_search recall returns zero hits from session A even with identical themes", async () => {
    const sessionA = await makeSession();
    const sessionB = await makeSession();

    // Same theme, same embedding model/dim, even similar embedding vectors —
    // the per-session filter must still reject cross-session hits.
    await insertMemories([
      newMemory(sessionA, {
        theme: "shared_pattern",
        happenedMd: "Session A observed pattern X in WIF orderbook.",
        embedding: randVector(EMBEDDING_DIM, "shared-seed"),
      }),
    ]);

    const queryEmbedding = randVector(EMBEDDING_DIM, "shared-seed"); // matches A's embedding
    const hits = await recallMemories(queryEmbedding, {
      sessionId: sessionB,
      embeddingModel: TEST_EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIM,
      topK: 10,
      minSimilarity: 0, // disable threshold to prove session filter, not threshold, blocks
    });

    expect(hits).toHaveLength(0);

    // Confirm session A would have found it given the same query — proves
    // the absence in session B is NOT because the vector was bad.
    const aHits = await recallMemories(queryEmbedding, {
      sessionId: sessionA,
      embeddingModel: TEST_EMBEDDING_MODEL,
      embeddingDim: EMBEDDING_DIM,
      topK: 10,
      minSimilarity: 0,
    });
    expect(aHits.length).toBeGreaterThan(0);
  });
});

// ── Scenario 2: knowledge source filter ──────────────────────────

describe("PR4 eval — knowledge source filter (Active Memory hot-context)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("active-knowledge surface filters by source; recall returns all tiers", async () => {
    const sid = await makeSession();
    await insertMessage(sid, "user", "seeding messages so session exists for source-surface FK");

    // Insert one entry per source tier. Same kind to make recall a clean
    // cross-source comparison. Use real embedding so dense recall works.
    const tiers = ["observed", "user_confirmed", "inferred", "hypothesis"] as const;
    const created: Array<{ id: number; source: typeof tiers[number] }> = [];

    for (const source of tiers) {
      const title = `${source} pattern title`;
      const summary = `${source} pattern summary about Kyber quote timeout handling.`;
      const embedded = await embedText(`${title} | ${summary}`);
      const { entry } = await knowledgeRepo.insertEntry({
        kind: "kyber_quote_timeout",
        title,
        summary,
        contentMd: summary,
        tags: [],
        sourceRefs: {},
        confidence: null,
        pinned: true,
        validUntil: null,
        maturityState: "established",
        contentHash: computeContentHash({ kind: "kyber_quote_timeout", title, summary, contentMd: summary }),
        embeddingModel: embedded.providerModel,
        embeddingDim: embedded.embedding.length,
        embedding: embedded.embedding,
        sourceSurface: "vex_agent",
        sourceSession: sid,
        source,
      });
      created.push({ id: entry.id, source });
    }
    expect(created).toHaveLength(4);

    // Active-knowledge surface — must include only observed + user_confirmed.
    const hotEntries = await knowledgeRepo.listActiveForHotContext({ limit: 20 });
    const sourcesById = new Map(created.map((entry) => [entry.id, entry.source]));
    const hotSources = new Set(hotEntries.map((entry) => {
      const source = sourcesById.get(entry.id);
      if (source === undefined) throw new Error("Unexpected knowledge entry in isolated fixture");
      return source;
    }));
    expect(hotSources.has("observed")).toBe(true);
    expect(hotSources.has("user_confirmed")).toBe(true);
    expect(hotSources.has("inferred")).toBe(false);
    expect(hotSources.has("hypothesis")).toBe(false);

    // Recall — returns all tiers when queried explicitly (no source filter on
    // recallLongMemoryTopK; the filter only gates the hot-context auto-injection).
    const queryEmbed = await embedText("Kyber quote timeout patterns");
    const recallHits = await knowledgeRepo.recallLongMemoryTopK(
      queryEmbed.embedding,
      {
        embeddingModel: queryEmbed.providerModel,
        embeddingDim: queryEmbed.embedding.length,
      },
      10,
    );
    const recallSources = new Set(recallHits.map((h) => h.source));
    expect(recallSources.has("observed")).toBe(true);
    expect(recallSources.has("user_confirmed")).toBe(true);
    expect(recallSources.has("inferred")).toBe(true);
    expect(recallSources.has("hypothesis")).toBe(true);
  });
});

// ── Scenario 3: stale-claim defense ──────────────────────────────

describe("PR4 eval — stale-claim defense on compact_jobs", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("only one workerId's markCompleted returns true on the same job", async () => {
    const sid = await makeSession();
    const enq = await enqueueJob(newJob(sid, 1));
    const jobId = enq.job.id;

    const workerA = `worker-A-${randomUUID()}`;
    const workerB = `worker-B-${randomUUID()}`;

    // Worker A claims the job — claimNextDueJob does the FOR UPDATE SKIP
    // LOCKED transition. After this, the row is `running` locked_by=A.
    const claimedA = await claimNextDueJob(workerA);
    expect(claimedA?.id).toBe(jobId);

    // Worker B never owned the row → markCompleted must return false.
    const audit = {
      chunksInserted: 0,
      chunksRejectedByExclusion: 0,
      chunksRejectedByRedaction: 0,
      inferenceProvider: "openrouter",
      inferenceModel: "test-model",
      costUsd: null,
    };
    const okB = await markCompleted(jobId, workerB, audit);
    expect(okB).toBe(false);

    // Worker A's markCompleted lands.
    const okA = await markCompleted(jobId, workerA, audit);
    expect(okA).toBe(true);

    // After A completes, B's retry still returns false (status='completed',
    // owner cleared) — no risk of double-completion races.
    const okBRetry = await markCompleted(jobId, workerB, audit);
    expect(okBRetry).toBe(false);

    // Final row is completed.
    const final = await getJobById(jobId);
    expect(final?.status).toBe("completed");
  });
});

// ── Scenario 4: single-compact full lifecycle ────────────────────

describe("PR4 eval — single-compact session lands a recallable chunk", () => {
  let savedApiKey: string | undefined;
  let savedAgentModel: string | undefined;

  beforeEach(async () => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    savedAgentModel = process.env.AGENT_MODEL;
    process.env.OPENROUTER_API_KEY = "test-fixture-key";
    process.env.AGENT_MODEL = "test/fixture-model";
    await resetDb();
    resetCompactMutexForTests();
    chunkerMockHandle.reset();
  });

  afterEach(() => {
    // Restore env so later integration tests (e.g. compact-service.int.test.ts
    // missing-config gate) see the original baseline. Mirrors the pattern in
    // that file's `afterEach`.
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
    if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = savedAgentModel;
  });

  it("compact_now → worker → session_memory_search recall surfaces the chunk", async () => {
    const sid = await makeSession();
    await seedConversation(sid, 14);

    // Chunker returns a single coherent chunk describing the conversation.
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        {
          theme: "wif_orderbook_observation_pattern",
          entities: ["WIF"],
          protocols: ["solana"],
          error_classes: [],
          chains: ["solana"],
          tasks: ["orderbook_review"],
          happened_md: "Observed thin WIF orderbook with widening spread over 14 turns.",
          did_md: "Logged the pattern for the next decision cycle.",
          tried_md: "Cross-checked with kyber quote depth.",
          outstanding_items: [],
        },
      ],
    });

    const compact = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Reviewed WIF orderbook for thin liquidity.",
      preserveMd: null,
      threadThemesHints: ["wif_orderbook"],
      source: "agent_tool",
    });
    expect(compact.kind).toBe("committed");
    if (compact.kind !== "committed") throw new Error("unreachable");
    expect(compact.generation).toBeGreaterThan(0);

    // Start the executor, wait for the job to complete + chunk to land.
    const handle = startCompactJobsExecutor({ pollIntervalMs: 100 });
    try {
      await waitFor(async () => {
        const job = await getJobById(compact.jobId);
        return job?.status === "completed";
      });
    } finally {
      await handle.stop();
    }

    // Memory recall must find the chunk via semantic query.
    const stats = await getSessionMemoryStats(sid, 10);
    expect(stats.activeCount).toBe(1);

    const queryEmbed = await embedText("WIF liquidity orderbook patterns");
    const hits = await recallMemories(queryEmbed.embedding, {
      sessionId: sid,
      embeddingModel: queryEmbed.providerModel,
      embeddingDim: queryEmbed.embedding.length,
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].memory.theme).toBe("wif_orderbook_observation_pattern");
    expect(hits[0].memory.bodyMd).toContain("Observed thin WIF orderbook");
  });
});

// ── Scenario 5: outstanding item resolution survives compact ─────

describe("PR4 eval — outstanding-item resolution survives a subsequent compact", () => {
  let savedApiKey: string | undefined;
  let savedAgentModel: string | undefined;

  beforeEach(async () => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    savedAgentModel = process.env.AGENT_MODEL;
    process.env.OPENROUTER_API_KEY = "test-fixture-key";
    process.env.AGENT_MODEL = "test/fixture-model";
    await resetDb();
    resetCompactMutexForTests();
    chunkerMockHandle.reset();
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
    if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = savedAgentModel;
  });

  it("chunk with 2 outstanding items, resolve one, run another compact — resolved state sticks", async () => {
    const sid = await makeSession();
    await seedConversation(sid, 14);

    // First compact — chunker emits a chunk with TWO outstanding items.
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        {
          theme: "pending_swap_review_pattern",
          entities: ["USDC", "SOL"],
          protocols: ["solana"],
          error_classes: [],
          chains: ["solana"],
          tasks: ["swap_review"],
          happened_md: "User initiated SOL→USDC swap discussion.",
          did_md: "Identified two follow-up checks.",
          tried_md: "",
          outstanding_items: ["confirm slippage budget", "verify destination wallet"],
        },
      ],
    });

    const compact1 = await executeCompactNow({
      sessionId: sid,
      agentSummary: "First compact with outstanding items.",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });
    if (compact1.kind !== "committed") throw new Error("compact1 not committed");

    const handle = startCompactJobsExecutor({ pollIntervalMs: 100 });
    try {
      await waitFor(async () => (await getJobById(compact1.jobId))?.status === "completed");
    } finally {
      await handle.stop();
    }

    // Get the chunk and resolve one of its outstanding items.
    const stats1 = await getSessionMemoryStats(sid, 10);
    expect(stats1.activeCount).toBe(1);

    const queryEmbed = await embedText("pending swap review");
    const hits1 = await recallMemories(queryEmbed.embedding, {
      sessionId: sid,
      embeddingModel: queryEmbed.providerModel,
      embeddingDim: queryEmbed.embedding.length,
      topK: 5,
      minSimilarity: 0,
    });
    expect(hits1.length).toBeGreaterThan(0);
    const memory = hits1[0].memory;
    expect(memory.outstandingItems).toHaveLength(2);

    const itemToResolve = memory.outstandingItems[0];
    const resolve = await markOutstandingResolved(
      memory.id,
      itemToResolve.id,
      "slippage budget = 0.5%",
      "agent",
    );
    expect(resolve.ok).toBe(true);
    if (!resolve.ok) throw new Error("unreachable");

    // After resolution: one outstanding remains unresolved, one resolved.
    const unresolvedAfter = resolve.memory.outstandingItems.filter((it) => it.resolvedAt === null);
    expect(unresolvedAfter).toHaveLength(1);

    // Add more conversation + run a second compact. The chunker doesn't
    // re-derive the old chunk (different message range), so the old chunk's
    // resolved state is the authoritative truth that must survive.
    await seedConversation(sid, 14);
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        {
          theme: "post_swap_confirmation_pattern",
          entities: [],
          protocols: ["solana"],
          error_classes: [],
          chains: [],
          tasks: [],
          happened_md: "Swap completed.",
          did_md: "",
          tried_md: "",
          outstanding_items: [],
        },
      ],
    });
    const compact2 = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Second compact after the first.",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });
    if (compact2.kind !== "committed") throw new Error("compact2 not committed");

    const handle2 = startCompactJobsExecutor({ pollIntervalMs: 100 });
    try {
      await waitFor(async () => (await getJobById(compact2.jobId))?.status === "completed");
    } finally {
      await handle2.stop();
    }

    // Re-query the FIRST chunk via its theme — resolved item must still be
    // resolved; the second compact didn't reset it.
    const reHits = await recallMemories(queryEmbed.embedding, {
      sessionId: sid,
      embeddingModel: queryEmbed.providerModel,
      embeddingDim: queryEmbed.embedding.length,
      topK: 10,
      minSimilarity: 0,
    });
    const swapReviewHit = reHits.find((h) => h.memory.id === memory.id);
    expect(swapReviewHit).toBeDefined();
    if (!swapReviewHit) throw new Error("unreachable");
    const resolvedFinal = swapReviewHit.memory.outstandingItems.find((it) => it.id === itemToResolve.id);
    expect(resolvedFinal?.resolvedAt).not.toBeNull();
    expect(resolvedFinal?.resolutionNote).toBe("slippage budget = 0.5%");
  });
});

// ── PR4.2: compact worker redaction / retry / validation regressions ─

describe("PR4.2 eval — Track 2 worker regression coverage", () => {
  let savedApiKey: string | undefined;
  let savedAgentModel: string | undefined;

  beforeEach(async () => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    savedAgentModel = process.env.AGENT_MODEL;
    process.env.OPENROUTER_API_KEY = "test-fixture-key";
    process.env.AGENT_MODEL = "test/fixture-model";
    await resetDb();
    resetCompactMutexForTests();
    chunkerMockHandle.reset();
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
    if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = savedAgentModel;
  });

  it("redacts archived transcript content before the chunker provider sees the prompt", async () => {
    const sid = await makeSession();
    const rawPrivateKey = `private_key=0x${"a".repeat(64)}`;
    const rawApiKey = `sk-${"x".repeat(28)}`;
    const rawAddress = "0x1234567890abcdef1234567890abcdef12345678";
    const rawTx = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

    await insertMessage(
      sid,
      "user",
      `Sensitive setup note: ${rawPrivateKey} ${rawApiKey} address ${rawAddress} tx ${rawTx}`,
    );
    await seedConversation(sid, 14);
    chunkerMockHandle.setChunkerResponse({ chunks: [] });

    const compact = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Archive sensitive setup note after redaction.",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });
    if (compact.kind !== "committed") throw new Error("compact not committed");

    await processJobToCompletion(compact.jobId);

    const prompt = chunkerMockHandle.getLastUserPrompt();
    expect(prompt).toContain("[REDACTED:private_key]");
    expect(prompt).toContain("[REDACTED:api_key]");
    expect(prompt).toContain("0x1234");
    expect(prompt).toContain("5678");
    expect(prompt).toContain("0xabcd");
    expect(prompt).not.toContain(rawPrivateKey);
    expect(prompt).not.toContain(rawApiKey);
    expect(prompt).not.toContain(rawAddress);
    expect(prompt).not.toContain(rawTx);

    const job = await getJobById(compact.jobId);
    expect(job?.status).toBe("completed");
    expect(job?.chunksInserted).toBe(0);
  });

  it("retries provider 429 failures and lands chunks on the third attempt while Track 1 remains committed", async () => {
    const sid = await makeSession();
    await seedConversation(sid, 14);

    chunkerMockHandle.setFailures([
      new Error("openrouter 429: rate limited"),
      new Error("openrouter 429: rate limited"),
    ]);
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        chunk({
          theme: "kyber_retry_backoff_pattern",
          entities: ["Kyber"],
          protocols: ["kyberswap"],
          chains: ["base"],
          tasks: ["quote_retry"],
          happenedMd: "Kyber quote failed twice with provider rate limits before succeeding.",
          didMd: "Kept the compact job retryable and preserved Track 1 continuity.",
        }),
      ],
    });

    const compact = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Track 1 committed before Track 2 retry.",
      preserveMd: null,
      threadThemesHints: ["kyber_retry_backoff"],
      source: "agent_tool",
    });
    if (compact.kind !== "committed") throw new Error("compact not committed");

    const sessionAfterTrack1 = await queryOne<{ checkpoint_generation: number }>(
      "SELECT checkpoint_generation FROM sessions WHERE id = $1",
      [sid],
    );
    expect(sessionAfterTrack1?.checkpoint_generation).toBe(compact.generation);

    const handle = startCompactJobsExecutor({ pollIntervalMs: 50 });
    try {
      await waitFor(async () => {
        const job = await getJobById(compact.jobId);
        return !!job && job.attemptCount >= 1 && job.status !== "running";
      });
      await execute("UPDATE compact_jobs SET next_attempt_at = NOW() WHERE id = $1", [compact.jobId]);

      await waitFor(async () => {
        const job = await getJobById(compact.jobId);
        return !!job && job.attemptCount >= 2 && job.status !== "running";
      });
      await execute("UPDATE compact_jobs SET next_attempt_at = NOW() WHERE id = $1", [compact.jobId]);

      await waitFor(async () => (await getJobById(compact.jobId))?.status === "completed", 15_000);
    } finally {
      await handle.stop();
    }

    const job = await getJobById(compact.jobId);
    expect(job?.attemptCount).toBe(3);
    expect(job?.chunksInserted).toBe(1);
    const stats = await getSessionMemoryStats(sid, 10);
    expect(stats.activeCount).toBe(1);
  });

  it("rejects live-state-heavy chunker output and records the exclusion counter", async () => {
    const sid = await makeSession();
    await seedConversation(sid, 14);
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        chunk({
          theme: "wallet_snapshot_balance_state",
          entities: ["USDC"],
          chains: ["base"],
          tasks: ["balance_snapshot"],
          happenedMd: [
            "balance is 1.23 SOL",
            "current price: $123.45",
            "5 gwei gas",
            "slot 12345678",
            "tx 0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd pending",
          ].join(" "),
        }),
      ],
    });

    const compact = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Reject live state snapshots.",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });
    if (compact.kind !== "committed") throw new Error("compact not committed");
    await processJobToCompletion(compact.jobId);

    const job = await getJobById(compact.jobId);
    expect(job?.chunksInserted).toBe(0);
    expect(job?.chunksRejectedByExclusion).toBe(1);
    const stats = await getSessionMemoryStats(sid, 10);
    expect(stats.activeCount).toBe(0);
  });

  it("hard-redacts chunker-emitted secrets before storing body_md", async () => {
    const sid = await makeSession();
    await seedConversation(sid, 14);
    const rawPrivateKey = `private_key=0x${"c".repeat(64)}`;
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        chunk({
          theme: "signer_secret_redaction_pattern",
          entities: ["signer"],
          tasks: ["secret_redaction"],
          happenedMd: `Durable lesson: remove ${rawPrivateKey} from generated memory text.`,
          didMd: "Stored only the sanitized setup lesson.",
          outstandingItems: [`Verify sanitized output does not contain ${rawPrivateKey}`],
        }),
      ],
    });

    const compact = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Redaction regression compact.",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });
    if (compact.kind !== "committed") throw new Error("compact not committed");
    await processJobToCompletion(compact.jobId);

    const row = await queryOne<{ body_md: string; happened_md: string; outstanding_items: unknown }>(
      "SELECT body_md, happened_md, outstanding_items FROM session_memories WHERE session_id = $1",
      [sid],
    );
    expect(row).not.toBeNull();
    expect(row!.body_md).toContain("[REDACTED:private_key]");
    expect(row!.happened_md).toContain("[REDACTED:private_key]");
    expect(JSON.stringify(row!.outstanding_items)).toContain("[REDACTED:private_key]");
    expect(row!.body_md).not.toContain(rawPrivateKey);
    expect(row!.happened_md).not.toContain(rawPrivateKey);
    expect(JSON.stringify(row!.outstanding_items)).not.toContain(rawPrivateKey);
  });

  it("falls back from degenerate themes to entity-derived slugs", async () => {
    const sid = await makeSession();
    await seedConversation(sid, 14);
    chunkerMockHandle.setChunkerResponse({
      chunks: [
        chunk({
          theme: "debug_session_mission",
          entities: ["WIF"],
          chains: ["solana"],
          tasks: ["quote_debug"],
          happenedMd: "The durable issue was a WIF quote debug pattern on Solana.",
        }),
      ],
    });

    const compact = await executeCompactNow({
      sessionId: sid,
      agentSummary: "Theme fallback compact.",
      preserveMd: null,
      threadThemesHints: [],
      source: "agent_tool",
    });
    if (compact.kind !== "committed") throw new Error("compact not committed");
    await processJobToCompletion(compact.jobId);

    const row = await queryOne<{ theme: string; theme_source: string }>(
      "SELECT theme, theme_source FROM session_memories WHERE session_id = $1",
      [sid],
    );
    expect(row?.theme_source).toBe("fallback");
    expect(row?.theme).not.toBe("debug_session_mission");
    expect(row?.theme).toContain("wif");
    expect(row?.theme).toContain("quote");
  });
});

describe("PR4.2 eval — multi-compact and long autonomous missions", () => {
  let savedApiKey: string | undefined;
  let savedAgentModel: string | undefined;

  beforeEach(async () => {
    savedApiKey = process.env.OPENROUTER_API_KEY;
    savedAgentModel = process.env.AGENT_MODEL;
    process.env.OPENROUTER_API_KEY = "test-fixture-key";
    process.env.AGENT_MODEL = "test/fixture-model";
    await resetDb();
    resetCompactMutexForTests();
    chunkerMockHandle.reset();
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedApiKey;
    if (savedAgentModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = savedAgentModel;
  });

  it("runs 3 compacts, bumps generations 1→2→3, enqueues jobs, and recalls scoped chunks", async () => {
    const sid = await makeSession();
    const committedJobIds: number[] = [];

    for (let gen = 1; gen <= 3; gen++) {
      await seedConversation(sid, 14);
      chunkerMockHandle.setChunkerResponse({
        chunks: [
          chunk({
            theme: `kyber_route_cycle_${gen}_pattern`,
            entities: ["Kyber"],
            protocols: ["kyberswap"],
            chains: ["base"],
            tasks: [`cycle_${gen}_route_review`],
            happenedMd: `Cycle ${gen} preserved a durable Kyber route validation decision.`,
            didMd: `Archived generation ${gen} and made it recallable.`,
          }),
        ],
      });

      const compact = await executeCompactNow({
        sessionId: sid,
        agentSummary: `Generation ${gen} summary for Kyber route validation.`,
        preserveMd: null,
        threadThemesHints: [`kyber_route_cycle_${gen}`],
        source: "agent_tool",
      });
      expect(compact.kind).toBe("committed");
      if (compact.kind !== "committed") throw new Error("compact not committed");
      expect(compact.generation).toBe(gen);
      committedJobIds.push(compact.jobId);
      await processJobToCompletion(compact.jobId);
    }

    const sessionRow = await queryOne<{ checkpoint_generation: number }>(
      "SELECT checkpoint_generation FROM sessions WHERE id = $1",
      [sid],
    );
    expect(sessionRow?.checkpoint_generation).toBe(3);

    const jobRows = await query<{ checkpoint_generation: number; status: string }>(
      "SELECT checkpoint_generation, status FROM compact_jobs WHERE session_id = $1 ORDER BY checkpoint_generation ASC",
      [sid],
    );
    expect(jobRows.map((r) => r.checkpoint_generation)).toEqual([1, 2, 3]);
    expect(jobRows.every((r) => r.status === "completed")).toBe(true);

    const memoryRows = await query<{ checkpoint_generation: number }>(
      "SELECT checkpoint_generation FROM session_memories WHERE session_id = $1 ORDER BY checkpoint_generation ASC",
      [sid],
    );
    expect(memoryRows.map((r) => r.checkpoint_generation)).toEqual([1, 2, 3]);

    const queryEmbed = await embedText("Kyber route validation decisions");
    const hits = await recallMemories(queryEmbed.embedding, {
      sessionId: sid,
      embeddingModel: queryEmbed.providerModel,
      embeddingDim: queryEmbed.embedding.length,
      topK: 10,
      minSimilarity: -1,
    });
    expect(new Set(hits.map((h) => h.memory.checkpointGeneration))).toEqual(new Set([1, 2, 3]));
    expect(committedJobIds).toHaveLength(3);
  });

  it("drives 20 compact cycles with bounded summary, non-degenerate themes, and recallable chunks", async () => {
    const sid = await makeSession();
    const handle = startCompactJobsExecutor({ pollIntervalMs: 25 });
    try {
      for (let gen = 1; gen <= 20; gen++) {
        await seedConversation(sid, 14);
        chunkerMockHandle.setChunkerResponse({
          chunks: [
            chunk({
              theme: `autonomous_cycle_${gen}_decision_pattern`,
              entities: ["mission"],
              tasks: [`cycle_${gen}_decision_review`],
              happenedMd: `Autonomous cycle ${gen} preserved a durable decision pattern.`,
              didMd: `Kept generation ${gen} summary within the bounded compact contract.`,
            }),
          ],
        });

        const compact = await executeCompactNow({
          sessionId: sid,
          agentSummary: `Cycle ${gen} summary: durable autonomous decision state stayed bounded.`,
          preserveMd: null,
          threadThemesHints: [`autonomous_cycle_${gen}`],
          source: "forced_fallback",
        });
        expect(compact.kind).toBe("committed");
        if (compact.kind !== "committed") throw new Error("compact not committed");
        await waitFor(async () => (await getJobById(compact.jobId))?.status === "completed", 15_000);
      }
    } finally {
      await handle.stop();
    }

    const sessionRow = await queryOne<{ checkpoint_generation: number; summary: string | null }>(
      "SELECT checkpoint_generation, summary FROM sessions WHERE id = $1",
      [sid],
    );
    expect(sessionRow?.checkpoint_generation).toBe(20);
    expect((sessionRow?.summary ?? "").length).toBeLessThanOrEqual(4000);

    const memoryRows = await query<{ theme: string; checkpoint_generation: number }>(
      "SELECT theme, checkpoint_generation FROM session_memories WHERE session_id = $1 ORDER BY checkpoint_generation ASC",
      [sid],
    );
    expect(memoryRows).toHaveLength(20);
    expect(memoryRows.every((r) => r.theme.startsWith("autonomous_cycle_"))).toBe(true);
    expect(memoryRows.every((r) => !["debug", "session", "mission"].includes(r.theme))).toBe(true);

    const queryEmbed = await embedText("autonomous durable decision pattern");
    const hits = await recallMemories(queryEmbed.embedding, {
      sessionId: sid,
      embeddingModel: queryEmbed.providerModel,
      embeddingDim: queryEmbed.embedding.length,
      topK: 20,
      minSimilarity: -1,
    });
    expect(hits).toHaveLength(20);
  }, 60_000);
});
