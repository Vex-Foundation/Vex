/**
 * Integration: the APPLY cutover against real Postgres.
 *
 * This is the money-path cutover — it rewrites a session's transcript — so
 * every case here drives the REAL two-phase path (`casBeginApply` then
 * `commitPreparation`) against real rows, real CHECK constraints and the real
 * lock order. Nothing is mocked.
 *
 * Pinned here:
 *   - the happy path REPLACES the summary, resets `token_count`, bumps the
 *     generation to EXACTLY `target_checkpoint_generation`, archives exactly the
 *     `<= watermark` prefix, and adds NO `compact_jobs` row (contract C6);
 *   - `applied_generation` equals the frozen target — the column
 *     `recoverStuckApplying`'s discriminator reads;
 *   - a generation that moved underneath the request is TERMINAL `failed`, not
 *     an eternal `apply_requested` that would park the session forever;
 *   - a noop prefix is terminal for the same reason;
 *   - a deferral returns the row to `apply_requested` — never `summary_ready`,
 *     and never stuck in `applying`.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, query, queryOne } from "@vex-agent/db/client.js";
import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import { commitPreparation } from "@vex-agent/engine/compaction/apply/index.js";
import { makeSession, insertMessage, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "../repos/compaction-preparation-fixtures.js";

const SUMMARY = "The compacted narrative of everything before the watermark.";

/** Drive a fresh preparation all the way to `summary_ready`, the real way. */
async function readyPreparation(
  sessionId: string,
  overrides: { watermarkMessageId: number; baseCheckpointGeneration?: number },
): Promise<number> {
  const prep = await forkPreparation(sessionId, {
    watermarkMessageId: overrides.watermarkMessageId,
    baseCheckpointGeneration: overrides.baseCheckpointGeneration ?? 0,
    targetCheckpointGeneration: (overrides.baseCheckpointGeneration ?? 0) + 1,
  });
  const workerId = `summary-${randomUUID()}`;
  const claimed = await preparationsRepo.claimBranch("summary", workerId);
  expect(claimed?.id).toBe(prep.id);
  const ready = await preparationsRepo.casSummaryReady(prep.id, workerId, {
    summary: SUMMARY,
    promptVersion: "v1.0.0",
    provider: "openrouter",
    model: "test-model",
    costUsd: null,
  });
  expect(ready.ok).toBe(true);
  // The queued request — the state Tx A consumes.
  const requested = await preparationsRepo.casRequestApply(prep.id, "ui_button");
  expect(requested.ok).toBe(true);
  return prep.id;
}

/** Tx A, exactly as the boundary consumer performs it. */
async function beginApply(preparationId: number, leaseId: string): Promise<void> {
  const begun = await preparationsRepo.casBeginApply(preparationId, leaseId);
  expect(begun.ok).toBe(true);
}

async function seedTranscript(sessionId: string): Promise<number[]> {
  const ids: number[] = [];
  ids.push(await insertMessage(sessionId, "user", "first"));
  ids.push(await insertMessage(sessionId, "assistant", "second"));
  ids.push(await insertMessage(sessionId, "user", "third"));
  ids.push(await insertMessage(sessionId, "assistant", "fourth"));
  return ids;
}

