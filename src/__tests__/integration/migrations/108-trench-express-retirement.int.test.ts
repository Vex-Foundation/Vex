/**
 * Integration: migration 108 retires Trench Express in durable state, applied as
 * an INCREMENT on a populated schema at 107.
 *
 * WHY THIS EXISTS, and why the shape is this one. `globalSetup` runs 001..108 on
 * an EMPTY database, which proves the file is valid SQL and nothing else. A data
 * migration's whole risk is what it does to rows that are already there, and the
 * rows here are money state: a launch intent that may have signed, an approval
 * card a human never decided, a mission run parked on it.
 *
 * The posture is the one `agents-colab/vscode`'s own retirement test uses
 * (`workbench/services/extensions/test/browser/extensionStorageMigration.test.ts`):
 * assert BOTH halves. Not only "the retired rows moved", but "the rows that must
 * NOT move stayed exactly where they were" - a pools.fun control in every live
 * status, a foreign approval, a sibling sync job, terminal Trench history.
 *
 * MECHANISM (cloned from `094-pools-launch-attribution.int.test.ts`): a second
 * database inside the SAME container the suite already runs, the real
 * `runMigrationsWithProgress` pointed at a temp directory holding only the files
 * at or below 107, rows inserted at that schema, then 108 copied in and the
 * runner invoked again. Nothing is stubbed.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE_DIR = getVexAgentMigrationsDir();
const TARGET_DB = "vex_108_probe";
const MIGRATION_108 = "108_trench_express_retirement.sql";

const SESSION = "session-108";
const OTHER_SESSION = "session-108-other";
const MISSION = "mission-108";
const RUN = "run-108";
const WALLET = `0x${"a".repeat(40)}`;

let pool: pg.Pool;
let stagingDir: string;

function filesUpTo(maxVersion: number): string[] {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".sql") && /^\d{3}_/.test(f))
    .filter((f) => parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
}

/**
 * The single row a one-row probe query must have returned.
 *
 * A throwing accessor rather than a non-null assertion: "the probe matched
 * nothing" is itself a meaningful failure here and deserves a name.
 */
function onlyRow<T extends pg.QueryResultRow>(result: pg.QueryResult<T>, what: string): T {
  const row = result.rows[0];
  if (row === undefined) throw new Error(`expected exactly one row for ${what}, got none`);
  return row;
}

interface IntentState {
  readonly status: string;
  readonly cancelledAt: string | null;
  readonly failureReason: string | null;
  readonly txHash: string | null;
}

async function intent(intentId: string): Promise<IntentState> {
  const res = await pool.query<{
    status: string;
    cancelled_at: Date | null;
    failure_reason: string | null;
    tx_hash: string | null;
  }>(
    `SELECT status, cancelled_at, failure_reason, tx_hash
       FROM token_launch_intents WHERE intent_id = $1`,
    [intentId],
  );
  const row = onlyRow(res, `intent ${intentId}`);
  return {
    status: row.status,
    cancelledAt: row.cancelled_at === null ? null : row.cancelled_at.toISOString(),
    failureReason: row.failure_reason,
    txHash: row.tx_hash,
  };
}

/** Insert one `token_launch_intents` row at the 107 schema. */
async function insertIntent(input: {
  readonly intentId: string;
  readonly protocol: string;
  readonly status: string;
  readonly origin?: string;
  readonly toolCallId?: string | null;
  readonly authorized?: boolean;
  readonly txHash?: string | null;
  readonly sessionId?: string;
  readonly pairedAsset?: string | null;
}): Promise<void> {
  const authorized = input.authorized ?? false;
  await pool.query(
    `INSERT INTO token_launch_intents (
       intent_id, session_id, origin, status, chain_id, wallet_address,
       name, symbol, expires_at, protocol, paired_asset,
       authorization_id, authorization_kind, tool_call_id, tx_hash
     ) VALUES ($1, $2, $3, $4, 4663, $5, 'Probe', 'PRB', NOW() + interval '1 hour',
               $6, $7, $8, $9, $10, $11)`,
    [
      input.intentId,
      input.sessionId ?? SESSION,
      input.origin ?? "user",
      input.status,
      WALLET,
      input.protocol,
      input.pairedAsset ?? null,
      authorized ? `auth-${input.intentId}` : null,
      authorized ? "user_submit" : null,
      input.toolCallId ?? null,
      input.txHash ?? null,
    ],
  );
}

