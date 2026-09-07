import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_PATH = resolve(
  process.cwd(),
  "src/vex-agent/db/migrations/109_migration_079_084_collision_repair.sql"
);
const MIRROR_PATH = resolve(
  process.cwd(),
  "vex-app/resources/migrations/109_migration_079_084_collision_repair.sql"
);
const migration = readFileSync(SOURCE_PATH, "utf8");

describe("migration 109 — 079-084 collision repair", () => {
  it("names every shipped colliding file whose schema it repairs", () => {
    for (const file of [
      "079_agent_activity_evm_lend",
      "079_lighter_nonce_state",
      "080_lighter_order_previews",
      "080_swap_prequotes_lend_kinds",
      "081_lighter_order_execution_intents",
      "081_swap_prequotes_borrow_kinds",
      "082_lighter_order_submit_lifecycle",
      "082_pools_fun_launch",
      "083_launch_image_onchain_variant",
      "083_lighter_order_provider_outcomes",
      "084_agent_activity_wallet_transfer",
      "084_lighter_order_pre_submit_revalidation",
    ]) {
      expect(migration).toContain(file);
    }
  });

  it("repairs the durable Lighter tables, lifecycle columns, and indexes", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS lighter_nonce_state/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS lighter_order_previews/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS lighter_order_execution_intents/i);
    for (const column of [
      "signer_tx_hash",
      "provider_outcome_json",
      "pre_submit_revalidation_json",
    ]) {
      expect(migration).toMatch(
        new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, "i")
      );
    }
    expect(migration).toContain(
      "idx_lighter_order_execution_intents_client_order"
    );
  });

  it("installs the final union of Morpho, pools.fun, and transfer predicates", () => {
    for (const value of [
      "lend_supply_collateral",
      "lend_repay",
      "pools_claim",
      "wallet_transfer",
      "tx_contract_call",
      "creator_fee_claim",
      "holder_reward_claim",
      "vex_fee",
    ]) {
      expect(migration).toContain(`'${value}'`);
    }
    expect(migration).toMatch(/kind = 'lend'.*'allowance'/s);
    expect(migration).toMatch(/kind = 'transfer'.*'wallet_transfer'/s);
    expect(migration).toMatch(/event_role IN \('pools_claim', 'creator_fee_claim', 'holder_reward_claim'\)/s);
  });

  it("uses re-runnable table, column, index, and named-constraint operations", () => {
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/DROP COLUMN/i);
    expect(migration).not.toMatch(/CREATE TABLE (?!IF NOT EXISTS)/i);
    expect(migration).not.toMatch(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/i);
    expect(migration).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/s);
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS/s);
  });

  it("is byte-identical in the packaged Electron migration mirror", () => {
    expect(readFileSync(MIRROR_PATH, "utf8")).toBe(migration);
  });
});
