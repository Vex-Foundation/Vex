/**
 * Integration: operator Stop vs the compaction cutover, and the forced-critical
 * bypass — real Postgres, real advisory lock, real control rows.
 *
 * Two safety properties live here, and they pull in opposite directions on
 * purpose:
 *
 *   1. STOP ALWAYS WINS. A queued operator or session stop must defer the
 *      cutover, and the request must survive as `apply_requested` so the next
 *      runner can apply it once the session is no longer stopping. The stop
 *      check lives INSIDE the cutover transaction, not only at the iteration
 *      boundary: the boundary check and the transaction are separated by an
 *      await, and an agent session never observes mission-run control at all.
 *
 *   2. FORCED CRITICAL BYPASSES THE MONEY GATE — but not the stop gate. At
 *      critical context the session cannot continue without compacting, so
 *      unresolved money state is recorded and overridden. A stop is still a
 *      stop.
 *
 * The money-gate half is the mirror of the writer-side interleaving suites:
 * those prove the WRITERS serialize with the gate; this proves the gate then
 * actually defers the cutover.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute, query, queryOne } from "@vex-agent/db/client.js";
import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import { enqueueSessionStopRequest } from "@vex-agent/engine/runtime/lease-and-status.js";
import { commitPreparation } from "@vex-agent/engine/compaction/apply/index.js";
import { makeSession, insertMessage, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "../repos/compaction-preparation-fixtures.js";

const SUMMARY = "The compacted narrative.";

async function readyRequestedPreparation(
  sessionId: string,
  watermarkMessageId: number,
): Promise<number> {
  const prep = await forkPreparation(sessionId, { watermarkMessageId });
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
  const requested = await preparationsRepo.casRequestApply(prep.id, "ui_button");
  expect(requested.ok).toBe(true);
  return prep.id;
}

async function seedTranscript(sessionId: string): Promise<number[]> {
  return [
    await insertMessage(sessionId, "user", "first"),
    await insertMessage(sessionId, "assistant", "second"),
    await insertMessage(sessionId, "user", "third"),
    await insertMessage(sessionId, "assistant", "fourth"),
  ];
}

/** A pending wallet intent — unresolved money state the gate must see. */
async function seedLiveWalletIntent(sessionId: string): Promise<void> {
  await execute(
    `INSERT INTO wallet_intents
       (intent_id, session_id, wallet_address, network, to_address, amount,
        preview_json, status, expires_at)
     VALUES ($1, $2, '0xwallet', 'eip155', '0xdest', '1', '{}'::jsonb,
             'pending', NOW() + interval '10 minutes')`,
    [`intent-${randomUUID()}`, sessionId],
  );
}

async function generationOf(sessionId: string): Promise<number> {
  const row = await queryOne<{ checkpoint_generation: number }>(
    "SELECT checkpoint_generation FROM sessions WHERE id = $1",
    [sessionId],
  );
  return row?.checkpoint_generation ?? -1;
}

async function statusOf(preparationId: number): Promise<string> {
  return (await preparationsRepo.getPreparationById(preparationId))?.status ?? "missing";
}

