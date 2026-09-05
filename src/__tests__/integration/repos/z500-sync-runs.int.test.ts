/**
 * z500_sync_runs over REAL Postgres — the claim/takeover SQL that carries the
 * workflow's whole idempotency story (migration 110).
 *
 * The unit suite proves the runner honors whatever the repo answers; THIS
 * suite proves the repo's answers are the database facts the spec demands:
 * one owner per window under real concurrency, completed windows closed
 * forever (restart-rerun protection is this row's existence), stale-running
 * takeover atomic and single-winner, and the record merge preserving partial
 * progress.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { execute } from "@vex-agent/db/client.js";
import { buildProductionRunRepo } from "@vex-agent/sync/z500-allocation-sync/repo.js";

const repo = buildProductionRunRepo();
const WINDOW = "2026-08-28T00:00:00.000Z";
const SCHEDULED = new Date(WINDOW);

beforeEach(async () => {
  await execute("DELETE FROM z500_sync_runs", []);
});

describe("window ownership", () => {
  it("the first claim owns; every later claim of the same window does not", async () => {
    const first = await repo.claimWindow(WINDOW, SCHEDULED, "scheduled");
    expect(first.kind).toBe("claimed");
    const second = await repo.claimWindow(WINDOW, SCHEDULED, "scheduled");
    expect(second.kind).toBe("owned");
  });

  it("CONCURRENT claims race to exactly one owner — the spec's multi-worker guarantee", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.claimWindow(WINDOW, SCHEDULED, "scheduled")),
    );
    expect(results.filter((r) => r.kind === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.kind === "owned")).toHaveLength(7);
  });

  it("a COMPLETED window can never be claimed again — restart-rerun and duplicate-catch-up protection", async () => {
    const claim = await repo.claimWindow(WINDOW, SCHEDULED, "scheduled");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    await repo.complete(claim.runId, "succeeded", "no_change_needed");
    const again = await repo.claimWindow(WINDOW, SCHEDULED, "catch-up");
    expect(again.kind).toBe("complete");
    // Failed windows are equally closed: fail-closed runs do not respawn.
    const other = await repo.claimWindow("2026-08-29T00:00:00.000Z", new Date("2026-08-29T00:00:00Z"), "scheduled");
    if (other.kind === "claimed") await repo.complete(other.runId, "failed", "source_unavailable", "x");
    expect((await repo.claimWindow("2026-08-29T00:00:00.000Z", new Date("2026-08-29T00:00:00Z"), "catch-up")).kind).toBe("complete");
  });

  it("different windows are independent claims", async () => {
    expect((await repo.claimWindow(WINDOW, SCHEDULED, "scheduled")).kind).toBe("claimed");
    expect((await repo.claimWindow("2026-08-29T00:00:00.000Z", new Date("2026-08-29T00:00:00Z"), "scheduled")).kind).toBe("claimed");
  });
});

describe("stale-running takeover", () => {
  it("a FRESH running row cannot be taken over; a stale one hands over its record exactly once", async () => {
    const claim = await repo.claimWindow(WINDOW, SCHEDULED, "scheduled");
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    await repo.mergeRecord(claim.runId, { mutationRequested: true, desiredAllocation: { mintA: 10 } });

    // Fresh → owned, not takeover.
    expect((await repo.claimWindow(WINDOW, SCHEDULED, "catch-up")).kind).toBe("owned");

    // Age the row past the takeover threshold, then race two takeovers.
    await execute("UPDATE z500_sync_runs SET started_at = NOW() - INTERVAL '2 hours' WHERE window_id = $1", [WINDOW]);
    const [a, b] = await Promise.all([
      repo.claimWindow(WINDOW, SCHEDULED, "catch-up"),
      repo.claimWindow(WINDOW, SCHEDULED, "catch-up"),
    ]);
    const takeovers = [a, b].filter((r) => r.kind === "takeover");
    expect(takeovers).toHaveLength(1);
    // The persisted partial progress rides along for reconciliation.
    expect((takeovers[0] as { record: Record<string, unknown> }).record).toMatchObject({
      mutationRequested: true,
      desiredAllocation: { mintA: 10 },
    });
  });
});

describe("record and terminal writes", () => {
  it("merges record patches without losing earlier keys, and the CHECK vocabulary admits every runner outcome", async () => {
    const claim = await repo.claimWindow(WINDOW, SCHEDULED, "catch-up");
    if (claim.kind !== "claimed") throw new Error("claim failed");
    await repo.mergeRecord(claim.runId, { source: { validation: "passed" } });
    await repo.mergeRecord(claim.runId, { selectedMints: ["m1"] });
    await repo.complete(claim.runId, "succeeded", "allocation_updated");
    const run = await repo.getRun(WINDOW);
    expect(run?.status).toBe("succeeded");
    expect(run?.outcome).toBe("allocation_updated");
    expect(run?.record).toMatchObject({ source: { validation: "passed" }, selectedMints: ["m1"] });
    expect(run?.triggerType).toBe("catch-up");
  });
});
