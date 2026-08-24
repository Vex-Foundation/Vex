/**
 * The mechanics both wallet-intent tables share, and NOTHING else.
 *
 * `wallet_intents` (transfers) and `wallet_transaction_intents` (generic
 * signing) do NOT share a state machine: seven statuses against nine, one
 * evidence rule that says "tx_hash MAY be set" against one that splits three
 * ways on a failure stage, and two different confirms that must not be able to
 * consume each other's rows. Extracting a common lifecycle would mean inventing
 * a superset nobody implements.
 *
 * What genuinely coincides is smaller and real:
 *
 *  - TIMESTAMPTZ normalisation (`pg` hands back `Date`, the DTOs are ISO
 *    strings, and a second spelling of that conversion is a second place for a
 *    timezone bug to live);
 *  - the `rowCount` discipline: every CAS is an `UPDATE ... RETURNING` whose
 *    empty result is a HARD "race lost" signal, never a silent success. A
 *    caller that cannot tell "I claimed it" from "somebody else did" will
 *    eventually broadcast twice.
 *
 * Both are used by both tables, so they live here once.
 */

import type { PoolClient } from "pg";

/** `pg` returns TIMESTAMPTZ as `Date`; every DTO in this layer carries ISO strings. */
export function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

/**
 * Run one CAS `UPDATE ... RETURNING` on the CALLER's transaction and map the
 * row through `mapRow`.
 *
 * `null` means the predicate missed. That is the whole point: the from-status,
 * the owning session, the expiry and (for the transaction table) the proposal
 * digest are all in the WHERE clause, so a `null` return is the single signal
 * that says "the state you assumed is not the state that exists". Callers gate
 * on it; nothing in this layer retries on its own.
 */
export async function casRow<T>(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
  mapRow: (row: Record<string, unknown>) => T,
): Promise<T | null> {
  const res = await client.query<Record<string, unknown>>(sql, [...params]);
  const row = res.rows[0];
  return row === undefined ? null : mapRow(row);
}