describe("compaction apply vs operator stop and the money gate", () => {
  let sessionId: string;
  let leaseId: string;
  let ids: number[];

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
    ids = await seedTranscript(sessionId);
  });

  // ── stop wins ───────────────────────────────────────────────────────

  it("a queued session stop defers the cutover and the request SURVIVES", async () => {
    const preparationId = await readyRequestedPreparation(sessionId, ids[1]!);
    await enqueueSessionStopRequest({ sessionId });
    const begun = await preparationsRepo.casBeginApply(preparationId, leaseId);
    expect(begun.ok).toBe(true);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    expect(result.kind).toBe("stop_queued");
    // Nothing was rewritten.
    expect(await generationOf(sessionId)).toBe(0);
    const live = await query<{ id: number }>(
      "SELECT id FROM messages WHERE session_id = $1",
      [sessionId],
    );
    expect(live).toHaveLength(4);
    // The request outlived the attempt — back to `apply_requested`, NEVER
    // downgraded to `summary_ready` (which would silently discard it) and never
    // left stuck in `applying`.
    expect(await statusOf(preparationId)).toBe("apply_requested");
  });

  it("forced critical does NOT override a queued stop", async () => {
    const preparationId = await readyRequestedPreparation(sessionId, ids[1]!);
    await enqueueSessionStopRequest({ sessionId });
    await preparationsRepo.casBeginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "forced_critical",
    });

    // The money gate is the only thing forcing bypasses. Stop is not money.
    expect(result.kind).toBe("stop_queued");
    expect(await generationOf(sessionId)).toBe(0);
    expect(await statusOf(preparationId)).toBe("apply_requested");
  });

  // ── money gate ──────────────────────────────────────────────────────

  it("unresolved money state defers the cutover and the request SURVIVES", async () => {
    const preparationId = await readyRequestedPreparation(sessionId, ids[1]!);
    await seedLiveWalletIntent(sessionId);
    await preparationsRepo.casBeginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    if (result.kind !== "money_state_blocked") {
      throw new Error(`expected money_state_blocked, got ${result.kind}`);
    }
    expect(result.reasons.map((r) => r.kind)).toEqual(["wallet_intent_live"]);
    expect(await generationOf(sessionId)).toBe(0);
    expect(await statusOf(preparationId)).toBe("apply_requested");
    // Re-requestable: this is a deferral, not a failure.
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.applyLockedBy).toBeNull();
  });

  it("forced critical applies ANYWAY and records the bypassed reasons for audit", async () => {
    const preparationId = await readyRequestedPreparation(sessionId, ids[1]!);
    await seedLiveWalletIntent(sessionId);
    await preparationsRepo.casBeginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "forced_critical",
    });

    expect(result.kind).toBe("applied");
    expect(await generationOf(sessionId)).toBe(1);
    expect(await statusOf(preparationId)).toBe("applied");

    // The bypass is never silent: what was in flight when we compacted anyway
    // is the evidence a later incident needs, and it commits WITH the cutover.
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.moneyGateBypassReasons).toHaveLength(1);
    expect(row?.moneyGateBypassReasons?.[0]).toMatch(/^wallet_intent_live:/);
  });

  it("a clear session records NO bypass reasons even when forced", async () => {
    // The audit column must mean "we overrode something", not "we were forced".
    const preparationId = await readyRequestedPreparation(sessionId, ids[1]!);
    await preparationsRepo.casBeginApply(preparationId, leaseId);

    const result = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "forced_critical",
    });

    expect(result.kind).toBe("applied");
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.moneyGateBypassReasons).toBeNull();
  });

  it("a deferred cutover applies cleanly once the money state resolves", async () => {
    // The whole point of returning to `apply_requested`: the request is still
    // there, and the next boundary succeeds.
    const preparationId = await readyRequestedPreparation(sessionId, ids[1]!);
    await seedLiveWalletIntent(sessionId);
    await preparationsRepo.casBeginApply(preparationId, leaseId);
    const deferred = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });
    expect(deferred.kind).toBe("money_state_blocked");

    await execute(
      "UPDATE wallet_intents SET status = 'cancelled' WHERE session_id = $1",
      [sessionId],
    );

    const retryBegun = await preparationsRepo.casBeginApply(preparationId, leaseId);
    expect(retryBegun.ok).toBe(true);
    const applied = await commitPreparation({
      sessionId,
      missionRunId: null,
      preparationId,
      runnerLeaseId: leaseId,
      mode: "requested",
    });

    expect(applied.kind).toBe("applied");
    expect(await generationOf(sessionId)).toBe(1);
    expect(await statusOf(preparationId)).toBe("applied");
  });
});
