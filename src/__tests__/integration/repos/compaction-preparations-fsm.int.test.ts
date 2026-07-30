/**
 * Integration: `compaction_preparations` row FSM.
 *
 * Proves, against real Postgres, that every legal edge fires and that every
 * illegal edge is a no-op — not merely "returns false", but leaves the row
 * byte-identical, which is the property the concurrent workers actually depend
 * on. Includes the two-phase apply model: `applying` is committed separately
 * from `applied`, a pre-cutover exit returns to `apply_requested` and never to
 * `summary_ready`, and an unsatisfiable request terminalizes instead of parking.
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  casBeginApply,
  casDeferApply,
  casFailApply,
  casMarkApplied,
  casMarkFailed,
  casRequestApply,
  casSummaryReady,
  claimBranch,
  getPreparationById,
  MAX_SUMMARY_CHARS,
} from "@vex-agent/db/repos/compaction-preparations/index.js";
import { withTransaction } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "./compaction-preparation-fixtures.js";

const SUMMARY_INPUT = {
  summary: "The user asked about Kyber routing; we quoted twice and deferred.",
  promptVersion: "compaction-summary/1.0.0",
  provider: "openrouter",
  model: "test/model",
  costUsd: 0.0012,
};

async function driveToSummaryReady(sessionId: string): Promise<number> {
  const preparation = await forkPreparation(sessionId);
  const claimed = await claimBranch("summary", "worker-A");
  expect(claimed?.id).toBe(preparation.id);
  const ready = await casSummaryReady(preparation.id, "worker-A", SUMMARY_INPUT);
  expect(ready.ok).toBe(true);
  return preparation.id;
}

describe("preparation row FSM — legal path (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("preparing → summary_ready → apply_requested → applying → applied", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);

    expect((await getPreparationById(id))?.status).toBe("summary_ready");

    expect(await casRequestApply(id, "ui_button")).toEqual({ ok: true });
    const requested = await getPreparationById(id);
    expect(requested?.status).toBe("apply_requested");
    expect(requested?.applySource).toBe("ui_button");
    expect(requested?.applyRequestedAt).not.toBeNull();

    const begun = await casBeginApply(id, "runner-1");
    expect(begun).toEqual({ ok: true, source: "ui_button" });
    const applying = await getPreparationById(id);
    expect(applying?.status).toBe("applying");
    expect(applying?.applyLockedBy).toBe("runner-1");
    // Tx A must NOT overwrite who asked — the consuming runner is not the asker.
    expect(applying?.applySource).toBe("ui_button");

    const applied = await withTransaction((tx) => casMarkApplied(id, "runner-1", tx));
    expect(applied).toBe(true);
    const final = await getPreparationById(id);
    expect(final?.status).toBe("applied");
    // `applied_generation` comes from the row's own frozen target — the whole
    // crash-recovery discriminator rests on it.
    expect(final?.appliedGeneration).toBe(final?.targetCheckpointGeneration);
    expect(final?.appliedAt).not.toBeNull();
  });

  it("summary output is stored with its prompt version and audit", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    const row = await getPreparationById(id);
    expect(row?.summaryStatus).toBe("succeeded");
    expect(row?.summaryOutput).toBe(SUMMARY_INPUT.summary);
    expect(row?.summaryPromptVersion).toBe(SUMMARY_INPUT.promptVersion);
    expect(row?.summaryProvider).toBe("openrouter");
    expect(row?.summaryCostUsd).toBeCloseTo(0.0012, 6);
    // Lease released on success.
    expect(row?.summaryLockedBy).toBeNull();
  });
});

describe("preparation row FSM — illegal edges mutate nothing (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("casRequestApply refuses a preparation that is not summary_ready", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    const before = await getPreparationById(preparation.id);

    expect(await casRequestApply(preparation.id, "agent_tool")).toEqual({
      ok: false,
      reason: "not_ready",
    });
    expect(await getPreparationById(preparation.id)).toEqual(before);
  });

  it("casBeginApply refuses a row that has no queued request", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    const before = await getPreparationById(id);

    expect(await casBeginApply(id, "runner-1")).toEqual({
      ok: false,
      reason: "not_requested",
    });
    expect(await getPreparationById(id)).toEqual(before);
  });

  it("casMarkApplied refuses a lease that does not own the cutover", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    await casRequestApply(id, "ui_button");
    await casBeginApply(id, "runner-1");
    const before = await getPreparationById(id);

    const stolen = await withTransaction((tx) => casMarkApplied(id, "runner-2", tx));
    expect(stolen).toBe(false);
    expect(await getPreparationById(id)).toEqual(before);
  });

  it("casSummaryReady rejects an out-of-bounds summary before issuing SQL", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    const before = await getPreparationById(preparation.id);

    const tooLong = await casSummaryReady(preparation.id, "worker-A", {
      ...SUMMARY_INPUT,
      summary: "x".repeat(MAX_SUMMARY_CHARS + 1),
    });
    expect(tooLong).toEqual({ ok: false, reason: "summary_out_of_bounds" });

    const empty = await casSummaryReady(preparation.id, "worker-A", {
      ...SUMMARY_INPUT,
      summary: "   ",
    });
    expect(empty).toEqual({ ok: false, reason: "summary_out_of_bounds" });

    expect(await getPreparationById(preparation.id)).toEqual(before);
  });

  it("casSummaryReady from a lost claim writes nothing", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await claimBranch("summary", "worker-A");
    const before = await getPreparationById(preparation.id);

    const result = await casSummaryReady(preparation.id, "worker-IMPOSTOR", SUMMARY_INPUT);
    expect(result).toEqual({ ok: false, reason: "claim_lost" });
    expect(await getPreparationById(preparation.id)).toEqual(before);
  });

  it("casMarkFailed refuses a row already owned by the apply lease", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    await casRequestApply(id, "ui_button");
    const before = await getPreparationById(id);

    expect(await casMarkFailed(id, "too late")).toBe(false);
    expect(await getPreparationById(id)).toEqual(before);
  });
});

describe("two-phase apply — pre-cutover exits (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a deferral returns the row to apply_requested, NEVER to summary_ready", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    await casRequestApply(id, "auto_full_autonomous");
    await casBeginApply(id, "runner-1");

    expect(await casDeferApply(id, "runner-1", "queued_stop")).toBe(true);
    const deferred = await getPreparationById(id);
    expect(deferred?.status).toBe("apply_requested");
    // The request outlived the attempt — source and request time survive.
    expect(deferred?.applySource).toBe("auto_full_autonomous");
    expect(deferred?.applyRequestedAt).not.toBeNull();
    expect(deferred?.applyLockedBy).toBeNull();
    expect(deferred?.lastError).toBe("queued_stop");

    // ...and the next runner can pick it straight back up.
    expect(await casBeginApply(id, "runner-2")).toEqual({
      ok: true,
      source: "auto_full_autonomous",
    });
  });

  it("casDeferApply from a foreign lease writes nothing", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    await casRequestApply(id, "ui_button");
    await casBeginApply(id, "runner-1");
    const before = await getPreparationById(id);

    expect(await casDeferApply(id, "runner-2", "not mine")).toBe(false);
    expect(await getPreparationById(id)).toEqual(before);
  });

  it("an unsatisfiable request terminalizes instead of parking the session", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    await casRequestApply(id, "ui_button");

    expect(await casFailApply(id, "generation_conflict")).toBe(true);
    const failed = await getPreparationById(id);
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("generation_conflict");
    expect(failed?.completedAt).not.toBeNull();
  });

  it("casFailApply also terminalizes from applying", async () => {
    const sid = await makeSession();
    const id = await driveToSummaryReady(sid);
    await casRequestApply(id, "ui_button");
    await casBeginApply(id, "runner-1");

    expect(await casFailApply(id, "invalid_preparation")).toBe(true);
    expect((await getPreparationById(id))?.status).toBe("failed");
  });
});
