import { createHash } from "node:crypto";
import { getPool, type Executor } from "@vex-agent/db/client.js";

/** Allow transient providers three recovery cycles without freezing history indefinitely. */
export const MAX_CHAIN_READ_DEFERRAL_CYCLES = 3;

/**
 * Count consecutive failed full reads for the same wallet set, not the random
 * publication id. Persisted so an application restart cannot restart the wait.
 * Saturation means a continuing outage publishes partial on every later cycle.
 */
export async function shouldDeferFailedChainReads(
  wallets: readonly { family: string; address: string }[],
  unresolvedChainCount: number,
  executor: Executor = getPool(),
): Promise<boolean> {
  if (wallets.length === 0) return false;
  const scope = [...new Set(wallets.map(({ family, address }) => JSON.stringify([family, address])))].sort();
  const key = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
  const { rows } = await executor.query<{ consecutive_failure_cycles: number }>(`
    INSERT INTO proj_snapshot_read_deferrals (wallet_scope_key, consecutive_failure_cycles)
    VALUES ($1, CASE WHEN $2::boolean THEN 1 ELSE 0 END)
    ON CONFLICT (wallet_scope_key) DO UPDATE SET
      consecutive_failure_cycles = CASE WHEN $2::boolean
        THEN LEAST(proj_snapshot_read_deferrals.consecutive_failure_cycles + 1, $3)
        ELSE 0 END,
      updated_at = NOW()
    RETURNING consecutive_failure_cycles`,
  [key, unresolvedChainCount > 0, MAX_CHAIN_READ_DEFERRAL_CYCLES + 1]);
  const cycles = rows[0]?.consecutive_failure_cycles;
  if (rows.length !== 1 || typeof cycles !== "number" || !Number.isInteger(cycles) || cycles < 0 || cycles > MAX_CHAIN_READ_DEFERRAL_CYCLES + 1) {
    throw new Error("snapshot_read_deferral_write_failed");
  }
  return unresolvedChainCount > 0 && cycles <= MAX_CHAIN_READ_DEFERRAL_CYCLES;
}
