import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "src/vex-agent/db/migrations/081_lighter_order_execution_intents.sql"),
  "utf-8",
);

describe("Lighter order execution intents migration", () => {
  it("creates a preview-linked approval-gated intent table", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS lighter_order_execution_intents/i);
    expect(migration).toMatch(/preview_id\s+TEXT NOT NULL REFERENCES lighter_order_previews\(preview_id\) ON DELETE RESTRICT/i);
    expect(migration).toMatch(/approval_id\s+TEXT UNIQUE REFERENCES approval_queue\(id\) ON DELETE SET NULL/i);
    expect(migration).toMatch(/protocol_execution_id\s+BIGINT REFERENCES protocol_executions\(id\) ON DELETE RESTRICT/i);
    expect(migration).toMatch(/api_key_index\s+INTEGER NOT NULL CHECK \(api_key_index >= 4 AND api_key_index <= 254\)/i);
  });

  it("keeps execution state separate from approval status", () => {
    expect(migration).toMatch(/approval_status\s+TEXT NOT NULL DEFAULT 'approval_pending'/i);
    expect(migration).toMatch(/execution_state\s+TEXT NOT NULL DEFAULT 'approval_pending'/i);
    expect(migration).toContain("'api_accepted'");
    expect(migration).toContain("'sequencer_pending'");
    expect(migration).toContain("'ambiguous'");
  });

  it("records only opaque credential references and not secrets or payloads", () => {
    expect(migration).toMatch(/credential_ref_json\s+JSONB NOT NULL/i);
    expect(migration).not.toMatch(/private_key/i);
    expect(migration).not.toMatch(/auth_token/i);
    expect(migration).not.toMatch(/signed_transaction/i);
    expect(migration).not.toMatch(/send_tx/i);
  });

  it("prevents more than one live approval intent for a preview", () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_live_preview/i);
    expect(migration).toMatch(/ON lighter_order_execution_intents \(session_id, preview_id\)/i);
    expect(migration).toMatch(/WHERE approval_status IN \('approval_pending','approved'\)/i);
  });
});