/** A Trench launch activity row carrying a staged hash - the signing evidence. */
async function insertSignedTrenchLaunchActivity(sessionId: string, txHash: string): Promise<void> {
  const execution = await pool.query<{ id: number }>(
    `INSERT INTO protocol_executions (tool_id, namespace, session_id, success)
     VALUES ('trench.launch_execute', 'trench', $1, true) RETURNING id`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO agent_activity (
       protocol_execution_id, event_index, event_role, kind, protocol,
       chain_id, status, wallet_address, session_id, tx_hash, nonce
     ) VALUES ($1, 0, 'token_launch', 'launch', 'trench', 4663, 'pending', $2, $3, $4, 7)`,
    [onlyRow(execution, "the probe execution").id, WALLET, sessionId, txHash],
  );
}

/** Enqueue one approval card plus its intent, exactly as the runtime writes the pair. */
async function insertApproval(input: {
  readonly approvalId: string;
  readonly toolCall: Record<string, unknown>;
  readonly missionRunId?: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id)
     VALUES ($1, $2::jsonb, 'probe', 'pending', $3)`,
    [input.approvalId, JSON.stringify(input.toolCall), SESSION],
  );
  await pool.query(
    `INSERT INTO approval_intents (
       approval_id, session_id, mission_run_id, action_kind, risk_level,
       preview_json, policy_json
     ) VALUES ($1, $2, $3, 'user_wallet_broadcast', 'high', '{}'::jsonb, '{}'::jsonb)`,
    [input.approvalId, SESSION, input.missionRunId ?? null],
  );
}

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
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

  stagingDir = mkdtempSync(path.join(tmpdir(), "vex-108-"));
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

