/**
 * Unit tests for the archive-path SQL in `sessions` repo — structural only.
 *
 * Why structural? The transactional helpers (`archivePrefix`,
 * `forkToolMessageToArchive`) run against a real pool with a `BEGIN/COMMIT`
 * shape that is painful to simulate end-to-end without a live database. What
 * we can still catch here — and what actually matters for the giant-tool /
 * prefix-archive interaction — is that both helpers keep
 * `ON CONFLICT (id) DO NOTHING` on the archive inserts. Without that, a
 * forked placeholder row colliding with a later prefix archive crashes the
 * pool on a unique-index violation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const clientQuery = vi.fn();
const clientRelease = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  execute: vi.fn(),
  executeWith: vi.fn(),
  query: vi.fn().mockResolvedValue([]),
  queryOneWith: vi.fn().mockResolvedValue(null),
  queryOne: vi.fn().mockResolvedValue(null),
  getPool: () => ({
    connect: async () => ({
      query: (...args: unknown[]) => clientQuery(...args),
      release: () => clientRelease(),
    }),
  }),
  setLocalLongStatementTimeout: async (client: { query: (sql: string) => Promise<unknown> }) => {
    await client.query("SET LOCAL statement_timeout = 300000");
  },
}));

const { archivePrefix, forkToolMessageToArchive } = await import(
  "../../../../vex-agent/db/repos/sessions.js"
);

beforeEach(() => {
  clientQuery.mockReset();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  clientRelease.mockReset();
});

describe("archivePrefix SQL", () => {
  it("uses ON CONFLICT (id) DO NOTHING when moving the prefix into archive", async () => {
    await archivePrefix("session-1", 42, 5);

    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    const archiveInsert = sqlCalls.find((s) => s.includes("INSERT INTO messages_archive"));
    expect(archiveInsert).toBeTruthy();
    expect(archiveInsert).toMatch(/ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/i);
  });

  it("wraps archive + message_count update in BEGIN / COMMIT", async () => {
    await archivePrefix("session-1", 42, 5);
    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls).toContain("BEGIN");
    expect(sqlCalls).toContain("COMMIT");
  });

  it("raises the statement cap for the bulk move, inside the transaction (S-4)", async () => {
    await archivePrefix("session-1", 42, 5);
    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqlCalls.slice(0, 2)).toEqual(["BEGIN", "SET LOCAL statement_timeout = 300000"]);
  });

  it("uses an explicit column list (no SELECT *) and stamps rewind_checkpoint_id NULL", async () => {
    // Puzzle 04 phase 5 invariant — compaction archive stamps
    // `rewind_checkpoint_id` NULL. The archive INSERT lists every
    // messages column explicitly and supplies NULL for
    // `rewind_checkpoint_id` so the partial index on
    // `messages_archive(rewind_checkpoint_id)` skips these rows.
    await archivePrefix("session-1", 42, 5);
    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    const archiveInsert = sqlCalls.find((s) => s.includes("INSERT INTO messages_archive"));
    expect(archiveInsert).toBeTruthy();
    // Explicit column list — every messages column appears in the
    // INSERT target column tuple. Spot-check key names; the constant
    // is the source of truth and a missing column there would also
    // fail this assertion.
    expect(archiveInsert).toMatch(/INSERT INTO messages_archive\s*\(/);
    expect(archiveInsert).toContain("session_id");
    expect(archiveInsert).toContain("metadata");
    expect(archiveInsert).toContain("rewind_checkpoint_id");
    // The SELECT projection includes a literal NULL for the stamp.
    expect(archiveInsert).toMatch(/SELECT[^;]*?,\s*NULL\s+FROM\s+moved/i);
    // No `SELECT \*` anywhere — would silently drop the new column
    // count mismatch on a future migration.
    expect(archiveInsert).not.toMatch(/SELECT\s*\*/);
  });
});

