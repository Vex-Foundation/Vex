/**
 * `readProjectPortfolioScope` against a project being DELETED, on a real
 * PostgreSQL, with two connections.
 *
 * ## The defect this pins
 *
 * The function used to ask two questions in two statements on one pooled
 * connection:
 *
 *   1. `SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL`
 *   2. `SELECT ... FROM project_wallets WHERE project_id = $1`
 *
 * Under READ COMMITTED - the Postgres default, and what this connection runs at
 * - each statement takes its OWN snapshot. Project deletion is a SOFT delete:
 * migration 097 writes `deleted_at` and PRESERVES the `project_wallets` rows,
 * because the approval audit still references the project. So a delete
 * committing between those two statements produced the worst available answer:
 * statement 1 said "active", statement 2 happily returned the tombstone's
 * wallet selection, and the user was shown balances for a project Vex had
 * already declared gone.
 *
 * The fix joins the tombstone predicate to the wallet read in ONE statement, so
 * "is this project active" and "whose addresses are these" come from the same
 * snapshot and cannot disagree.
 *
 * ## Why the old sequence is reproduced here
 *
 * The interleaving cannot be forced from outside the production function - it
 * has no injectable client, and forcing the gap would mean adding a seam whose
 * only purpose is to be raced. So the test reproduces the OLD two-statement
 * shape explicitly, on its own connection, at exactly the point the delete has
 * committed, and runs the PRODUCTION function at the same point. That makes the
 * two answers visible side by side and deterministic:
 *
 *   - the old shape's second statement STILL returns the wallets, which is what
 *     proves the interleaving was reachable and the concern real rather than
 *     theoretical;
 *   - the production function returns `not_found`.
 *
 * If the production function ever regresses to two statements, its assertion
 * below does not change - but the control above is what keeps this file honest
 * about what it is proving.
 *
 * Connection A is a dedicated `pg.Client` that holds the delete transaction
 * OPEN across an assertion, so the "uncommitted delete is not visible" half is
 * proven on a real concurrent transaction rather than on a sequence.
 */

import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../logger/index.js", () => ({
  log: {
    debug: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
  },
  configureLogger: (): void => undefined,
  redact: (value: unknown): unknown => value,
  redactArgs: (value: unknown): unknown => value,
}));

