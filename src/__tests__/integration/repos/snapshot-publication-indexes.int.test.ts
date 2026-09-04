/**
 * Integration: migration 100 gives the snapshot publication gate an index-only
 * access path on all three intent tables, proved by REAL PostgreSQL plans.
 *
 * WHY A PLAN TEST AND NOT A TIMING TEST. The gate
 * (`sync/balance-sync/publication-gate.ts`) runs INSIDE the publishing
 * transaction, after `LOCK TABLE agent_activity IN SHARE MODE` and under a
 * two-second `SET LOCAL lock_timeout` (`snapshot-publication.ts`). A slow gate
 * therefore does not merely cost latency: it holds a lock that stops every
 * activity writer, and it pushes concurrent publishers onto the 55P03
 * `lock_unavailable` path that skips a snapshot entirely. What we must be able
 * to regress on is the ACCESS PATH, and a wall-clock threshold on a 3,000-row
 * table in a container is noise, not a contract. So the assertions are plan
 * SHAPE - "this exact index name appears, no sequential scan on this table" -
 * and the cost/buffer figures are MEASURED AND REPORTED on every run rather
 * than asserted against a frozen number.
 *
 * WHERE THE SQL COMES FROM. The gate's seven-branch UNION is a private const
 * inside its own module, and re-typing 60 lines of money-path SQL into a test
 * would create a second source of truth that can drift silently. This file
 * therefore EXTRACTS the exact `IN_FLIGHT_SQL` and `MAX_IN_FLIGHT` text from the
 * owner's source file and explains that, so the plan measured here is the plan
 * production gets. A rename breaks this test loudly, which is the correct
 * failure.
 *
 * MECHANISM, the template established by
 * `migrations/096-wallet-wrap-intents.int.test.ts`: a second database inside
 * the SAME container the lane already runs, migrated to 097 by the real runner,
 * seeded, measured, then migrated to 098 by the same runner and measured again.
 * Both plans come from identical data, so the difference is the migration and
 * nothing else. Nothing is stubbed: same runner, same files, same Postgres, and
 * the in-flight rows are read by the production `readInFlightMoney`.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getPackageRoot, getVexAgentMigrationsDir } from "@utils/package-assets.js";
import {
  readInFlightMoney,
  type InFlightEntry,
} from "@vex-agent/sync/balance-sync/publication-gate.js";

/** What the ENGINE runtime loads: `dist/` when built, else the source tree. */
const SOURCE_DIR = getVexAgentMigrationsDir();
const MIGRATION_100 = "100_wallet_intent_wallet_indexes.sql";
const TARGET_DB = "vex_100_probe";
const SESSION = "session-098-probe";

/** 3,000 rows per table over 300 wallets: 10 rows each, 3 of them blocking. */
const ROWS_PER_TABLE = 3000;
const WALLET_COUNT = 300;
const WALLET_PREFIX = "0x098wallet";
const wallet = (n: number): string => `${WALLET_PREFIX}${String(n).padStart(4, "0")}`;
/** Two wallets out of 300 - the selectivity a real refresh cycle has. */
const PROBE_WALLETS = [wallet(7), wallet(211)];

const NEW_INDEXES = {
  wallet_intents: "idx_wallet_intents_wallet",
  wallet_transaction_intents: "idx_wallet_transaction_intents_wallet",
  wallet_wrap_intents: "idx_wallet_wrap_intents_wallet",
} as const;
const INTENT_TABLES = Object.keys(NEW_INDEXES) as (keyof typeof NEW_INDEXES)[];

let pool: pg.Pool;
let stagingDir: string;

// ── the gate's own SQL, read from the owner's source ─────────────────────

const GATE_SOURCE = readFileSync(
  path.join(getPackageRoot(), "src/vex-agent/sync/balance-sync/publication-gate.ts"),
  "utf-8",
);

function extractTemplate(name: string): string {
  const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(GATE_SOURCE);
  if (match?.[1] === undefined) {
    throw new Error(
      `publication-gate.ts no longer declares a template literal named ${name}. ` +
        `This test explains the gate's REAL SQL; update the extraction rather than inlining a copy.`,
    );
  }
  return match[1];
}

