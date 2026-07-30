/**
 * Integration: compact-jobs outbox state machine.
 *
 * Proofs requiring a live DB:
 *   - Per-(session_id, checkpoint_generation) unique constraint dedupes
 *     concurrent enqueue attempts.
 *   - `claimNextDueJob` is mutex-safe (`SELECT FOR UPDATE SKIP LOCKED`) so
 *     two simultaneous claims never get the same job.
 *   - `recoverStaleRunning` resets `running` rows whose heartbeat aged out.
 *   - `markFailed` schedules retry with backoff until `attempt_count >=
 *     max_attempts`, then transitions to `permanently_failed`.
 *   - `next_attempt_at NOT NULL DEFAULT NOW()` means newly enqueued rows are
 *     immediately due (no missed-pickup via NULL).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  enqueueJob,
  claimNextDueJob,
  heartbeat,
  markCompleted,
  markFailed,
  recoverStaleRunning,
  getById,
  getBySessionAndGeneration,
  listPendingForSession,
  type NewCompactJob,
} from "@vex-agent/db/repos/compact-jobs/index.js";
import { execute, queryOne } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

function newJob(sessionId: string, gen: number, overrides: Partial<NewCompactJob> = {}): NewCompactJob {
  return {
    sessionId,
    checkpointGeneration: gen,
    agentSummary: overrides.agentSummary ?? `Summary for generation ${gen}`,
    preserveMd: overrides.preserveMd ?? null,
    threadThemesHints: overrides.threadThemesHints ?? [],
    sourceStartMessageId: overrides.sourceStartMessageId ?? null,
    sourceEndMessageId: overrides.sourceEndMessageId ?? 100,
  };
}

describe("enqueueJob idempotency (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("first enqueue inserts; second is no-op returning existing row", async () => {
    const sid = await makeSession();
    const first = await enqueueJob(newJob(sid, 1));
    expect(first.inserted).toBe(true);

    const second = await enqueueJob(newJob(sid, 1, { agentSummary: "Different summary, same key" }));
    expect(second.inserted).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    // Original summary preserved — ON CONFLICT DO NOTHING means the new agent_summary is NOT applied.
    expect(second.job.agentSummary).toBe(first.job.agentSummary);
  });

  it("different generations land as separate rows", async () => {
    const sid = await makeSession();
    const j1 = await enqueueJob(newJob(sid, 1));
    const j2 = await enqueueJob(newJob(sid, 2));
    expect(j1.job.id).not.toBe(j2.job.id);
  });

  it("newly enqueued job is immediately due (next_attempt_at <= now())", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    expect(claimed).not.toBeNull();
  });
});

describe("claimNextDueJob mutex (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("two workers cannot claim the same job", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));

    const [a, b] = await Promise.all([
      claimNextDueJob("worker-A"),
      claimNextDueJob("worker-B"),
    ]);
    const claimed = [a, b].filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
  });

  it("only picks up jobs whose retry time has come", async () => {
    const sid = await makeSession();
    const j = await enqueueJob(newJob(sid, 1));
    // Push retry into the future
    await execute(
      "UPDATE compact_jobs SET next_attempt_at = NOW() + interval '1 hour' WHERE id = $1",
      [j.job.id],
    );
    const claimed = await claimNextDueJob("worker-A");
    expect(claimed).toBeNull();
  });

  it("stamps attempt_count, locked_at, heartbeat_at on claim", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    expect(claimed).not.toBeNull();
    if (!claimed) return;
    expect(claimed.status).toBe("running");
    expect(claimed.lockedBy).toBe("worker-A");
    expect(claimed.lockedAt).not.toBeNull();
    expect(claimed.heartbeatAt).not.toBeNull();
    expect(claimed.attemptCount).toBe(1);
  });
});

describe("heartbeat + markCompleted (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("heartbeat updates timestamp on running job", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    if (!claimed) throw new Error("expected claim");

    const before = claimed.heartbeatAt;
    // Pretend time passed — force older timestamp then heartbeat refresh
    await execute(
      "UPDATE compact_jobs SET heartbeat_at = NOW() - interval '60 seconds' WHERE id = $1",
      [claimed.id],
    );
    const refreshed = await heartbeat(claimed.id, "worker-A");
    expect(refreshed).toBe(true);

    const after = await getById(claimed.id);
    expect(after?.heartbeatAt).not.toBeNull();
    expect(after?.heartbeatAt).not.toBe(before);
  });

  it("heartbeat rejects when worker id does not match (stale claim)", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    if (!claimed) throw new Error("expected claim");
    const refreshed = await heartbeat(claimed.id, "worker-B");
    expect(refreshed).toBe(false);
  });

  it("markCompleted clears lock state and stamps audit", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    if (!claimed) throw new Error("expected claim");
    const ok = await markCompleted(claimed.id, "worker-A", {
      chunksInserted: 3,
      chunksRejectedByExclusion: 1,
      chunksRejectedByRedaction: 0,
      inferenceProvider: "openrouter",
      inferenceModel: "anthropic/claude-sonnet-4.6",
      costUsd: 0.0123,
    });
    expect(ok).toBe(true);

    const after = await getById(claimed.id);
    expect(after?.status).toBe("completed");
    expect(after?.chunksInserted).toBe(3);
    expect(after?.chunksRejectedByExclusion).toBe(1);
    expect(after?.inferenceProvider).toBe("openrouter");
    expect(after?.inferenceModel).toBe("anthropic/claude-sonnet-4.6");
    expect(after?.costUsd).toBe(0.0123);
    expect(after?.lockedAt).toBeNull();
    expect(after?.heartbeatAt).toBeNull();
  });
});

describe("markFailed retry + terminal (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("schedules retry with backoff while under max_attempts", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    if (!claimed) throw new Error("expected claim");

    const r = await markFailed(claimed.id, "worker-A", "openrouter 429", 30_000);
    expect(r.ok).toBe(true);
    expect(r.terminal).toBe(false);

    const after = await getById(claimed.id);
    expect(after?.status).toBe("failed");
    expect(after?.lastError).toBe("openrouter 429");
    expect(after?.lockedAt).toBeNull();
    expect(after?.heartbeatAt).toBeNull();
  });

  it("transitions to permanently_failed after max_attempts", async () => {
    const sid = await makeSession();
    const enq = await enqueueJob(newJob(sid, 1));
    // Force attempt_count to max and set lock fields so the owner-check passes.
    await execute(
      `UPDATE compact_jobs
       SET attempt_count = max_attempts, status = 'running',
           locked_by = 'worker-A', locked_at = NOW(), heartbeat_at = NOW()
       WHERE id = $1`,
      [enq.job.id],
    );
    const r = await markFailed(enq.job.id, "worker-A", "exhausted", 0);
    expect(r.ok).toBe(true);
    expect(r.terminal).toBe(true);

    const after = await getById(enq.job.id);
    expect(after?.status).toBe("permanently_failed");
    expect(after?.completedAt).not.toBeNull();
  });

  it("markFailed returns ok=false when worker id mismatches (stale claim)", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    if (!claimed) throw new Error("expected claim");
    const r = await markFailed(claimed.id, "worker-B", "stranger", 0);
    expect(r.ok).toBe(false);
    expect(r.terminal).toBe(false);
    const after = await getById(claimed.id);
    expect(after?.status).toBe("running");
  });

  it("markCompleted returns false when worker id mismatches", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    const claimed = await claimNextDueJob("worker-A");
    if (!claimed) throw new Error("expected claim");
    const ok = await markCompleted(claimed.id, "worker-B", {
      chunksInserted: 0,
      chunksRejectedByExclusion: 0,
      chunksRejectedByRedaction: 0,
      inferenceProvider: "x",
      inferenceModel: "y",
      costUsd: null,
    });
    expect(ok).toBe(false);
    const after = await getById(claimed.id);
    expect(after?.status).toBe("running");
  });
});

describe("recoverStaleRunning (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("resets running rows whose heartbeat exceeds the stale threshold", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    await claimNextDueJob("worker-A");
    // Force old heartbeat (2 min ago)
    await execute(
      "UPDATE compact_jobs SET heartbeat_at = NOW() - interval '2 minutes 5 seconds'",
    );

    const reset = await recoverStaleRunning(2 * 60_000);
    expect(reset).toBeGreaterThanOrEqual(1);

    const after = await getBySessionAndGeneration(sid, 1);
    expect(after?.status).toBe("pending");
    expect(after?.lockedAt).toBeNull();
    expect(after?.heartbeatAt).toBeNull();
  });

  it("leaves fresh running rows untouched", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 1));
    await claimNextDueJob("worker-A");
    const reset = await recoverStaleRunning(2 * 60_000);
    expect(reset).toBe(0);

    const after = await getBySessionAndGeneration(sid, 1);
    expect(after?.status).toBe("running");
  });

  it("recovers an abandoned Track 2 claim so the next worker can complete it once the backoff elapses", async () => {
    const sid = await makeSession();
    const enq = await enqueueJob(newJob(sid, 1));
    const firstClaim = await claimNextDueJob("worker-before-restart");
    expect(firstClaim?.id).toBe(enq.job.id);

    await execute(
      "UPDATE compact_jobs SET heartbeat_at = NOW() - interval '2 minutes 5 seconds' WHERE id = $1",
      [enq.job.id],
    );
    const reset = await recoverStaleRunning(2 * 60_000);
    expect(reset).toBeGreaterThanOrEqual(1);

    // `recoverStaleRunning` resets the row to pending WITH a backoff
    // (`next_attempt_at = NOW() + min(staleThreshold, 30s)`), so the recovered
    // job is deliberately NOT claimable straight away — `claimNextDueJob`
    // requires `next_attempt_at <= NOW()`. Pin that documented contract, then
    // fast-forward past the backoff to exercise the re-claim.
    const recovered = await queryOne<{ status: string; due_in_future: boolean }>(
      "SELECT status, next_attempt_at > NOW() AS due_in_future FROM compact_jobs WHERE id = $1",
      [enq.job.id],
    );
    expect(recovered?.status).toBe("pending");
    expect(recovered?.due_in_future).toBe(true);
    expect(await claimNextDueJob("worker-too-early")).toBeNull();

    await execute("UPDATE compact_jobs SET next_attempt_at = NOW() WHERE id = $1", [enq.job.id]);

    const secondClaim = await claimNextDueJob("worker-after-restart");
    expect(secondClaim?.id).toBe(enq.job.id);
    expect(secondClaim?.attemptCount).toBe(2);

    const staleComplete = await markCompleted(enq.job.id, "worker-before-restart", {
      chunksInserted: 1,
      chunksRejectedByExclusion: 0,
      chunksRejectedByRedaction: 0,
      inferenceProvider: "openrouter",
      inferenceModel: "stale-worker",
      costUsd: null,
    });
    expect(staleComplete).toBe(false);

    const recoveredComplete = await markCompleted(enq.job.id, "worker-after-restart", {
      chunksInserted: 1,
      chunksRejectedByExclusion: 0,
      chunksRejectedByRedaction: 0,
      inferenceProvider: "openrouter",
      inferenceModel: "recovered-worker",
      costUsd: null,
    });
    expect(recoveredComplete).toBe(true);

    const after = await getById(enq.job.id);
    expect(after?.status).toBe("completed");
    expect(after?.lockedAt).toBeNull();
    expect(after?.heartbeatAt).toBeNull();
    expect(after?.inferenceModel).toBe("recovered-worker");
  });
});

describe("listPendingForSession (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns pending + running + failed rows ordered by generation ASC", async () => {
    const sid = await makeSession();
    await enqueueJob(newJob(sid, 3));
    await enqueueJob(newJob(sid, 1));
    await enqueueJob(newJob(sid, 2));
    const list = await listPendingForSession(sid);
    expect(list.map((j) => j.checkpointGeneration)).toEqual([1, 2, 3]);
  });

  it("excludes completed and permanently_failed rows", async () => {
    const sid = await makeSession();
    const enq = await enqueueJob(newJob(sid, 1));
    await execute(
      "UPDATE compact_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1",
      [enq.job.id],
    );
    const list = await listPendingForSession(sid);
    expect(list).toHaveLength(0);
  });
});

describe("cascade delete (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("removes compact_jobs when parent session is deleted", async () => {
    const sid = await makeSession();
    const enq = await enqueueJob(newJob(sid, 1));
    await execute("DELETE FROM sessions WHERE id = $1", [sid]);

    const after = await getById(enq.job.id);
    expect(after).toBeNull();
  });
});
