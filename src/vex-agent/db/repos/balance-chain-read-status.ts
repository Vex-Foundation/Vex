/** Balance read failure and incomplete discovery are independent of cached value. */
import { getPool } from "../client.js";
import { jsonb } from "../params.js";

export interface ChainReadObservation {
  readonly chainId: number;
  readonly status: "ok" | "read_failed" | "inventory_incomplete";
  /** Null only when both the read and discovery succeeded. */
  readonly reason: string | null;
}

export async function recordChainReadObservations(
  walletAddress: string,
  observations: readonly ChainReadObservation[],
): Promise<void> {
  if (observations.length === 0) return;
  await getPool().query(
    `INSERT INTO proj_balance_chain_read_status
       (wallet_address, chain_id, last_attempt_at, last_success_at, stale_since, failure_reason, read_status)
     SELECT $1, o.chain_id, NOW(),
            CASE WHEN o.status != 'read_failed' THEN NOW() ELSE NULL END,
            CASE WHEN o.status = 'ok' THEN NULL ELSE NOW() END, o.reason, o.status
       FROM jsonb_to_recordset($2::jsonb) AS o(chain_id bigint, reason text, status text)
     ON CONFLICT (wallet_address, chain_id) DO UPDATE SET
       last_attempt_at = EXCLUDED.last_attempt_at,
       last_success_at = CASE WHEN EXCLUDED.read_status != 'read_failed'
         THEN EXCLUDED.last_success_at ELSE proj_balance_chain_read_status.last_success_at END,
       stale_since = CASE WHEN EXCLUDED.read_status = 'ok' THEN NULL
         WHEN EXCLUDED.read_status != proj_balance_chain_read_status.read_status THEN EXCLUDED.stale_since
         ELSE COALESCE(proj_balance_chain_read_status.stale_since, EXCLUDED.stale_since) END,
       failure_reason = EXCLUDED.failure_reason, read_status = EXCLUDED.read_status`,
    [walletAddress, jsonb(observations.map(({ chainId, reason, status }) => ({
      chain_id: chainId, reason, status,
    })))],
  );
}
