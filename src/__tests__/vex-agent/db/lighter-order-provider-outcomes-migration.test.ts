import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/083_lighter_order_provider_outcomes.sql"),
  "utf-8",
);

describe("Lighter order provider outcomes migration", () => {
  it("adds bounded provider outcome repair metadata", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS client_order_index TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS provider_order_id TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS provider_order_status TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS provider_outcome_source TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS provider_outcome_json JSONB/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS provider_outcome_checked_at TIMESTAMPTZ/i);
  });

  it("keeps provider outcome evidence separate from signed submit payloads", () => {
    expect(migration).toContain("'active_order'");
    expect(migration).toContain("'inactive_order'");
    expect(migration).toContain("'account_trade'");
    expect(migration).toContain("'not_found'");
    expect(migration).not.toMatch(/private_key/i);
    expect(migration).not.toMatch(/auth_token/i);
    expect(migration).not.toMatch(/tx_info/i);
    expect(migration).not.toMatch(/signature/i);
  });

  it("indexes exact client-order lookup for repair", () => {
    expect(migration).toMatch(/idx_lighter_order_execution_intents_client_order/i);
    expect(migration).toMatch(/environment, account_index, client_order_index/i);
  });
});