describe("forkToolMessageToArchive SQL", () => {
  it("uses ON CONFLICT (id) DO NOTHING on the archive copy", async () => {
    await forkToolMessageToArchive("session-1", 99, "[placeholder]");

    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    const archiveInsert = sqlCalls.find((s) => s.includes("INSERT INTO messages_archive"));
    expect(archiveInsert).toBeTruthy();
    expect(archiveInsert).toMatch(/ON CONFLICT\s*\(\s*id\s*\)\s*DO NOTHING/i);
  });

  it("stamps rewind_checkpoint_id NULL on the giant-tool archive copy", async () => {
    // Puzzle 04 phase 5 invariant — giant-tool overflow rows are
    // stamped `rewind_checkpoint_id` NULL, like compaction.
    await forkToolMessageToArchive("session-1", 99, "[placeholder]");
    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    const archiveInsert = sqlCalls.find((s) => s.includes("INSERT INTO messages_archive"));
    expect(archiveInsert).toBeTruthy();
    expect(archiveInsert).toMatch(/INSERT INTO messages_archive\s*\([^)]*rewind_checkpoint_id\)/);
    expect(archiveInsert).toMatch(/SELECT[^;]*?,\s*NULL\s+FROM\s+messages/i);
    expect(archiveInsert).not.toMatch(/SELECT\s*\*/);
  });

  it("issues the live UPDATE with the placeholder content and the same id", async () => {
    await forkToolMessageToArchive("session-1", 99, "[placeholder]");
    const updateCall = clientQuery.mock.calls.find((c: unknown[]) =>
      String(c[0]).toUpperCase().includes("UPDATE MESSAGES"),
    );
    expect(updateCall).toBeTruthy();
    const [, params] = updateCall as [string, unknown[]];
    // session_id is constrained in both the archive SELECT and the
    // live UPDATE so a wrong sessionId arg cannot lock one session
    // and mutate another's message.
    expect(params).toEqual([99, "session-1", "[placeholder]"]);
  });

  it("constrains both archive SELECT and live UPDATE by session_id (cross-session safety)", async () => {
    // Codex defensive fix — the lock takes `sessionId`, but the
    // mutation must also restrict by `session_id` so a wrong
    // sessionId arg is a no-op rather than a cross-session write.
    await forkToolMessageToArchive("session-1", 99, "[placeholder]");
    const sqlCalls = clientQuery.mock.calls.map((c) => c as [string, unknown[]]);
    const archiveCall = sqlCalls.find(([sql]) => String(sql).includes("INSERT INTO messages_archive"));
    expect(archiveCall).toBeTruthy();
    const [archiveSql, archiveParams] = archiveCall as [string, unknown[]];
    expect(archiveSql).toMatch(/FROM messages\s+WHERE id = \$1 AND session_id = \$2/);
    expect(archiveParams).toEqual([99, "session-1"]);

    const updateCall = sqlCalls.find(([sql]) => String(sql).toUpperCase().includes("UPDATE MESSAGES"));
    expect(updateCall).toBeTruthy();
    const [updateSql] = updateCall as [string, unknown[]];
    expect(updateSql).toMatch(/WHERE id = \$1 AND session_id = \$2/);
  });
});

// ── Puzzle 04 phase 5 — session row lock first ────────────────
// Codex required: `archivePrefix` and `forkToolMessageToArchive`
// must SELECT FOR UPDATE on the sessions row BEFORE touching
// messages. This block pins the ordering on the no-client
// (helper-owned tx) paths.

describe("session row lock ordering", () => {
  it("archivePrefix locks the sessions row before the DELETE FROM messages", async () => {
    await archivePrefix("session-1", 42, 5);
    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    const lockIdx = sqlCalls.findIndex((s) => /SELECT id FROM sessions WHERE id = \$1 FOR UPDATE/i.test(s));
    const deleteIdx = sqlCalls.findIndex((s) => s.includes("DELETE FROM messages"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(lockIdx);
  });

  it("forkToolMessageToArchive locks the sessions row before touching messages", async () => {
    await forkToolMessageToArchive("session-1", 99, "[placeholder]");
    const sqlCalls = clientQuery.mock.calls.map((c: unknown[]) => String(c[0]));
    const lockIdx = sqlCalls.findIndex((s) => /SELECT id FROM sessions WHERE id = \$1 FOR UPDATE/i.test(s));
    const archiveIdx = sqlCalls.findIndex((s) => s.includes("INSERT INTO messages_archive"));
    const updateIdx = sqlCalls.findIndex((s) => s.toUpperCase().includes("UPDATE MESSAGES"));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(archiveIdx).toBeGreaterThan(lockIdx);
    expect(updateIdx).toBeGreaterThan(lockIdx);
  });
});
