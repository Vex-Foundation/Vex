import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const migration = readFileSync(
  path.join(root, "src/vex-agent/db/migrations/038_hyperliquid_session_policies.sql"),
  "utf8",
);

describe("038 Hyperliquid session policy migration", () => {
  it("keeps proposals immutable in shape and limits an active policy to a session/wallet", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS hyperliquid_session_policies/i);
    expect(migration).toMatch(/proposed_by\s+TEXT NOT NULL CHECK \(proposed_by IN \('agent', 'user'\)\)/i);
    expect(migration).toMatch(/status\s+TEXT NOT NULL CHECK \(status IN \('proposed', 'active', 'expired', 'revoked'\)\)/i);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS idx_hyperliquid_session_policies_one_active/i);
    expect(migration).toMatch(/ON hyperliquid_session_policies \(session_id, wallet_address\)\s+WHERE status = 'active'/i);
  });
});
