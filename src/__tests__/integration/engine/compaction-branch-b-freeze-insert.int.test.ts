/**
 * Integration: branch B's freeze-then-insert contract (C5) against real
 * Postgres and the real embeddings sidecar.
 *
 * The behaviour under test is the crash-retry guarantee: once the snapshot is
 * frozen, a retry inserts EXACTLY those bytes, makes ZERO model calls, and
 * produces no duplicate rows. There is no delete path anywhere in it — a
 * delete would turn a crash into data loss, which is why the row identity is
 * asserted stable across retries rather than merely the row count.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { getPreparationById } from "@vex-agent/db/repos/compaction-preparations/index.js";
import { execute, query } from "@vex-agent/db/client.js";
import {
  buildPreparationCorpus,
  fingerprintPreparationCorpus,
  serializePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/index.js";
import { runChunksBranchTick } from "@vex-agent/engine/compaction/branch-b-chunks-worker.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation, makeDue } from "../repos/compaction-preparation-fixtures.js";

const WORKER = "test-chunks-worker";
const OTHER_WORKER = "test-chunks-worker-2";

const CHUNKS = JSON.stringify({
  chunks: [
    {
      theme: "user_prefers_solana_routes",
      happened_md: "the user asked to avoid bridges",
      did_md: "recorded the preference",
      outstanding_items: ["confirm the preference next session"],
      protocols: ["kyberswap"],
      chains: ["solana"],
    },
  ],
});

/**
 * A chunk in the size class that broke the live run (~747 tokens). The stub
 * returns it for BOTH the chunking call and the repair round, standing in for a
 * model that will not comply.
 */
const OVERSIZED_CHUNKS = JSON.stringify({
  chunks: [
    {
      theme: "kyber_quote_timeout_pattern",
      happened_md: "the kyberswap quote timed out again. ".repeat(81),
      did_md: "retried with a longer deadline",
      outstanding_items: [],
      protocols: ["kyberswap"],
      chains: ["solana"],
    },
  ],
});

function corpusText(): string {
  return serializePreparationCorpus(
    buildPreparationCorpus({
      frozenSummary: null,
      rows: [
        {
          id: 1,
          role: "user",
          content: "avoid bridges please",
          toolCallId: null,
          toolCalls: null,
        },
      ] as unknown as MessageWithId[],
      watermarkMessageId: 1,
    }),
  );
}

/** Counts model calls so a retry proving "zero LLM calls" is a real assertion. */
function countingProvider(content: string): {
  factory: () => Promise<JudgeProvider>;
  calls: () => number;
} {
  let calls = 0;
  return {
    factory: async () => ({
      loadConfig: async () => ({ model: "test/model" }),
      chatCompletionSimple: async () => {
        calls += 1;
        return { content, usage: { cost: 0.0003 } };
      },
    }),
    calls: () => calls,
  };
}

async function forkWithCorpus() {
  const sessionId = await makeSession();
  const text = corpusText();
  const preparation = await forkPreparation(sessionId, {
    corpusText: text,
    corpusSha256: fingerprintPreparationCorpus(text),
    watermarkMessageId: 1,
    baseCheckpointGeneration: 2,
    targetCheckpointGeneration: 3,
  });
  await makeDue(preparation.id, "chunks_next_attempt_at");
  return { sessionId, preparation };
}

async function memoryRows(sessionId: string) {
  return query<{
    id: number;
    theme: string;
    theme_source: string;
    status: string;
    checkpoint_generation: number;
    source_end_message_id: number | null;
    body_md: string;
  }>(
    `SELECT id, theme, theme_source, status, checkpoint_generation, source_end_message_id, body_md
     FROM session_memories WHERE session_id = $1 ORDER BY id ASC`,
    [sessionId],
  );
}

/** Simulate a crash after the freeze: release the lease and make it due. */
async function simulatePostFreezeCrash(id: number): Promise<void> {
  await execute(
    `UPDATE compaction_preparations
     SET chunks_locked_by = NULL, chunks_locked_at = NULL, chunks_heartbeat_at = NULL,
         chunks_next_attempt_at = NOW() - interval '1 second'
     WHERE id = $1`,
    [id],
  );
}

