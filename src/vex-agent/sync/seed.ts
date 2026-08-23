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

  // Agent Scan repair sweep (plan §4.1/§11.1) — re-checks pending
  // agent_activity rows by persisted tx_hash. Lookup-only; see
  // sync/agent-activity-repair.ts.
  { namespace: "_global", syncType: "agent_activity_repair", readToolId: null, strategy: "periodic", intervalSeconds: 30 },

  // Phase-2 bridge order-status sweep — re-checks pending bridge logical rows by
  // provider_order_id (Khalani/Relay), independently verifies fills before
  // confirming, never ages pending→failed. Lookup-only; see
  // sync/bridge-activity-repair.ts. Cadence mirrors the Phase-1 repair sweep.
  { namespace: "_global", syncType: "bridge_activity_repair", readToolId: null, strategy: "periodic", intervalSeconds: 120 },

  // W5 (agent-scan-phase3 migration 049) — re-checks pending Solana-family
  // agent_activity rows (Jupiter swap/lend/prediction + Solana bridge legs)
  // by persisted signature, family-disjoint from the EVM repair sweep and
  // the bridge order-status sweep. Lookup-only; see
  // sync/solana-activity-repair.ts (K3). ON CONFLICT DO NOTHING makes this
  // safe to seed now even though the worker branch does not exist yet —
  // worker.ts logs "Unknown sync type" and skips until K3 lands.
  { namespace: "_global", syncType: "solana_activity_repair", readToolId: null, strategy: "periodic", intervalSeconds: 30 },

  // Trench launch identity sweep — completes the TOKEN IDENTITY of a create
  // that mined after the handler died, and terminalizes one later proven to
  // have reverted. The generic activity sweep cannot do this: it is status-only
  // and decodes nothing, so it would confirm the activity row and still leave
  // `launched_tokens` empty. Lookup-only, never signs; see
  // sync/launch-identity-repair.ts. Cadence mirrors the other two per-tx repair
  // sweeps (30s) — a user staring at a launch with no address is the wait this
  // ends, so it is not slowed to the bridge sweep's 120s provider cadence.
  { namespace: "_global", syncType: "launch_identity_repair", readToolId: null, strategy: "periodic", intervalSeconds: 30 },

  // Trench launch ATTRIBUTION retry lane — claims the VEX badge on trench.express
  // for launched tokens whose creator signature is stored but whose POST has not
  // succeeded yet (app closed, network down, provider 5xx). The handler does this
  // inline on a healthy launch; this is the catch-up. Never signs; see
  // sync/launch-attribution.ts. 120s mirrors the bridge sweep's provider cadence —
  // a badge is cosmetic, so it is not given the 30s per-tx repair urgency.
  { namespace: "_global", syncType: "launch_attribution", readToolId: null, strategy: "periodic", intervalSeconds: 120 },

  // pools.fun launch ATTRIBUTION retry lane - the same catch-up for the
  // pools.fun VEX badge, against a different partner and a different attest
  // string. The handler does this inline on a healthy launch; this covers the
  // app being closed, the network being down, or a partner 429/5xx. Never
  // signs, and claims no rows at all while services.poolsFunAttestApiUrl is
  // empty. See sync/pools-attribution.ts. 120s mirrors the trench lane above -
  // a badge is cosmetic, so it is not given the 30s per-tx repair urgency.
  { namespace: "_global", syncType: "pools_attribution", readToolId: null, strategy: "periodic", intervalSeconds: 120 },

  // Trench launch FORM EXPIRY — stamps overdue `awaiting_user_form` intents
  // `expired` and resumes the agent turn parked on them. Without it an
  // unanswered form parks a turn forever. Deadline-driven and lookup-only;
  // never signs. See sync/launch-form-expiry.ts. 60s: the window is minutes
  // long, so a sub-minute cadence would only add lock traffic.
  { namespace: "_global", syncType: "launch_form_expiry", readToolId: null, strategy: "periodic", intervalSeconds: 60 },

  // AgentScan reporting lane — diff-scans agent_activity into agentscan_outbox
  // and drains due rows to the AgentScan ingest API (pseudonymous; dark until
  // services.agentscanApiUrl is configured). Never signs, never blocks the
  // money path; offline just accumulates outbox rows. 30s mirrors the per-tx
  // repair cadence so a confirmed swap reaches the public feed promptly.
  // See sync/agentscan-report.ts.
  { namespace: "_global", syncType: "agentscan_report", readToolId: null, strategy: "periodic", intervalSeconds: 30 },

  // AgentScan token-ATTESTATION sweep — delivers the SAME creator signature
  // already stored for the trench.express VEX badge (attest_signature,
  // migration 071) to the AgentScan attestation registry, over its own
  // keyless POST. Cloned from the trench attribution sweep's architecture;
  // dark until services.agentscanApiUrl is configured. Never signs, never
  // blocks the money path. 300s: an attestation badge is not latency-critical
  // (unlike the 30s per-tx repair sweeps), so 5 minutes is politeness rather
  // than urgency — matching the reporting lane's own non-urgent cadences.
  // See sync/agentscan-attest.ts.
  { namespace: "_global", syncType: "agentscan_attest", readToolId: null, strategy: "periodic", intervalSeconds: 300 },

  // Wave P — post-terminalization portfolio snapshot. ENQUEUED, never timed
  // (`intervalSeconds: null`, `post_mutation`): the fast lane and the repair
  // sweeps enqueue it the moment a transaction terminalizes, so the portfolio
  // takes a fresh, settled snapshot immediately instead of waiting up to 300s
  // for the periodic `balances` job. It re-checks the group-wide no-pending
  // guard when it runs and re-defers if another transaction is still in flight —
  // a partial snapshot group is never emitted. See sync/balance-sync.ts.
  { namespace: "_global", syncType: "balances_snapshot", readToolId: null, strategy: "post_mutation", intervalSeconds: null },

  // Per-namespace post_mutation triggers (runtime.ts capture hook finds these by namespace)
  { namespace: "khalani", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  { namespace: "solana", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  { namespace: "kyberswap", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  // Relay bridge post-mutation balance refresh (khalani parity, B8). The W4 sweep
  // enqueues this job by execution id on a verified pending→confirmed; this
  // post_mutation entry is the job the enqueue targets (getJobsForNamespace("relay")).
  { namespace: "relay", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
  // Pendle trades can land on chains Khalani cannot scan; the post-mutation run
  // derives the traded chain from _tradeCapture.chain and selectively refreshes
  // it (enrich/seed) so PT balances appear immediately instead of at the next
  // periodic _global cycle.
  { namespace: "pendle", syncType: "balances", readToolId: "khalani.tokens.balances", strategy: "post_mutation", intervalSeconds: null },
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
