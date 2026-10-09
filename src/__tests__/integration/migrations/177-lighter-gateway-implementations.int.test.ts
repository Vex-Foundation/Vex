import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrationsWithProgress } from "../../../lib/db/migrate-runner.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";

const SOURCE = path.resolve("src/vex-agent/db/migrations");
const DATABASE = "vex_177_probe";
const MIGRATION = "177_lighter_gateway_implementations.sql";
const OWNER = `0x${"1".repeat(40)}`;
const HASH = `0x${"a".repeat(64)}`;
const OBSERVED_AT = new Date("2030-01-01T00:00:00Z");
const LEGACY = [
  ["core", "0x8d692294a4824d868e35b3cecd734acf41b2342e"],
  ["rhc", "0xe470e41cacc197ea07f879577765a8c81234ed7b"],
  ["rhc", "0x82de5b1161c93afdfe21ba0d5343f01cd7401d90"],
] as const;
let pool: pg.Pool;
let staging: string;
let sequence = 0;

beforeAll(async () => {
  const base = process.env.VEX_DB_URL;
  if (!base) throw new Error("VEX_DB_URL is unset: isolated PostgreSQL setup required");
  const admin = new pg.Pool({ connectionString: base });
  try {
    expect((await admin.query("SELECT current_database() AS name")).rows).toEqual([{ name: "vex_test" }]);
    await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
    await admin.query(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base);
  url.pathname = `/${DATABASE}`;
  pool = new pg.Pool({ connectionString: url.toString() });
  staging = mkdtempSync(path.join(tmpdir(), "vex-177-"));
  for (const file of readdirSync(SOURCE).filter((name) => /^\d{3}_.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 176)) {
    copyFileSync(path.join(SOURCE, file), path.join(staging, file));
  }
  await runMigrationsWithProgress({ pool, migrationsDir: staging });
  await pool.query("INSERT INTO sessions (id, mode, permission) VALUES ('gateway-review', 'agent', 'full')");
  for (const [environment, implementation] of LEGACY) await seed(environment, implementation);
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

type Table = "lighter_withdrawal_intents" | "lighter_withdrawal_claim_attempts";
async function insert(table: Table, values: Record<string, unknown>) {
  const columns = Object.keys(values);
  await pool.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(values));
}

// Public identity and interrupted-lifecycle fixtures in a disposable database.
async function seed(environment: "core" | "rhc", implementation: string) {
  const deployment = getLighterFundingDeployment(environment);
  const id = `withdrawal-${++sequence}`;
  const identity = {
    session_id: "gateway-review", match_hash: "b".repeat(64),
    settlement_chain_id: deployment.settlementChainId,
    settlement_network_name: deployment.settlementNetworkName,
    wallet_address: OWNER, asset_index: 3, asset_symbol: deployment.settlementSymbol,
    asset_decimals: 6, settlement_token_address: deployment.settlementTokenProxy,
    gateway_address: deployment.gatewayProxy, gateway_implementation: implementation,
    gateway_code_hash: HASH, settlement_token_code_hash: HASH, amount_units: "1000000",
    preflight_json: { fixture: "interrupted", gatewayImplementation: implementation },
    preflight_observed_at: OBSERVED_AT, expires_at: new Date("2030-01-01T00:05:00Z"),
  };
  await insert("lighter_withdrawal_intents", {
    ...identity, intent_id: id, preview_id: `preview-${id}`, environment,
    operation_class: "secure_l2_withdrawal", endpoint: deployment.restBaseUrl,
    signing_chain_id: deployment.lighterSignerChainId, account_index: sequence, api_key_index: 4,
    destination_address: OWNER, credential_ref_json: {}, route_type: 0,
    minimum_withdrawal_units: "1000000", available_balance_units: "2000000",
    collateral_units: "2000000", initial_margin_units: "0", maintenance_margin_units: "0",
    pending_order_count: 0, open_position_count: 0, active_order_count: 0,
    withdrawal_delay_seconds: 0, delay_observed_at: OBSERVED_AT,
    execution_state: "ambiguous", nonce_reservation_id: `reservation-${id}`, nonce_value: "1",
    signer_tx_hash: "fixture-signer-hash", signer_expiry_ms: OBSERVED_AT.getTime(),
    submitted_tx_hash: "fixture-submitted-hash", submit_code: 200,
  });
  await insert("lighter_withdrawal_claim_attempts", {
    ...identity, claim_id: `claim-${id}`, withdrawal_intent_id: id, preview_id: `claim-preview-${id}`,
    operation_class: environment === "core" ? "manual_core_usdc_claim" : "manual_rhc_usdg_claim",
    owner_address: OWNER, calldata: "0x1234", value_wei: "0", preflight_block_number: "1",
    native_balance_wei: "1000000", gas_estimate: "1", gas_limit: "2",
    quoted_max_fee_per_gas_wei: "1", quoted_priority_fee_per_gas_wei: "0",
    fee_ceiling_per_gas_wei: "4", priority_fee_ceiling_wei: "0", network_fee_ceiling_wei: "8",
    state: "ambiguous", tx_hash: HASH, from_address: OWNER, nonce: 1,
    send_attempt_started_at: OBSERVED_AT,
  });
}

async function rows(table: Table) {
  return (await pool.query(`SELECT * FROM ${table} ORDER BY preview_id`)).rows;
}

describe("migration 177 on populated withdrawal and claim tables", () => {
  it("accepts the reviewed replacements without rewriting any historical evidence", async () => {
    expect((await pool.query("SELECT max(version) AS version FROM schema_version")).rows).toEqual([{ version: 176 }]);
    for (const [environment, previous] of LEGACY) {
      await expect(pool.query("UPDATE lighter_withdrawal_intents SET gateway_implementation=$1 WHERE gateway_implementation=$2", [
        getLighterFundingDeployment(environment).expectedGatewayImplementation, previous,
      ])).rejects.toThrow(/environment_identity_check/);
    }
    const before = [await rows("lighter_withdrawal_intents"), await rows("lighter_withdrawal_claim_attempts")];
    copyFileSync(path.join(SOURCE, MIGRATION), path.join(staging, MIGRATION));
    expect((await runMigrationsWithProgress({ pool, migrationsDir: staging })).files).toEqual([MIGRATION]);
    expect([await rows("lighter_withdrawal_intents"), await rows("lighter_withdrawal_claim_attempts")]).toEqual(before);
    expect((await runMigrationsWithProgress({ pool, migrationsDir: staging })).applied).toBe(0);
    await pool.query(readFileSync(path.join(SOURCE, MIGRATION), "utf8"));
    expect([await rows("lighter_withdrawal_intents"), await rows("lighter_withdrawal_claim_attempts")]).toEqual(before);
  });

  it.each(["core", "rhc"] as const)("persists new %s withdrawals and claims", async (environment) => {
    const implementation = getLighterFundingDeployment(environment).expectedGatewayImplementation;
    if (!implementation) throw new Error("Reviewed implementation missing");
    await seed(environment, implementation);
    for (const table of ["lighter_withdrawal_intents", "lighter_withdrawal_claim_attempts"] as const) {
      expect((await pool.query(`SELECT gateway_implementation FROM ${table} WHERE gateway_implementation=$1`, [implementation])).rows)
        .toEqual([{ gateway_implementation: implementation }]);
    }
  });

  it.each(["core", "rhc"] as const)("keeps unknown and cross-environment %s identities prohibited", async (environment) => {
    const deployment = getLighterFundingDeployment(environment);
    const other = getLighterFundingDeployment(environment === "core" ? "rhc" : "core");
    for (const table of ["lighter_withdrawal_intents", "lighter_withdrawal_claim_attempts"] as const) {
      for (const replacement of [OWNER, other.expectedGatewayImplementation]) {
        await expect(pool.query(`UPDATE ${table} SET gateway_implementation=$1 WHERE gateway_implementation=$2`, [replacement, deployment.expectedGatewayImplementation]))
          .rejects.toThrow(/environment_identity_check/);
      }
      await expect(pool.query(`UPDATE ${table} SET settlement_token_address=$1 WHERE gateway_implementation=$2`, [other.settlementTokenProxy, deployment.expectedGatewayImplementation]))
        .rejects.toThrow(/environment_identity_check/);
    }
  });
});
