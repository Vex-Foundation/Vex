/**
 * Integration: `requestApply` — the one surface that queues a cutover.
 *
 * Real Postgres, because the properties that matter are FSM predicates and
 * lease liveness, not branching.
 *
 * The headline case is the durability one: with no live runner the request is
 * still WRITTEN and reported as `queued_no_live_runner`. An earlier design
 * checked the lease first and wrote nothing, so pressing Apply on an idle
 * session discarded the user's intent and returned an error. The queued request
 * is what the next runner consumes at its boundary.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";

import { execute } from "@vex-agent/db/client.js";
import * as preparationsRepo from "@vex-agent/db/repos/compaction-preparations/index.js";
import * as runnerLeasesRepo from "@vex-agent/db/repos/runner-leases.js";
import { requestApply } from "@vex-agent/engine/compaction/apply/index.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "../repos/compaction-preparation-fixtures.js";

async function makeReady(sessionId: string): Promise<number> {
  const prep = await forkPreparation(sessionId, { watermarkMessageId: 42 });
  const workerId = `summary-${randomUUID()}`;
  await preparationsRepo.claimBranch("summary", workerId);
  const ready = await preparationsRepo.casSummaryReady(prep.id, workerId, {
    summary: "ready summary",
    promptVersion: "v1.0.0",
    provider: "openrouter",
    model: "test-model",
    costUsd: null,
  });
  expect(ready.ok).toBe(true);
  return prep.id;
}

async function giveLease(sessionId: string, ttlMs = 600_000): Promise<string> {
  const ownerId = `runner-${randomUUID()}`;
  await runnerLeasesRepo.acquireLease({
    sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs,
  });
  return ownerId;
}

describe("requestApply", () => {
  let sessionId: string;

  beforeEach(async () => {
    await resetDb();
    sessionId = await makeSession();
  });

  it("no preparation → honest refusal, nothing written", async () => {
    const outcome = await requestApply({ sessionId, source: "ui_button" });
    expect(outcome).toEqual({ kind: "no_preparation" });
  });

  it("summary_ready + live runner → queued", async () => {
    const preparationId = await makeReady(sessionId);
    await giveLease(sessionId);

    const outcome = await requestApply({ sessionId, source: "ui_button" });

    expect(outcome).toEqual({ kind: "queued", preparationId });
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.status).toBe("apply_requested");
    expect(row?.applySource).toBe("ui_button");
  });

  it("NO live runner → still QUEUED and durable, reported honestly", async () => {
    // The correction that matters: the request is written regardless. The user
    // asked; the next runner consumes it.
    const preparationId = await makeReady(sessionId);

    const outcome = await requestApply({ sessionId, source: "ui_button" });

    expect(outcome).toEqual({ kind: "queued_no_live_runner", preparationId });
    const row = await preparationsRepo.getPreparationById(preparationId);
    expect(row?.status).toBe("apply_requested");
    expect(row?.applySource).toBe("ui_button");
  });

  it("an EXPIRED lease counts as no live runner, and still queues", async () => {
    const preparationId = await makeReady(sessionId);
    await giveLease(sessionId);
    await execute(
      "UPDATE runner_leases SET expires_at = NOW() - interval '1 minute' WHERE session_id = $1",
      [sessionId],
    );

    const outcome = await requestApply({ sessionId, source: "agent_tool" });

    expect(outcome).toEqual({ kind: "queued_no_live_runner", preparationId });
    expect((await preparationsRepo.getPreparationById(preparationId))?.applySource).toBe(
      "agent_tool",
    );
  });

  it("a second request is idempotent — already_requested, source unchanged", async () => {
    const preparationId = await makeReady(sessionId);
    await giveLease(sessionId);
    await requestApply({ sessionId, source: "ui_button" });

    const second = await requestApply({ sessionId, source: "agent_tool" });

    expect(second).toEqual({ kind: "already_requested", preparationId });
    // The FIRST asker is preserved — the source records who asked.
    expect((await preparationsRepo.getPreparationById(preparationId))?.applySource).toBe(
      "ui_button",
    );
  });

  it("a still-preparing row is not_ready and is never forced", async () => {
    const prep = await forkPreparation(sessionId, { watermarkMessageId: 42 });
    await giveLease(sessionId);

    const outcome = await requestApply({ sessionId, source: "ui_button" });

    expect(outcome).toEqual({
      kind: "not_ready",
      preparationId: prep.id,
      status: "preparing",
    });
    expect((await preparationsRepo.getPreparationById(prep.id))?.status).toBe("preparing");
  });
});
