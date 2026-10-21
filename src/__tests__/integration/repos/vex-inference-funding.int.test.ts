/**
 * The Vex Inference funding policy's durable side (migrations 178 and 179,
 * `src/vex-agent/db/repos/vex-inference-funding.ts`) against a REAL Postgres:
 * the constraints no in-memory fake can prove.
 *
 * Proves: one live rule per account (partial unique index); one in-flight
 * execution per rule (partial unique index and the advisory-locked
 * admission); the rolling 24 hour and 30 day cap SQL counting unknown,
 * in-flight and reverted rows and skipping refused ones; two admissions from
 * two connections at once admit exactly one; expiry retires a rule and bumps
 * its version; the network fee ceiling persists and its CHECK refuses zero;
 * migration 179 applied over a populated 178 schema leaves the old rule's
 * ceiling NULL (it spends nothing until edited).
 *
 * Does not prove the policy decisions (the vex-app unit suites) or the chain.
 *
 *   pnpm exec vitest run --config vitest/studio-postgres.config.ts \
 *     src/__tests__/integration/repos/vex-inference-funding.int.test.ts
 */

import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";
import * as repo from "@vex-agent/db/repos/vex-inference-funding.js";
import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";

const ACCOUNT = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_ACCOUNT = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const WALLET = `0x${"1".repeat(40)}`;
const DEPOSIT = `0x${"d".repeat(40)}`;
const E18 = 10n ** 18n;
const DAY_MS = 86_400_000;
const NOW = new Date("2030-01-15T12:00:00.000Z");

let sequence = 0;
const ruleId = (): string => `vxrule-00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const executionId = (): string => `vxexec-00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

function newRule(overrides: Partial<repo.NewRuleInput> = {}): repo.NewRuleInput {
  return {
    ruleId: ruleId(),
    accountId: ACCOUNT,
    sourceWallet: WALLET,
    amountWei: 6_000n * E18,
    maxPerDay: 2,
    monthlyCapWei: 30_000n * E18,
    maxNetworkFeeWei: 10n ** 14n,
    expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    approvedAt: NOW,
    ...overrides,
  };
}

function ask(rule: string, amountWei = 6_000n * E18): repo.AskExecutionInput {
  return { executionId: executionId(), ruleId: rule, authority: "auto_top_up_poller", sessionId: null, sourceWallet: WALLET, depositAddress: DEPOSIT, amountWei };
}

/** Insert an execution row directly with a chosen status and age (fixture, not a provider observation). */
async function seedExecution(rule: string, status: repo.DepositExecutionStatus, askedAt: Date, amountWei: bigint): Promise<void> {
  const decided = status === "asked" || status === "submitted" ? null : askedAt;
  await execute(
    `INSERT INTO vex_inference_deposit_executions
       (execution_id, rule_id, authority, session_id, source_wallet, deposit_address, amount_wei, status, tx_hash, asked_at, decided_at)
     VALUES ($1, $2, 'auto_top_up_poller', NULL, $3, $4, $5, $6, NULL, $7, $8)`,
    [executionId(), rule, WALLET, DEPOSIT, amountWei.toString(), status, askedAt, decided],
  );
}

beforeEach(async () => {
  expect(process.env.VEX_DB_URL).toBeTruthy();
  expect(await queryOne<{ name: string }>("SELECT current_database() AS name")).toEqual({ name: "vex_test" });
  await execute("TRUNCATE vex_inference_deposit_executions, vex_inference_auto_top_up_rules, vex_inference_balance_watch, vex_inference_settings");
});

describe("one live rule per account (178, partial unique index)", () => {
  it("a second active or paused rule for the account is a constraint error; after a revoke a new one is allowed", async () => {
    const first = await repo.insertRule(newRule());
    await expect(repo.insertRule(newRule())).rejects.toMatchObject({ code: "23505" });
    await repo.setRuleStatus({ ruleId: first.ruleId, expectedVersion: 1, from: ["active"], to: "paused" });
    await expect(repo.insertRule(newRule())).rejects.toMatchObject({ code: "23505" });
    // Another account is independent.
    await expect(repo.insertRule(newRule({ accountId: OTHER_ACCOUNT }))).resolves.toMatchObject({ accountId: OTHER_ACCOUNT });
    await repo.setRuleStatus({ ruleId: first.ruleId, expectedVersion: 2, from: ["active", "paused"], to: "revoked" });
    await expect(repo.insertRule(newRule())).resolves.toMatchObject({ status: "active", version: 1 });
  });

  it("compare-and-set: a stale version changes nothing", async () => {
    const rule = await repo.insertRule(newRule());
    expect(await repo.setRuleStatus({ ruleId: rule.ruleId, expectedVersion: 7, from: ["active"], to: "revoked" })).toBeNull();
    expect(await repo.editRule({ ruleId: rule.ruleId, expectedVersion: 7, sourceWallet: WALLET, amountWei: E18, maxPerDay: 1, monthlyCapWei: E18, maxNetworkFeeWei: 1n, expiresAt: rule.expiresAt, approvedAt: NOW })).toBeNull();
    expect(await repo.readRule(rule.ruleId)).toMatchObject({ status: "active", version: 1, amountWei: 6_000n * E18 });
  });
});

