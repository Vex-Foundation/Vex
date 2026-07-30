/**
 * Integration: the branch workers' compaction-bus emits, against real Postgres.
 *
 * Two properties, and both are the kind that only a real DB can prove:
 *
 *   POST-COMMIT. The listener re-reads the row the moment it fires — exactly
 *   what the renderer does. If a producer emitted inside its transaction, that
 *   read would observe the OLD state, and the renderer would then sit on a
 *   stale button until the 60s fallback poll. So the assertion is not "an event
 *   fired" but "a read taken FROM the listener already sees the new state".
 *
 *   SILENCE WHEN NOTHING WAS WRITTEN. A refused CAS or a lost lease wrote
 *   nothing, so there is nothing to announce; an event there would make the
 *   renderer refetch and re-render an unchanged row.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  getPreparationById,
  SUMMARY_MAX_ATTEMPTS,
  type CompactionPreparation,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { execute } from "@vex-agent/db/client.js";
import {
  COMPACTION_PREPARATION_EVENT_TYPE,
  compactionPreparationBus,
  type CompactionPreparationEvent,
} from "@vex-agent/engine/runtime/compaction-bus.js";
import {
  buildPreparationCorpus,
  fingerprintPreparationCorpus,
  serializePreparationCorpus,
} from "@vex-agent/engine/compaction-prep/index.js";
import { runSummaryBranchTick } from "@vex-agent/engine/compaction/branch-a-summary-worker.js";
import { runChunksBranchTick } from "@vex-agent/engine/compaction/branch-b-chunks-worker.js";
import type { JudgeProvider } from "@vex-agent/memory/manager/judge.js";
import type { MessageWithId } from "@vex-agent/db/repos/messages/types.js";

import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation, makeDue } from "../repos/compaction-preparation-fixtures.js";

const SUMMARY_OUT = JSON.stringify({
  conversation_summary: "The user prefers Solana routes and refuses bridges.",
});
const CHUNKS_OUT = JSON.stringify({
  chunks: [
    {
      theme: "user_prefers_solana_routes",
      happened_md: "the user asked to avoid bridges",
    },
  ],
});

function provider(content: string): () => Promise<JudgeProvider> {
  return async () => ({
    loadConfig: async () => ({ model: "test/model" }),
    chatCompletionSimple: async () => ({ content, usage: { cost: 0.0001 } }),
  });
}

/**
 * Captures each event together with a row read taken FROM the listener — the
 * renderer's own refetch, at the renderer's own moment.
 */
function captureEvents(): {
  events: CompactionPreparationEvent[];
  rowsAtEmit: (CompactionPreparation | null)[];
  pending: () => Promise<void>;
  stop: () => void;
} {
  const events: CompactionPreparationEvent[] = [];
  const rowsAtEmit: (CompactionPreparation | null)[] = [];
  const reads: Promise<void>[] = [];
  // `resetDb` restarts identity, and each test forks exactly one preparation,
  // so id 1 is the row every event in this suite refers to.
  const ONLY_PREPARATION_ID = 1;
  const stop = compactionPreparationBus.subscribe(() => {
    reads.push(
      getPreparationById(ONLY_PREPARATION_ID).then((row) => {
        rowsAtEmit.push(row);
      }),
    );
  });
  const stopEvents = compactionPreparationBus.subscribe((event) => {
    events.push(event);
  });
  return {
    events,
    rowsAtEmit,
    pending: async () => {
      await Promise.all(reads);
    },
    stop: () => {
      stop();
      stopEvents();
    },
  };
}

