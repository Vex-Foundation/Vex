/**
 * Shared real-Postgres fixtures for the Agent Scan repo-backed suites (C13).
 *
 * These suites intentionally do NOT mock `@vex-agent/db/client.js` — they run
 * against a real local Postgres (the dev-compose stack the client's
 * documented fallback points at, `postgresql://vex:vex@localhost:5777/vex_test`,
 * or `VEX_DB_URL` when set) with migration 044 applied, because the
 * CAS/immutability/FK-constraint behavior under test genuinely lives in SQL —
 * a mocked client would prove nothing about it.
 *
 * `seedIntent` creates ONE real `protocol_executions` row via the executions
 * repo (satisfying `agent_activity`'s `protocol_execution_id` FK) so every
 * test gets a genuine, non-orphan id instead of a hardcoded literal.
 * `cleanupSeeded` deletes every row a file's tests created this run, in
 * FK-safe order (`agent_activity` children before their `protocol_executions`
 * parent), so repeated runs never accumulate residue in a shared dev
 * database. Each importing test file gets its OWN tracked id list (module
 * state is per test-file under vitest's default isolation) — call
 * `cleanupSeeded` from that file's own `afterEach`.
 */
import { randomUUID } from "node:crypto";

import { execute } from "@vex-agent/db/client.js";
import { createExecutionIntent } from "@vex-agent/db/repos/executions.js";

export interface SeededIntent {
  readonly protocolExecutionId: number;
  readonly sessionId: string;
  readonly walletAddress: string;
}

const seededExecutionIds: number[] = [];

/** Seed one real `protocol_executions` intent row; returns its id + a fresh per-call sessionId/wallet. */
export async function seedIntent(toolId = "kyberswap.swap.execute"): Promise<SeededIntent> {
  const sessionId = `w0-agent-scan-${randomUUID()}`;
  const walletAddress = `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
  const protocolExecutionId = await createExecutionIntent(
    toolId,
    "kyberswap",
    sessionId,
    { fixture: "w0-agent-scan" },
  );
  if (protocolExecutionId <= 0) {
    throw new Error("agent-scan fixtures: createExecutionIntent returned no id");
  }
  seededExecutionIds.push(protocolExecutionId);
  return { protocolExecutionId, sessionId, walletAddress };
}

/** Delete every row this file's tests seeded so far. Safe to call repeatedly (no-op once drained). */
export async function cleanupSeeded(): Promise<void> {
  if (seededExecutionIds.length === 0) return;
  const ids = seededExecutionIds.splice(0, seededExecutionIds.length);
  await execute(`DELETE FROM agent_activity WHERE protocol_execution_id = ANY($1::bigint[])`, [ids]);
  await execute(`DELETE FROM protocol_executions WHERE id = ANY($1::bigint[])`, [ids]);
}

/**
 * Test-only direct SQL: push an `agent_activity` row's `submit_attempted_at`
 * into the past so the repair sweep's `listPendingOlderThan` (a real
 * `NOW() - make_interval(...)` comparison) treats it as a candidate without
 * a real wall-clock wait. Never used by production code — repair-sweep and
 * staged-broadcast suites only, to construct an "old enough" precondition.
 */
export async function backdateSubmitAttempt(activityEventId: number, msAgo: number): Promise<void> {
  await execute(
    `UPDATE agent_activity
        SET submit_attempted_at = NOW() - make_interval(secs => $2::float8)
      WHERE id = $1`,
    [activityEventId, msAgo / 1000],
  );
}
