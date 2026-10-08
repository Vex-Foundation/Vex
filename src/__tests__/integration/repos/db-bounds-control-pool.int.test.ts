/**
 * Kairos S-4 on a real (disposable, testcontainers) Postgres:
 *   - the main pool's statement_timeout cancels a long statement;
 *   - a known long statement's SET LOCAL override lasts only for its
 *     transaction;
 *   - idle_in_transaction_session_timeout is the session default;
 *   - with every main-pool client checked out, a main-pool connect fails
 *     within AGENT_DB_CONNECTION_TIMEOUT_MS while the reserved control pool
 *     still gets a connection.
 *
 * Tight bounds are set BEFORE the pool modules load so the proof runs in a
 * few seconds; the environment is restored afterwards.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

const TIGHT_ENV = {
  AGENT_DB_STATEMENT_TIMEOUT_MS: "1000",
  AGENT_DB_CONNECTION_TIMEOUT_MS: "1000",
  AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "2000",
  AGENT_DB_LONG_STATEMENT_TIMEOUT_MS: "5000",
} as const;

const saved: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(TIGHT_ENV)) {
  saved[key] = process.env[key];
  process.env[key] = value;
}

const client = await import("@vex-agent/db/client.js");
const control = await import("@vex-agent/db/control-pool.js");

function sqlState(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

describe("S-4 DB bounds on a disposable Postgres", () => {
  beforeAll(() => {
    client.getPool();
  });

  afterAll(async () => {
    await client.closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("statement_timeout cancels a statement that runs past the bound", async () => {
    const startedAt = Date.now();
    const err = await client.query("SELECT pg_sleep(5)").then(
      () => null,
      (e: unknown) => e,
    );
    expect(sqlState(err)).toBe("57014"); // query_canceled
    expect(Date.now() - startedAt).toBeLessThan(4_000);
  });

  it("the long-statement override is raised inside its transaction only", async () => {
    const inside = await client.withLongStatementTransaction(async (tx) => {
      await tx.query("SELECT pg_sleep(1.5)"); // over the 1 s ordinary cap
      const shown = await tx.query<{ statement_timeout: string }>("SHOW statement_timeout");
      return shown.rows[0]?.statement_timeout;
    });
    expect(inside).toBe("5s");

    const after = await client.queryOne<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(after?.statement_timeout).toBe("1s");
  });

  it("idle_in_transaction_session_timeout is the pool's session default", async () => {
    const shown = await client.queryOne<{ idle_in_transaction_session_timeout: string }>(
      "SHOW idle_in_transaction_session_timeout",
    );
    expect(shown?.idle_in_transaction_session_timeout).toBe("2s");
  });

  it("the control pool still connects while the main pool is saturated", async () => {
    const pool = client.getPool();
    const held: pg.PoolClient[] = [];
    try {
      for (let i = 0; i < 10; i += 1) held.push(await pool.connect());

      const startedAt = Date.now();
      await expect(pool.connect()).rejects.toThrow(/timeout/i);
      expect(Date.now() - startedAt).toBeLessThan(3_000);

      const outcome = await control.withControlTransaction(async (tx) => {
        const r = await tx.query<{ app: string }>(
          "SELECT current_setting('application_name') AS app",
        );
        return r.rows[0]?.app;
      });
      expect(outcome).toBe("vex-agent-control");
    } finally {
      for (const c of held) c.release();
    }
  });
});