async function forkWithCorpus() {
  const sessionId = await makeSession();
  const text = serializePreparationCorpus(
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
  const preparation = await forkPreparation(sessionId, {
    corpusText: text,
    corpusSha256: fingerprintPreparationCorpus(text),
    watermarkMessageId: 1,
  });
  await makeDue(preparation.id, "summary_next_attempt_at");
  await makeDue(preparation.id, "chunks_next_attempt_at");
  return { sessionId, preparation };
}

describe("compaction branch workers emit after commit", () => {
  const originalKey = process.env.OPENROUTER_API_KEY;
  const originalModel = process.env.AGENT_MODEL;
  let capture: ReturnType<typeof captureEvents>;

  beforeEach(async () => {
    await resetDb();
    compactionPreparationBus.clear();
    capture = captureEvents();
    process.env.OPENROUTER_API_KEY = "test-key";
    process.env.AGENT_MODEL = "test/model";
  });

  afterEach(() => {
    capture.stop();
    compactionPreparationBus.clear();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.AGENT_MODEL;
    else process.env.AGENT_MODEL = originalModel;
  });

  it("branch A announces summary_ready, and the state is already readable", async () => {
    const { sessionId } = await forkWithCorpus();

    await runSummaryBranchTick("summary-worker", {
      makeProvider: provider(SUMMARY_OUT),
    });
    await capture.pending();

    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]).toEqual({
      type: COMPACTION_PREPARATION_EVENT_TYPE,
      sessionId,
      status: "summary_ready",
      summaryReady: true,
      correlationId: null,
    });
    // The renderer's refetch, taken at emit time, already sees the transition.
    expect(capture.rowsAtEmit[0]?.status).toBe("summary_ready");
    expect(capture.rowsAtEmit[0]?.summaryOutput).not.toBeNull();
  });

  it("branch A is SILENT on a non-terminal failed attempt and speaks once at exhaustion", async () => {
    const { sessionId, preparation } = await forkWithCorpus();

    for (let attempt = 1; attempt <= SUMMARY_MAX_ATTEMPTS; attempt += 1) {
      await makeDue(preparation.id, "summary_next_attempt_at");
      await runSummaryBranchTick("summary-worker", {
        makeProvider: provider("not json at all"),
      });
    }
    await capture.pending();

    // Two retries changed nothing observable; only the terminal transition did.
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]).toMatchObject({
      sessionId,
      status: "failed",
      summaryReady: false,
    });
    expect(capture.rowsAtEmit[0]?.status).toBe("failed");
  });

  it("branch A stays silent when the readiness CAS is refused", async () => {
    const { preparation } = await forkWithCorpus();

    const outcome = await runSummaryBranchTick("summary-worker", {
      makeProvider: async () => ({
        loadConfig: async () => ({ model: "test/model" }),
        chatCompletionSimple: async () => {
          await execute(
            "UPDATE compaction_preparations SET status = 'superseded' WHERE id = $1",
            [preparation.id],
          );
          return { content: SUMMARY_OUT };
        },
      }),
    });
    await capture.pending();

    // Nothing was written, so there is nothing to announce.
    expect(outcome.kind).toBe("rejected");
    expect(capture.events).toHaveLength(0);
  });

  it("branch B announces the freeze and the landing separately", async () => {
    const { sessionId } = await forkWithCorpus();

    await runChunksBranchTick("chunks-worker", {
      makeProvider: provider(CHUNKS_OUT),
    });
    await capture.pending();

    // The row STATUS never moves for branch B — the DTO's `chunks_*` fields do,
    // which is exactly why both commits still have to be announced.
    expect(capture.events).toHaveLength(2);
    expect(capture.events.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(capture.events.every((e) => e.status === "preparing")).toBe(true);
    expect(capture.rowsAtEmit[0]?.chunksStatus).toBe("frozen");
    expect(capture.rowsAtEmit[0]?.chunksFrozenOutput).not.toBeNull();
    expect(capture.rowsAtEmit[1]?.chunksStatus).toBe("succeeded");
    expect(capture.rowsAtEmit[1]?.chunksInserted).toBe(1);
  });

  it("branch B stays silent when the vault is locked and nothing is claimed", async () => {
    await forkWithCorpus();
    delete process.env.OPENROUTER_API_KEY;

    await runChunksBranchTick("chunks-worker");
    await capture.pending();

    expect(capture.events).toHaveLength(0);
  });
});
