/**
 * Integration: the schema-level invariants of `compaction_preparations`.
 *
 * These CHECKs are not decoration — they are the last line of defence for states
 * the repo functions make unrepresentable but a future writer, a migration, or a
 * manual intervention could still attempt. Each is exercised with raw SQL,
 * deliberately bypassing the repo, because the repo is exactly what they exist
 * to outlive.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";
import { forkPreparation } from "./compaction-preparation-fixtures.js";

async function expectRejected(sql: string, params: unknown[]): Promise<void> {
  await expect(execute(sql, params)).rejects.toThrow();
}

describe("058 schema invariants (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("target generation must be exactly base + 1", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await expectRejected(
      "UPDATE compaction_preparations SET target_checkpoint_generation = base_checkpoint_generation + 2 WHERE id = $1",
      [preparation.id],
    );
  });

  it("a succeeded summary branch cannot exist without an output", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await expectRejected(
      "UPDATE compaction_preparations SET summary_status = 'succeeded' WHERE id = $1",
      [preparation.id],
    );
  });

  it("readiness and everything past it require a summary", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    for (const status of ["summary_ready", "apply_requested", "applying"]) {
      await expectRejected(
        "UPDATE compaction_preparations SET status = $2 WHERE id = $1",
        [preparation.id, status],
      );
    }
  });

  it("a frozen or succeeded chunks branch requires the snapshot", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    for (const status of ["frozen", "succeeded"]) {
      await expectRejected(
        "UPDATE compaction_preparations SET chunks_status = $2 WHERE id = $1",
        [preparation.id, status],
      );
    }
  });

  it("an applied row must record the generation it produced", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await expectRejected(
      "UPDATE compaction_preparations SET status = 'applied', summary_output = 'x' WHERE id = $1",
      [preparation.id],
    );
  });

  it("the corpus may only be absent when retention pruned it", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await expectRejected(
      "UPDATE compaction_preparations SET corpus_text = NULL WHERE id = $1",
      [preparation.id],
    );
    // With the prune stamp it is allowed.
    await execute(
      "UPDATE compaction_preparations SET corpus_text = NULL, corpus_pruned_at = NOW() WHERE id = $1",
      [preparation.id],
    );
  });

  it("a supersession link only exists on a superseded row and never self-refers", async () => {
    const sid = await makeSession();
    const first = await forkPreparation(sid);
    await expectRejected(
      "UPDATE compaction_preparations SET superseded_by_id = $1 WHERE id = $1",
      [first.id],
    );
    await expectRejected(
      "UPDATE compaction_preparations SET status = 'superseded', superseded_by_id = id WHERE id = $1",
      [first.id],
    );
  });

  it("apply_source is restricted to the four frozen values", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    // `apply_requested` is a STATUS, not a source — a writer that confuses the
    // two is rejected by the database.
    await expectRejected(
      "UPDATE compaction_preparations SET apply_source = 'apply_requested' WHERE id = $1",
      [preparation.id],
    );
    for (const source of [
      "ui_button",
      "agent_tool",
      "auto_full_autonomous",
      "forced_critical",
    ]) {
      await execute("UPDATE compaction_preparations SET apply_source = $2 WHERE id = $1", [
        preparation.id,
        source,
      ]);
    }
  });

  it("money_gate_bypass_reasons must be a JSON array", async () => {
    const sid = await makeSession();
    const preparation = await forkPreparation(sid);
    await expectRejected(
      `UPDATE compaction_preparations SET money_gate_bypass_reasons = '{"a":1}'::jsonb WHERE id = $1`,
      [preparation.id],
    );
    await execute(
      `UPDATE compaction_preparations SET money_gate_bypass_reasons = '["wallet_pending"]'::jsonb WHERE id = $1`,
      [preparation.id],
    );
  });

  it("deleting the session cascades the preparation away", async () => {
    const sid = await makeSession();
    await forkPreparation(sid);
    await execute("DELETE FROM sessions WHERE id = $1", [sid]);
    const remaining = await queryOne<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM compaction_preparations WHERE session_id = $1",
      [sid],
    );
    expect(remaining?.count).toBe("0");
  });
});
