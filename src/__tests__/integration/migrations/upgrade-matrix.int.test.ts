/**
 * The upgrade matrix, on real PostgreSQL.
 *
 * WHAT THIS SUITE OWNS. Every shape of database a user's machine can present to
 * this build's migration runner, and the exact outcome each one must get:
 *
 *   fresh install                 -> applies everything, marker present
 *   populated pre-Lighter main (111) -> applies 112..end, audit records untouched
 *   older supported main (036)    -> same, from the oldest shipped release
 *   older supported main (094)    -> same, from the latest shipped release
 *   interrupted before 112        -> resumes at 112
 *   interrupted after 112         -> resumes after 112, marker already there
 *   ledger gap                    -> refused, nothing applied
 *   pre-release numeric-only DB   -> refused, nothing applied
 *   pre-release lineage-ledger DB -> refused, nothing applied
 *
 * "Older supported main" is pinned to the two ends of the shipped range:
 * v0.1.0, the oldest release (high-water migration 036), and v0.2.7, the latest
 * (high-water 094). ASSUMPTION, stated because it is a product decision and not
 * a repository fact: a user may start Vex from any released version, so both
 * ends must upgrade; versions between them are covered by the same forward
 * path and are not enumerated here.
 *
 * The main baseline comes from a CHECKED-IN fixture of main's exact filenames
 * and content hashes, not from the working tree: reading the tree would prove
 * only that the branch upgrades from itself. The first describe block is the
 * gate that keeps the fixture honest.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { describe, expect, it } from "vitest";
import {
  MigrationBranchEraDatabaseError,
  MigrationLedgerGapError,
  runMigrationsWithProgress,
} from "../../../lib/db/migrate-runner.js";

const SOURCE = path.resolve("src/vex-agent/db/migrations");
const ALL_FILES = readdirSync(SOURCE)
  .filter((file) => /^\d{3}_.*\.sql$/.test(file))
  .sort();

interface PinnedMigration {
  readonly file: string;
  readonly sha256: string;
}
interface MainBaselineFixture {
  readonly pinnedCommit: string;
  readonly migrationsPath: string;
  readonly files: ReadonlyArray<PinnedMigration>;
}

function readBaselineFixture(): MainBaselineFixture {
  const raw: unknown = JSON.parse(
    readFileSync(new URL("./fixtures/main-before-lighter.json", import.meta.url), "utf8")
  );
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as MainBaselineFixture).pinnedCommit !== "string" ||
    !Array.isArray((raw as MainBaselineFixture).files)
  ) {
    throw new Error("main-before-lighter.json is not a baseline fixture");
  }
  return raw as MainBaselineFixture;
}

const BASELINE = readBaselineFixture();
const MAIN_FILES = BASELINE.files.map(({ file }) => file);
/** main's high-water mark: the last version a released build ever applied. */
const MAIN_HIGH_WATER = Math.max(
  ...MAIN_FILES.map((file) => Number.parseInt(file.slice(0, 3), 10))
);
/** The first Lighter migration under this numbering: the positive marker. */
const MARKER_FILE = "112_lighter_schema_marker.sql";

