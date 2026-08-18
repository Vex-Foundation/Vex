/**
 * Migration 081 vocabulary - `swap_prequotes.kind` admits the four Morpho Blue
 * borrow-lane operations, against a REAL local Postgres with the full 029..081
 * chain applied. The invariant genuinely lives in SQL (a CHECK constraint), so
 * a mocked client would prove nothing about it.
 *
 * Pins:
 *   - a row INSERTs for each of the four new kinds;
 *   - NEGATIVE: an unknown kind is still REJECTED, so 081 widened the CHECK
 *     rather than removing it, and the `agent_activity` role name
 *     'lend_borrow_operate' is NOT a prequote kind (the gate resolves per
 *     operation; only the ledger reads the lane as one activity);
 *   - the pre-081 kinds, including 080's two, still insert, pinning
 *     expand-only.
 */
import { afterEach, describe, expect, it } from "vitest";

import { execute, queryOne } from "@vex-agent/db/client.js";

const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdSessionIds.length === 0) return;
  const ids = createdSessionIds.splice(0, createdSessionIds.length);
  // `swap_prequotes.session_id` is ON DELETE CASCADE, so the session delete
  // takes its prequotes with it.
  await execute(`DELETE FROM sessions WHERE id = ANY($1::text[])`, [ids]);
});

async function seedSession(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (id) VALUES (gen_random_uuid()::text) RETURNING id`,
    [],
  );
  if (!row) throw new Error("migration 081 test: failed to seed a session");
  createdSessionIds.push(row.id);
  return row.id;
}

async function insertPrequote(kind: string): Promise<unknown> {
  const sessionId = await seedSession();
  return queryOne<{ prequote_id: string }>(
    `INSERT INTO swap_prequotes
       (prequote_id, session_id, match_hash, kind, family, provider, chain_id,
        wallet_address, token_in, token_out, amount, safety_verdict,
        safety_detail, expires_at)
     VALUES (gen_random_uuid()::text, $1, 'match-081', $2, 'eip155', 'morpho', 8453,
             '0xWALLET081', 'TOKEN_IN', 'TOKEN_OUT', '1', 'pass',
             '{}'::jsonb, NOW() + INTERVAL '5 minutes')
     RETURNING prequote_id`,
    [sessionId, kind],
  );
}

describe("migration 081 - swap_prequotes borrow kinds", () => {
  it("a prequote row inserts for each Morpho Blue borrow-lane operation", async () => {
    for (const kind of [
      "lend_supply_collateral",
      "lend_withdraw_collateral",
      "lend_borrow",
      "lend_repay",
    ]) {
      const row = await insertPrequote(kind);
      expect(row, `${kind} was rejected by swap_prequotes_kind_check`).toBeTruthy();
    }
  });

  it("NEGATIVE: an unknown kind is still rejected", async () => {
    for (const kind of [
      "lend_borrow_operate",
      "lend_authorize",
      "borrow",
      "morpho_borrow",
      "",
    ]) {
      await expect(insertPrequote(kind), `${kind} was wrongly admitted`).rejects.toThrow();
    }
  });

  it("081 is expand-only: the pre-existing kinds still insert", async () => {
    for (const kind of [
      "swap",
      "bridge",
      "lp_add",
      "lp_remove",
      "sy_mint",
      "lp_to_pt",
      "lend_deposit",
      "lend_withdraw",
    ]) {
      const row = await insertPrequote(kind);
      expect(row, `${kind} was dropped from swap_prequotes_kind_check`).toBeTruthy();
    }
  });
});
