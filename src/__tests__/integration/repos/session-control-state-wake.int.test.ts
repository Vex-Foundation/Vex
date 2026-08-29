/**
 * Integration: the control-state aggregate's session-wake projection, against
 * REAL Postgres.
 *
 * WHY THIS EXISTS. `CONTROL_FACTS_SQL` is one hand-written statement, and the
 * M5 wave added a correlated subquery to it that names three things the unit
 * tests cannot check: the table `loop_wake_requests`, the column
 * `mission_run_id` that migration 057 made nullable, and the `due_at` ordering
 * the "next wake" claim rests on. A mocked `pg.Client` returns whatever row the
 * test hands it, so every one of those names could be wrong and the whole unit
 * suite would still be green. It nearly was: the same wave shipped the
 * statement with a backtick inside its own template literal, which truncated
 * the SQL and went unnoticed because nothing ever executed it.
 *
 * So this drives the REAL reader (`readSessionControlFacts`) over a real client
 * against a migrated schema, and asserts the projection through
 * `readSessionActivity` - the same two functions `runtime.getState` calls, in
 * the same order, with no SQL restated here. A test that re-wrote the query
 * would prove only that the copy runs.
 *
 * WHAT IS SUBSTITUTED, AND WHY THAT IS STILL THE REAL PATH. Only
 * `buildPoolConfig` (the desktop compose-credential lookup) and the main
 * process's electron logger. Both are environment plumbing, not the subject:
 * the statement text, the parameter binding, `withRuntimeDbClient`'s own client
 * lifecycle, the row shape and `toFacts` are all untouched. What is being
 * proven is that the SQL survives contact with the real schema.
 *
 * The four cases are the projection's whole contract:
 *   (a) a pending SESSION-scoped wake (mission_run_id IS NULL) is carried, and
 *       reads as sleeping with that instant;
 *   (b) a MISSION-scoped wake alone leaves it NULL - the projection must not
 *       leak a mission run's park into session activity;
 *   (c) a live lease plus a pending session wake reads running - the executor
 *       holds the lease before it consumes the row, and "running" is the only
 *       honest word for that interval;
 *   (d) a consumed or cancelled wake is not a park at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { query } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/**
 * The container's coordinates, published by the global setup as `VEX_DB_URL`.
 * Parsed rather than hardcoded: the port is assigned by Docker per run.
 */