function version(file: string): number {
  return Number.parseInt(file.slice(0, 3), 10);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Files a release with the given high-water mark carried. */
function mainFilesThrough(highWater: number): string[] {
  return MAIN_FILES.filter((file) => version(file) <= highWater);
}

async function withDatabase(
  run: (pool: pg.Pool, staging: string) => Promise<void>
): Promise<void> {
  const base = process.env.VEX_DB_URL;
  if (!base) throw new Error("The isolated PostgreSQL setup is required");
  const database = `upgrade_matrix_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: base });
  const staging = mkdtempSync(path.join(tmpdir(), "upgrade-matrix-"));
  let pool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    await run(pool, staging);
  } finally {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
    rmSync(staging, { recursive: true, force: true });
  }
}

function stage(files: readonly string[], staging: string): void {
  for (const file of files) {
    copyFileSync(path.join(SOURCE, file), path.join(staging, file));
  }
}

/**
 * Audit rows a real install carries across the upgrade and must not lose.
 *
 * `agent_activity` only exists from migration 044, so an older release's
 * database is seeded with what it can actually hold. The tables it does have
 * (001) still carry the user's approval decisions, which is the record the
 * upgrade must not disturb.
 */
async function seedAuditRecords(pool: pg.Pool, highWater: number): Promise<void> {
  await pool.query("INSERT INTO sessions (id) VALUES ('upgrade-session')");
  await pool.query(`INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id)
    VALUES ('upgrade-approval', '{}'::jsonb, 'retained decision', 'pending', 'upgrade-session')`);
  await pool.query(`INSERT INTO protocol_executions (id, tool_id, namespace, success)
    VALUES (9001, 'wallet.transaction', 'wallet', false)`);
  if (highWater < 44) return;
  await pool.query(`INSERT INTO agent_activity
    (protocol_execution_id, event_index, event_role, kind, protocol, chain_id, chain_family, wallet_address)
    VALUES
    (9001, 0, 'tx_contract_call', 'transaction', 'wallet', 1, 'eip155', '0x1111111111111111111111111111111111111111')`);
}

/**
 * Reads back exactly the records `seedAuditRecords` could write for this
 * baseline, so before and after are compared like for like. A release that
 * predates `agent_activity` cannot lose activity rows it never had.
 */
async function auditRecords(pool: pg.Pool, highWater: number): Promise<unknown> {
  return {
    approvals: (await pool.query("SELECT * FROM approval_queue ORDER BY id")).rows,
    executions: (await pool.query(
      "SELECT id, tool_id, namespace, success FROM protocol_executions ORDER BY id"
    )).rows,
    activity:
      highWater < 44
        ? null
        : (await pool.query("SELECT * FROM agent_activity ORDER BY id")).rows.map((row) => ({
            // Migration 157 extends historical rows with NULL lease fields.
            // Defaults apply only when the old schema lacks the columns; any
            // migrated non-NULL value still overrides them and fails equality.
            nonce_reservation_until: null,
            nonce_reservation_token: null,
            ...row,
          })),
  };
}

async function appliedVersions(pool: pg.Pool): Promise<number[]> {
  const rows = (
    await pool.query<{ version: number }>(
      "SELECT version FROM schema_version ORDER BY version"
    )
  ).rows;
  return rows.map(({ version: v }) => Number(v));
}

async function tableExists(pool: pg.Pool, table: string): Promise<boolean> {
  const rows = (
    await pool.query<{ name: string | null }>("SELECT to_regclass($1)::text AS name", [table])
  ).rows;
  return rows[0]?.name === table;
}

/**
 * The end state every admitted path must reach: the whole directory applied
 * exactly once, the marker holding its single row, the Lighter tables present
 * with the states and columns the execution path depends on, and a rerun that
 * does nothing.
 */
async function assertFullyUpgraded(pool: pg.Pool, staging: string): Promise<void> {
  expect(await appliedVersions(pool)).toEqual(ALL_FILES.map(version));

  expect((await pool.query(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_activity'
        AND column_name IN ('nonce_reservation_until', 'nonce_reservation_token')
      ORDER BY column_name`,
  )).rows).toEqual([
    { column_name: "nonce_reservation_token", data_type: "uuid", is_nullable: "YES", column_default: null },
    { column_name: "nonce_reservation_until", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
  ]);

  expect((await pool.query("SELECT lineage FROM lighter_schema_marker")).rows).toEqual([
    { lineage: "main-2026-09" },
  ]);

  for (const table of [
    "lighter_order_execution_intents",
    "lighter_onboarding_intents",
    "lighter_withdrawal_intents",
    "lighter_oco_execution_intents",
    "lighter_order_lifecycle_intents",
    "lighter_fee_authorization_intents",
  ]) {
    expect(await tableExists(pool, table)).toBe(true);
  }

  // Every table whose rows can be signed and then not sent carries the
  // send-attempt column: without it the execution path cannot tell "signed,
  // never sent" from "possibly sent", and would have to assume the worse of the
  // two on every consent expiry.
  for (const table of [
    "lighter_order_execution_intents",
    "lighter_oco_execution_intents",
    "lighter_order_lifecycle_intents",
    "lighter_withdrawal_intents",
    "lighter_fee_authorization_intents",
    // Key registration rows live on the onboarding table; manual claims have
    // their own. Both are signed and submitted on the same path.
    "lighter_onboarding_intents",
    "lighter_withdrawal_claim_attempts",
  ]) {
    const columns = (
      await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = $1 AND column_name = 'send_attempt_started_at'`,
        [table]
      )
    ).rows;
    expect(columns, `${table}.send_attempt_started_at`).toEqual([
      { column_name: "send_attempt_started_at" },
    ]);
  }

  // The consent-expiry state itself: a schema that cannot hold
  // `expired_unsubmitted` would force the execution path to record an order as
  // submitted that was never sent.
  for (const table of [
    "lighter_order_execution_intents",
    "lighter_oco_execution_intents",
    "lighter_order_lifecycle_intents",
    "lighter_withdrawal_intents",
    "lighter_fee_authorization_intents",
  ]) {
    const accepts = (
      await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'c'`,
        [table]
      )
    ).rows.some(({ definition }) => definition.includes("expired_unsubmitted"));
    expect(accepts, `${table} execution_state accepts expired_unsubmitted`).toBe(true);
  }

  expect(await runMigrationsWithProgress({ pool, migrationsDir: staging })).toEqual({
    applied: 0,
    files: [],
  });
}