describe("the network fee ceiling (179)", () => {
  it("persists on insert and edit, and its CHECK refuses zero", async () => {
    const rule = await repo.insertRule(newRule({ maxNetworkFeeWei: 12_345n }));
    expect(rule.maxNetworkFeeWei).toBe(12_345n);
    const edited = await repo.editRule({ ruleId: rule.ruleId, expectedVersion: 1, sourceWallet: WALLET, amountWei: 6_000n * E18, maxPerDay: 2, monthlyCapWei: 30_000n * E18, maxNetworkFeeWei: 99n, expiresAt: rule.expiresAt, approvedAt: NOW });
    expect(edited).toMatchObject({ maxNetworkFeeWei: 99n, version: 2 });
    await expect(repo.insertRule(newRule({ accountId: OTHER_ACCOUNT, maxNetworkFeeWei: 0n }))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("one in-flight execution per rule (178, partial unique index + advisory lock)", () => {
  it("a second undecided row is refused, by the admission and by the index itself; a decided row frees the slot", async () => {
    const rule = await repo.insertRule(newRule());
    const first = await repo.askExecution(ask(rule.ruleId), () => null, NOW);
    expect(first.admitted).toBe(true);
    await expect(repo.askExecution(ask(rule.ruleId), () => null, NOW)).rejects.toBeInstanceOf(repo.RuleExecutionInFlightError);
    // Bypassing the admission: the index still refuses.
    await expect(seedExecution(rule.ruleId, "submitted", NOW, E18)).rejects.toMatchObject({ code: "23505" });
    if (!first.admitted) return;
    await repo.decideExecution({ executionId: first.row.executionId, status: "unknown", txHash: `0x${"ab".repeat(32)}`, refusalKind: null, decidedAt: NOW });
    expect((await repo.askExecution(ask(rule.ruleId), () => null, NOW)).admitted).toBe(true);
  });

  it("two admissions from two connections at once: exactly one is admitted, the other refused, one row written", async () => {
    const rule = await repo.insertRule(newRule({ maxPerDay: 1 }));
    // Each call runs its own transaction on its own pooled connection.
    const admit = (r: repo.AutoTopUpRuleRow | null, u: repo.RuleUsage | null) =>
      r === null || u === null ? "missing" : u.countLastDay + 1 > r.maxPerDay ? "cap" : null;
    const outcomes = await Promise.allSettled([
      repo.askExecution(ask(rule.ruleId), admit, NOW),
      repo.askExecution(ask(rule.ruleId), admit, NOW),
    ]);
    const admitted = outcomes.filter((o) => o.status === "fulfilled" && o.value.admitted);
    const refused = outcomes.filter((o) => o.status === "rejected" || (o.status === "fulfilled" && !o.value.admitted));
    expect(admitted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM vex_inference_deposit_executions WHERE rule_id = $1", [rule.ruleId])).toEqual({ n: "1" });
  });

  it("the cap check and the write are one step: with the day's slot used, the admission refuses and writes nothing", async () => {
    const rule = await repo.insertRule(newRule({ maxPerDay: 1 }));
    await seedExecution(rule.ruleId, "unknown", new Date(NOW.getTime() - 60_000), E18);
    const outcome = await repo.askExecution(ask(rule.ruleId), (r, u) => (r !== null && u !== null && u.countLastDay + 1 > r.maxPerDay ? "cap" : null), NOW);
    expect(outcome).toEqual({ admitted: false, reason: "cap" });
    expect(await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM vex_inference_deposit_executions WHERE rule_id = $1", [rule.ruleId])).toEqual({ n: "1" });
  });
});

describe("the rolling cap windows (178)", () => {
  it("24 hours and 30 days, counting unknown, in-flight and reverted rows, never refused ones", async () => {
    const rule = await repo.insertRule(newRule({ monthlyCapWei: 100_000n * E18 }));
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    await seedExecution(rule.ruleId, "unknown", ago(23 * 3_600_000), 1n * E18); // day + month
    await seedExecution(rule.ruleId, "reverted", ago(2 * 3_600_000), 2n * E18); // day + month
    await seedExecution(rule.ruleId, "refused", ago(3_600_000), 1_000n * E18); // neither
    await seedExecution(rule.ruleId, "confirmed", ago(25 * 3_600_000), 4n * E18); // month only
    await seedExecution(rule.ruleId, "confirmed", ago(29 * DAY_MS), 8n * E18); // month only
    await seedExecution(rule.ruleId, "confirmed", ago(30 * DAY_MS + 60_000), 16n * E18); // neither
    await seedExecution(rule.ruleId, "asked", ago(60_000), 32n * E18); // in flight: day + month
    expect(await repo.readRuleUsage(rule.ruleId, NOW)).toEqual({ countLastDay: 3, sumLast30DaysWei: (1n + 2n + 4n + 8n + 32n) * E18 });
  });

  it("the window edge is exclusive: a row exactly 24 hours old no longer counts for the day", async () => {
    const rule = await repo.insertRule(newRule());
    await seedExecution(rule.ruleId, "confirmed", new Date(NOW.getTime() - DAY_MS), E18);
    expect(await repo.readRuleUsage(rule.ruleId, NOW)).toEqual({ countLastDay: 0, sumLast30DaysWei: E18 });
  });

  it("recovery marks every undecided row unknown, and it still counts", async () => {
    const rule = await repo.insertRule(newRule());
    await seedExecution(rule.ruleId, "submitted", new Date(NOW.getTime() - 60_000), 3n * E18);
    expect(await repo.markOrphanedExecutionsUnknown(NOW)).toBe(1);
    expect(await repo.readRuleUsage(rule.ruleId, NOW)).toEqual({ countLastDay: 1, sumLast30DaysWei: 3n * E18 });
  });
});

describe("expiry (178)", () => {
  it("retires a live rule whose expiry passed, bumps its version, and leaves a later one alone", async () => {
    const lapsed = await repo.insertRule(newRule({ approvedAt: new Date(NOW.getTime() - 2 * DAY_MS), expiresAt: new Date(NOW.getTime() - DAY_MS) }));
    const live = await repo.insertRule(newRule({ accountId: OTHER_ACCOUNT }));
    expect(await repo.expireRules(NOW)).toBe(1);
    expect(await repo.readRule(lapsed.ruleId)).toMatchObject({ status: "expired", version: 2 });
    expect(await repo.readRule(live.ruleId)).toMatchObject({ status: "active", version: 1 });
    expect(await repo.readLiveRule(ACCOUNT)).toBeNull();
    expect(await repo.expireRules(NOW)).toBe(0);
  });

  it("the schema refuses a rule lasting more than 90 days or expiring before its approval", async () => {
    await expect(repo.insertRule(newRule({ expiresAt: new Date(NOW.getTime() + 90 * DAY_MS + 1_000) }))).rejects.toMatchObject({ code: "23514" });
    await expect(repo.insertRule(newRule({ expiresAt: NOW }))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("migration 179 over a populated 178 schema", () => {
  const DATABASE = "vex_179_probe";
  let pool: pg.Pool | null = null;
  let staging = "";

  afterAll(async () => {
    await pool?.end();
    if (staging !== "") rmSync(staging, { recursive: true, force: true });
    const base = process.env.VEX_DB_URL;
    if (!base) return;
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    } finally {
      await admin.end();
    }
  });

  it("adds the ceiling as NULL on an existing rule, and running it again changes nothing", async () => {
    const base = process.env.VEX_DB_URL;
    if (!base) throw new Error("VEX_DB_URL is unset: isolated PostgreSQL setup required");
    const admin = new pg.Pool({ connectionString: base });
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    } finally {
      await admin.end();
    }
    const url = new URL(base);
    url.pathname = `/${DATABASE}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    const source = path.resolve("src/vex-agent/db/migrations");
    staging = mkdtempSync(path.join(tmpdir(), "vex-179-"));
    const copyThrough = (last: number) => {
      for (const file of readdirSync(source).filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= last)) {
        copyFileSync(path.join(source, file), path.join(staging, file));
      }
    };
    copyThrough(178);
    await runMigrationsWithProgress({ pool, migrationsDir: staging });
    const legacy = ruleId();
    await pool.query(
      `INSERT INTO vex_inference_auto_top_up_rules (rule_id, account_id, source_wallet, amount_wei, max_per_day, monthly_cap_wei, trigger_kind, expires_at, status, approved_at)
       VALUES ($1, $2, $3, $4, 1, $4, 'below_alert_percent', $5, 'active', $6)`,
      [legacy, ACCOUNT, WALLET, (6_000n * E18).toString(), new Date(NOW.getTime() + DAY_MS), NOW],
    );
    copyThrough(179);
    await runMigrationsWithProgress({ pool, migrationsDir: staging });
    expect((await pool.query("SELECT max_network_fee_wei FROM vex_inference_auto_top_up_rules WHERE rule_id = $1", [legacy])).rows).toEqual([{ max_network_fee_wei: null }]);
    // The repository reads it as "no ceiling approved".
    expect(await repo.readRule(legacy, pool)).toMatchObject({ maxNetworkFeeWei: null, status: "active" });
    // Idempotent: the column and the constraint are not added twice.
    const file = readdirSync(staging).find((name) => name.startsWith("179_"));
    expect(file).toBe("179_vex_inference_rule_network_fee_ceiling.sql");
    if (file === undefined) return;
    await pool.query(readFileSync(path.join(staging, file), "utf8"));
    expect((await pool.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'vex_inference_auto_top_up_rules_max_network_fee_positive'")).rows).toEqual([{ n: 1 }]);
    await expect(pool.query("UPDATE vex_inference_auto_top_up_rules SET max_network_fee_wei = 0 WHERE rule_id = $1", [legacy])).rejects.toMatchObject({ code: "23514" });
  }, 120_000);
});
