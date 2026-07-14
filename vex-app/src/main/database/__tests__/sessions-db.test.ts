/**
 * Direct branching tests for `softDeleteSessionWithClient` — the outcome
 * classification is the riskiest part of the soft-delete contract and
 * lives entirely inside main, so it gets a focused unit test that does
 * not require a live Postgres.
 *
 * The helper accepts a `pg.Client`; the tests pass a fake whose `.query`
 * returns pre-scripted results in call order. The atomic UPDATE always
 * runs first; subsequent queries (existence check, deleted_at probe,
 * mission_run probe, approval_queue probe) run only when the UPDATE
 * returned 0 rows.
 */

import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

vi.mock("../../logger/index.js", () => ({
  log: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    silly: vi.fn(),
  },
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: async () => null,
}));

// Load the façade before individual 5s test timers start. The full app graph
// grew with Hyperliquid; outcome assertions should measure the query helper,
// not first-time Vite module transformation under a saturated worker pool.
await import("../sessions-db.js");

const TEST_ID = "00000000-0000-4000-8000-000000000001";

interface ScriptedQueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
}

function scriptedClient(results: ReadonlyArray<ScriptedQueryResult>): {
  client: Client;
  queryMock: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const queryMock = vi.fn(async () => {
    const r = results[call++];
    if (r === undefined) {
      throw new Error(`unexpected query call ${call}`);
    }
    return r;
  });
  const client = { query: queryMock } as unknown as Client;
  return { client, queryMock };
}

describe("softDeleteSessionWithClient outcome branching", () => {
  it("returns 'removed' when the atomic UPDATE affects a row", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      { rows: [{ id: TEST_ID }], rowCount: 1 },
    ]);
    const result = await mod.softDeleteSessionWithClient(client, TEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("removed");
  });

  it("returns 'not_found' when the existence probe returns no row", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      { rows: [], rowCount: 0 }, // atomic UPDATE: 0 rows
      { rows: [], rowCount: 0 }, // SELECT deleted_at: missing
    ]);
    const result = await mod.softDeleteSessionWithClient(client, TEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("not_found");
  });

  it("returns 'already_removed' when deleted_at is already set", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      { rows: [], rowCount: 0 },
      { rows: [{ deleted_at: new Date() }], rowCount: 1 },
    ]);
    const result = await mod.softDeleteSessionWithClient(client, TEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("already_removed");
  });

  it("returns 'blocked_active_mission' when an active mission_run exists", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      { rows: [], rowCount: 0 },
      { rows: [{ deleted_at: null }], rowCount: 1 },
      { rows: [{ "?column?": 1 }], rowCount: 1 }, // mission_run probe hit
    ]);
    const result = await mod.softDeleteSessionWithClient(client, TEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("blocked_active_mission");
  });

  it("returns 'blocked_pending_approval' when approval_queue has a pending row", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      { rows: [], rowCount: 0 },
      { rows: [{ deleted_at: null }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // no active mission
      { rows: [{ "?column?": 1 }], rowCount: 1 }, // pending approval hit
    ]);
    const result = await mod.softDeleteSessionWithClient(client, TEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("blocked_pending_approval");
  });

  it("returns 'state_changed' when classification finds no blockers (race-loser tail)", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      { rows: [], rowCount: 0 },
      { rows: [{ deleted_at: null }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 }, // no pending approval — race-loser
    ]);
    const result = await mod.softDeleteSessionWithClient(client, TEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.outcome).toBe("state_changed");
  });

  it("first SQL is the atomic guarded UPDATE with both NOT EXISTS clauses + RETURNING", async () => {
    const mod = await import("../sessions-db.js");
    const { client, queryMock } = scriptedClient([
      { rows: [{ id: TEST_ID }], rowCount: 1 },
    ]);
    await mod.softDeleteSessionWithClient(client, TEST_ID);
    const firstCall = queryMock.mock.calls[0];
    expect(firstCall).toBeDefined();
    const sql = firstCall![0] as string;
    expect(sql).toMatch(/^\s*UPDATE sessions/);
    expect(sql).toMatch(/SET\s+deleted_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/AND\s+NOT\s+EXISTS\s*\(\s*SELECT 1 FROM mission_runs/);
    expect(sql).toMatch(/AND\s+NOT\s+EXISTS\s*\(\s*SELECT 1 FROM approval_queue/);
    expect(sql).toMatch(/RETURNING id/);
  });
});