describe("branch-B freeze-then-insert (integration)", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;

  beforeEach(async () => {
    await resetDb();
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
  });

  it("carries theme provenance from the freeze to the row", async () => {
    const { sessionId } = await forkWithCorpus();
    await runChunksBranchTick(WORKER, { makeProvider: countingProvider(CHUNKS).factory });

    const rows = await memoryRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].theme).toBe("user_prefers_solana_routes");
    expect(rows[0].theme_source).toBe("chunker");
  });

  it("records a fallback theme as `fallback`, not `chunker`", async () => {
    // `debug` is a single token, so `validateTheme` rejects it and
    // `buildFallbackTheme` supplies the theme instead. The fallback validates by
    // CONSTRUCTION, so re-deriving provenance at insert time would label this
    // row `chunker` and quietly falsify the audit trail. The snapshot carries
    // the label decided where the choice was actually made.
    const { sessionId } = await forkWithCorpus();
    const fallbackChunks = JSON.stringify({
      chunks: [
        {
          theme: "debug",
          happened_md: "the user asked to avoid bridges",
          did_md: "recorded the preference",
          outstanding_items: [],
          protocols: ["kyberswap"],
          chains: ["solana"],
        },
      ],
    });

    const outcome = await runChunksBranchTick(WORKER, {
      makeProvider: countingProvider(fallbackChunks).factory,
    });
    expect(outcome).toMatchObject({ kind: "landed", inserted: 1 });

    const rows = await memoryRows(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].theme).not.toBe("debug");
    expect(rows[0].theme_source).toBe("fallback");
  });

  it("freezes the snapshot and lands it at the fixed target generation", async () => {
    const { sessionId, preparation } = await forkWithCorpus();
    const provider = countingProvider(CHUNKS);

    const outcome = await runChunksBranchTick(WORKER, {
      makeProvider: provider.factory,
    });
    expect(outcome).toMatchObject({ kind: "landed", inserted: 1, deduped: 0 });

    const row = await getPreparationById(preparation.id);
    expect(row?.chunksStatus).toBe("succeeded");
    expect(row?.chunksFrozenOutput?.chunks).toHaveLength(1);
    expect(row?.chunksInserted).toBe(1);
    expect(row?.chunksRejectedByExclusionAtFreeze).toBe(0);
    expect(row?.chunksCostUsd).toBeCloseTo(0.0003, 6);

    const memories = await memoryRows(sessionId);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.status).toBe("active");
    // The FIXED target generation frozen at fork, and the watermark as the
    // upper source bound (the corpus is membership, not an interval).
    expect(memories[0]?.checkpoint_generation).toBe(3);
    expect(memories[0]?.source_end_message_id).toBe(1);
  });

  it("a post-freeze crash retries with ZERO model calls and inserts exactly the frozen bytes", async () => {
    const { sessionId, preparation } = await forkWithCorpus();

    // Attempt 1: freeze, then die before the insert can complete.
    const first = countingProvider(CHUNKS);
    await runChunksBranchTick(WORKER, { makeProvider: first.factory });
    expect(first.calls()).toBe(1);

    const afterFirst = await memoryRows(sessionId);
    const frozenBefore = (await getPreparationById(preparation.id))
      ?.chunksFrozenOutput;

    // Re-open the frozen tail as if the process had died mid-insert.
    await execute(
      "UPDATE compaction_preparations SET chunks_status = 'frozen' WHERE id = $1",
      [preparation.id],
    );
    await simulatePostFreezeCrash(preparation.id);

    const second = countingProvider(
      JSON.stringify({ chunks: [{ theme: "should_never_be_used" }] }),
    );
    const retry = await runChunksBranchTick(OTHER_WORKER, {
      makeProvider: second.factory,
    });

    // The whole point: the retry never reaches the model.
    expect(second.calls()).toBe(0);
    expect(retry).toMatchObject({ kind: "landed", inserted: 0, deduped: 1 });

    const afterRetry = await memoryRows(sessionId);
    // Same rows, same ids — the upsert collapsed the retry, nothing was
    // deleted and re-created.
    expect(afterRetry.map((r) => r.id)).toEqual(afterFirst.map((r) => r.id));
    expect(afterRetry.map((r) => r.body_md)).toEqual(
      afterFirst.map((r) => r.body_md),
    );
    expect(afterRetry.every((r) => r.status === "active")).toBe(true);
    expect(
      (await getPreparationById(preparation.id))?.chunksFrozenOutput,
    ).toEqual(frozenBefore);
  });

  it("lands late on a superseded preparation and records the late landing", async () => {
    const { sessionId, preparation } = await forkWithCorpus();
    const provider = countingProvider(CHUNKS);

    // The row is superseded WHILE the model call is in flight: the FSM-forward
    // edges refuse it, but the memory write is still valid — the conversation
    // prefix it describes really happened.
    await runChunksBranchTick(WORKER, {
      makeProvider: async () => ({
        loadConfig: async () => ({ model: "test/model" }),
        chatCompletionSimple: async () => {
          await execute(
            "UPDATE compaction_preparations SET status = 'superseded' WHERE id = $1",
            [preparation.id],
          );
          return { content: CHUNKS, usage: { cost: 0.0003 } };
        },
      }),
    });
    expect(provider.calls()).toBe(0);

    const row = await getPreparationById(preparation.id);
    expect(row?.status).toBe("superseded");
    expect(row?.chunksStatus).toBe("succeeded");
    expect(row?.chunksLandedAfterSupersession).toBe(true);

    const memories = await memoryRows(sessionId);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.status).toBe("active");
  });

  it("stays idle without provider config, but still drains a frozen tail", async () => {
    const { sessionId, preparation } = await forkWithCorpus();
    const provider = countingProvider(CHUNKS);
    await runChunksBranchTick(WORKER, { makeProvider: provider.factory });

    await execute(
      "UPDATE compaction_preparations SET chunks_status = 'frozen' WHERE id = $1",
      [preparation.id],
    );
    await simulatePostFreezeCrash(preparation.id);

    // Inserting a snapshot that was already paid for needs no credentials —
    // gating it on the vault would strand durable work behind a locked vault.
    delete process.env.OPENROUTER_API_KEY;
    const outcome = await runChunksBranchTick(OTHER_WORKER);
    expect(outcome).toMatchObject({ kind: "landed" });
    expect((await memoryRows(sessionId))).toHaveLength(1);
  });

  it("never freezes a chunk the embeddings provider could not accept", async () => {
    // The live acceptance run's defect, end to end: an oversized chunk reached
    // the freeze, every insert failed with the provider's 500, and the row sat
    // in `chunks_status = 'frozen'` retrying forever — the session silently
    // never got its narrative memory. The size budget has to make that state
    // unreachable, so a model that will not comply produces a FAILED ATTEMPT
    // with nothing frozen and nothing in `session_memories`.
    const { sessionId, preparation } = await forkWithCorpus();
    const provider = countingProvider(OVERSIZED_CHUNKS);

    const outcome = await runChunksBranchTick(WORKER, {
      makeProvider: provider.factory,
    });

    expect(outcome).toMatchObject({ kind: "llm_failed" });
    // One chunking call plus exactly ONE repair round — never a per-chunk loop.
    expect(provider.calls()).toBe(2);

    const row = await getPreparationById(preparation.id);
    expect(row?.chunksStatus).not.toBe("frozen");
    expect(row?.chunksFrozenOutput).toBeNull();
    expect(row?.chunksLastError).toMatch(/oversized_after_repair/);
    expect(await memoryRows(sessionId)).toHaveLength(0);
  });

  it("does not claim an LLM attempt while the vault is locked", async () => {
    const { preparation } = await forkWithCorpus();
    delete process.env.OPENROUTER_API_KEY;

    expect(await runChunksBranchTick(WORKER)).toEqual({
      kind: "idle_no_provider_config",
    });
    const row = await getPreparationById(preparation.id);
    expect(row?.chunksAttemptCount).toBe(0);
    expect(row?.chunksStatus).toBe("pending");
  });
});
