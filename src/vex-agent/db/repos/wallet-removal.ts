import type { PoolClient } from "pg";
import type { WalletRemovalRecord } from "../../../tools/wallet/lifecycle.js";
import { WalletLifecycleError } from "../../../tools/wallet/lifecycle.js";
import { hasExecutingMoneyForRemoval } from "./approval-intents/money-state.js";

export interface RemovalDependencies { readonly sessionIds: string[]; readonly missionCount: number }
type WalletIdentity = Pick<WalletRemovalRecord, "family" | "entry">;
const addressesFor = (record: WalletIdentity): string[] => record.family === "evm"
  ? [...new Set([record.entry.address, record.entry.address.toLowerCase()])] : [record.entry.address];

/** Bounded waits, stable table order, and real writer exclusion through dependency retirement. */
export async function lockRemovalDependencies(client: PoolClient): Promise<void> {
  await client.query("SET LOCAL lock_timeout = '1500ms'");
  await client.query(`LOCK TABLE agent_activity, approval_intents, approval_queue,
    lighter_integration_settings, lighter_onboarding_intents, lighter_onboarding_workflows,
    loop_wake_requests, mission_runs, missions, project_wallets, projects, protocol_executions, runner_leases,
    runtime_control_requests, sessions,
    wallet_intents, wallet_transaction_intents, wallet_wrap_intents IN SHARE ROW EXCLUSIVE MODE`);
}

export async function inspectRemovalDependencies(client: PoolClient, record: WalletIdentity): Promise<RemovalDependencies> {
  const addresses = addressesFor(record);
  const connection = await client.query(`SELECT 1 FROM lighter_integration_settings WHERE wallet_address = ANY($1::text[])
    UNION ALL SELECT 1 FROM lighter_onboarding_workflows WHERE wallet_address = ANY($1::text[])
    UNION ALL SELECT 1 FROM lighter_onboarding_intents WHERE wallet_address = ANY($1::text[])
    LIMIT 1`, [addresses]);
  if (connection.rows.length > 0) throw new WalletLifecycleError("This wallet has a trading connection. Removing connected wallets is not supported yet.");
  const sessions = await client.query<{ id: string }>(`WITH affected_missions AS (
    SELECT id, root_session_id FROM missions WHERE allowed_wallets && $2::text[]
      OR root_session_id IN (SELECT id FROM sessions WHERE selected_evm_wallet_id = $1 OR selected_solana_wallet_id = $1)
  ) SELECT id FROM sessions WHERE selected_evm_wallet_id = $1 OR selected_solana_wallet_id = $1
      OR selected_evm_wallet_address = ANY($2::text[]) OR selected_solana_wallet_address = ANY($2::text[])
    UNION SELECT root_session_id FROM affected_missions
    UNION SELECT session_id FROM mission_runs WHERE mission_id IN (SELECT id FROM affected_missions)
    UNION SELECT p.backing_session_id FROM projects p JOIN project_wallets w ON w.project_id = p.id
      WHERE w.wallet_id = $1 OR w.address = ANY($2::text[])
    UNION SELECT session_id FROM wallet_intents WHERE wallet_address = ANY($2::text[])
    UNION SELECT session_id FROM wallet_transaction_intents WHERE wallet_address = ANY($2::text[])
    UNION SELECT session_id FROM wallet_wrap_intents WHERE wallet_address = ANY($2::text[])
    UNION SELECT session_id FROM agent_activity WHERE wallet_address = ANY($2::text[]) AND session_id IS NOT NULL`, [record.entry.id, addresses]);
  const sessionIds = sessions.rows.map((row) => row.id);
  const unscoped = await client.query(`SELECT 1 FROM protocol_executions WHERE session_id IS NULL AND execution_status = 'intent'
    UNION ALL SELECT 1 FROM agent_activity WHERE wallet_address = ANY($1::text[]) AND status = 'pending' LIMIT 1`, [addresses]);
  if (unscoped.rows.length > 0) throw new WalletLifecycleError("A transaction outcome is unresolved. Reconcile it before removing this wallet.");
  const running = await client.query(`SELECT 1 FROM runner_leases
    WHERE session_id = ANY($1::text[]) AND expires_at > NOW() LIMIT 1`, [sessionIds]);
  if (running.rows.length > 0) throw new WalletLifecycleError("An affected agent run is active. Stop it or wait for it to finish before removing this wallet.");
  if (await hasExecutingMoneyForRemoval(client, sessionIds)) throw new WalletLifecycleError("A transaction is running or its outcome is unresolved. Reconcile it before removing this wallet.");
  const missions = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM missions
    WHERE (allowed_wallets && $1::text[] OR root_session_id = ANY($2::text[]))
      AND status NOT IN ('completed','failed','cancelled')`, [addresses, sessionIds]);
  return { sessionIds, missionCount: Number(missions.rows[0]?.count ?? "0") };
}

/** Idempotent, local-only retirement. No submitted transaction or public history is deleted. */
export async function retireRemovalDependencies(client: PoolClient, record: WalletRemovalRecord, dependencies: RemovalDependencies): Promise<void> {
  const ids = dependencies.sessionIds;
  await client.query(`UPDATE approval_queue SET status = 'rejected', resolved_at = NOW()
    WHERE session_id = ANY($1::text[]) AND status = 'pending'`, [ids]);
  await client.query(`UPDATE approval_intents SET decision = 'rejected_stop', decision_reason = 'wallet_removed', decided_at = NOW(),
    refusal_reason = CASE WHEN origin = 'studio_mcp' THEN 'scope_unavailable' ELSE refusal_reason END
    WHERE session_id = ANY($1::text[]) AND decision IS NULL AND execution_status = 'not_started'`, [ids]);
  for (const table of ["wallet_intents", "wallet_transaction_intents", "wallet_wrap_intents"] as const) {
    await client.query(`UPDATE ${table} SET status = 'cancelled' WHERE session_id = ANY($1::text[]) AND status = 'pending' AND tx_hash IS NULL`, [ids]);
  }
  const addresses = addressesFor(record);
  await client.query(`UPDATE missions SET allowed_wallets = ARRAY(SELECT address FROM unnest(allowed_wallets) address WHERE NOT address = ANY($1::text[])), updated_at = NOW()
    WHERE (allowed_wallets && $1::text[] OR root_session_id = ANY($2::text[]))
      AND status NOT IN ('completed','failed','cancelled')`, [addresses, ids]);
  await client.query(`UPDATE mission_runs SET status = 'paused_user', stop_reason = 'wallet_removed'
    WHERE session_id = ANY($1::text[]) AND status NOT IN ('completed','failed','cancelled','stopped')`, [ids]);
  await client.query(`UPDATE loop_wake_requests SET status = 'cancelled', cancelled_at = NOW(), cancelled_reason = 'wallet_removed'
    WHERE session_id = ANY($1::text[]) AND status = 'pending'`, [ids]);
  await client.query(`UPDATE runtime_control_requests SET status = 'failed', cleared_at = NOW(), reason = 'wallet_removed'
    WHERE session_id = ANY($1::text[]) AND status IN ('pending','observed')`, [ids]);
}