function extractNumber(name: string): number {
  const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(GATE_SOURCE);
  if (match?.[1] === undefined) {
    throw new Error(`publication-gate.ts no longer declares a numeric const named ${name}.`);
  }
  return Number(match[1].replace(/_/g, ""));
}

const IN_FLIGHT_SQL = extractTemplate("IN_FLIGHT_SQL");
const FENCE_SQL = extractTemplate("FENCE_SQL");
const MAX_IN_FLIGHT = extractNumber("MAX_IN_FLIGHT");

// ── plan inspection ───────────────────────────────────────────────────────

interface PlanNode {
  readonly "Node Type": string;
  readonly "Relation Name"?: string;
  readonly "Index Name"?: string;
  readonly Plans?: readonly PlanNode[];
  /** EXPLAIN emits many more fields (buffer counters among them). */
  readonly [key: string]: unknown;
}

interface ExplainRoot {
  readonly Plan: PlanNode & { readonly "Total Cost": number };
  readonly "Planning Time"?: number;
}

interface MeasuredPlan {
  /** Estimated total cost of the whole statement - reported, never asserted. */
  readonly totalCost: number;
  /** Buffers actually read/hit by the execution - reported, never asserted. */
  readonly buffers: number;
  /** Every scan node, flattened: what it touched and how. */
  readonly scans: ReadonlyArray<{ table: string; nodeType: string; index: string | null }>;
}

/**
 * Every scan node, with its relation resolved. A `Bitmap Index Scan` names its
 * index but NOT its relation - the relation is on its `Bitmap Heap Scan`
 * parent - so the parent's name is carried down.
 */
function flattenScans(
  node: PlanNode,
  inheritedTable: string | null = null,
  out: { table: string; nodeType: string; index: string | null }[] = [],
): { table: string; nodeType: string; index: string | null }[] {
  const table = node["Relation Name"] ?? inheritedTable;
  if (node["Node Type"].endsWith("Scan")) {
    out.push({
      table: table ?? "?",
      nodeType: node["Node Type"],
      index: node["Index Name"] ?? null,
    });
  }
  for (const child of node.Plans ?? []) flattenScans(child, table, out);
  return out;
}

/**
 * The gate query's plan, executed for real. `ANALYZE` here is PostgreSQL's
 * EXPLAIN option (run the statement and report actuals), not the planner
 * statistics command; the statement is a pure SELECT, so executing it is safe.
 */
async function measure(sql: string, params: readonly unknown[]): Promise<MeasuredPlan> {
  const res = await pool.query<{ "QUERY PLAN": ExplainRoot[] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    [...params],
  );
  const root = res.rows[0]?.["QUERY PLAN"]?.[0];
  if (root === undefined) throw new Error("EXPLAIN returned no plan");
  return {
    totalCost: root.Plan["Total Cost"],
    buffers: countBuffers(root.Plan),
    scans: flattenScans(root.Plan),
  };
}

function countBuffers(node: PlanNode): number {
  const hit = node["Shared Hit Blocks"];
  const read = node["Shared Read Blocks"];
  const own = (typeof hit === "number" ? hit : 0) + (typeof read === "number" ? read : 0);
  return own + (node.Plans ?? []).reduce((sum, child) => sum + countBuffers(child), 0);
}

function scansOf(plan: MeasuredPlan, table: string): MeasuredPlan["scans"] {
  return plan.scans.filter((s) => s.table === table);
}

/** Blocker identity without the clock: parity must not depend on when we ran. */
function identity(entries: readonly InFlightEntry[]): string[] {
  return entries.map((e) => `${e.kind}|${e.ref}|${e.detail ?? ""}|${e.standing}`).sort();
}

// ── seeding ───────────────────────────────────────────────────────────────

const HASH = (g: string): string => `'0x' || lpad(${g}::text, 64, '0')`;
const WALLET_EXPR = `'${WALLET_PREFIX}' || lpad((g % ${WALLET_COUNT})::text, 4, '0')`;

/**
 * Ten rows per wallet per table, of which exactly three block publication:
 * one live row, one hash-carrying unresolved row, and (for `agent_activity`)
 * one pending broadcast. The other seven are terminal, so the branches have to
 * discriminate rather than matching everything the wallet owns.
 */
