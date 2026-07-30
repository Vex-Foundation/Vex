/**
 * Integration: one live preparation per session, and the supersession link cycle.
 *
 * The partial unique index is the only thing standing between a pressure spike
 * and two concurrent forks of the same session, so it is proven here against
 * real concurrency rather than assumed from the DDL. The supersession sequence
 * is proven to survive it: the old row must LEAVE the partial unique before the
 * replacement's serial id exists, which is why supersede-then-insert-then-link
 * is one transaction and not three calls.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  casRequestApply,
  casSummaryReady,
  claimBranch,
  getLivePreparationForSession,
  getPreparationById,
  listPreparationsForSession,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { execute } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import {
  forkPreparation,
  forkPreparationResult,
  supersedeWithReplacement,
} from "./compaction-preparation-fixtures.js";

const SUMMARY_INPUT = {
  summary: "ready",
  promptVersion: "compaction-summary/1.0.0",
  provider: "openrouter",
  model: "test/model",
  costUsd: null,
};

describe("one live preparation per session (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a second fork while one is live returns live_exists without throwing", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);

    const second = await forkPreparationResult(sid);
    expect(second).toEqual({ ok: false, reason: "live_exists" });

    // The conflict is inferred, not raised: the caller's transaction stayed
    // usable, and the original row is untouched.
    const live = await getLivePreparationForSession(sid);
    expect(live?.id).toBe(first.id);
    expect((await listPreparationsForSession(sid, 10)).length).toBe(1);
  });

  it("two concurrent forks on separate connections: exactly one wins", async () => {
    const sid = await makeSession();
    const [a, b] = await Promise.all([forkPreparationResult(sid), forkPreparationResult(sid)]);
    const winners = [a, b].filter((r) => r.ok);
    expect(winners.length).toBe(1);
    expect((await listPreparationsForSession(sid, 10)).length).toBe(1);
  });

  it("each terminal status frees the session for a new fork", async () => {
    for (const terminal of ["applied", "failed", "superseded"] as const) {
      await resetDb();
      const sid = await makeSession();
      const first = await forkPreparation(sid);
      // Drive the row terminal directly: this test is about the INDEX predicate,
      // not about which transition got there.
      await execute(
        `UPDATE compaction_preparations
         SET status = $2,
             summary_output = COALESCE(summary_output, 'x'),
             applied_generation = CASE WHEN $2 = 'applied' THEN target_checkpoint_generation ELSE applied_generation END
         WHERE id = $1`,
        [first.id, terminal],
      );

      const second = await forkPreparationResult(sid);
      expect(second.ok, `expected a new fork to be allowed after ${terminal}`).toBe(true);
    }
  });

  it("a session with no live preparation reads back null", async () => {
    const sid = await makeSession();
    expect(await getLivePreparationForSession(sid)).toBeNull();
  });
});

describe("supersession link cycle (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("supersede → insert → link commits as one unit", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);

    const result = await supersedeWithReplacement(first.id, sid, { watermarkMessageId: 99 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.superseded.status).toBe("superseded");
    expect(result.superseded.supersededById).toBe(result.replacement.id);
    expect(result.superseded.completedAt).not.toBeNull();
    expect(result.replacement.status).toBe("preparing");
    expect(result.replacement.watermarkMessageId).toBe(99);

    // Exactly one live row survives the swap.
    const live = await getLivePreparationForSession(sid);
    expect(live?.id).toBe(result.replacement.id);
  });

  it("superseding is REFUSED once an apply is requested", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    await casSummaryReady(first.id, "worker-A", SUMMARY_INPUT);
    await casRequestApply(first.id, "ui_button");
    const before = await getPreparationById(first.id);

    const result = await supersedeWithReplacement(first.id, sid);
    expect(result).toEqual({ ok: false, reason: "apply_in_progress" });
    // Nothing was written: no replacement row, old row unchanged.
    expect(await getPreparationById(first.id)).toEqual(before);
    expect((await listPreparationsForSession(sid, 10)).length).toBe(1);
  });

  it("superseding an already-terminal row reports not_live and inserts nothing", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);
    await execute("UPDATE compaction_preparations SET status = 'failed' WHERE id = $1", [first.id]);

    const result = await supersedeWithReplacement(first.id, sid);
    expect(result).toEqual({ ok: false, reason: "not_live" });
    expect((await listPreparationsForSession(sid, 10)).length).toBe(1);
  });

  it("superseding a row that does not exist reports not_found", async () => {
    const sid = await makeSession();
    const result = await supersedeWithReplacement(999_999, sid);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });
});