function containerPoolConfig(): {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
} {
  const raw = process.env.VEX_DB_URL;
  if (raw === undefined) {
    throw new Error("VEX_DB_URL is unset - the postgres global setup did not run");
  }
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

// The desktop credential lookup reads the compose stack's mounted secret file
// and hardcodes the production database name. Neither exists here, and neither
// is what this test is about.
vi.mock("../../../../vex-app/src/main/database/db-config.js", () => ({
  buildPoolConfig: async () => containerPoolConfig(),
}));

// The main-process logger imports `electron`, which has no app instance in a
// node test runner. The reader only ever calls `log.warn` on a failure path.
vi.mock("../../../../vex-app/src/main/logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { readSessionControlFacts, readSessionActivity } = await import(
  "../../../../vex-app/src/main/database/session-control-state.js"
);

const CORRELATION = "session-wake-int";

/** The reader returns a Result; a failure here is a defect, not a case. */
async function factsFor(sessionId: string) {
  const outcome = await readSessionControlFacts(sessionId, CORRELATION);
  if (!outcome.ok) {
    throw new Error(
      `readSessionControlFacts failed: ${outcome.error.code} ${outcome.error.message}`,
    );
  }
  return outcome.data;
}

/**
 * A session-scoped wake: `mission_run_id` NULL, which is exactly what
 * migration 057 made possible and what the projection selects on.
 */
async function seedSessionWake(
  sessionId: string,
  dueAt: string,
  status: "pending" | "consumed" | "cancelled" = "pending",
): Promise<void> {
  await query(
    `INSERT INTO loop_wake_requests
       (session_id, mission_run_id, due_at, status, reason)
     VALUES ($1, NULL, $2, $3, 'session-wake integration')`,
    [sessionId, dueAt, status],
  );
}

/** A mission-scoped wake needs the mission + run rows it references. */
async function seedMissionWake(
  sessionId: string,
  dueAt: string,
): Promise<string> {
  const missionId = `mission-${sessionId}`;
  const runId = `run-${sessionId}`;
  await query(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'session-wake integration')`,
    [missionId, sessionId],
  );
  await query(
    `INSERT INTO mission_runs (id, mission_id, session_id, status, started_at)
     VALUES ($1, $2, $3, 'paused_wake', NOW())`,
    [runId, missionId, sessionId],
  );
  await query(
    `INSERT INTO loop_wake_requests
       (session_id, mission_run_id, due_at, status, reason)
     VALUES ($1, $2, $3, 'pending', 'mission wake')`,
    [sessionId, runId, dueAt],
  );
  return runId;
}

/** `expiresInMs` positive = a lease a runner still holds. */
async function seedLease(
  sessionId: string,
  expiresInMs: number,
  missionRunId: string | null = null,
): Promise<void> {
  await query(
    `INSERT INTO runner_leases
       (session_id, mission_run_id, owner_id, process_kind,
        acquired_at, heartbeat_at, expires_at)
     VALUES ($1, $2, 'owner-int', 'electron_main', NOW(), NOW(),
             NOW() + ($3::int * interval '1 millisecond'))`,
    [sessionId, missionRunId, expiresInMs],
  );
}

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * The schema facts the projection is written against. Asserted directly, so a
 * migration that renames or re-tightens one fails HERE with the reason, rather
 * than as a confusing null in the cases below.
 */
describe("the live schema the projection names", () => {
  it("loop_wake_requests.mission_run_id exists and is NULLABLE (migration 057)", async () => {
    const rows = await query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'loop_wake_requests'
          AND column_name IN ('mission_run_id', 'session_id', 'due_at', 'status')
        ORDER BY column_name`,
    );
    const byName = new Map(rows.map((r) => [r.column_name, r.is_nullable]));
    expect([...byName.keys()].sort()).toEqual([
      "due_at",
      "mission_run_id",
      "session_id",
      "status",
    ]);
    // The whole session-scoped branch depends on this being nullable. Before
    // 057 it was NOT NULL, and the subquery could never have matched a row.
    expect(byName.get("mission_run_id")).toBe("YES");
    expect(byName.get("session_id")).toBe("NO");
    expect(byName.get("due_at")).toBe("NO");
  });

  it("accepts a session-scoped wake row - the constraint really is dropped", async () => {
    const sessionId = await makeSession();
    await seedSessionWake(sessionId, "2026-08-29T12:04:00.000Z");
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM loop_wake_requests
        WHERE session_id = $1 AND mission_run_id IS NULL`,
      [sessionId],
    );
    expect(rows[0]?.n).toBe("1");
  });
});

describe("session_wake_due_at over the real schema", () => {
  it("(a) carries a pending session-scoped wake and reads as sleeping", async () => {
    const sessionId = await makeSession();
    const dueAt = "2026-08-29T12:04:00.000Z";
    await seedSessionWake(sessionId, dueAt);

    const facts = await factsFor(sessionId);

    expect(facts.sessionWakeDueAt).toBe(dueAt);
    // The broad fact sees it too; only the narrow one is session-scoped.
    expect(facts.hasPendingWake).toBe(true);
    expect(facts.leaseActive).toBe(false);
    expect(readSessionActivity(facts)).toEqual({
      kind: "sleeping",
      nextWakeAt: dueAt,
    });
  });

  it("(b) leaves a MISSION-scoped wake out of the session projection", async () => {
    const sessionId = await makeSession();
    await seedMissionWake(sessionId, "2026-08-29T12:04:00.000Z");

    const facts = await factsFor(sessionId);

    // The mission park is real and the broad fact reports it - that is what
    // keeps the Stop key alive. The SESSION projection must stay silent, or a
    // sleeping mission would drive the agent-session status word too and the
    // two surfaces would contradict each other.
    expect(facts.hasPendingWake).toBe(true);
    expect(facts.sessionWakeDueAt).toBeNull();
    expect(readSessionActivity(facts)).toEqual({ kind: "none" });
  });

  it("(c) reports running when a lease is held over a pending session wake", async () => {
    const sessionId = await makeSession();
    await seedSessionWake(sessionId, "2026-08-29T12:04:00.000Z");
    await seedLease(sessionId, 60_000);

    const facts = await factsFor(sessionId);

    // Both facts are true at once, which is the executor's real interval: it
    // claims the row and takes the lease before it marks the row consumed.
    expect(facts.leaseActive).toBe(true);
    expect(facts.sessionWakeDueAt).toBe("2026-08-29T12:04:00.000Z");
    expect(readSessionActivity(facts)).toEqual({ kind: "running" });
  });

  it.each(["consumed", "cancelled"] as const)(
    "(d) ignores a %s wake - a settled park is not sleep",
    async (status) => {
      const sessionId = await makeSession();
      await seedSessionWake(sessionId, "2026-08-29T12:04:00.000Z", status);

      const facts = await factsFor(sessionId);

      expect(facts.sessionWakeDueAt).toBeNull();
      expect(facts.hasPendingWake).toBe(false);
      expect(readSessionActivity(facts)).toEqual({ kind: "none" });
    },
  );

  /**
   * The subquery orders by `due_at` and takes one row. The partial unique index
   * `uniq_loop_wake_pending_per_session` means production can only hold one
   * PENDING row per session, so the ordering is belt and braces - but it is the
   * claim the copy makes ("the next wake"), and a settled row sorting earlier
   * must not win it.
   */
  it("takes the earliest PENDING row, never an earlier settled one", async () => {
    const sessionId = await makeSession();
    await seedSessionWake(sessionId, "2026-08-29T11:00:00.000Z", "cancelled");
    await seedSessionWake(sessionId, "2026-08-29T12:04:00.000Z", "pending");

    const facts = await factsFor(sessionId);

    expect(facts.sessionWakeDueAt).toBe("2026-08-29T12:04:00.000Z");
  });

  it("reports no park for a session with no wake rows at all", async () => {
    const sessionId = await makeSession();

    const facts = await factsFor(sessionId);

    expect(facts.sessionWakeDueAt).toBeNull();
    expect(readSessionActivity(facts)).toEqual({ kind: "none" });
  });
});

/**
 * The `recoveryReady` mirror's READY branch, proven at the reader that decides
 * it. `runtime.getState` maps `clear === true` to `{ kind: "ready" }` and
 * everything else to `blocked`, so this is the fact the mapping turns on.
 *
 * GAP, named rather than faked: `readRecoveryReadiness` itself is private to
 * `ipc/runtime/get-state.ts` and reachable only through a registered IPC
 * handler, which needs the electron `ipcMain` surface this harness does not
 * boot. What is unproven here is that wiring, not the money fact.
 */
describe("the recoveryReady mirror's underlying money fact", () => {
  it("a session with no money-path rows reads clear", async () => {
    const sessionId = await makeSession();
    const { withTransaction } = await import("@vex-agent/db/client.js");
    const { getUnresolvedMoneyStateForSession } = await import(
      "@vex-agent/db/repos/approval-intents/money-state.js"
    );

    const money = await withTransaction(async (client) =>
      getUnresolvedMoneyStateForSession(client, sessionId),
    );

    expect(money.clear).toBe(true);
  });
});
