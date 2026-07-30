/**
 * Integration: the storage side of the per-turn pressure read.
 *
 * The barrier bypass is a security-relevant relaxation — it lets mutating,
 * fund-moving tools run at >=88% context — so every mapping from a stored row
 * to a `PreparationPressureState` variant is asserted here, and each is asserted
 * THROUGH the engine's own derived axes rather than by eyeballing the variant.
 * That is the property that matters: what the barrier and the tool catalog
 * actually do with the row.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  BRANCH_STALE_THRESHOLD_MS,
  casBeginApply,
  casFailApply,
  casRequestApply,
  casSummaryReady,
  claimBranch,
  getLivePreparationPressureState,
  getPreparationById,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import {
  barrierBypassAllowed,
  hasCompactionSummaryReady,
} from "@vex-agent/engine/core/preparation-pressure-state.js";
import { execute, withTransaction } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import {
  ageHeartbeat,
  forkPreparation,
  makeDue,
} from "./compaction-preparation-fixtures.js";

const SUMMARY_CALL_TIMEOUT_MS = 90_000;

const SUMMARY_INPUT = {
  summary: "ready",
  promptVersion: "compaction-summary/1.0.0",
  provider: "openrouter",
  model: "test/model",
  costUsd: null,
};

function readState(sessionId: string) {
  return getLivePreparationPressureState(sessionId, SUMMARY_CALL_TIMEOUT_MS);
}

describe("pressure state — no preparation (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a session with no preparation denies the bypass and hides apply", async () => {
    const sid = await makeSession();
    const state = await readState(sid);
    expect(state).toEqual({ kind: "none" });
    expect(barrierBypassAllowed(state)).toBe(false);
    expect(hasCompactionSummaryReady(state)).toBe(false);
  });
});

describe("pressure state — preparing (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a freshly forked row has attempts but no live lease yet", async () => {
    const sid = await makeSession();
    await forkPreparation(sid);
    const state = await readState(sid);

    expect(state.kind).toBe("preparing");
    if (state.kind !== "preparing") return;
    expect(state.leaseAlive).toBe(false);
    expect(state.attemptsRemaining).toBe(3);
    expect(state.currentAttemptDeadlineMs).toBeNull();
    // Nothing is actually in flight, so the barrier stays up.
    expect(barrierBypassAllowed(state)).toBe(false);
  });

  it("a claimed attempt is live, and carries THIS attempt's deadline", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");

    const state = await readState(sid);
    expect(state.kind).toBe("preparing");
    if (state.kind !== "preparing") return;
    expect(state.leaseAlive).toBe(true);
    expect(state.attemptsRemaining).toBe(2);
    expect(state.preparationId).toBe(String(preparation.id));

    const row = await getPreparationById(preparation.id);
    const startedMs = new Date(row!.summaryLockedAt!).getTime();
    expect(state.currentAttemptDeadlineMs).toBe(startedMs + SUMMARY_CALL_TIMEOUT_MS);
    expect(barrierBypassAllowed(state)).toBe(true);
    expect(hasCompactionSummaryReady(state)).toBe(false);
  });

  it("a dead lease revokes the bypass even with attempts left", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-dead");
    await ageHeartbeat(preparation.id, "summary_heartbeat_at", BRANCH_STALE_THRESHOLD_MS * 2);

    const state = await readState(sid);
    expect(state.kind).toBe("preparing");
    if (state.kind !== "preparing") return;
    expect(state.leaseAlive).toBe(false);
    expect(state.attemptsRemaining).toBe(2);
    expect(barrierBypassAllowed(state)).toBe(false);
  });

  it("an exhausted budget reports zero attempts remaining, never a negative", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await execute(
      "UPDATE compaction_preparations SET summary_attempt_count = 5 WHERE id = $1",
      [preparation.id],
    );

    const state = await readState(sid);
    expect(state.kind).toBe("preparing");
    if (state.kind !== "preparing") return;
    expect(state.attemptsRemaining).toBe(0);
    expect(barrierBypassAllowed(state)).toBe(false);
  });
});

describe("pressure state — the apply statuses (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("summary_ready and apply_requested read as relief-is-coming", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    await casSummaryReady(preparation.id, "worker-A", SUMMARY_INPUT);

    for (const step of ["summary_ready", "apply_requested"] as const) {
      if (step === "apply_requested") await casRequestApply(preparation.id, "ui_button");

      const state = await readState(sid);
      expect(state.kind, `status ${step}`).toBe("summary_ready");
      expect(state).toEqual({ kind: "summary_ready", preparationId: String(preparation.id) });
      expect(barrierBypassAllowed(state)).toBe(true);
      expect(hasCompactionSummaryReady(state)).toBe(true);
    }
  });

  it("`applying` is its OWN state — never collapsed into summary_ready", async () => {
    // CONTRACT CHANGE. All three apply statuses used to read as
    // `summary_ready`, on the reasoning that the barrier only asks "is relief
    // coming". That collapse was a defect at CRITICAL: the ladder saw
    // `summary_ready`, tried a forced apply that could not win against a row
    // already consumed into `applying`, and then fell through to the
    // deterministic fallback — which bumps `current + 1`, normally the exact
    // generation the in-flight preparation had frozen as its target. Two writers
    // then claim one generation with different summaries and archives, and
    // apply-crash recovery can no longer tell which committed.
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    await casSummaryReady(preparation.id, "worker-A", SUMMARY_INPUT);
    await casRequestApply(preparation.id, "ui_button");
    await casBeginApply(preparation.id, "runner-1");

    const state = await readState(sid);

    expect(state).toEqual({ kind: "applying", preparationId: String(preparation.id) });
    // Both derived axes fail CLOSED. The snapshot carries no apply-lease
    // liveness, so a cutover whose owner died must not keep fund-moving tools
    // unlocked at >=88%; and offering `compact_apply` for a cutover already in
    // flight would invite a second request for it.
    expect(barrierBypassAllowed(state)).toBe(false);
    expect(hasCompactionSummaryReady(state)).toBe(false);
  });
});

describe("pressure state — terminal rows (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a failed preparation returns today's barrier and offers no apply", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    await casSummaryReady(preparation.id, "worker-A", SUMMARY_INPUT);
    await casRequestApply(preparation.id, "ui_button");
    await casFailApply(preparation.id, "generation_conflict");

    const state = await readState(sid);
    expect(state).toEqual({ kind: "failed", preparationId: String(preparation.id) });
    expect(barrierBypassAllowed(state)).toBe(false);
    expect(hasCompactionSummaryReady(state)).toBe(false);
  });

  it("an applied preparation no longer bears on pressure", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    await casSummaryReady(preparation.id, "worker-A", SUMMARY_INPUT);
    await casRequestApply(preparation.id, "ui_button");
    await casBeginApply(preparation.id, "runner-1");
    await withTransaction(async (tx) => {
      const { casMarkApplied } = await import(
        "@vex-agent/db/repos/compaction-preparations/index.js"
      );
      return casMarkApplied(preparation.id, "runner-1", tx);
    });

    expect(await readState(sid)).toEqual({ kind: "none" });
  });

  it("a superseded row yields to its replacement, which is what pressure sees", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);
    const { supersedeWithReplacement } = await import("./compaction-preparation-fixtures.js");
    const result = await supersedeWithReplacement(first.id, sid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The LATEST row is the replacement, so the read follows the live one.
    const state = await readState(sid);
    expect(state.kind).toBe("preparing");
    if (state.kind !== "preparing") return;
    expect(state.preparationId).toBe(String(result.replacement.id));
  });

  it("a superseded row with no replacement left reads as none", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await execute("UPDATE compaction_preparations SET status = 'superseded' WHERE id = $1", [
      preparation.id,
    ]);
    expect(await readState(sid)).toEqual({ kind: "none" });
  });

  it("a re-forked session after a failure follows the new preparation", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);
    await execute("UPDATE compaction_preparations SET status = 'failed' WHERE id = $1", [
      first.id,
    ]);
    expect((await readState(sid)).kind).toBe("failed");

    const second = await forkPreparation(sid);
    await makeDue(second.id, "summary_next_attempt_at");
    const state = await readState(sid);
    expect(state.kind).toBe("preparing");
    if (state.kind !== "preparing") return;
    expect(state.preparationId).toBe(String(second.id));
  });
});