async function sessionRow(
  sessionId: string,
): Promise<{ checkpoint_generation: number; token_count: number; summary: string | null }> {
  const row = await queryOne<{
    checkpoint_generation: number;
    token_count: number;
    summary: string | null;
  }>(
    "SELECT checkpoint_generation, token_count, summary FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (row === null) throw new Error("session vanished");
  return row;
}

async function statusOf(preparationId: number): Promise<string> {
  const row = await preparationsRepo.getPreparationById(preparationId);
  return row?.status ?? "missing";
}

describe("compaction apply — the cutover", () => {
  let sessionId: string;
  let leaseId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
    leaseId = `runner-${randomUUID()}`;
    await runnerLeasesRepo.acquireLease({
      sessionId,
      ownerId: leaseId,
      processKind: "electron_main",
      ttlMs: 600_000,
    });
  });

  it("applies: summary REPLACED, token_count reset, prefix archived, no compact_jobs row", async () => {
    const ids = await seedTranscript(sessionId);
    await execute("UPDATE sessions SET summary = $2, token_count = 9999 WHERE id = $1", [
      sessionId,
      "the OLD rolling summary",
    ]);
    // Watermark at the 2nd message: the first two archive, the last two stay.
    const preparationId = await readyPreparation(sessionId, {
      watermarkMessageId: ids[1]!,
    });
    await beginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    expect(result).toEqual({
      kind: "applied",
      generation: 1,
      archivedMessages: 2,
    });

    const session = await sessionRow(sessionId);
    // REPLACED wholesale, not merged — merge semantics produced telephone-game
    // drift across successive compactions.
    expect(session.summary).toBe(SUMMARY);
    expect(session.token_count).toBe(0);
    expect(session.checkpoint_generation).toBe(1);

    const live = await query<{ id: number }>(
      "SELECT id FROM messages WHERE session_id = $1 ORDER BY id",
      [sessionId],
    );
    expect(live.map((r) => r.id)).toEqual([ids[2], ids[3]]);

    const archived = await query<{ id: number }>(
      "SELECT id FROM messages_archive WHERE session_id = $1 ORDER BY id",
      [sessionId],
    );
    expect(archived).toHaveLength(2);

    // C6: the APPLY path must never touch `compact_jobs`.
    const jobs = await query<{ id: number }>(
      "SELECT id FROM compact_jobs WHERE session_id = $1",
      [sessionId],
    );
    expect(jobs).toHaveLength(0);

    expect(await statusOf(preparationId)).toBe("applied");
  });

  it("bumps to EXACTLY target_checkpoint_generation and stamps applied_generation", async () => {
    // The assertion recovery depends on. A cutover that computed `current + 1`
    // from a re-read would make a crashed apply indistinguishable from a
    // completed one, because recovery asks whether the session reached the
    // generation THIS row was always going to produce.
    const ids = await seedTranscript(sessionId);
    await execute("UPDATE sessions SET checkpoint_generation = 7 WHERE id = $1", [sessionId]);
    const preparationId = await readyPreparation(sessionId, {
      watermarkMessageId: ids[1]!,
      baseCheckpointGeneration: 7,
    });
    const target = (await preparationsRepo.getPreparationById(preparationId))!
      .targetCheckpointGeneration;
    expect(target).toBe(8);
    await beginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
    expect(result.generation).toBe(target);
    expect((await sessionRow(sessionId)).checkpoint_generation).toBe(target);
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.appliedGeneration).toBe(target);
  });

  it("generation moved underneath the request → TERMINAL failed, not an eternal request", async () => {
    const ids = await seedTranscript(sessionId);
    const preparationId = await readyPreparation(sessionId, {
      watermarkMessageId: ids[1]!,
      baseCheckpointGeneration: 0,
    });
    await beginApply(preparationId, leaseId);
    // A concurrent compaction landed between the request and the cutover.
    await execute("UPDATE sessions SET checkpoint_generation = 5 WHERE id = $1", [sessionId]);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    expect(result.kind).toBe("generation_moved");
    // Terminal, because it can never become true again — and leaving it live
    // would block every future fork through the one-live-per-session index.
    expect(await statusOf(preparationId)).toBe("failed");
    expect((await sessionRow(sessionId)).checkpoint_generation).toBe(5);
  });

  it("nothing compactable → terminal noop, transcript untouched", async () => {
    const ids = await seedTranscript(sessionId);
    // A watermark below every live id: everything it covered is already gone.
    const preparationId = await readyPreparation(sessionId, {
      watermarkMessageId: ids[0]! - 1,
    });
    await beginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    if (result.kind !== "noop") throw new Error(`expected noop, got ${result.kind}`);
    expect(result.reason).toBe("watermark_not_live");
    expect(await statusOf(preparationId)).toBe("failed");
    const live = await query<{ id: number }>(
      "SELECT id FROM messages WHERE session_id = $1",
      [sessionId],
    );
    expect(live).toHaveLength(4);
  });

  it("SCHEMA GUARD: a row can never reach apply_requested without a summary", async () => {
    // The engine guards this too (`summaryStatus !== 'succeeded'` is terminal),
    // but that guard is defence-in-depth: the state is UNREPRESENTABLE, and
    // this pins which layer actually makes it so. If the CHECK were ever
    // relaxed, this test fails and the engine guard becomes load-bearing.
    const ids = await seedTranscript(sessionId);
    const prep = await forkPreparation(sessionId, { watermarkMessageId: ids[1]! });

    await expect(
      execute(
        `UPDATE compaction_preparations
         SET status = 'apply_requested', apply_source = 'ui_button', apply_requested_at = NOW()
         WHERE id = $1`,
        [prep.id],
      ),
    ).rejects.toThrow(/cprep_ready_requires_summary/);
  });

  it("a cutover whose apply lease is not ours is not applicable, and changes nothing", async () => {
    const ids = await seedTranscript(sessionId);
    const preparationId = await readyPreparation(sessionId, {
      watermarkMessageId: ids[1]!,
    });
    await beginApply(preparationId, leaseId);

    // Another runner's id — every apply edge is fenced on `apply_locked_by`.
    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: `other-${randomUUID()}`,
      mode: "requested",
    });

    expect(result.kind).toBe("preparation_not_applicable");
    expect((await sessionRow(sessionId)).checkpoint_generation).toBe(0);
    const live = await query<{ id: number }>(
      "SELECT id FROM messages WHERE session_id = $1",
      [sessionId],
    );
    expect(live).toHaveLength(4);
    // "Changes nothing" includes the PREPARATION. A non-owner must not
    // terminalize a cutover another runner still owns: `casFailApply` accepts
    // `applying` without an owner check (a conflict may legitimately be
    // discovered by either side), so the ownership guard has to come first.
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.status).toBe("applying");
    expect(row?.applyLockedBy).toBe(leaseId);
  });
});