vi.mock("../db-config.js", () => ({
  buildPoolConfig: (): Promise<{
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
  } | null> => {
    const url = process.env.VEX_DB_URL;
    if (url === undefined || url === "") return Promise.resolve(null);
    const parsed = new URL(url);
    return Promise.resolve({
      host: parsed.hostname,
      port: Number(parsed.port),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  },
}));

import { ok } from "@shared/ipc/result.js";
import { withClient } from "../sessions/connection.js";
import { readProjectPortfolioScope } from "../projects/portfolio-scope.js";

async function sql<T extends Record<string, unknown>>(
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await withClient(async (client) => {
    const rows = await client.query<T>(text, [...values]);
    return ok(rows.rows);
  });
  if (!result.ok) throw new Error(`statement failed: ${text}`);
  return result.data;
}

/** The OLD two-statement shape, on connection B's own client. The control. */
async function readTheOldWay(
  projectId: string,
): Promise<{ active: boolean; walletRows: number }> {
  const result = await withClient(async (client) => {
    const projectRows = await client.query<{ id: string }>(
      "SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    const walletRows = await client.query(
      "SELECT project_id, family, wallet_id, address FROM project_wallets WHERE project_id = $1",
      [projectId],
    );
    return ok({
      active: projectRows.rows.length > 0,
      walletRows: walletRows.rows.length,
    });
  });
  if (!result.ok) throw new Error("control read failed");
  return result.data;
}

const PROJECT_NAME = "Race";
let projectId = "";
let sessionId = "";
let connectionA: Client | null = null;

beforeEach(async () => {
  projectId = randomUUID();
  sessionId = randomUUID();
  await sql(
    "INSERT INTO sessions (id, mode, scope) VALUES ($1, 'agent', 'vex_studio')",
    [sessionId],
  );
  await sql(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, $2, $3, $3, 'restricted', $4, 1)`,
    [projectId, PROJECT_NAME, `race-${projectId.slice(0, 8)}`, sessionId],
  );
  // No wallet SELECTED (NULL ids) - the projection then resolves without
  // consulting the keystore, and the rows still exist, which is the whole point:
  // a soft delete leaves them behind.
  await sql(
    `INSERT INTO project_wallets (project_id, family, wallet_id, address)
     VALUES ($1, 'evm', NULL, NULL), ($1, 'solana', NULL, NULL)`,
    [projectId],
  );

  const url = process.env.VEX_DB_URL;
  if (url === undefined || url === "") throw new Error("VEX_DB_URL is not set");
  connectionA = new Client({ connectionString: url });
  await connectionA.connect();
});

afterEach(async () => {
  if (connectionA !== null) {
    try {
      await connectionA.query("ROLLBACK");
    } catch {
      // Already committed or rolled back; the connection is closing either way.
    }
    await connectionA.end();
    connectionA = null;
  }
  await sql("DELETE FROM project_wallets WHERE project_id = $1", [projectId]);
  await sql("DELETE FROM projects WHERE id = $1", [projectId]);
  await sql("DELETE FROM sessions WHERE id = $1", [sessionId]);
});

describe("readProjectPortfolioScope and a concurrent project delete", () => {
  it("still reports the wallets while the delete is UNCOMMITTED", async () => {
    const a = connectionA;
    if (a === null) throw new Error("connection A is not open");

    await a.query("BEGIN");
    await a.query(
      `UPDATE projects SET deleted_at = NOW(), cleanup_state = 'pending'
        WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );

    // Connection B, while A holds the transaction open. An uncommitted delete
    // is not a delete: the project is still authorized and the read must say so
    // rather than fail closed on work that may yet roll back.
    const scope = await readProjectPortfolioScope(projectId);
    expect(scope.kind).toBe("ok");

    await a.query("ROLLBACK");
  });

  it("fails closed with not_found the moment the delete COMMITS, while the wallet rows survive", async () => {
    const a = connectionA;
    if (a === null) throw new Error("connection A is not open");

    await a.query("BEGIN");
    await a.query(
      `UPDATE projects SET deleted_at = NOW(), cleanup_state = 'pending'
        WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    await a.query("COMMIT");

    // THE CONTROL. The soft delete preserved the wallet rows, and the old
    // shape's SECOND statement returns them for a project its FIRST statement
    // now calls gone. That divergence between two statements is precisely what
    // a delete committing in the gap used to hand back as a portfolio.
    const control = await readTheOldWay(projectId);
    expect(control.active).toBe(false);
    expect(control.walletRows).toBe(2);

    // THE PRODUCTION FUNCTION. One statement, one snapshot, one answer.
    const scope = await readProjectPortfolioScope(projectId);
    expect(scope.kind).toBe("not_found");
    // Never a wallet list, and never an empty-but-successful portfolio: those
    // are different states from "no such project" and rule 04 forbids
    // collapsing them.
    expect(scope).toEqual({ kind: "not_found" });
  });

  it("distinguishes an ACTIVE project with no wallet rows from a tombstoned one", async () => {
    // The LEFT JOIN LATERAL exists so these two do not collapse into the same
    // zero-row answer, which an inner join would have done.
    await sql("DELETE FROM project_wallets WHERE project_id = $1", [projectId]);

    const active = await readProjectPortfolioScope(projectId);
    expect(active.kind).toBe("missing_family");

    await sql(
      `UPDATE projects SET deleted_at = NOW(), cleanup_state = 'pending' WHERE id = $1`,
      [projectId],
    );
    const deleted = await readProjectPortfolioScope(projectId);
    expect(deleted.kind).toBe("not_found");
  });
});
