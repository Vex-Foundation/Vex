/**
 * Integration: the Vex Studio PER-CALL SCOPE SNAPSHOT against a racing scope
 * edit, on TWO REAL POSTGRES CONNECTIONS (stage A4a, spec item 2).
 *
 * The property under test cannot be proven with a scripted client, because it
 * is a statement about what PostgreSQL does when two transactions interleave:
 *
 *   A Studio call loads the project's permission, `scope_version` and wallet
 *   selection while the user is editing exactly those fields. The call must
 *   observe ONE committed version of all of them. It may see version N, it may
 *   see version N+1, and there is no third answer: it must never pair N's
 *   permission with N+1's wallets, because that pairing is an authorization
 *   the user never granted - the old permission (which decides whether the
 *   Vex approval card fires at all) together with the new signing key.
 *
 * That is why `scope-snapshot-query.ts` is ONE statement and not the two
 * queries `database/projects/read.ts` uses for display reads. This file runs
 * the PRODUCTION statement text, read out of that module (see
 * `readProductionSql` below), against an edit transaction shaped exactly like
 * `updateProjectScope`'s: permission, wallets and `scope_version` bumped
 * together, committed as one unit.
 *
 * The second connection is not decoration. The reader is deliberately opened
 * and held while the writer's transaction is open and uncommitted, so the
 * statement really is evaluated across the commit boundary rather than
 * comfortably before or after it.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeEach } from "vitest";

import type { PoolClient } from "pg";

import { execute, getPool } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/**
 * The PRODUCTION statement text, read out of its owning module at run time.
 *
 * Not imported, and not copied. Not imported because the module belongs to the
 * desktop app package and this lane's TypeScript project is rooted at `src/`;
 * an import across that line is a `rootDir` violation the repository's test
 * type ratchet correctly refuses. Not copied because a copy proves a property
 * of the copy: the statement could change in production and this file would go
 * on passing.
 *
 * So the text is EXTRACTED from the source, and the extraction is asserted
 * before it is used. If `scope-snapshot-query.ts` moves, is renamed, or stops
 * declaring `SCOPE_SNAPSHOT_SQL` as a single template literal, this file fails
 * loudly rather than falling back to something it made up.
 */
const QUERY_MODULE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../vex-app/src/main/database/projects/scope-snapshot-query.ts",
);

