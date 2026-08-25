import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../../../vex-agent/db/migrations/108_lighter_rhc_gateway_implementation.sql", import.meta.url),
  "utf8",
);

describe("Lighter RHC gateway implementation migration", () => {
  it("reviews the replacement implementation without invalidating historical rows", () => {
    expect(sql).toContain("lighter_withdrawal_intents_environment_identity_check");
    expect(sql).toContain("lighter_withdrawal_claim_attempts_environment_identity_check");
    expect(sql).toContain("0xe470e41cacc197ea07f879577765a8c81234ed7b");
    expect(sql).toContain("0x82de5b1161c93afdfe21ba0d5343f01cd7401d90");
    expect(sql.match(/LOWER\(gateway_implementation\) IN/g)).toHaveLength(2);
  });

  it("preserves the complete Core and RHC pairwise identities", () => {
    for (const value of [
      "environment = 'core'",
      "operation_class = 'manual_core_usdc_claim'",
      "settlement_chain_id = 1",
      "asset_symbol = 'USDC'",
      "environment = 'rhc'",
      "operation_class = 'manual_rhc_usdg_claim'",
      "signing_chain_id = 466324",
      "settlement_chain_id = 4663",
      "asset_symbol = 'USDG'",
      "0x94bab9693ba2f6358507effcbd372b0660afff9d",
      "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
    ]) expect(sql).toContain(value);
  });
});