describe("setSessionPinnedWithClient — soft-delete invariant", () => {
  it("returns ok(null) when the row is soft-deleted (UPDATE 0 rows)", async () => {
    const mod = await import("../sessions-db.js");
    // Soft-deleted rows fail the `AND deleted_at IS NULL` filter, so the
    // UPDATE affects 0 rows. The helper must return ok(null) instead of
    // happily echoing a stale `SessionListItem` back into the cache.
    const { client } = scriptedClient([{ rows: [], rowCount: 0 }]);
    const result = await mod.setSessionPinnedWithClient(client, TEST_ID, true);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toBeNull();
  });

  it("WHERE clause filters deleted_at IS NULL (regression guard)", async () => {
    const mod = await import("../sessions-db.js");
    const { client, queryMock } = scriptedClient([{ rows: [], rowCount: 0 }]);
    await mod.setSessionPinnedWithClient(client, TEST_ID, true);
    const sql = queryMock.mock.calls[0]![0] as string;
    expect(sql).toMatch(/UPDATE sessions/);
    expect(sql).toMatch(/AND\s+deleted_at\s+IS\s+NULL/);
  });

  it("returns a live SessionListItem with missionStatus for an active mission row", async () => {
    const mod = await import("../sessions-db.js");
    const { client } = scriptedClient([
      {
        rows: [
          {
            id: TEST_ID,
            mode: "mission",
            permission: "restricted",
            initial_goal: "Live mission",
            started_at: new Date(),
            ended_at: null,
            title: "Pinned mission",
            pinned_at: new Date(),
          },
        ],
        rowCount: 1,
      },
      { rows: [{ status: "running" }], rowCount: 1 }, // loadMissionStatus
    ]);
    const result = await mod.setSessionPinnedWithClient(client, TEST_ID, true);
    expect(result.ok).toBe(true);
    if (result.ok && result.data !== null) {
      expect(result.data.mode).toBe("mission");
      expect(result.data.missionStatus).toBe("running");
      expect(result.data.pinnedAt).not.toBeNull();
    }
  });
});

// Drift guard for the puzzle 03 follow-up: every helper that uses the
// `ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES` whitelist must include
// `paused_user`. Otherwise the sidebar's active-run buckets, the
// delete guard, and pinned-row lookups will silently miss any session
// that the user has paused via `runtime.requestPause`. The constant is
// not exported; we assert it via the SQL parameters the helpers send.
describe("ACTIVE_OR_PAUSED_MISSION_RUN_STATUSES — paused_user parity", () => {
  it("loadMissionStatus (used by setSessionPinned) passes paused_user in $2", async () => {
    const mod = await import("../sessions-db.js");
    const { client, queryMock } = scriptedClient([
      // setSessionPinnedWithClient first runs the guarded UPDATE on sessions.
      // `mode: 'mission'` triggers the follow-up `loadMissionStatus` probe
      // which is the actual query carrying the whitelist param.
      {
        rows: [
          {
            id: TEST_ID,
            mode: "mission",
            permission: "restricted",
            initial_goal: null,
            started_at: new Date(),
            ended_at: null,
            title: "Test",
            pinned_at: new Date(),
          },
        ],
        rowCount: 1,
      },
      // ...followed by loadMissionStatus on mission_runs.
      { rows: [], rowCount: 0 },
    ]);
    await mod.setSessionPinnedWithClient(client, TEST_ID, true);
    // Second call is the mission_run status probe.
    const missionRunCall = queryMock.mock.calls[1];
    expect(missionRunCall).toBeDefined();
    const sql = missionRunCall![0] as string;
    const params = missionRunCall![1] as readonly unknown[];
    expect(sql).toMatch(/FROM mission_runs/);
    expect(sql).toMatch(/status\s*=\s*ANY\(\$2::text\[\]\)/);
    expect(params[1]).toContain("paused_user");
    expect(params[1]).toContain("running");
    expect(params[1]).toContain("paused_approval");
    expect(params[1]).toContain("paused_wake");
    expect(params[1]).toContain("paused_error");
  });
});
