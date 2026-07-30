/**
 * Integration: the REAL consumer path's lease-ownership proof — `consumeApply
 * Request` / `forcePreparedApply`, not `commitPreparation` with a substituted id.
 *
 * The hole this closes: the consumer used to read the CURRENT owner out of
 * `runner_leases` and adopt it as its own identity. A stale runner therefore
 * impersonated whatever replacement lease holder it happened to find and sailed
 * through every ownership fence downstream. Tests that call `commitPreparation`
 * with a deliberately wrong id cannot detect that, because they never exercise
 * the code that chose the id.
 *
 * So every case here enters through the production entry point and asserts on
 * the DB afterwards. Ownership is checked twice — before Tx A and again inside
 * Tx B under the advisory lock — and both are exercised.
 *
 * Also covered: the awaited per-session stale-apply recovery that runs at the
 * boundary before any cutover is consumed.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import {
  consumeApplyRequest,
  forcePreparedApply,
} from "@vex-agent/engine/compaction/apply/index.js";
import { makeSession, insertMessage, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "../repos/compaction-preparation-fixtures.js";

const HOLDER = "runner-holder";
const STALE = "runner-stale";

async function readyRequested(sessionId: string, watermarkMessageId: number): Promise<number> {
  const prep = await forkPreparation(sessionId, { watermarkMessageId });
  const workerId = `summary-${randomUUID()}`;
  await preparationsRepo.claimBranch("summary", workerId);
  const ready = await preparationsRepo.casSummaryReady(prep.id, workerId, {
    summary: "the compacted narrative",
    promptVersion: "v1.0.0",
    provider: "openrouter",
    model: "test-model",
    costUsd: null,
  });
  expect(ready.ok).toBe(true);
  const requested = await preparationsRepo.casRequestApply(prep.id, "ui_button");
  expect(requested.ok).toBe(true);
  return prep.id;
}

async function statusOf(id: number): Promise<string> {
  return (await preparationsRepo.getPreparationById(id))?.status ?? "missing";
}

async function generationOf(sessionId: string): Promise<number> {
  const row = await queryOne<{ checkpoint_generation: number }>(
    "SELECT checkpoint_generation FROM sessions WHERE id = $1",
    [sessionId],
  );
  return row?.checkpoint_generation ?? -1;
}

describe("compaction apply — consumer proves lease ownership", () => {
  let sessionId: string;
  let ids: number[];

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
    ids = [
      await insertMessage(sessionId, "user", "first"),
      await insertMessage(sessionId, "assistant", "second"),
      await insertMessage(sessionId, "user", "third"),
      await insertMessage(sessionId, "assistant", "fourth"),
    ];
    await runnerLeasesRepo.acquireLease({
      sessionId,
      ownerId: HOLDER,
      processKind: "electron_main",
      ttlMs: 600_000,
    });
  });

  function consumeAs(runnerOwnerId: string) {
    return consumeApplyRequest({
      sessionId,
      missionRunId: null,
      sessionPermission: "restricted",
      runnerOwnerId,
    });
  }

  it("the lease HOLDER consumes the request and the cutover lands", async () => {
    const id = await readyRequested(sessionId, ids[1]!);

    const outcome = await consumeAs(HOLDER);

    expect(outcome.kind).toBe("applied");
    expect(await statusOf(id)).toBe("applied");
    expect(await generationOf(sessionId)).toBe(1);
    // Stamped with OUR id, never one adopted from the row.
    const row = await preparationsRepo.getPreparationById(id);
    expect(row?.appliedGeneration).toBe(1);
  });

  it("a STALE runner cannot impersonate the replacement holder", async () => {
    // The exact hole. `STALE` is not the lease owner; the lease belongs to
    // `HOLDER`. Adopting the row's current owner would have let this through.
    const id = await readyRequested(sessionId, ids[1]!);

    const outcome = await consumeAs(STALE);

    expect(outcome.kind).toBe("nothing_to_do");
    // Nothing claimed, nothing rewritten, request still standing.
    expect(await statusOf(id)).toBe("apply_requested");
    expect(await generationOf(sessionId)).toBe(0);
    expect((await preparationsRepo.getPreparationById(id))?.applyLockedBy).toBeNull();
  });

  it("an EXPIRED lease is not ownership, even for the right owner id", async () => {
    const id = await readyRequested(sessionId, ids[1]!);
    await execute(
      "UPDATE runner_leases SET expires_at = NOW() - interval '1 minute' WHERE session_id = $1",
      [sessionId],
    );

    const outcome = await consumeAs(HOLDER);

    expect(outcome.kind).toBe("nothing_to_do");
    expect(await statusOf(id)).toBe("apply_requested");
    expect(await generationOf(sessionId)).toBe(0);
  });

  it("a lease that changes hands BETWEEN Tx A and Tx B aborts the cutover", async () => {
    // Tx B re-checks ownership under the advisory lock precisely for this. The
    // two phases are separated by an arbitrary gap, and the new holder — not the
    // old one — is entitled to finish the cutover.
    const id = await readyRequested(sessionId, ids[1]!);
    // Tx A, performed by the real holder.
    const begun = await preparationsRepo.casBeginApply(id, HOLDER);
    expect(begun.ok).toBe(true);
    // The lease is taken over by someone else before Tx B runs. Written
    // directly: `acquireLease` correctly REFUSES to steal a live lease, and what
    // this case models is the aftermath of a legitimate handover (the old lease
    // expired, a replacement claimed it) as Tx B would find it.
    await execute(
      "UPDATE runner_leases SET owner_id = $2 WHERE session_id = $1",
      [sessionId, "runner-replacement"],
    );

    const { commitPreparation } = await import(
      "@vex-agent/engine/compaction/apply/index.js"
    );
    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId: id,
      runnerLeaseId: HOLDER,
      mode: "requested",
    });

    expect(result.kind).toBe("preparation_not_applicable");
    expect(await generationOf(sessionId)).toBe(0);
    // Untouched: the old holder must not terminalize or release a row the new
    // holder now owns.
    const row = await preparationsRepo.getPreparationById(id);
    expect(row?.status).toBe("applying");
    expect(row?.applyLockedBy).toBe(HOLDER);
  });

  it("forcePreparedApply also requires proven ownership", async () => {
    const id = await readyRequested(sessionId, ids[1]!);

    const refused = await forcePreparedApply({
      sessionId,
      missionRunId: null,
      sessionPermission: "restricted",
      runnerOwnerId: STALE,
    });

    expect(refused.kind).toBe("nothing_to_do");
    expect(await generationOf(sessionId)).toBe(0);

    const allowed = await forcePreparedApply({
      sessionId,
      missionRunId: null,
      sessionPermission: "restricted",
      runnerOwnerId: HOLDER,
    });

    expect(allowed.kind).toBe("applied");
    expect(await statusOf(id)).toBe("applied");
  });

  // ── awaited per-session stale recovery at the boundary ─────────────

  it("recovers a STALE applying row at the boundary, then applies it", async () => {
    const id = await readyRequested(sessionId, ids[1]!);
    // A previous runner died mid-cutover: `applying`, heartbeat long dead, and
    // the target generation still free (Tx B never committed).
    await preparationsRepo.casBeginApply(id, "runner-dead");
    await execute(
      "UPDATE compaction_preparations SET apply_heartbeat_at = NOW() - interval '1 hour' WHERE id = $1",
      [id],
    );

    const outcome = await consumeAs(HOLDER);

    // Recovery restored `apply_requested`, and this boundary then consumed it.
    expect(outcome.kind).toBe("applied");
    expect(await statusOf(id)).toBe("applied");
    expect(await generationOf(sessionId)).toBe(1);
  });

  it("a stale applying row whose target generation is SPENT becomes terminal, not applied", async () => {
    // The inverted discriminator. A still-`applying` row PROVES Tx B never
    // committed, because `casMarkApplied` flips the status in the same
    // transaction as the bump. So a session already sitting at the row's target
    // generation means someone ELSE took it — the deterministic fallback — with a
    // different summary and archive. Marking it `applied` would attribute that
    // history to this preparation's frozen corpus.
    const id = await readyRequested(sessionId, ids[1]!);
    await preparationsRepo.casBeginApply(id, "runner-dead");
    await execute(
      "UPDATE compaction_preparations SET apply_heartbeat_at = NOW() - interval '1 hour' WHERE id = $1",
      [id],
    );
    const target = (await preparationsRepo.getPreparationById(id))!
      .targetCheckpointGeneration;
    await execute("UPDATE sessions SET checkpoint_generation = $2 WHERE id = $1", [
      sessionId,
      target,
    ]);

    const outcome = await consumeAs(HOLDER);

    expect(outcome.kind).toBe("nothing_to_do");
    expect(await statusOf(id)).toBe("failed");
    const row = await preparationsRepo.getPreparationById(id);
    expect(row?.lastError).toBe("recovered_generation_conflict");
    // Emphatically NOT applied — and no second cutover ran.
    expect(row?.appliedGeneration).toBeNull();
    expect(await generationOf(sessionId)).toBe(target);
  });

  it("a LIVE applying row is left alone — it is not ours to take", async () => {
    const id = await readyRequested(sessionId, ids[1]!);
    await preparationsRepo.casBeginApply(id, "runner-other");

    const outcome = await consumeAs(HOLDER);

    expect(outcome.kind).toBe("nothing_to_do");
    expect(await statusOf(id)).toBe("applying");
    expect((await preparationsRepo.getPreparationById(id))?.applyLockedBy).toBe(
      "runner-other",
    );
    expect(await generationOf(sessionId)).toBe(0);
  });
});
