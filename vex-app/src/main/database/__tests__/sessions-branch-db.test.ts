/**
 * Branching tests for `branchSessionWithClient` (A14) — the fail-closed
 * outcome classification and the copy transaction shape are the whole
 * contract, so they get a focused unit test on a scripted fake `pg.Client`
 * (same pattern as `sessions-db.test.ts`).
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

await import("../sessions-db.js");

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const NEW_ID = "00000000-0000-4000-8000-000000000002";
const ANCHOR_ID = 41;

interface ScriptedQueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount: number;
}

const EMPTY: ScriptedQueryResult = { rows: [], rowCount: 0 };
const ONE_ROW: ScriptedQueryResult = { rows: [{ ok: 1 }], rowCount: 1 };

function scriptedClient(results: ReadonlyArray<ScriptedQueryResult>): {
  client: Client;
  queryMock: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  const queryMock = vi.fn(async () => {
    const r = results[call++];
    if (r === undefined) throw new Error(`unexpected query call ${call}`);
    return r;
  });
  return { client: { query: queryMock } as unknown as Client, queryMock };
}

function sessionRow(): Record<string, unknown> {
  return {
    id: NEW_ID,
    mode: "agent",
    permission: "restricted",
    initial_goal: null,
    started_at: new Date(),
    ended_at: null,
    title: "Branch title",
    pinned_at: null,
  };
}

async function branch(
  client: Client,
  name: string | null = null,
): Promise<unknown> {
  const mod = await import("../sessions-db.js");
  return mod.branchSessionWithClient(client, {
    sourceId: SOURCE_ID,
    messageId: ANCHOR_ID,
    name,
    newSessionId: NEW_ID,
  });
}

function lastSql(queryMock: ReturnType<typeof vi.fn>, n: number): string {
  return queryMock.mock.calls[n]![0] as string;
}

describe("branchSessionWithClient - fail-closed outcome classification", () => {
  it("an unknown or soft-deleted source is 'not_found' and the transaction rolls back before any write", async () => {
    const { client, queryMock } = scriptedClient([
      EMPTY, // BEGIN
      EMPTY, // source probe: no row
      EMPTY, // ROLLBACK
    ]);
    const result = (await branch(client)) as {
      ok: boolean;
      data: { outcome: string };
    };
    expect(result.ok).toBe(true);
    expect(result.data.outcome).toBe("not_found");
    // The last statement is the ROLLBACK — nothing was inserted.
    expect(lastSql(queryMock, 2)).toMatch(/ROLLBACK/);
  });

  it("a mission-mode source is 'unsupported_mode': mission state (frozen contract, approvals, wallets) never crosses a branch", async () => {
    const { client } = scriptedClient([
      EMPTY,
      { rows: [{ mode: "mission", title: "M" }], rowCount: 1 },
      EMPTY, // ROLLBACK
    ]);
    const result = (await branch(client)) as { data: { outcome: string } };
    expect(result.data.outcome).toBe("unsupported_mode");
  });

  it("an anchor absent from BOTH live and archive tape is 'anchor_not_found'", async () => {
    const { client } = scriptedClient([
      EMPTY,
      { rows: [{ mode: "agent", title: "S" }], rowCount: 1 },
      EMPTY, // live anchor probe: miss
      EMPTY, // archive probe: miss
      EMPTY, // ROLLBACK
    ]);
    const result = (await branch(client)) as { data: { outcome: string } };
    expect(result.data.outcome).toBe("anchor_not_found");
  });

  it("an anchor that compaction moved to the archive is 'anchor_compacted' - only the live tape can seed a branch", async () => {
    const { client } = scriptedClient([
      EMPTY,
      { rows: [{ mode: "agent", title: "S" }], rowCount: 1 },
      EMPTY, // live anchor probe: miss
      ONE_ROW, // archive probe: hit
      EMPTY, // ROLLBACK
    ]);
    const result = (await branch(client)) as { data: { outcome: string } };
    expect(result.data.outcome).toBe("anchor_compacted");
  });

  it("a prefix that severs a tool call from its result is 'open_tool_batch' - no auto-repair, nothing written", async () => {
    const { client, queryMock } = scriptedClient([
      EMPTY,
      { rows: [{ mode: "agent", title: "S" }], rowCount: 1 },
      { rows: [{ created_at: new Date() }], rowCount: 1 }, // anchor: live
      ONE_ROW, // open-batch probe: an orphaned tool_call exists
      EMPTY, // ROLLBACK
    ]);
    const result = (await branch(client)) as { data: { outcome: string } };
    expect(result.data.outcome).toBe("open_tool_batch");
    expect(lastSql(queryMock, 4)).toMatch(/ROLLBACK/);
  });
});

describe("branchSessionWithClient - the copy transaction", () => {
  function happyPathScript(): ScriptedQueryResult[] {
    return [
      EMPTY, // BEGIN
      { rows: [{ mode: "agent", title: "Source title" }], rowCount: 1 },
      { rows: [{ created_at: new Date() }], rowCount: 1 }, // anchor
      EMPTY, // open-batch probe: closed prefix
      ONE_ROW, // INSERT sessions copy
      { rows: [], rowCount: ANCHOR_ID }, // INSERT..SELECT messages
      ONE_ROW, // UPDATE message_count
      ONE_ROW, // INSERT session_links
      { rows: [sessionRow()], rowCount: 1 }, // SELECT list-item row
      EMPTY, // COMMIT
    ];
  }

  it("a closed prefix creates the branch and returns the new SessionListItem", async () => {
    const { client, queryMock } = scriptedClient(happyPathScript());
    const result = (await branch(client, "Branch title")) as {
      ok: boolean;
      data: { outcome: string; session: { id: string; missionStatus: unknown } };
    };
    expect(result.ok).toBe(true);
    expect(result.data.outcome).toBe("created");
    expect(result.data.session.id).toBe(NEW_ID);
    // Agent-mode branch never carries a mission status.
    expect(result.data.session.missionStatus).toBeNull();
    expect(lastSql(queryMock, 9)).toMatch(/COMMIT/);
  });

  it("the transaction opens REPEATABLE READ so a concurrent compaction cannot shear the prefix mid-copy", async () => {
    const { client, queryMock } = scriptedClient(happyPathScript());
    await branch(client, "Branch title");
    expect(lastSql(queryMock, 0)).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ/);
  });

  it("the message copy INSERTs new rows scoped to the new session and stamps origin_session_id with the source - the source tape itself is never touched", async () => {
    const { client, queryMock } = scriptedClient(happyPathScript());
    await branch(client, "Branch title");
    const copySql = lastSql(queryMock, 5);
    expect(copySql).toMatch(/INSERT INTO messages/);
    expect(copySql).toMatch(/origin_session_id/);
    // No statement in the whole transaction UPDATEs or DELETEs source rows.
    for (const call of queryMock.mock.calls) {
      const sql = call[0] as string;
      expect(sql).not.toMatch(/UPDATE messages/);
      expect(sql).not.toMatch(/DELETE/);
    }
  });

  it("the branch is recorded as a session_links row (parent, child, 'branch')", async () => {
    const { client, queryMock } = scriptedClient(happyPathScript());
    await branch(client, "Branch title");
    const linkSql = lastSql(queryMock, 7);
    expect(linkSql).toMatch(/INSERT INTO session_links/);
    expect(queryMock.mock.calls[7]![1]).toEqual([SOURCE_ID, NEW_ID, "branch"]);
  });

  it("message_count is set absolutely from the copied rows, not incremented", async () => {
    const { client, queryMock } = scriptedClient(happyPathScript());
    await branch(client, "Branch title");
    expect(lastSql(queryMock, 6)).toMatch(
      /SET message_count = \(SELECT COUNT\(\*\)/i,
    );
  });

  it("a missing name falls back to the source title", async () => {
    const { client, queryMock } = scriptedClient(happyPathScript());
    await branch(client, null);
    // INSERT sessions copy carries the resolved title parameter.
    const params = queryMock.mock.calls[4]![1] as unknown[];
    expect(params).toContain("Source title");
  });

  it("a thrown query error rolls back and surfaces a db error, never a partial branch", async () => {
    let call = 0;
    const script = happyPathScript();
    const queryMock = vi.fn(async (..._args: unknown[]) => {
      if (call === 5) {
        call++;
        throw new Error("copy failed");
      }
      const r = script[call++];
      if (r === undefined) return EMPTY; // trailing ROLLBACK
      return r;
    });
    const client = { query: queryMock } as unknown as Client;
    const result = (await branch(client, "Branch title")) as { ok: boolean };
    expect(result.ok).toBe(false);
    const sqls = queryMock.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("ROLLBACK"))).toBe(true);
    expect(sqls.some((s) => s.includes("COMMIT"))).toBe(false);
  });
});
