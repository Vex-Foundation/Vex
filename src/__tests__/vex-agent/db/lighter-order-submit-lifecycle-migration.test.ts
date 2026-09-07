import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/082_lighter_order_submit_lifecycle.sql"),
  "utf-8",
);

describe("Lighter order submit lifecycle migration", () => {
  it("adds safe submit lifecycle metadata columns", () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS signer_tx_hash TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS submitted_tx_hash TEXT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS submit_code INTEGER/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS predicted_execution_time_ms INTEGER/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS volume_quota_remaining BIGINT/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS api_accepted_at TIMESTAMPTZ/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS ambiguous_at TIMESTAMPTZ/i);
  });

  it("updates the trading API-key range without breaking old local rows", () => {
    expect(migration).toMatch(/DROP CONSTRAINT IF EXISTS lighter_order_execution_intents_api_key_index_check/i);
    expect(migration).toMatch(/CHECK \(api_key_index >= 4 AND api_key_index <= 254\) NOT VALID/i);
  });

  it("keeps submit acceptance separate from terminal provider outcomes", () => {
    expect(migration).toContain("execution_state = 'api_accepted'");
    expect(migration).toContain("execution_state = 'ambiguous'");
    expect(migration).not.toContain("filled");
    expect(migration).not.toContain("canceled");
  });

  it("does not add storage for secrets, signatures, or submit bodies", () => {
    expect(migration).not.toMatch(/private_key/i);
    expect(migration).not.toMatch(/auth_token/i);
    expect(migration).not.toMatch(/signature/i);
    expect(migration).not.toMatch(/tx_info/i);
    expect(migration).not.toMatch(/send_tx_payload/i);
  });
});
