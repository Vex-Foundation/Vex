/**
 * Integration: apply crash recovery.
 *
 * A crashed `applying` row is the one place in this FSM where guessing has an
 * irreversible cost, and the discriminator was INVERTED once these tests were
 * read against the cutover's own atomicity.
 *
 * `casMarkApplied` flips `status` to `applied` in the SAME transaction as the
 * generation bump, the summary replacement and the archive. So a row that is
 * still `applying` PROVES Tx B never committed, whatever the generation says.
 * Finding the session already AT the row's target generation therefore does not
 * mean "our cutover landed" — it means someone ELSE took that generation, in
 * practice the deterministic critical fallback (`current + 1`) with a different
 * summary and a different archive. Marking the row `applied` there would
 * attribute the fallback's history to this preparation's frozen corpus.
 *
 * Hence: target reached ⇒ CONFLICT ⇒ terminal `failed`; anything else ⇒ the
 * cutover never committed and the target is still free ⇒ `apply_requested`.
 * These tests move ONLY the session generation between the cases, leaving every
 * timestamp identical.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  APPLY_STALE_THRESHOLD_MS,
  applyHeartbeat,
  casBeginApply,
  casRequestApply,
  casSummaryReady,
  claimBranch,
  getPreparationById,
  recoverStuckApplying,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import {
  ageHeartbeat,
  forkPreparation,
  setSessionGeneration,
} from "./compaction-preparation-fixtures.js";

const SUMMARY_INPUT = {
  summary: "ready",
  promptVersion: "compaction-summary/1.0.0",
  provider: "openrouter",
  model: "test/model",
  costUsd: null,
};

/** Leave a row mid-cutover: Tx A committed, Tx B never did (or maybe did). */
async function stallMidApply(sessionId: string): Promise<number> {
  const preparation = await forkPreparation(sessionId);
  await claimBranch("summary", "worker-A");
  await casSummaryReady(preparation.id, "worker-A", SUMMARY_INPUT);
  await casRequestApply(preparation.id, "ui_button");
  await casBeginApply(preparation.id, "runner-dead");
  return preparation.id;
}

describe("recoverStuckApplying (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("target generation already SPENT ⇒ CONFLICT ⇒ terminal failed, never applied", async () => {
    // The inversion. A still-`applying` row cannot represent a committed Tx B,
    // so the only way the session can sit at this row's target is that another
    // writer got there first.
    const sid = await makeSession();
    const id = await stallMidApply(sid);
    const row = await getPreparationById(id);
    await setSessionGeneration(sid, row!.targetCheckpointGeneration);
    await ageHeartbeat(id, "apply_heartbeat_at", APPLY_STALE_THRESHOLD_MS * 2);

    const result = await recoverStuckApplying(APPLY_STALE_THRESHOLD_MS);
    expect(result).toEqual({ conflictedTerminal: 1, restoredToRequested: 0 });

    const recovered = await getPreparationById(id);
    expect(recovered?.status).toBe("failed");
    expect(recovered?.lastError).toBe("recovered_generation_conflict");
    // Emphatically NOT applied: claiming it would credit this preparation with
    // a cutover performed from a different summary.
    expect(recovered?.appliedGeneration).toBeNull();
    expect(recovered?.applyLockedBy).toBeNull();
  });

  it("generation did NOT move ⇒ the cutover never committed ⇒ apply_requested", async () => {
    const sid = await makeSession();
    const id = await stallMidApply(sid);
    await ageHeartbeat(id, "apply_heartbeat_at", APPLY_STALE_THRESHOLD_MS * 2);

    const result = await recoverStuckApplying(APPLY_STALE_THRESHOLD_MS);
    expect(result).toEqual({ conflictedTerminal: 0, restoredToRequested: 1 });

    const recovered = await getPreparationById(id);
    // NEVER summary_ready — the request outlived the attempt.
    expect(recovered?.status).toBe("apply_requested");
    expect(recovered?.applySource).toBe("ui_button");
    expect(recovered?.applyRequestedAt).not.toBeNull();
    expect(recovered?.applyLockedBy).toBeNull();
    expect(recovered?.lastError).toBe("recovered_pre_commit");

    // The next runner consumes it without any further intervention.
    expect(await casBeginApply(id, "runner-2")).toEqual({ ok: true, source: "ui_button" });
  });

  it("a generation that moved past the target is NOT treated as our commit", async () => {
    const sid = await makeSession();
    const id = await stallMidApply(sid);
    const row = await getPreparationById(id);
    // Some other compaction path advanced the session further. Our cutover was
    // never the one that landed, so equality — not `>=` — is the right test.
    await setSessionGeneration(sid, row!.targetCheckpointGeneration + 1);
    await ageHeartbeat(id, "apply_heartbeat_at", APPLY_STALE_THRESHOLD_MS * 2);

    const result = await recoverStuckApplying(APPLY_STALE_THRESHOLD_MS);
    expect(result).toEqual({ conflictedTerminal: 0, restoredToRequested: 1 });
    expect((await getPreparationById(id))?.status).toBe("apply_requested");
  });

  it("a live cutover is left strictly alone", async () => {
    const sid = await makeSession();
    const id = await stallMidApply(sid);
    expect(await applyHeartbeat(id, "runner-dead")).toBe(true);
    const before = await getPreparationById(id);

    const result = await recoverStuckApplying(APPLY_STALE_THRESHOLD_MS);
    expect(result).toEqual({ conflictedTerminal: 0, restoredToRequested: 0 });
    expect(await getPreparationById(id)).toEqual(before);
  });

  it("resolves several stuck rows across sessions in one sweep", async () => {
    const conflicted = await makeSession();
    const crashed = await makeSession();
    const conflictedId = await stallMidApply(conflicted);
    const crashedId = await stallMidApply(crashed);
    await setSessionGeneration(
      conflicted,
      (await getPreparationById(conflictedId))!.targetCheckpointGeneration,
    );
    await ageHeartbeat(conflictedId, "apply_heartbeat_at", APPLY_STALE_THRESHOLD_MS * 2);
    await ageHeartbeat(crashedId, "apply_heartbeat_at", APPLY_STALE_THRESHOLD_MS * 2);

    expect(await recoverStuckApplying(APPLY_STALE_THRESHOLD_MS)).toEqual({
      conflictedTerminal: 1,
      restoredToRequested: 1,
    });
    expect((await getPreparationById(conflictedId))?.status).toBe("failed");
    expect((await getPreparationById(crashedId))?.status).toBe("apply_requested");
  });
});
