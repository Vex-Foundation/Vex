/**
 * WHICH CONFIRMED ROWS STILL OWE THE USER THEIR AMOUNTS — the pending
 * fallback's candidate selection, and the durable marker that stops it from
 * re-deciding the same immutable receipt forever.
 *
 * A different reason to change from `./settlement-enrichment.js`: that module
 * owns WHAT may be written to an already-confirmed row (and enforces the role
 * contract inside its own SQL). This one owns WHEN a row is worth looking at
 * again. One is a money guard, the other is a scheduler.
 *
 * ── The query is a LOOSE PREFILTER, deliberately ────────────────────────────
 *
 * It selects rows that are plausibly incomplete; the authoritative decision is
 * `roleLegsIncomplete` (`./role-legs.js`), IMPORTED and applied by the caller,
 * and then re-enforced inside the writers' own predicates. Mirroring that role
 * contract into SQL here would be a second implementation of a money rule, and
 * the two would drift — a `yield_claim` legitimately has no input leg, and a
 * no-prebuy `token_launch` has a raw output of `"0"` rather than an absent one.
 * One contract, three enforcement points, zero copies.
 *
 * ── The decode marker, and why it stores a VERSION ──────────────────────────
 *
 * A bare `last_decode_attempt_at` could only say "try again later", which for an
 * IMMUTABLE receipt means re-running the identical decode forever. Storing the
 * decoder identity + version instead lets a row become eligible again at exactly
 * the moment that can change the answer: when the decoder changes.
 *
 * IT IS WRITTEN ONLY AFTER A COMPLETED DECLINE, never before the attempt.
 * Claiming first would be a CRASH POISON — a crash between claim and completion
 * would exclude the row from that decoder version permanently, which is a worse
 * failure than the duplicate work it prevents. Duplicate deterministic decoding
 * is harmless here because the fill is a compare-before-fill CAS.
 */

import { execute, query, queryOne } from "../../client.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent } from "./types.js";

/**
 * Confirmed EVM rows that may still be missing executed amounts, oldest
 * observation first so the window rotates instead of re-serving the same rows.
 *
 * `decoderVersion` is the marker gate: a row that already COMPLETED a decline
 * under this exact version is skipped, and becomes a candidate again the moment
 * the version changes.
 */
export async function listAmountCorrectionCandidates(
  limit: number,
  decoderVersion: string,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity
      WHERE status = 'confirmed'
        AND chain_family = 'eip155'
        AND tx_hash IS NOT NULL
        -- A quarantined row is EXCLUDED: two decoders already disagreed about
        -- its money, and re-running one of them cannot settle that dispute.
        AND settlement_source IS DISTINCT FROM 'conflict_quarantined'
        AND settlement_decode_version IS DISTINCT FROM $2
        -- The loose prefilter. roleLegsIncomplete makes the real decision.
        AND (executed_amount_in_raw IS NULL
             OR executed_amount_out_raw IS NULL
             OR (token_in2_address IS NOT NULL AND executed_amount_in2_raw IS NULL)
             OR (token_out2_address IS NOT NULL AND executed_amount_out2_raw IS NULL))
      ORDER BY COALESCE(last_checked_at, confirmed_at, created_at) ASC, id ASC
      LIMIT $1`,
    [limit, decoderVersion],
  );
  return rows.map(mapRow);
}

/**
 * The persisted SENDER AND NONCE of the activity row that carries this hash.
 *
 * Why this exists at all: `token_launch_intents` stores no nonce (migration
 * 062) — only `tx_hash`, `wallet_address` and `chain_id` — so the launch sweep
 * cannot check supersession from its own table. The nonce lives on the sibling
 * `agent_activity` row that `markActivityBroadcast` staged. Reading it by hash is
 * an ESTABLISHED shape here (`stampLaunchOutputIdentityByTxHash` does the same),
 * which is why this is a lookup and not a schema change.
 *
 * `null` when no row carries the hash, and either field may be `null` on a row
 * staged before those columns were populated. Supersession is NEVER inferred
 * from a missing value — the caller's contract is to conclude "unknown" instead.
 */
export async function findBroadcastSenderByTxHash(
  txHash: string,
): Promise<{ fromAddress: string | null; nonce: number | null } | null> {
  const row = await queryOne<{ from_address: string | null; nonce: number | null }>(
    `SELECT from_address, nonce
       FROM agent_activity
      WHERE tx_hash = $1
      ORDER BY id ASC
      LIMIT 1`,
    [txHash],
  );
  if (!row) return null;
  return {
    fromAddress: row.from_address,
    nonce: row.nonce === null ? null : Number(row.nonce),
  };
}

/**
 * Record that this decoder version COMPLETED a decline on this row.
 *
 * Called only after the decline is final, and never on a successful fill — a
 * row that got its amounts is no longer a candidate for the ordinary reason
 * (its legs are complete), so marking it would add a second, redundant reason
 * that could outlive the first.
 *
 * Guarded to `status = 'confirmed'` so this scheduling column can never be
 * stamped on a row whose lifecycle moved underneath the attempt.
 */
export async function noteSettlementDecodeVersion(
  id: number,
  decoderVersion: string,
): Promise<void> {
  await execute(
    `UPDATE agent_activity
        SET settlement_decode_version = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'confirmed'`,
    [id, decoderVersion],
  );
}
