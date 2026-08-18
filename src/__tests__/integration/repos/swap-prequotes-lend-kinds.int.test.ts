/**
 * Migration 080 vocabulary - `swap_prequotes.kind` admits the two Morpho vault
 * lend directions, against a REAL local Postgres with the full 029..080 chain
 * applied. The invariant genuinely lives in SQL (a CHECK constraint), so a
 * mocked client would prove nothing about it.
 *
 * Pins:
 *   - a row with `kind = 'lend_deposit'` and one with `kind = 'lend_withdraw'`
 *     INSERT;
 *   - NEGATIVE: an unknown kind is still REJECTED, so 080 widened the CHECK
 *     rather than removing it;
 *   - NEGATIVE: the 054 kinds and `swap` still insert, pinning expand-only.
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
  if (!row) throw new Error("migration 080 test: failed to seed a session");
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
     VALUES (gen_random_uuid()::text, $1, 'match-080', $2, 'eip155', 'morpho', 8453,
             '0xWALLET080', 'TOKEN_IN', 'TOKEN_OUT', '1', 'pass',
             '{}'::jsonb, NOW() + INTERVAL '5 minutes')
     RETURNING prequote_id`,
    [sessionId, kind],
  );
}

describe("migration 080 - swap_prequotes lend kinds", () => {
  it("a prequote row inserts for each Morpho vault lend direction", async () => {
    for (const kind of ["lend_deposit", "lend_withdraw"]) {
      const row = await insertPrequote(kind);
      expect(row, `${kind} was rejected by swap_prequotes_kind_check`).toBeTruthy();
    }
  });

  it("NEGATIVE: an unknown kind is still rejected", async () => {
    for (const kind of ["lend", "lend_borrow_operate", "morpho_deposit", ""]) {
      await expect(insertPrequote(kind), `${kind} was wrongly admitted`).rejects.toThrow();
    }
  });

  it("080 is expand-only: the pre-existing kinds still insert", async () => {
    for (const kind of ["swap", "bridge", "lp_add", "lp_remove", "sy_mint", "lp_to_pt"]) {
      const row = await insertPrequote(kind);
      expect(row, `${kind} was dropped from swap_prequotes_kind_check`).toBeTruthy();
    }
  });
});