describe("main baseline fixture gate", () => {
  it("pins every main migration this repository still carries, byte for byte", () => {
    const tree = new Map(
      readdirSync(SOURCE)
        .filter((file) => /^\d{3}_.*\.sql$/.test(file))
        .map((file) => [file, sha256(readFileSync(path.join(SOURCE, file)))])
    );

    const drifted = BASELINE.files
      .filter(({ file, sha256: pinned }) => tree.get(file) !== pinned)
      .map(({ file }) => file);
    expect(
      drifted,
      "a pinned main migration changed or disappeared; regenerate the fixture deliberately with " +
        "node src/__tests__/integration/migrations/fixtures/generate-main-migrations-fixture.mjs"
    ).toEqual([]);

    // Nothing may occupy main's numbering that main did not ship: the Lighter
    // range starts at 112, above main's high-water mark.
    const pinnedNames = new Set(MAIN_FILES);
    const intruders = [...tree.keys()]
      .filter((file) => version(file) <= MAIN_HIGH_WATER && !pinnedNames.has(file))
      .sort();
    expect(intruders).toEqual([]);
    expect(MAIN_HIGH_WATER).toBe(111);
    expect(ALL_FILES).toContain(MARKER_FILE);
  });

  const hasCommit = (rev: string): boolean => {
    try {
      execFileSync("git", ["cat-file", "-e", `${rev}^{commit}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };

  const listing = (rev: string): PinnedMigration[] =>
    execFileSync("git", ["ls-tree", "--name-only", rev, `${BASELINE.migrationsPath}/`], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line.endsWith(".sql"))
      .map((line) => path.posix.basename(line))
      .sort()
      .map((file) => ({
        file,
        sha256: sha256(
          execFileSync("git", ["show", `${rev}:${BASELINE.migrationsPath}/${file}`], {
            encoding: "buffer",
            maxBuffer: 32 * 1024 * 1024,
          })
        ),
      }));

  /**
   * The second half of the gate needs git history the studio-postgres CI job
   * does not fetch (it checks out without full depth), so each git-backed
   * assertion is skipped there rather than failing for a reason unrelated to
   * the change under test. The skip condition is evaluated at collection time
   * and shows up as a skipped test, never as a silent pass.
   */
  it.skipIf(!hasCommit(BASELINE.pinnedCommit))("matches the pinned commit", () => {
    expect(listing(BASELINE.pinnedCommit)).toEqual([...BASELINE.files]);
  });

  it.skipIf(!hasCommit("origin/main"))("main still carries the pinned baseline, byte for byte", () => {
    // Since the Lighter range landed on main (b3ff96641), main is a SUPERSET of
    // the baseline: the pre-Lighter release set plus 112 and up. Equality with
    // the fixture was the tripwire for the period the branch lived beside
    // main; what may never change now is the baseline itself - a pinned file
    // rewritten or removed, or a stranger occupying main's own numbering -
    // because that set is the database a released build hands this runner.
    const onMain = new Map(listing("origin/main").map(({ file, sha256: hash }) => [file, hash]));
    const drifted = BASELINE.files
      .filter(({ file, sha256: pinned }) => onMain.get(file) !== pinned)
      .map(({ file }) => file);
    expect(
      drifted,
      "origin/main rewrote or dropped a pinned baseline migration; if that was deliberate, refresh " +
        "the fixture with node src/__tests__/integration/migrations/fixtures/generate-main-migrations-fixture.mjs " +
        "and update PINNED_COMMIT"
    ).toEqual([]);
    const pinnedNames = new Set(MAIN_FILES);
    const intruders = [...onMain.keys()]
      .filter((file) => version(file) <= MAIN_HIGH_WATER && !pinnedNames.has(file))
      .sort();
    expect(intruders).toEqual([]);
  });
});

describe("upgrade matrix on real PostgreSQL", () => {
  it("installs fresh", async () => {
    await withDatabase(async (pool, staging) => {
      stage(ALL_FILES, staging);
      const result = await runMigrationsWithProgress({ pool, migrationsDir: staging });
      expect(result.files).toEqual([...ALL_FILES]);
      await assertFullyUpgraded(pool, staging);
    });
  }, 180_000);

  for (const [label, highWater] of [
    ["current main", 111],
    ["v0.2.7, the latest shipped release", 94],
    ["v0.1.0, the oldest shipped release", 36],
  ] as const) {
    it(`upgrades a populated ${label} without losing audit records`, async () => {
      await withDatabase(async (pool, staging) => {
        const baseline = mainFilesThrough(highWater);
        stage(baseline, staging);
        expect(
          (await runMigrationsWithProgress({ pool, migrationsDir: staging })).files
        ).toEqual(baseline);
        await seedAuditRecords(pool, highWater);
        const before = await auditRecords(pool, highWater);

        stage(ALL_FILES, staging);
        const result = await runMigrationsWithProgress({ pool, migrationsDir: staging });
        expect(result.files[0]).toBe(
          highWater === 111 ? MARKER_FILE : mainFilesThrough(111).filter((f) => version(f) > highWater)[0]
        );
        expect(result.files).toContain(MARKER_FILE);
        expect(result.files.at(-1)).toBe(ALL_FILES.at(-1));

        expect(await auditRecords(pool, highWater)).toEqual(before);
        await assertFullyUpgraded(pool, staging);
      });
    }, 180_000);
  }

  it("resumes an upgrade interrupted BEFORE the marker migration committed", async () => {
    await withDatabase(async (pool, staging) => {
      stage(MAIN_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await seedAuditRecords(pool, MAIN_HIGH_WATER);
      const before = await auditRecords(pool, MAIN_HIGH_WATER);

      stage(ALL_FILES, staging);
      await expect(
        runMigrationsWithProgress({
          pool,
          migrationsDir: staging,
          onProgress(event) {
            if (event.phase === "start" && event.file === MARKER_FILE) {
              throw new Error("interrupted before the marker");
            }
          },
        })
      ).rejects.toThrow("interrupted before the marker");

      // Nothing of the Lighter range landed, so the database is still an
      // ordinary main install: no marker, and the runner must not mistake it
      // for a pre-release database.
      expect(await tableExists(pool, "lighter_schema_marker")).toBe(false);
      expect(await appliedVersions(pool)).toEqual(MAIN_FILES.map(version));

      const resumed = await runMigrationsWithProgress({ pool, migrationsDir: staging });
      expect(resumed.files[0]).toBe(MARKER_FILE);
      expect(await auditRecords(pool, MAIN_HIGH_WATER)).toEqual(before);
      await assertFullyUpgraded(pool, staging);
    });
  }, 180_000);

  it("resumes an upgrade interrupted AFTER the marker migration committed", async () => {
    await withDatabase(async (pool, staging) => {
      stage(MAIN_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await seedAuditRecords(pool, MAIN_HIGH_WATER);
      const before = await auditRecords(pool, MAIN_HIGH_WATER);

      stage(ALL_FILES, staging);
      const crashAfter = ALL_FILES.filter((file) => version(file) > 112)[2];
      await expect(
        runMigrationsWithProgress({
          pool,
          migrationsDir: staging,
          onProgress(event) {
            if (event.phase === "applied" && event.file === crashAfter) {
              throw new Error("interrupted after the marker");
            }
          },
        })
      ).rejects.toThrow("interrupted after the marker");

      // The marker committed with its own migration, so the partial upgrade is
      // recognisable as this build's work and the resumed run is admitted.
      expect((await pool.query("SELECT lineage FROM lighter_schema_marker")).rows).toEqual([
        { lineage: "main-2026-09" },
      ]);
      expect(await appliedVersions(pool)).toContain(112);

      const resumed = await runMigrationsWithProgress({ pool, migrationsDir: staging });
      expect(resumed.files[0]).toBe(
        ALL_FILES[ALL_FILES.indexOf(crashAfter) + 1]
      );
      expect(await auditRecords(pool, MAIN_HIGH_WATER)).toEqual(before);
      await assertFullyUpgraded(pool, staging);
    });
  }, 180_000);
});

/**
 * The consent-expiry state is only useful if the database REFUSES the dishonest
 * version of it. `expired_unsubmitted` means "signing evidence retained,
 * submission never attempted"; a row claiming it while `send_attempt_started_at`
 * is set would assert exactly what the execution path cannot know. Proven here
 * against the real CHECK, on the table whose insert needs no order fixtures.
 */
describe("consent-expiry state on real PostgreSQL", () => {
  const insertFeeIntent = (
    pool: pg.Pool,
    state: string,
    txHash: string | null,
    sendAttemptStartedAt: string | null
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO lighter_fee_authorization_intents
         (intent_id, session_id, environment, wallet_address, account_index, api_key_index,
          terms_json, approval_status, execution_state, tx_hash, send_attempt_started_at, expires_at)
       VALUES ('fee-1', 'expiry-session', 'core', $1, 42, 7, '{}'::jsonb, 'approved', $2, $3, $4, now() + interval '1 hour')`,
      [`0x${"1".repeat(40)}`, state, txHash, sendAttemptStartedAt]
    );

  it("accepts a truthful expired_unsubmitted row and refuses one that started a send", async () => {
    await withDatabase(async (pool, staging) => {
      stage(ALL_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await pool.query("INSERT INTO sessions (id) VALUES ('expiry-session')");

      // Signed, never sent: the row the expiry path must be able to write.
      await insertFeeIntent(pool, "expired_unsubmitted", "0xabc", null);
      expect(
        (
          await pool.query<{ execution_state: string }>(
            "SELECT execution_state FROM lighter_fee_authorization_intents"
          )
        ).rows
      ).toEqual([{ execution_state: "expired_unsubmitted" }]);

      await pool.query("DELETE FROM lighter_fee_authorization_intents");

      // A send attempt was started: the state is a lie and the database says so.
      await expect(
        insertFeeIntent(pool, "expired_unsubmitted", "0xabc", "2026-09-07T00:00:00Z")
      ).rejects.toMatchObject({ code: "23514" });

      // No signing evidence at all is equally refused: the state promises the
      // evidence was retained.
      await expect(
        insertFeeIntent(pool, "expired_unsubmitted", null, null)
      ).rejects.toMatchObject({ code: "23514" });
    });
  }, 180_000);

  it("frees the one-live-authorization slot once an intent expires unsubmitted", async () => {
    await withDatabase(async (pool, staging) => {
      stage(ALL_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await pool.query("INSERT INTO sessions (id) VALUES ('expiry-session')");
      await insertFeeIntent(pool, "expired_unsubmitted", "0xabc", null);

      // A terminal state must not hold the partial unique index hostage, or the
      // user could never authorize fees again after one consent expiry.
      await pool.query(
        `INSERT INTO lighter_fee_authorization_intents
           (intent_id, session_id, environment, wallet_address, account_index, api_key_index,
            terms_json, approval_status, execution_state, expires_at)
         VALUES ('fee-2', 'expiry-session', 'core', $1, 42, 7, '{}'::jsonb, 'approval_pending',
                 'approval_pending', now() + interval '1 hour')`,
        [`0x${"1".repeat(40)}`]
      );
      expect(
        (await pool.query("SELECT intent_id FROM lighter_fee_authorization_intents ORDER BY intent_id")).rows
      ).toEqual([{ intent_id: "fee-1" }, { intent_id: "fee-2" }]);
    });
  }, 180_000);
});

describe("upgrade matrix refusals on real PostgreSQL", () => {
  it("refuses a genuine ledger gap and applies nothing", async () => {
    await withDatabase(async (pool, staging) => {
      stage(ALL_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      const skipped = ALL_FILES.at(-2);
      if (skipped === undefined) throw new Error("expected at least two migrations");
      await pool.query("DELETE FROM schema_version WHERE version = $1", [version(skipped)]);
      const before = await appliedVersions(pool);

      await expect(
        runMigrationsWithProgress({ pool, migrationsDir: staging })
      ).rejects.toBeInstanceOf(MigrationLedgerGapError);

      // The refusal is a precondition, not a partial run.
      expect(await appliedVersions(pool)).toEqual(before);
    });
  }, 180_000);

  /**
   * A pre-release developer database: the Lighter migrations ran at 079..120,
   * numbers this build assigns to other files, so `schema_version` says 120 and
   * the tables it names are not the ones this build's 120 creates. Both branch
   * ledger shapes are exercised: numeric-only (runners before 9e81d5d85) and
   * the lineage tables (after 6479316ff).
   */
  for (const lineageLedger of [false, true]) {
    it(`refuses a pre-release database with a ${lineageLedger ? "lineage-table" : "numeric-only"} ledger`, async () => {
      await withDatabase(async (pool, staging) => {
        stage(mainFilesThrough(78), staging);
        await runMigrationsWithProgress({ pool, migrationsDir: staging });

        // The observable shape a branch build left behind: Lighter tables that
        // no run of THIS build could have created, and a ledger claiming 120.
        await pool.query("CREATE TABLE lighter_nonce_state (id TEXT PRIMARY KEY)");
        await pool.query("CREATE TABLE lighter_order_execution_intents (id TEXT PRIMARY KEY)");
        for (let v = 79; v <= 120; v += 1) {
          await pool.query("INSERT INTO schema_version (version) VALUES ($1)", [v]);
        }
        if (lineageLedger) {
          await pool.query(
            "CREATE TABLE schema_migration_files (file TEXT PRIMARY KEY, version INTEGER NOT NULL)"
          );
          await pool.query("CREATE TABLE schema_migration_baseline (version INTEGER PRIMARY KEY)");
        }
        const before = await appliedVersions(pool);

        stage(ALL_FILES, staging);
        try {
          await runMigrationsWithProgress({ pool, migrationsDir: staging });
          expect.fail("should have refused a pre-release database");
        } catch (err: unknown) {
          expect(err).toBeInstanceOf(MigrationBranchEraDatabaseError);
          const refusal = err as MigrationBranchEraDatabaseError;
          expect(refusal.reason).toBe(
            lineageLedger ? "lineage_tables" : "unmarked_lighter_tables"
          );
          // The user is told what to do, and told Vex will not do it for them.
          expect(refusal.message).toContain("back up");
          expect(refusal.message).toContain("recreate the local Vex database");
          expect(refusal.message).toContain("never delete or convert");
        }

        // Refused without touching the database it refused.
        expect(await appliedVersions(pool)).toEqual(before);
        expect(await tableExists(pool, "lighter_schema_marker")).toBe(false);
      });
    }, 180_000);
  }

  it("refuses a database whose marker does not hold exactly the expected row", async () => {
    await withDatabase(async (pool, staging) => {
      stage(ALL_FILES, staging);
      await runMigrationsWithProgress({ pool, migrationsDir: staging });
      await pool.query("INSERT INTO lighter_schema_marker (lineage) VALUES ('tampered')");

      await expect(
        runMigrationsWithProgress({ pool, migrationsDir: staging })
      ).rejects.toMatchObject({
        name: "MigrationBranchEraDatabaseError",
        reason: "unexpected_marker",
      });
    });
  }, 180_000);
});
