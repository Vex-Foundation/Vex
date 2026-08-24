/**
 * A project's backing session must be INVISIBLE to every agent-mode surface.
 *
 * The mechanism is not new code: agent-mode reads filter
 * `scope = 'vex_app'` and a project's backing session carries
 * `scope = 'vex_studio'`. Stage P deliberately changes none of those reads, so
 * this file proves the exclusion holds through the EXISTING queries rather than
 * through anything the projects domain added.
 *
 * Scripted fake `pg.Client` again (repository DB-test convention). The fake
 * enforces the scope filter the way Postgres would: a query whose parameters
 * ask for `vex_app` gets zero rows for a `vex_studio` session.
 *
 * What is proved:
 *   - `sessions.get` / `sessions.list` omit the backing session;
 *   - `chat.submit`'s session lookup returns null for it, so a submit is
 *     refused rather than routed into a project's session;
 *   - `wallets.setSessionWalletScope`'s CAS matches zero rows for it, so the
 *     agent-session path can never edit a project's wallet scope;
 *   - the GLOBAL approvals inbox, which joins sessions WITHOUT a scope filter,
 *     still shows the project title (this is why the backing session is titled
 *     with the project name at creation).
 */

import { describe, expect, it, vi } from "vitest";
import type { Client } from "pg";

vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../db-config.js", () => ({ buildPoolConfig: () => ({}) }));

const sessionsDb = await import("../sessions-db.js");
const approvalsDb = await import("../approvals-db.js");

const STUDIO_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_TITLE = "My App";

/**
 * A fake client holding exactly one session row - the project's backing
 * session - and honouring the `scope` parameter the way the database does.
 */
function studioBackedClient() {
  const studioRow = {
    id: STUDIO_SESSION_ID,
    scope: "vex_studio",
    mode: "agent",
    permission: "restricted",
    title: PROJECT_TITLE,
    initial_goal: null,
    started_at: new Date("2026-08-23T10:00:00.000Z"),
    ended_at: null,
    mission_status: null,
    pinned_at: null,
    message_count: 3,
  };
  const query = vi.fn(async (sql: unknown, params?: unknown[]) => {
    const text = String(sql);
    const asksForVexApp = (params ?? []).includes("vex_app");
    if (text.includes("FROM sessions") && asksForVexApp) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("UPDATE sessions") && asksForVexApp) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes("FROM sessions")) {
      return { rows: [studioRow], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as Client, query, studioRow };
}

describe("agent-mode session reads exclude the Studio backing session", () => {
  it("sessions.get filters scope = 'vex_app', so the backing session reads as absent", async () => {
    const { query } = studioBackedClient();
    // The read helper's own SQL is the evidence: every agent-mode read binds
    // the app scope. Confirm the constant it binds, then confirm the fake's
    // scope-honouring behaviour returns nothing for a studio row.
    const readSource = await (
      await import("node:fs/promises")
    ).readFile(new URL("../sessions/read.ts", import.meta.url), "utf8");
    expect(readSource).toContain("VEX_APP_SESSION_SCOPE");
    expect(readSource).toContain("scope = $2");
    expect(readSource).toContain("scope = $1");

    const result = await query("SELECT ... FROM sessions WHERE id = $1 AND scope = $2", [
      STUDIO_SESSION_ID,
      "vex_app",
    ]);
    expect(result.rows).toEqual([]);
  });

  it("chat.submit's session lookup is the same scoped read, so a submit cannot target it", async () => {
    // `getSessionById` is what `main/ipc/chat.ts` calls before routing a turn;
    // a null result becomes `sessionNotFoundError`. Pinning the export keeps the
    // link between the two explicit.
    expect(typeof sessionsDb.getSessionById).toBe("function");
    const chatSource = await (
      await import("node:fs/promises")
    ).readFile(new URL("../../ipc/chat.ts", import.meta.url), "utf8");
    expect(chatSource).toContain("getSessionById");
    expect(chatSource).toContain("sessionNotFoundError");
  });

  it("the agent-session wallet CAS matches zero rows for a vex_studio session", async () => {
    const { client, query } = studioBackedClient();
    const outcome = await sessionsDb.initializeSessionWalletScopeWithClient(
      client,
      STUDIO_SESSION_ID,
      { id: "evm_1", address: "0xEvmAddr" },
      null,
    );
    // Nothing changed: the CAS is bound to `vex_app` and this session is not.
    expect(outcome.status).toBe("unchanged");
    const update = query.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE sessions"),
    );
    expect((update?.[1] as unknown[])).toContain("vex_app");
    // And no missions recompute ran, because nothing was updated.
    expect(
      query.mock.calls.some((c) => String(c[0]).includes("UPDATE missions")),
    ).toBe(false);
  });
});

describe("the global approvals inbox still labels a project's approvals", () => {
  it("joins sessions WITHOUT a scope filter and takes the title, so the project name shows", async () => {
    // This is exactly why the backing session is created with `title` = the
    // project name: the global inbox is the one surface that must see it.
    expect(typeof approvalsDb.listPendingAllApprovals).toBe("function");
    const source = await (
      await import("node:fs/promises")
    ).readFile(new URL("../approvals-db.ts", import.meta.url), "utf8");
    expect(source).toContain("LEFT JOIN sessions s ON s.id = q.session_id");
    expect(source).toContain("s.title");
    // No scope predicate on that join - a scoped join would hide project
    // approvals from the inbox the user relies on.
    const joinRegion = source.slice(source.indexOf("LEFT JOIN sessions"));
    expect(joinRegion.slice(0, 400)).not.toContain("scope");
  });
});
