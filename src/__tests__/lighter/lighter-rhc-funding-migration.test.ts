import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  new URL(
    "../../vex-agent/db/migrations/101_lighter_rhc_funding_preflight.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("RHC funding preflight migration", () => {
  it("allows only the environment-bound Core USDC and RHC USDG identities", () => {
    expect(SQL).toContain("environment = 'core'");
    expect(SQL).toContain("chain_id = 1");
    expect(SQL).toContain("settlement_token_symbol = 'USDC'");
    expect(SQL).toContain("environment = 'rhc'");
    expect(SQL).toContain("chain_id = 4663");
    expect(SQL).toContain("settlement_token_symbol = 'USDG'");
    expect(SQL.toLowerCase()).toContain("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
  });

  it("binds the durable public snapshot to the exact zero-value action", () => {
    expect(SQL).toContain("preflight_public_snapshot JSONB");
    expect(SQL).toContain("'beneficiaryAddress'");
    expect(SQL).toContain("'depositCalldata'");
    expect(SQL).toContain("'depositValueWei'");
    expect(SQL).toContain("preflight_public_snapshot->>'depositValueWei' = '0'");
    expect(SQL).toContain("LOWER(preflight_public_snapshot->>'beneficiaryAddress') = LOWER(deposit_to)");
  });
});
