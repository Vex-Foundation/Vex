import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../vex-agent/db/migrations/106_lighter_rhc_withdrawal_claims.sql", import.meta.url),
  "utf8",
);

describe("Lighter RHC withdrawal claim migration", () => {
  it("locks complete Core and RHC manual-claim identities as pairwise alternatives", () => {
    expect(sql).toContain("lighter_withdrawal_claim_attempts_environment_identity_check");
    expect(sql).toContain("operation_class = 'manual_core_usdc_claim'");
    expect(sql).toContain("settlement_chain_id = 1");
    expect(sql).toContain("asset_symbol = 'USDC'");
    expect(sql).toContain("operation_class = 'manual_rhc_usdg_claim'");
    expect(sql).toContain("settlement_chain_id = 4663");
    expect(sql).toContain("asset_symbol = 'USDG'");
    expect(sql).toContain("0x94bab9693ba2f6358507effcbd372b0660afff9d");
    expect(sql).toContain("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  it("does not weaken amount, asset index, decimals, value, or fee constraints", () => {
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_amount_units_check/);
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_asset_index_check/);
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_asset_decimals_check/);
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_value_wei_check/);
    expect(sql).not.toMatch(/DROP CONSTRAINT IF EXISTS lighter_withdrawal_claim_attempts_network_fee_ceiling_wei_check/);
  });
});