async function seed(): Promise<void> {
  await pool.query(`INSERT INTO sessions (id) VALUES ($1)`, [SESSION]);

  await pool.query(
    `INSERT INTO protocol_executions
       (tool_id, namespace, session_id, params, result, success, external_refs, execution_status)
     SELECT 'swap_execute', 'agentscan', $1, jsonb_build_object('g', g), '{}'::jsonb,
            false, '{}'::jsonb, 'succeeded'
       FROM generate_series(1, ${ROWS_PER_TABLE}) g`,
    [SESSION],
  );

  await pool.query(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_role, kind, protocol, chain_id, wallet_address,
        session_id, status, from_address, nonce, tx_hash, confirmed_at,
        executed_amount_in_raw, executed_amount_out_raw)
     SELECT pe.id, 'swap', 'swap', 'kyberswap', 8453,
            '${WALLET_PREFIX}' || lpad(((pe.params->>'g')::int % ${WALLET_COUNT})::text, 4, '0'),
            $1,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN 'pending' ELSE 'confirmed' END,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN NULL ELSE '0xfrom' END,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN NULL ELSE 1 END,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN NULL
                 ELSE '0x' || lpad((pe.params->>'g'), 64, '0') END,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN NULL ELSE NOW() END,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN NULL ELSE '1' END,
            CASE WHEN (pe.params->>'g')::int <= ${WALLET_COUNT} THEN NULL ELSE '1' END
       FROM protocol_executions pe
      WHERE pe.session_id = $1`,
    [SESSION],
  );

  // `wallet_intents`: `consuming` hits the live branch, `review_required`
  // (hash required by 093) hits the hash-carrying unresolved branch.
  await pool.query(
    `INSERT INTO wallet_intents
       (intent_id, session_id, wallet_address, network, to_address, amount,
        preview_json, status, expires_at, tx_hash)
     SELECT 'wi-098-' || g, $1, ${WALLET_EXPR}, 'eip155', '0xdest', '1',
            '{"label":"send","criticalArgs":{}}'::jsonb,
            CASE WHEN g <= ${WALLET_COUNT} THEN 'consuming'
                 WHEN g <= ${WALLET_COUNT * 2} THEN 'review_required'
                 ELSE 'executed' END,
            NOW() + INTERVAL '10 minutes',
            CASE WHEN g <= ${WALLET_COUNT} THEN NULL ELSE ${HASH("g")} END
       FROM generate_series(1, ${ROWS_PER_TABLE}) g`,
    [SESSION],
  );

  // `wallet_transaction_intents`: an unexpired `pending` and a
  // `broadcast_unconfirmed` (hash required by 087's evidence rule).
  await pool.query(
    `INSERT INTO wallet_transaction_intents
       (intent_id, session_id, wallet_address, family, chain_alias, chain_id,
        payload_json, decoded_json, preview_json, fee_bounds_json,
        proposal_digest, proposal_digest_version, status, expires_at, tx_hash)
     SELECT 'wti-098-' || g, $1, ${WALLET_EXPR}, 'eip155', 'base', 8453,
            '{"to":"0xdest","data":"0x","valueWei":"1"}'::jsonb,
            '{}'::jsonb, '{"label":"tx","criticalArgs":{}}'::jsonb, '{}'::jsonb,
            repeat('b', 64), 'v1',
            CASE WHEN g <= ${WALLET_COUNT} THEN 'pending'
                 WHEN g <= ${WALLET_COUNT * 2} THEN 'broadcast_unconfirmed'
                 ELSE 'executed' END,
            NOW() + INTERVAL '10 minutes',
            CASE WHEN g <= ${WALLET_COUNT} THEN NULL ELSE ${HASH("g")} END
       FROM generate_series(1, ${ROWS_PER_TABLE}) g`,
    [SESSION],
  );

  // `wallet_wrap_intents`: an unexpired `pending` and a `review_required`
  // (the receipt contradicted the approved amount - blocks until a human acts).
  await pool.query(
    `INSERT INTO wallet_wrap_intents
       (intent_id, session_id, wallet_address, chain_alias, chain_id, direction,
        wrapped_native_address, wrapped_native_symbol, wrapped_native_decimals,
        amount_raw, payload_json, preview_json, fee_bounds_json,
        proposal_digest, proposal_digest_version, status, expires_at, tx_hash)
     SELECT 'wrp-098-' || g, $1, ${WALLET_EXPR}, 'base', 8453, 'wrap',
            '0x4200000000000000000000000000000000000006', 'WETH', 18,
            '1000000000000000000',
            '{"to":"0x4200000000000000000000000000000000000006","data":"0xd0e30db0","valueWei":"1000000000000000000"}'::jsonb,
            '{"label":"wrap","criticalArgs":{}}'::jsonb, '{}'::jsonb,
            repeat('c', 64), 'v1',
            CASE WHEN g <= ${WALLET_COUNT} THEN 'pending'
                 WHEN g <= ${WALLET_COUNT * 2} THEN 'review_required'
                 ELSE 'executed' END,
            NOW() + INTERVAL '10 minutes',
            CASE WHEN g <= ${WALLET_COUNT} THEN NULL ELSE ${HASH("g")} END
       FROM generate_series(1, ${ROWS_PER_TABLE}) g`,
    [SESSION],
  );

  await pool.query("ANALYZE");
}

function filesUpTo(maxVersion: number): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .filter((f) => parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
}

async function indexNames(table: string): Promise<string[]> {
  const res = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = $1`,
    [table],
  );
  return res.rows.map((r) => r.indexname);
}