function readProductionSql(): string {
  const source = readFileSync(QUERY_MODULE_PATH, "utf8");
  const match = /export const SCOPE_SNAPSHOT_SQL = `([^`]*)`;/.exec(source);
  if (match === null) {
    throw new Error(
      `could not find SCOPE_SNAPSHOT_SQL in ${QUERY_MODULE_PATH}. `
        + "The per-call scope snapshot statement moved or changed shape; point this "
        + "test at its new owner rather than pasting the SQL here.",
    );
  }
  return match[1] as string;
}

const SCOPE_SNAPSHOT_SQL = readProductionSql();

/**
 * The row shape `json_agg` produces. Declared locally because it is only how
 * this test reads the result; the production narrowing lives beside the module
 * that owns the query.
 */
interface ScopeSnapshotRow {
  id: string;
  permission: string;
  backing_session_id: string;
  scope_version: number;
  wallets: ReadonlyArray<{ family: unknown; wallet_id: unknown; address: unknown }>;
}

const OLD_EVM = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW_EVM = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A project at version 1: `full`, one EVM selection, no Solana selection. */
async function seedProject(sessionId: string): Promise<string> {
  const projectId = randomUUID();
  await execute(
    `INSERT INTO studio_settings (id, projects_root)
     VALUES (1, '/tmp/vex-projects') ON CONFLICT (id) DO NOTHING`,
  );
  await execute(
    `INSERT INTO projects (id, name, slug, root_path, permission,
                           backing_session_id, scope_version)
     VALUES ($1, 'Race', $2, $2, 'full', $3, 1)`,
    [projectId, `p-${projectId.slice(0, 8)}`, sessionId],
  );
  await execute(
    `INSERT INTO project_wallets (project_id, family, wallet_id, address)
     VALUES ($1, 'evm', 'w-old', $2), ($1, 'solana', NULL, NULL)`,
    [projectId, OLD_EVM],
  );
  return projectId;
}

interface ObservedScope {
  readonly permission: string;
  readonly scopeVersion: number;
  readonly evmWalletId: string | null;
  readonly evmAddress: string | null;
}

/** Run the production statement on `client` and flatten what it returned. */
async function observe(
  client: PoolClient,
  projectId: string,
): Promise<ObservedScope> {
  const result = await client.query<ScopeSnapshotRow>(SCOPE_SNAPSHOT_SQL, [projectId]);
  const row = result.rows[0];
  expect(row).toBeDefined();
  if (row === undefined) throw new Error("unreachable");
  const evm = row.wallets.find((w) => w.family === "evm");
  return {
    permission: row.permission,
    scopeVersion: row.scope_version,
    evmWalletId: typeof evm?.wallet_id === "string" ? evm.wallet_id : null,
    evmAddress: typeof evm?.address === "string" ? evm.address : null,
  };
}

/**
 * Exactly ONE of the two committed versions, never a blend. This is the
 * assertion the whole file exists for.
 */
function expectCoherent(observed: ObservedScope): void {
  if (observed.scopeVersion === 1) {
    expect(observed.permission).toBe("full");
    expect(observed.evmWalletId).toBe("w-old");
    expect(observed.evmAddress).toBe(OLD_EVM);
    return;
  }
  expect(observed.scopeVersion).toBe(2);
  expect(observed.permission).toBe("restricted");
  expect(observed.evmWalletId).toBe("w-new");
  expect(observed.evmAddress).toBe(NEW_EVM);
}

beforeEach(async () => {
  await resetDb();
});

describe("the statement under test is the production one", () => {
  it("extracted a single joined statement from its owning module", () => {
    // The guard on the extraction: a silent failure here would leave every
    // assertion below testing nothing.
    expect(SCOPE_SNAPSHOT_SQL).toContain("FROM projects p");
    expect(SCOPE_SNAPSHOT_SQL).toContain("LEFT JOIN project_wallets w");
    expect(SCOPE_SNAPSHOT_SQL).toContain("json_agg");
    // ONE statement: no semicolon splitting it, and no transaction control.
    expect(SCOPE_SNAPSHOT_SQL).not.toContain(";");
    expect(SCOPE_SNAPSHOT_SQL.toUpperCase()).not.toContain("BEGIN");
    expect(SCOPE_SNAPSHOT_SQL.match(/\bSELECT\b/g)).toHaveLength(1);
  });
});

describe("the per-call scope snapshot never mixes two scope versions", () => {
  it("reads only version N while the edit to N+1 is uncommitted", async () => {
    const projectId = await seedProject(await makeSession());
    const writer = await getPool().connect();
    const reader = await getPool().connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `UPDATE projects SET permission = 'restricted', scope_version = 2
          WHERE id = $1`,
        [projectId],
      );
      await writer.query(
        `UPDATE project_wallets SET wallet_id = 'w-new', address = $2
          WHERE project_id = $1 AND family = 'evm'`,
        [projectId, NEW_EVM],
      );

      // The edit is open, not committed. A reader on its own connection must
      // see the whole OLD version: this is the "call admitted under N runs
      // under N" half of the linearization guarantee.
      const observed = await observe(reader, projectId);
      expect(observed.scopeVersion).toBe(1);
      expectCoherent(observed);

      await writer.query("COMMIT");
    } finally {
      writer.release();
      reader.release();
    }
  });

  it("reads only version N+1 once the edit commits", async () => {
    const projectId = await seedProject(await makeSession());
    const writer = await getPool().connect();
    const reader = await getPool().connect();
    try {
      await writer.query("BEGIN");
      await writer.query(
        `UPDATE projects SET permission = 'restricted', scope_version = 2
          WHERE id = $1`,
        [projectId],
      );
      await writer.query(
        `UPDATE project_wallets SET wallet_id = 'w-new', address = $2
          WHERE project_id = $1 AND family = 'evm'`,
        [projectId, NEW_EVM],
      );
      await writer.query("COMMIT");

      const observed = await observe(reader, projectId);
      expect(observed.scopeVersion).toBe(2);
      expectCoherent(observed);
    } finally {
      writer.release();
      reader.release();
    }
  });

  /**
   * The RACE itself: the snapshot statement is issued on one connection while
   * the edit commits on another, with no ordering between them. Repeated,
   * because a single pass can miss the interleaving that matters; every pass
   * must land on one coherent version.
   */
  it("never blends the two versions when the read races the commit", async () => {
    const writer = await getPool().connect();
    const reader = await getPool().connect();
    try {
      for (let attempt = 0; attempt < 25; attempt++) {
        await resetDb();
        const projectId = await seedProject(await makeSession());

        const commit = (async () => {
          await writer.query("BEGIN");
          await writer.query(
            `UPDATE projects SET permission = 'restricted', scope_version = 2
              WHERE id = $1`,
            [projectId],
          );
          await writer.query(
            `UPDATE project_wallets SET wallet_id = 'w-new', address = $2
              WHERE project_id = $1 AND family = 'evm'`,
            [projectId, NEW_EVM],
          );
          await writer.query("COMMIT");
        })();

        const [observed] = await Promise.all([observe(reader, projectId), commit]);
        // The whole point: permission, version and wallets always agree. A
        // two-statement read is what could return `full` plus `w-new` here,
        // which is the old approval policy holding the new signing key.
        expectCoherent(observed);
      }
    } finally {
      writer.release();
      reader.release();
    }
  });
});
