import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const SOURCE = getVexAgentMigrationsDir();
const DATABASE = "vex_176_probe";
const MIGRATION = "176_lighter_fill_position_facts_without_pnl.sql";
let pool: pg.Pool;
let staging: string;

beforeAll(async () => {
  const base = process.env.VEX_DB_URL;
  if (!base) throw new Error("VEX_DB_URL is unset: isolated PostgreSQL setup required");
  const admin = new pg.Pool({ connectionString: base });
  try {
    expect((await admin.query<{ name: string }>("SELECT current_database() AS name")).rows).toEqual([{ name: "vex_test" }]);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${DATABASE}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  staging = mkdtempSync(path.join(tmpdir(), "vex-176-"));
  for (const file of readdirSync(SOURCE).filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 175)) {
    copyFileSync(path.join(SOURCE, file), path.join(staging, file));
  }
  await runMigrationsWithProgress({ pool, migrationsDir: staging });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  if (staging) rmSync(staging, { recursive: true, force: true });
  const base = process.env.VEX_DB_URL;
  if (!base) return;
  const admin = new pg.Pool({ connectionString: base });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  } finally {
    await admin.end();
  }
});

async function seed(id: string, known: boolean) {
  await pool.query(
    `INSERT INTO lighter_fills (
      canonical_identity, environment, account_index, market_index, provider_trade_id,
      market_symbol, side, price, base_size, quote_notional,
      base_asset_id, base_asset_symbol, base_asset_decimals,
      quote_asset_id, quote_asset_symbol, quote_asset_decimals,
      block_height, trade_type, traded_at, usd_amount, fee_side,
      position_size_before, position_sign_changed, position_effect, account_pnl
    ) VALUES ($1,'rhc',42,19,$1,'BABA-USD','sell','100','1','100',
      'fixture-base','BABA',4,'fixture-quote','USD',6,'1','trade',NOW(),'100','taker',
      $2,$3,$4,$5)`,
    [id, known ? "0" : null, known ? true : null, known ? "open" : null, known ? "0" : null],
  );
}

describe("migration 176 on a populated 175 schema", () => {
  it("preserves existing unknown and fully known rows while allowing independent position facts", async () => {
    expect((await pool.query<{ version: number }>("SELECT max(version) AS version FROM schema_version")).rows).toEqual([{ version: 175 }]);
    await seed("1", false);
    await seed("2", true);
    await expect(pool.query("UPDATE lighter_fills SET position_size_before='0', position_sign_changed=true, position_effect='open' WHERE provider_trade_id='1'"))
      .rejects.toThrow(/lighter_fills_account_facts_whole/);
    const before = (await pool.query("SELECT * FROM lighter_fills ORDER BY id")).rows;
    copyFileSync(path.join(SOURCE, MIGRATION), path.join(staging, MIGRATION));
    const applied = await runMigrationsWithProgress({ pool, migrationsDir: staging });
    expect(applied.files).toEqual([MIGRATION]);
    expect(applied.applied).toBe(1);
    expect((await pool.query("SELECT * FROM lighter_fills ORDER BY id")).rows).toEqual(before);
    expect((await runMigrationsWithProgress({ pool, migrationsDir: staging })).applied).toBe(0);
    await expect(pool.query(readFileSync(path.join(SOURCE, MIGRATION), "utf8"))).resolves.toBeDefined();
    expect((await pool.query("SELECT * FROM lighter_fills ORDER BY id")).rows).toEqual(before);
  });

  it("accepts complete position facts with unknown PnL and preserves known PnL", async () => {
    await pool.query("UPDATE lighter_fills SET position_size_before='0', position_sign_changed=true, position_effect='open' WHERE provider_trade_id='1'");
    expect((await pool.query("SELECT position_size_before, position_sign_changed, position_effect, account_pnl FROM lighter_fills WHERE provider_trade_id='1'")).rows)
      .toEqual([{ position_size_before: "0", position_sign_changed: true, position_effect: "open", account_pnl: null }]);
    expect((await pool.query("SELECT account_pnl FROM lighter_fills WHERE provider_trade_id='2'")).rows).toEqual([{ account_pnl: "0" }]);
  });

  it.each([
    "position_size_before=NULL", "position_sign_changed=NULL", "position_effect=NULL",
    "position_size_before=NULL, position_sign_changed=NULL, position_effect=NULL, account_pnl='1'",
    "account_pnl='not-pnl'",
  ])("keeps partial position facts and malformed PnL prohibited: %s", async (update) => {
    await expect(pool.query(`UPDATE lighter_fills SET ${update} WHERE provider_trade_id='1'`)).rejects.toThrow(/check constraint/);
    expect((await pool.query("SELECT account_pnl FROM lighter_fills WHERE provider_trade_id='1'")).rows).toEqual([{ account_pnl: null }]);
  });
});