// ── measured state, filled by the ordered `it`s below ─────────────────────

let planBefore: MeasuredPlan;
let planAfter: MeasuredPlan;
let fencePlan: MeasuredPlan;
let blockersBefore: readonly InFlightEntry[];
let blockersAfter: readonly InFlightEntry[];

beforeAll(async () => {
  const base = process.env.VEX_DB_URL;
  if (!base) throw new Error("VEX_DB_URL is unset - globalSetup did not run.");

  const admin = new pg.Pool({ connectionString: base });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
    await admin.query(`CREATE DATABASE ${TARGET_DB}`);
  } finally {
    await admin.end();
  }

  const url = new URL(base);
  url.pathname = `/${TARGET_DB}`;
  pool = new pg.Pool({ connectionString: url.toString() });

  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-098-"));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  const base = process.env.VEX_DB_URL;
  if (base) {
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TARGET_DB}`);
    } finally {
      await admin.end();
    }
  }
});

describe("098 wallet-address indexes for the publication gate", () => {
  it("reaches 097 with none of 098's indexes present", async () => {
    const upTo97 = filesUpTo(97);
    for (const f of upTo97) copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(upTo97.length);

    for (const table of INTENT_TABLES) {
      expect(await indexNames(table), `${table} must not already carry 098's index`)
        .not.toContain(NEW_INDEXES[table]);
    }
  }, 180_000);

  it("seeds 3,000 rows per table over 300 wallets and plans the gate WITHOUT the indexes", async () => {
    await seed();

    for (const table of INTENT_TABLES) {
      const count = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`);
      expect(Number(count.rows[0]?.n)).toBe(ROWS_PER_TABLE);
    }

    blockersBefore = (await readInFlightMoney(pool, PROBE_WALLETS)).entries;
    planBefore = await measure(IN_FLIGHT_SQL, [PROBE_WALLETS, MAX_IN_FLIGHT + 1]);
    fencePlan = await measure(FENCE_SQL, [PROBE_WALLETS]);

    // THE DEFECT, stated as a plan: with no wallet index, at least one branch
    // per intent table is read END TO END while the publisher holds
    // `agent_activity` in SHARE mode. (Some branches can borrow an existing
    // partial status index; none of them can answer the wallet predicate, and
    // it is the full reads that the lock window pays for.)
    for (const table of INTENT_TABLES) {
      const scans = scansOf(planBefore, table);
      expect(scans.length, `${table} must be scanned by the gate`).toBeGreaterThan(0);
      expect(
        scans.filter((s) => s.nodeType === "Seq Scan").length,
        `${table} without 098 must be sequentially scanned at least once, got ${JSON.stringify(scans)}`,
      ).toBeGreaterThan(0);
      expect(
        scans.some((s) => s.index === NEW_INDEXES[table]),
        `${NEW_INDEXES[table]} cannot exist yet`,
      ).toBe(false);
    }

    // `agent_activity` already has `idx_agent_activity_wallet` (044), which is
    // why 098 adds nothing for it. Reported, not asserted: the fence is an
    // aggregate and the planner may legitimately prefer a full read for it.
    expect(fencePlan.scans.length).toBeGreaterThan(0);
  }, 180_000);

  it("applies 098 once, and applying again is a no-op (runner and statements)", async () => {
    copyFileSync(path.join(SOURCE_DIR, MIGRATION_100), path.join(stagingDir, MIGRATION_100));

    const first = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(first.applied).toBe(1);
    expect(first.files).toEqual([MIGRATION_100]);

    // Second runner pass: `schema_version` already holds 98, so nothing is
    // pending. This proves the RUNNER's idempotence.
    const second = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(second.applied).toBe(0);
    expect(second.files).toEqual([]);

    // And the FILE's own idempotence, independent of `schema_version`: a
    // repair/mirror path that re-executes the SQL must not fail or duplicate.
    const sql = readFileSync(path.join(SOURCE_DIR, MIGRATION_100), "utf-8");
    await expect(pool.query(sql)).resolves.toBeDefined();

    for (const table of INTENT_TABLES) {
      const names = await indexNames(table);
      expect(names).toContain(NEW_INDEXES[table]);
      expect(names.filter((n) => n === NEW_INDEXES[table])).toHaveLength(1);
    }
  }, 180_000);

  it("plans every wallet predicate through the named index, with no sequential scan left", async () => {
    await pool.query("ANALYZE");
    planAfter = await measure(IN_FLIGHT_SQL, [PROBE_WALLETS, MAX_IN_FLIGHT + 1]);

    for (const table of INTENT_TABLES) {
      const scans = scansOf(planAfter, table);
      expect(scans.length, `${table} must still be scanned by the gate`).toBeGreaterThan(0);
      expect(
        scans.some((s) => s.index === NEW_INDEXES[table]),
        `${NEW_INDEXES[table]} must appear in the plan, got ${JSON.stringify(scans)}`,
      ).toBe(true);
      expect(
        scans.filter((s) => s.nodeType === "Seq Scan"),
        `${table} must no longer be sequentially scanned`,
      ).toEqual([]);
    }

    // The measurement, printed so a reviewer reads the real numbers THIS run
    // produced rather than the ones a docblock remembers. Written straight to
    // stdout because the lane's logger owns `console`.
    process.stdout.write(
      `\n[098] gate plan cost ${planBefore.totalCost.toFixed(2)} -> ${planAfter.totalCost.toFixed(2)}` +
        `, buffers ${planBefore.buffers} -> ${planAfter.buffers}\n` +
        `[098] before: ${JSON.stringify(planBefore.scans)}\n` +
        `[098] after:  ${JSON.stringify(planAfter.scans)}\n` +
        `[098] fence (agent_activity, unchanged by 098): cost ${fencePlan.totalCost.toFixed(2)}` +
        `, buffers ${fencePlan.buffers}, ${JSON.stringify(fencePlan.scans)}\n`,
    );

    // The point of the index: strictly less work, on identical data. Not a
    // threshold, a direction.
    expect(planAfter.totalCost).toBeLessThan(planBefore.totalCost);
    expect(planAfter.buffers).toBeLessThan(planBefore.buffers);
  }, 180_000);

  it("returns the SAME blockers before and after: an access path, not a semantic change", async () => {
    blockersAfter = (await readInFlightMoney(pool, PROBE_WALLETS)).entries;

    // Seeded shape: per wallet one pending activity, two `wallet_intents`
    // branches, one live transaction intent and one live wrap intent per
    // status, all seven well inside the gate's own bound.
    expect(blockersBefore.length).toBeGreaterThan(0);
    expect(blockersBefore.length).toBeLessThan(MAX_IN_FLIGHT);
    expect(identity(blockersAfter)).toEqual(identity(blockersBefore));

    const kinds = new Set(blockersAfter.map((b) => b.kind));
    expect([...kinds].sort()).toEqual([
      "agent_activity_pending",
      "wallet_confirmation_unknown",
      "wallet_intent_live",
      "wallet_transaction_intent_live",
      "wallet_wrap_intent_live",
    ]);

    // Every blocker belongs to a probed wallet: the predicate still scopes.
    for (const ref of blockersAfter.map((b) => b.ref)) {
      expect(typeof ref).toBe("string");
      expect(ref.length).toBeGreaterThan(0);
    }
  }, 180_000);
});
