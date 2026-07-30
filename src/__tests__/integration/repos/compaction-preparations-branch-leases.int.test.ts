/**
 * Integration: the two independent branch leases.
 *
 * The properties proven here are the ones the whole two-branch design rests on,
 * and every one of them is a real defect that has shipped in this repo's sibling
 * pipeline before:
 *   - two workers never claim the same branch of the same row;
 *   - the two branches of ONE row are claimable simultaneously — a shared lease
 *     would silently serialize them;
 *   - branch B keeps working after the row is applied/superseded/summary-failed;
 *   - the frozen tail cannot be stolen from a live lease, never re-runs the LLM,
 *     and never burns an attempt;
 *   - stale recovery does NOT recreate the exhausted-but-unclaimable zombie that
 *     bit `compact_jobs` (reset to `pending` with `attempt_count >= max_attempts`
 *     is pending forever and claimable never).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  BRANCH_STALE_THRESHOLD_MS,
  branchHeartbeat,
  casBranchFailed,
  casFreezeChunksOutput,
  casFrozenTailFailed,
  casSummaryReady,
  claimBranch,
  claimFrozenChunksTail,
  getFrozenChunksOutput,
  getPreparationById,
  recoverStaleBranch,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { execute } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import {
  ageHeartbeat,
  forkPreparation,
  frozenSnapshot,
  makeDue,
} from "./compaction-preparation-fixtures.js";

const FREEZE_INPUT = {
  frozenOutput: frozenSnapshot(["kyber_quote_timeout", "user_prefers_solana"]),
  frozenOutputSha256: "a".repeat(64),
  rejectedByExclusion: 2,
  rejectedByRedaction: 1,
  provider: "openrouter",
  model: "test/model",
  costUsd: 0.0004,
};

describe("branch lease independence (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("two workers cannot claim the same branch of the same row", async () => {
    const sid = await makeSession();
    await forkPreparation(sid);

    const [a, b] = await Promise.all([
      claimBranch("summary", "worker-A"),
      claimBranch("summary", "worker-B"),
    ]);
    expect([a, b].filter((r) => r !== null).length).toBe(1);
  });

  it("both branches of the SAME row hold their own live lease simultaneously", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);

    expect((await claimBranch("summary", "worker-A"))?.id).toBe(preparation.id);
    // Branch B claims while branch A is still `running` — a shared lease column
    // would make this impossible, and the two workers would silently serialize.
    expect((await claimBranch("chunks", "worker-B"))?.id).toBe(preparation.id);

    const row = await getPreparationById(preparation.id);
    expect(row?.summaryStatus).toBe("running");
    expect(row?.chunksStatus).toBe("running");
    expect(row?.summaryLockedBy).toBe("worker-A");
    expect(row?.chunksLockedBy).toBe("worker-B");
  });

  it("a same-instant cross-branch claim collision is a skip, never a lost or double claim", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);

    // SKIP LOCKED takes a ROW lock, so simultaneous claims for different
    // branches can collide. The loser must skip cleanly — not block, not claim.
    const [summary, chunks] = await Promise.all([
      claimBranch("summary", "worker-A"),
      claimBranch("chunks", "worker-B"),
    ]);
    const winners = [summary, chunks].filter((r) => r !== null);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    for (const winner of winners) expect(winner?.id).toBe(preparation.id);

    // ...and the skipped branch takes the row on its very next poll, while the
    // other branch is still running.
    if (summary === null) {
      expect((await claimBranch("summary", "worker-A"))?.id).toBe(preparation.id);
    }
    if (chunks === null) {
      expect((await claimBranch("chunks", "worker-B"))?.id).toBe(preparation.id);
    }
    const row = await getPreparationById(preparation.id);
    expect(row?.summaryStatus).toBe("running");
    expect(row?.chunksStatus).toBe("running");
    expect(row?.summaryAttemptCount).toBe(1);
    expect(row?.chunksAttemptCount).toBe(1);
  });

  it("branch B stays claimable after the row is applied, superseded or summary-failed", async () => {
    for (const terminal of ["applied", "superseded", "failed"] as const) {
      await resetDb();
      const sid = await makeSession();
      const preparation = await forkPreparation(sid);
      await execute(
        `UPDATE compaction_preparations
         SET status = $2,
             summary_output = COALESCE(summary_output, 'x'),
             applied_generation = CASE WHEN $2 = 'applied' THEN target_checkpoint_generation ELSE applied_generation END
         WHERE id = $1`,
        [preparation.id, terminal],
      );

      const chunks = await claimBranch("chunks", "worker-B");
      expect(chunks?.id, `branch B must remain claimable on a ${terminal} row`).toBe(
        preparation.id,
      );
      // ...while branch A is correctly shut out.
      expect(await claimBranch("summary", "worker-A")).toBeNull();
    }
  });

  it("owner-checked heartbeat and failure reject a foreign worker", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");

    expect(await branchHeartbeat(preparation.id, "summary", "worker-A")).toBe(true);
    expect(await branchHeartbeat(preparation.id, "summary", "worker-B")).toBe(false);
    expect(
      await casBranchFailed(preparation.id, "summary", "worker-B", "not mine", 1_000),
    ).toEqual({ ok: false, terminal: false });
  });
});

describe("branch attempt budget (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("branch A exhaustion terminalizes the ROW; branch B exhaustion does not", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = await claimBranch("summary", `worker-${attempt}`);
      expect(claimed, `attempt ${attempt} should be claimable`).not.toBeNull();
      const result = await casBranchFailed(
        preparation.id,
        "summary",
        `worker-${attempt}`,
        `provider timeout ${attempt}`,
        0,
      );
      expect(result.ok).toBe(true);
      expect(result.terminal).toBe(attempt === 3);
      await makeDue(preparation.id, "summary_next_attempt_at");
    }

    const afterA = await getPreparationById(preparation.id);
    expect(afterA?.summaryStatus).toBe("permanently_failed");
    expect(afterA?.status).toBe("failed");
    expect(afterA?.lastError).toBe("provider timeout 3");
    // Exhausted ⇒ not claimable again.
    expect(await claimBranch("summary", "worker-X")).toBeNull();
  });

  it("branch B exhaustion leaves the row status alone — chunks are non-blocking", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await claimBranch("chunks", `worker-${attempt}`);
      await casBranchFailed(preparation.id, "chunks", `worker-${attempt}`, "boom", 0);
      await makeDue(preparation.id, "chunks_next_attempt_at");
    }

    const row = await getPreparationById(preparation.id);
    expect(row?.chunksStatus).toBe("permanently_failed");
    expect(row?.status).toBe("preparing");
  });
});

describe("stale branch recovery does not create zombies (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a stale row with attempts left comes back as pending and IS claimable", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-dead");
    await ageHeartbeat(preparation.id, "summary_heartbeat_at", BRANCH_STALE_THRESHOLD_MS * 2);

    expect(await recoverStaleBranch("summary", BRANCH_STALE_THRESHOLD_MS)).toBe(1);
    const recovered = await getPreparationById(preparation.id);
    expect(recovered?.summaryStatus).toBe("pending");
    expect(recovered?.summaryLockedBy).toBeNull();

    await makeDue(preparation.id, "summary_next_attempt_at");
    expect((await claimBranch("summary", "worker-new"))?.id).toBe(preparation.id);
  });

  it("a stale row with NO attempts left becomes permanently_failed, not an unclaimable pending", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    // Burn the budget, then die holding the last claim.
    await execute(
      "UPDATE compaction_preparations SET summary_attempt_count = 2 WHERE id = $1",
      [preparation.id],
    );
    await claimBranch("summary", "worker-dead");
    await ageHeartbeat(preparation.id, "summary_heartbeat_at", BRANCH_STALE_THRESHOLD_MS * 2);

    expect(await recoverStaleBranch("summary", BRANCH_STALE_THRESHOLD_MS)).toBe(1);
    const recovered = await getPreparationById(preparation.id);
    // The legacy defect would have written 'pending' here — pending forever,
    // claimable never, because the claim also requires attempt < max.
    expect(recovered?.summaryStatus).toBe("permanently_failed");
    expect(recovered?.status).toBe("failed");
    await makeDue(preparation.id, "summary_next_attempt_at");
    expect(await claimBranch("summary", "worker-new")).toBeNull();
  });

  it("a live heartbeat is not reclaimed", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("chunks", "worker-alive");

    expect(await recoverStaleBranch("chunks", BRANCH_STALE_THRESHOLD_MS)).toBe(0);
    expect((await getPreparationById(preparation.id))?.chunksStatus).toBe("running");
  });
});

describe("branch-B frozen tail (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("freezing stores the complete insert-ready snapshot and is write-once", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("chunks", "worker-B");

    expect(await casFreezeChunksOutput(preparation.id, "worker-B", FREEZE_INPUT)).toBe(true);
    const stored = await getFrozenChunksOutput(preparation.id);
    // Round-trips byte-identically, INCLUDING the generated outstanding-item ids
    // and timestamps — that is what makes an insert retry deterministic.
    expect(stored).toEqual(FREEZE_INPUT.frozenOutput);

    const row = await getPreparationById(preparation.id);
    expect(row?.chunksStatus).toBe("frozen");
    expect(row?.chunksFrozenOutputSha256).toBe(FREEZE_INPUT.frozenOutputSha256);
    expect(row?.chunksFrozenAt).not.toBeNull();
    // Freeze-time rejections land with the snapshot, in the same statement, so
    // the account of what was dropped can never disagree with what was kept.
    expect(row?.chunksRejectedByExclusionAtFreeze).toBe(2);
    expect(row?.chunksRejectedByRedactionAtFreeze).toBe(1);
    // The insert phase has not run — its counters are still zero.
    expect(row?.chunksInserted).toBe(0);
    expect(row?.chunksDeduped).toBe(0);

    // A second freeze with different bytes cannot overwrite it.
    const second = await casFreezeChunksOutput(preparation.id, "worker-B", {
      ...FREEZE_INPUT,
      frozenOutput: frozenSnapshot(["something_else"]),
      frozenOutputSha256: "b".repeat(64),
    });
    expect(second).toBe(false);
    expect(await getFrozenChunksOutput(preparation.id)).toEqual(FREEZE_INPUT.frozenOutput);
  });

  it("a frozen row is NOT stealable while its lease is alive", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("chunks", "worker-B");
    await casFreezeChunksOutput(preparation.id, "worker-B", FREEZE_INPUT);
    await makeDue(preparation.id, "chunks_next_attempt_at");

    // The freezing worker still holds a live heartbeat mid-insert.
    expect(await claimFrozenChunksTail("worker-THIEF", BRANCH_STALE_THRESHOLD_MS)).toBeNull();
    // ...and the ordinary LLM claim path cannot see it either.
    expect(await claimBranch("chunks", "worker-THIEF")).toBeNull();
    expect((await getPreparationById(preparation.id))?.chunksLockedBy).toBe("worker-B");
  });

  it("attempt 3 → freeze → crash stays insert-retryable and never re-runs the LLM", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    // Spend the entire LLM budget, then freeze on the final attempt.
    await execute(
      "UPDATE compaction_preparations SET chunks_attempt_count = 2 WHERE id = $1",
      [preparation.id],
    );
    await claimBranch("chunks", "worker-B");
    expect((await getPreparationById(preparation.id))?.chunksAttemptCount).toBe(3);
    await casFreezeChunksOutput(preparation.id, "worker-B", FREEZE_INPUT);

    // Crash: the lease goes cold.
    await ageHeartbeat(preparation.id, "chunks_heartbeat_at", BRANCH_STALE_THRESHOLD_MS * 2);
    await makeDue(preparation.id, "chunks_next_attempt_at");

    const resumed = await claimFrozenChunksTail("worker-C", BRANCH_STALE_THRESHOLD_MS);
    expect(resumed?.id).toBe(preparation.id);
    // Still frozen, still the same snapshot, and NOT a fourth attempt.
    expect(resumed?.chunksStatus).toBe("frozen");
    expect(resumed?.chunksAttemptCount).toBe(3);
    expect(resumed?.chunksFrozenOutput).toEqual(FREEZE_INPUT.frozenOutput);
    expect(resumed?.chunksLockedBy).toBe("worker-C");
  });

  it("a failed insert keeps the frozen phase instead of burning an attempt", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("chunks", "worker-B");
    await casFreezeChunksOutput(preparation.id, "worker-B", FREEZE_INPUT);

    expect(await casFrozenTailFailed(preparation.id, "worker-B", "embedding down", 0)).toBe(true);
    const row = await getPreparationById(preparation.id);
    expect(row?.chunksStatus).toBe("frozen");
    expect(row?.chunksAttemptCount).toBe(1);
    expect(row?.chunksLockedBy).toBeNull();
    expect(row?.chunksLastError).toBe("embedding down");

    // Immediately re-claimable by anyone, no stale wait needed.
    expect((await claimFrozenChunksTail("worker-C", BRANCH_STALE_THRESHOLD_MS))?.id).toBe(
      preparation.id,
    );
  });

  it("the frozen-tail heartbeat is owner-checked", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("chunks", "worker-B");
    await casFreezeChunksOutput(preparation.id, "worker-B", FREEZE_INPUT);

    expect(await branchHeartbeat(preparation.id, "chunks", "worker-B")).toBe(true);
    expect(await branchHeartbeat(preparation.id, "chunks", "worker-C")).toBe(false);
  });

  it("summary readiness is unaffected by branch B's phase", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("chunks", "worker-B");
    await casFreezeChunksOutput(preparation.id, "worker-B", FREEZE_INPUT);

    await claimBranch("summary", "worker-A");
    const ready = await casSummaryReady(preparation.id, "worker-A", {
      summary: "ready even though chunks are still landing",
      promptVersion: "compaction-summary/1.0.0",
      provider: "openrouter",
      model: "test/model",
      costUsd: null,
    });
    expect(ready).toEqual({ ok: true });
    expect((await getPreparationById(preparation.id))?.status).toBe("summary_ready");
  });
});
