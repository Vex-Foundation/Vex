/**
 * Seed default sync jobs into protocol_sync_jobs.
 *
 * One canonical periodic balance refresh (_global) + per-namespace
 * post_mutation trigger jobs. All backed by Khalani.
 */

import { execute } from "@vex-agent/db/client.js";
import logger from "@utils/logger.js";

const SYNC_JOBS = [
  // Canonical periodic full refresh — every 5 minutes
  { namespace: "_global", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "periodic", intervalSeconds: 300 },

  // Prediction settlement reconciliation — every 5 minutes
  { namespace: "_global", syncType: "prediction_settlement", readToolId: null, strategy: "periodic", intervalSeconds: 300 },

  // Hyperliquid is off-chain state. The reconciler short-circuits before any
  // venue request when no tracked position or resting entry exists.
  { namespace: "_global", syncType: "hyperliquid_reconcile", readToolId: null, strategy: "periodic", intervalSeconds: 60 },

  // Per-namespace post_mutation triggers (runtime.ts capture hook finds these by namespace)
  { namespace: "khalani", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  { namespace: "solana", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  { namespace: "kyberswap", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  { namespace: "polymarket", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  // Pendle trades can land on chains Khalani cannot scan; the post-mutation run
  // derives the traded chain from _tradeCapture.chain and selectively refreshes
  // it (enrich/seed) so PT balances appear immediately instead of at the next
  // periodic _global cycle.
  { namespace: "pendle", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  { namespace: "hyperliquid", syncType: "hyperliquid_reconcile", readToolId: null, strategy: "post_mutation", intervalSeconds: null },
];

/**
 * Seed sync jobs. Idempotent — ON CONFLICT DO NOTHING.
 */
export async function seedSyncJobs(): Promise<void> {
  let seeded = 0;
  for (const job of SYNC_JOBS) {
    const result = await execute(
      `INSERT INTO protocol_sync_jobs (namespace, sync_type, read_tool_id, strategy, interval_seconds)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (namespace, sync_type) DO NOTHING`,
      [job.namespace, job.syncType, job.readToolId, job.strategy, job.intervalSeconds],
    );
    if (result > 0) seeded++;
  }

  if (seeded > 0) {
    logger.info("sync.seed.completed", { seeded, total: SYNC_JOBS.length });
  } else {
    logger.debug("sync.seed.up_to_date");
  }
}