describe("108 retires Trench Express over a populated schema at 107", () => {
  it("reaches 107 and seeds a row in EVERY intent state, plus the sibling state 108 must not touch", async () => {
    for (const f of filesUpTo(107)) copyFileSync(path.join(SOURCE_DIR, f), path.join(stagingDir, f));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(filesUpTo(107).length);

    const version = await pool.query<{ v: number }>(
      `SELECT COALESCE(MAX(version), 0)::int AS v FROM schema_version`,
    );
    expect(onlyRow(version, "schema_version high-water mark").v).toBe(107);

    // 108 has not run, so the Trench write default is still armed. This is the
    // trapdoor section 2 of the migration closes.
    const defaultBefore = await pool.query<{ column_default: string | null }>(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'token_launch_intents' AND column_name = 'protocol'`,
    );
    expect(onlyRow(defaultBefore, "the protocol column default").column_default).toContain("trench");

    await pool.query(`INSERT INTO sessions (id) VALUES ($1), ($2)`, [SESSION, OTHER_SESSION]);
    await pool.query(`INSERT INTO missions (id, root_session_id) VALUES ($1, $2)`, [MISSION, SESSION]);
    await pool.query(
      `INSERT INTO mission_runs (id, mission_id, session_id, status)
       VALUES ($1, $2, $3, 'paused_approval')`,
      [RUN, MISSION, SESSION],
    );

    // ── The Trench cross-product: one row per status ──────────────────────
    await insertIntent({ intentId: "t-previewed", protocol: "trench", status: "previewed" });
    await insertIntent({
      intentId: "t-awaiting",
      protocol: "trench",
      status: "awaiting_user_form",
      origin: "agent_requested_form",
      toolCallId: "call-awaiting",
    });
    await insertIntent({
      intentId: "t-authorized", protocol: "trench", status: "authorized", authorized: true,
    });
    await insertIntent({
      intentId: "t-consuming-unsigned", protocol: "trench", status: "consuming", authorized: true,
    });
    // The crash-window row: the activity carries the staged hash, the intent
    // does not. It signed, so 108 must leave it alone.
    await insertIntent({
      intentId: "t-consuming-signed",
      protocol: "trench",
      status: "consuming",
      authorized: true,
      sessionId: OTHER_SESSION,
    });
    await insertSignedTrenchLaunchActivity(OTHER_SESSION, `0x${"b".repeat(64)}`);
    await insertIntent({
      intentId: "t-broadcast", protocol: "trench", status: "broadcast_pending",
      authorized: true, txHash: `0x${"c".repeat(64)}`,
    });
    await insertIntent({
      intentId: "t-confirmed", protocol: "trench", status: "confirmed",
      authorized: true, txHash: `0x${"d".repeat(64)}`,
    });
    await insertIntent({
      intentId: "t-terminal", protocol: "trench", status: "terminal_failure", authorized: true,
    });
    await insertIntent({ intentId: "t-cancelled", protocol: "trench", status: "cancelled" });
    await insertIntent({ intentId: "t-expired", protocol: "trench", status: "expired" });
    await insertIntent({
      intentId: "t-superseded", protocol: "trench", status: "superseded_unproven",
      authorized: true, txHash: `0x${"e".repeat(64)}`,
    });

    // ── The pools.fun controls: every LIVE status, none of which may move ──
    for (const status of ["previewed", "awaiting_user_form", "authorized", "consuming"]) {
      await insertIntent({
        intentId: `p-${status}`,
        protocol: "pools_fun",
        status,
        pairedAsset: "weth",
        authorized: status === "authorized" || status === "consuming",
        ...(status === "awaiting_user_form"
          ? { origin: "agent_requested_form", toolCallId: `call-${status}` }
          : {}),
      });
    }

    // ── Approvals: a Trench card in each stored envelope shape, one control ──
    await insertApproval({
      approvalId: "appr-envelope",
      toolCall: {
        command: "execute_tool",
        args: { toolId: "trench.launch_execute", params: {} },
        vex: { v: 2, originalToolName: "trench__launch_execute", manifestFingerprint: "x" },
      },
      missionRunId: RUN,
    });
    await insertApproval({
      approvalId: "appr-dotted",
      toolCall: { command: "trench.trade_execute", args: {} },
    });
    await insertApproval({
      approvalId: "appr-public-name",
      toolCall: { command: "trench__trade_execute", args: {} },
    });
    await insertApproval({
      approvalId: "appr-control",
      toolCall: {
        command: "execute_tool",
        args: { toolId: "pools.launch_execute", params: {} },
        vex: { v: 2, originalToolName: "pools__launch_execute", manifestFingerprint: "y" },
      },
    });

    // ── Sync jobs: the retired lane and a sibling that must keep running ────
    const retired = await pool.query<{ id: number }>(
      `INSERT INTO protocol_sync_jobs (namespace, sync_type, strategy, interval_seconds, enabled)
       VALUES ('_global', 'launch_attribution', 'periodic', 120, true) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO protocol_sync_runs (sync_job_id, status) VALUES ($1, 'pending'), ($1, 'completed')`,
      [onlyRow(retired, "the retired sync job").id],
    );
    await pool.query(
      `INSERT INTO protocol_sync_jobs (namespace, sync_type, strategy, interval_seconds, enabled)
       VALUES ('_global', 'pools_attribution', 'periodic', 120, true)`,
    );

    // ── Tool embeddings: the ten retired ids and one that must survive ──────
    for (const toolId of [
      "trench.tokens", "trench.search", "trench.trades", "trench.images", "trench.my_launches",
      "trench.trade_quote", "trench.trade_execute", "trench.launch_preview",
      "trench.launch_request_form", "trench.launch_execute",
    ]) {
      await pool.query(
        `INSERT INTO tool_embeddings (tool_id, namespace, content_hash, embedding_model, embedding_dim, embedding)
         VALUES ($1, 'trench', $2, 'probe', 3, '[1,2,3]'::vector)`,
        [toolId, toolId.padEnd(64, "0").slice(0, 64)],
      );
    }
    await pool.query(
      `INSERT INTO tool_embeddings (tool_id, namespace, content_hash, embedding_model, embedding_dim, embedding)
       VALUES ('pools.launch_execute', 'pools', $1, 'probe', 3, '[1,2,3]'::vector)`,
      ["p".padEnd(64, "0")],
    );
  }, 180_000);

  it("108 applies as ONE increment over those rows", async () => {
    copyFileSync(path.join(SOURCE_DIR, MIGRATION_108), path.join(stagingDir, MIGRATION_108));
    const result = await runMigrationsWithProgress({ pool, migrationsDir: stagingDir });
    expect(result.applied).toBe(1);
    expect(result.files).toEqual([MIGRATION_108]);
  }, 120_000);

  it("cancels every Trench intent that never signed, with a stated reason", async () => {
    for (const id of ["t-previewed", "t-awaiting", "t-authorized", "t-consuming-unsigned"]) {
      const state = await intent(id);
      expect(state.status, id).toBe("cancelled");
      expect(state.cancelledAt, id).not.toBeNull();
      expect(state.txHash, id).toBeNull();
      // Model-visible on the resume path, so it must name the cause rather than
      // leaving the parked turn to be told the form merely "expired".
      expect(state.failureReason ?? "", id).toContain("Trench Express was retired");
      // Every row that COULD have signed says so. The preview never could, so
      // its sentence says what it actually is instead of borrowing that claim.
      if (id === "t-previewed") {
        expect(state.failureReason ?? "", id).toContain("can never be launched");
      } else {
        expect(state.failureReason ?? "", id).toContain("Nothing was signed");
      }
    }
  });

  it("leaves the `consuming` row whose activity carries a staged hash UNTOUCHED", async () => {
    const state = await intent("t-consuming-signed");
    expect(state.status).toBe("consuming");
    expect(state.cancelledAt).toBeNull();
    expect(state.failureReason).toBeNull();
  });

  it("leaves broadcast_pending and every terminal history row exactly as it was", async () => {
    expect((await intent("t-broadcast")).status).toBe("broadcast_pending");
    expect((await intent("t-broadcast")).txHash).toBe(`0x${"c".repeat(64)}`);
    expect((await intent("t-confirmed")).status).toBe("confirmed");
    expect((await intent("t-terminal")).status).toBe("terminal_failure");
    expect((await intent("t-expired")).status).toBe("expired");
    expect((await intent("t-superseded")).status).toBe("superseded_unproven");

    // A row already cancelled before 108 keeps ITS record: no reason is written
    // over it and no second cancellation timestamp is stamped.
    const alreadyCancelled = await intent("t-cancelled");
    expect(alreadyCancelled.status).toBe("cancelled");
    expect(alreadyCancelled.failureReason).toBeNull();
    expect(alreadyCancelled.cancelledAt).toBeNull();
  });

  it("touches NO pools.fun intent, in any live status", async () => {
    for (const status of ["previewed", "awaiting_user_form", "authorized", "consuming"]) {
      const state = await intent(`p-${status}`);
      expect(state.status, status).toBe(status);
      expect(state.cancelledAt, status).toBeNull();
      expect(state.failureReason, status).toBeNull();
    }
  });

  it("drops the latent `protocol` write default while keeping the value legal", async () => {
    const after = await pool.query<{ column_default: string | null; is_nullable: string }>(
      `SELECT column_default, is_nullable FROM information_schema.columns
        WHERE table_name = 'token_launch_intents' AND column_name = 'protocol'`,
    );
    const row = onlyRow(after, "the protocol column after 108");
    expect(row.column_default).toBeNull();
    expect(row.is_nullable).toBe("NO");

    // Historical rows still read back as what they are, so the CHECK must still
    // admit 'trench' - the retirement removes the ability to WRITE it by
    // omission, never the ability to read the launches that used it.
    await expect(
      pool.query(
        `INSERT INTO token_launch_intents (
           intent_id, session_id, origin, status, chain_id, wallet_address,
           name, symbol, expires_at, protocol
         ) VALUES ('t-readback', $1, 'user', 'cancelled', 4663, $2, 'N', 'S',
                   NOW() + interval '1 hour', 'trench')`,
        [SESSION, WALLET],
      ),
    ).resolves.toBeDefined();

    // ...and an omitted protocol is now a refusal rather than a silent Trench row.
    await expect(
      pool.query(
        `INSERT INTO token_launch_intents (
           intent_id, session_id, origin, status, chain_id, wallet_address,
           name, symbol, expires_at
         ) VALUES ('t-nodefault', $1, 'user', 'cancelled', 4663, $2, 'N', 'S',
                   NOW() + interval '1 hour')`,
        [SESSION, WALLET],
      ),
    ).rejects.toThrow();
  });

  it("denies every pending Trench approval without dispatching it, and no other", async () => {
    const queue = await pool.query<{ id: string; status: string; resolved_at: Date | null }>(
      `SELECT id, status, resolved_at FROM approval_queue ORDER BY id`,
    );
    const byId = new Map(queue.rows.map((r) => [r.id, r]));
    for (const id of ["appr-envelope", "appr-dotted", "appr-public-name"]) {
      const row = byId.get(id);
      expect(row?.status, id).toBe("rejected");
      expect(row?.resolved_at, id).not.toBeNull();
    }
    expect(byId.get("appr-control")?.status).toBe("pending");

    const intents = await pool.query<{
      approval_id: string; decision: string | null; execution_status: string; decision_reason: string | null;
    }>(`SELECT approval_id, decision, execution_status, decision_reason FROM approval_intents ORDER BY approval_id`);
    const intentById = new Map(intents.rows.map((r) => [r.approval_id, r]));
    for (const id of ["appr-envelope", "appr-dotted", "appr-public-name"]) {
      expect(intentById.get(id)?.decision, id).toBe("rejected");
      // NOTHING WAS DISPATCHED. The denial is a decision, never an execution.
      expect(intentById.get(id)?.execution_status, id).toBe("not_started");
      expect(intentById.get(id)?.decision_reason ?? "", id).toContain("Nothing was dispatched");
    }
    expect(intentById.get("appr-control")?.decision).toBeNull();
  });

  it("un-parks the mission run that was waiting on a denied Trench card", async () => {
    const run = await pool.query<{ status: string }>(
      `SELECT status FROM mission_runs WHERE id = $1`, [RUN],
    );
    // `paused_error`, not terminal: the operator can /retry, and the user's
    // mission stays theirs to end.
    expect(onlyRow(run, "the parked mission run").status).toBe("paused_error");
  });

  it("disables the retired attribution job and terminalizes only its live runs", async () => {
    const jobs = await pool.query<{ sync_type: string; enabled: boolean }>(
      `SELECT sync_type, enabled FROM protocol_sync_jobs ORDER BY sync_type`,
    );
    const enabledBySyncType = new Map(jobs.rows.map((r) => [r.sync_type, r.enabled]));
    expect(enabledBySyncType.get("launch_attribution")).toBe(false);
    expect(enabledBySyncType.get("pools_attribution")).toBe(true);

    const runs = await pool.query<{ status: string; error: string | null }>(
      `SELECT r.status, r.error FROM protocol_sync_runs r
         JOIN protocol_sync_jobs j ON j.id = r.sync_job_id
        WHERE j.sync_type = 'launch_attribution' ORDER BY r.status`,
    );
    expect(runs.rows.map((r) => r.status)).toEqual(["completed", "failed"]);
    // Completed history keeps its record; only the live run is terminalized.
    expect(runs.rows.find((r) => r.status === "failed")?.error).toContain("retired");
    expect(runs.rows.find((r) => r.status === "completed")?.error).toBeNull();
  });

  it("deletes the ten retired tool embeddings and nothing else", async () => {
    const rows = await pool.query<{ tool_id: string }>(
      `SELECT tool_id FROM tool_embeddings ORDER BY tool_id`,
    );
    expect(rows.rows.map((r) => r.tool_id)).toEqual(["pools.launch_execute"]);
  });

  it("is idempotent: re-applying the file changes nothing", async () => {
    const digest = async (): Promise<string> => {
      const res = await pool.query<{ snapshot: string }>(
        `SELECT (
           (SELECT COALESCE(string_agg(intent_id || ':' || status || ':' || COALESCE(failure_reason, '-')
                                       || ':' || COALESCE(cancelled_at::text, '-'), '|' ORDER BY intent_id), '')
              FROM token_launch_intents)
           || '#' ||
           (SELECT COALESCE(string_agg(id || ':' || status || ':' || COALESCE(resolved_at::text, '-'), '|' ORDER BY id), '')
              FROM approval_queue)
           || '#' ||
           (SELECT COALESCE(string_agg(approval_id || ':' || COALESCE(decision, '-'), '|' ORDER BY approval_id), '')
              FROM approval_intents)
           || '#' ||
           (SELECT COALESCE(string_agg(id::text || ':' || status || ':' || COALESCE(ended_at::text, '-'), '|' ORDER BY id), '')
              FROM protocol_sync_runs)
           || '#' ||
           (SELECT COALESCE(string_agg(id::text || ':' || enabled::text, '|' ORDER BY id), '')
              FROM protocol_sync_jobs)
           || '#' ||
           (SELECT COALESCE(string_agg(tool_id, '|' ORDER BY tool_id), '') FROM tool_embeddings)
           || '#' ||
           (SELECT COALESCE(string_agg(id || ':' || status, '|' ORDER BY id), '') FROM mission_runs)
         ) AS snapshot`,
      );
      return onlyRow(res, "the durable snapshot").snapshot;
    };

    const before = await digest();
    // The RUNNER would skip 108 by version, so the file's own SQL is executed
    // directly: what has to be proven is that the STATEMENTS are re-runnable,
    // not that the version table works.
    await pool.query(readFileSync(path.join(SOURCE_DIR, MIGRATION_108), "utf8"));
    expect(await digest()).toBe(before);
  }, 120_000);
});
