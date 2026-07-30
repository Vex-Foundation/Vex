/**
 * Integration: corpus retention.
 *
 * The corpus may only be dropped once BOTH consumers are finished — the row and
 * branch B — and either one can be the last to arrive. Both orderings are proven
 * here, because a prune that only fires on one crossing means either unbounded
 * transcript growth (the crossing that never fires) or a superseded row losing
 * the corpus a late branch-B retry still needs.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  casBeginApply,
  casBranchFailed,
  casChunksApplied,
  casFreezeChunksOutput,
  casMarkApplied,
  casMarkFailed,
  casRequestApply,
  casSummaryReady,
  claimBranch,
  getPreparationById,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { execute, withTransaction } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import {
  forkPreparation,
  frozenSnapshot,
  makeDue,
  supersedeWithReplacement,
} from "./compaction-preparation-fixtures.js";

const FREEZE_INPUT = {
  frozenOutput: frozenSnapshot(),
  frozenOutputSha256: "c".repeat(64),
  rejectedByExclusion: 0,
  rejectedByRedaction: 0,
  provider: "openrouter",
  model: "test/model",
  costUsd: null,
};

const SUMMARY_INPUT = {
  summary: "ready",
  promptVersion: "compaction-summary/1.0.0",
  provider: "openrouter",
  model: "test/model",
  costUsd: null,
};

/** Land branch B, leaving it `succeeded`. */
async function finishChunks(id: number, workerId = "worker-B"): Promise<void> {
  await claimBranch("chunks", workerId);
  await casFreezeChunksOutput(id, workerId, {
    ...FREEZE_INPUT,
    rejectedByExclusion: 3,
    rejectedByRedaction: 1,
  });
  await casChunksApplied(id, workerId, { inserted: 2, deduped: 1 });
}

async function driveToApplied(sessionId: string, id: number): Promise<void> {
  await claimBranch("summary", "worker-A");
  await casSummaryReady(id, "worker-A", SUMMARY_INPUT);
  await casRequestApply(id, "ui_button");
  await casBeginApply(id, "runner-1");
  await withTransaction((tx) => casMarkApplied(id, "runner-1", tx));
  await execute("UPDATE sessions SET checkpoint_generation = 1 WHERE id = $1", [sessionId]);
}

describe("corpus retention — crossing order A: row terminal last (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("branch B finishes first, then the apply prunes", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);

    await finishChunks(preparation.id);
    // Branch B is terminal but the row is not — nothing may be pruned yet.
    const midway = await getPreparationById(preparation.id);
    expect(midway?.chunksStatus).toBe("succeeded");
    expect(midway?.corpusText).not.toBeNull();
    expect(midway?.corpusPrunedAt).toBeNull();

    await driveToApplied(sid, preparation.id);

    const pruned = await getPreparationById(preparation.id);
    expect(pruned?.status).toBe("applied");
    expect(pruned?.corpusText).toBeNull();
    expect(pruned?.corpusPrunedAt).not.toBeNull();
    // Audit survives the prune — the row stays explainable.
    expect(pruned?.corpusSha256).toBe(preparation.corpusSha256);
    expect(pruned?.corpusFormatVersion).toBe(preparation.corpusFormatVersion);
    expect(pruned?.corpusMessageCount).toBe(preparation.corpusMessageCount);
    expect(pruned?.corpusBytes).toBe(preparation.corpusBytes);
  });

  it("row failure is the second crossing too", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await finishChunks(preparation.id);

    expect(await casMarkFailed(preparation.id, "gave up")).toBe(true);
    const row = await getPreparationById(preparation.id);
    expect(row?.corpusText).toBeNull();
    expect(row?.corpusPrunedAt).not.toBeNull();
  });
});

describe("corpus retention — crossing order B: branch B terminal last (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("the row applies first, then branch B lands and prunes", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);

    await driveToApplied(sid, preparation.id);
    // Row terminal, branch B still pending — the corpus is still needed.
    const midway = await getPreparationById(preparation.id);
    expect(midway?.status).toBe("applied");
    expect(midway?.corpusText).not.toBeNull();

    await finishChunks(preparation.id);

    const pruned = await getPreparationById(preparation.id);
    expect(pruned?.corpusText).toBeNull();
    expect(pruned?.corpusPrunedAt).not.toBeNull();
    // Both phases' accounting survives the prune — it is the audit trail that
    // explains why this compaction produced the memories it did.
    expect(pruned?.chunksRejectedByExclusionAtFreeze).toBe(3);
    expect(pruned?.chunksRejectedByRedactionAtFreeze).toBe(1);
    expect(pruned?.chunksInserted).toBe(2);
    expect(pruned?.chunksDeduped).toBe(1);
  });

  it("branch-B exhaustion on an already-terminal row prunes as well", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await casMarkFailed(preparation.id, "branch A gave up");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await claimBranch("chunks", `worker-${attempt}`);
      await casBranchFailed(preparation.id, "chunks", `worker-${attempt}`, "boom", 0);
      await makeDue(preparation.id, "chunks_next_attempt_at");
    }

    const row = await getPreparationById(preparation.id);
    expect(row?.chunksStatus).toBe("permanently_failed");
    expect(row?.corpusText).toBeNull();
    expect(row?.corpusPrunedAt).not.toBeNull();
  });
});

describe("corpus retention — a superseded row keeps its corpus for a late landing (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("supersession alone does not prune while branch B is still live", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);

    const result = await supersedeWithReplacement(first.id, sid);
    expect(result.ok).toBe(true);

    const superseded = await getPreparationById(first.id);
    expect(superseded?.status).toBe("superseded");
    // C3: the late branch-B landing is explicitly allowed, so the bytes it reads
    // must still be there.
    expect(superseded?.corpusText).not.toBeNull();
    expect(superseded?.corpusPrunedAt).toBeNull();

    await finishChunks(first.id, "worker-late");
    const landed = await getPreparationById(first.id);
    expect(landed?.chunksLandedAfterSupersession).toBe(true);
    expect(landed?.corpusText).toBeNull();
  });

  it("landing on a still-live row is NOT flagged as post-supersession", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await finishChunks(preparation.id);
    expect((await getPreparationById(preparation.id))?.chunksLandedAfterSupersession).toBe(false);
  });
});
