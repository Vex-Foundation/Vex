/**
 * Integration: migration 184 (watchlist and price alerts) against real
 * Postgres. The suite's database is already migrated by globalSetup; this
 * file re-applies 184 to prove it is idempotent, then proves the CHECKs and
 * the partial unique index refuse what the service must never write.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closePool, execute, query } from "@vex-agent/db/client.js";
import { getVexAgentMigrationsDir } from "@utils/package-assets.js";

const MIGRATION_184 = path.join(getVexAgentMigrationsDir(), "184_watchlist_price_alerts.sql");
const KEY = "base:0x4200000000000000000000000000000000000006";

async function insertAlert(over: Record<string, unknown> = {}): Promise<void> {
  const row = {
    asset_kind: "token",
    chain: "base",
    address: "0x4200000000000000000000000000000000000006",
    asset_key: KEY,
    label: "WETH",
    condition: "above",
    value: "4000",
    reference_price: "3500",
    trigger_price: "4000",
    direction: "above",
    origin: "app",
    ...over,
  };
  const columns = Object.keys(row);
  const values = Object.values(row);
  await execute(
    `INSERT INTO price_alerts (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    values,
  );
}

beforeEach(async () => {
  await execute("DELETE FROM price_alerts");
  await execute("DELETE FROM watchlist_items");
});

afterAll(async () => {
  await execute("DELETE FROM price_alerts");
  await execute("DELETE FROM watchlist_items");
  await closePool();
});

describe("migration 184: watchlist_items and price_alerts", () => {
  it("re-applies without error (idempotent DDL)", async () => {
    await execute(readFileSync(MIGRATION_184, "utf8"));
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name IN ('watchlist_items', 'price_alerts') ORDER BY table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual(["price_alerts", "watchlist_items"]);
  });

  it("keeps one watchlist row per asset key", async () => {
    await execute(
      "INSERT INTO watchlist_items (asset_kind, chain, address, asset_key, label) VALUES ('token', 'base', 'a', $1, 'WETH')",
      [KEY],
    );
    await expect(
      execute(
        "INSERT INTO watchlist_items (asset_kind, chain, address, asset_key, label) VALUES ('token', 'base', 'a', $1, 'WETH')",
        [KEY],
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("refuses an unknown asset kind, condition, direction or origin", async () => {
    await expect(insertAlert({ asset_kind: "cex" })).rejects.toThrow(/check constraint/);
    await expect(insertAlert({ condition: "crosses" })).rejects.toThrow(/check constraint/);
    await expect(insertAlert({ direction: "sideways" })).rejects.toThrow(/check constraint/);
    await expect(insertAlert({ origin: "studio" })).rejects.toThrow(/check constraint/);
  });

  it("refuses a value, reference or trigger price that is not positive", async () => {
    await expect(insertAlert({ value: "0" })).rejects.toThrow(/check constraint/);
    await expect(insertAlert({ reference_price: "-1" })).rejects.toThrow(/check constraint/);
    await expect(insertAlert({ trigger_price: "0" })).rejects.toThrow(/check constraint/);
  });

  it("refuses a note longer than 140 characters and an empty label", async () => {
    await expect(insertAlert({ note: "x".repeat(141) })).rejects.toThrow(/check constraint/);
    await expect(insertAlert({ label: "" })).rejects.toThrow(/check constraint/);
    await insertAlert({ note: "x".repeat(140) });
  });

  it("refuses a triggered row without its time and price", async () => {
    await expect(insertAlert({ status: "triggered" })).rejects.toThrow(/price_alerts_triggered_fields_chk/);
    await insertAlert({ status: "triggered", triggered_at: "2026-10-24T12:00:00Z", triggered_price: "4001" });
  });

  it("refuses a second identical ACTIVE alert, but allows it once the first is done", async () => {
    await insertAlert();
    await expect(insertAlert()).rejects.toThrow(/price_alerts_active_unique_idx/);
    await execute("UPDATE price_alerts SET status = 'cancelled'");
    await insertAlert();
    const rows = await query<{ status: string }>("SELECT status FROM price_alerts ORDER BY created_at");
    expect(rows.map((r) => r.status).sort()).toEqual(["active", "cancelled"]);
  });

  it("treats 4000 and 4000.00 as the same active alert (NUMERIC equality)", async () => {
    await insertAlert({ value: "4000" });
    await expect(insertAlert({ value: "4000.00" })).rejects.toThrow(/price_alerts_active_unique_idx/);
  });
});
