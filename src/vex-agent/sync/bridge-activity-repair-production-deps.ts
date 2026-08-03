/**
 * `bridge-activity-repair.ts` production `BridgeRepairDeps` wiring — split
 * out (Card C5, move-only) once the parent file crossed the repo's 500-line
 * cap. See `bridge-activity-repair.ts`'s own module doc for the full W4
 * design these deps implement: raw fair-scheduling SQL (the bridge sweep
 * queries are NOT part of W-SPINE's repo API and MUST NOT be added to it —
 * this module owns them, reading through the shared `db/client` primitives
 * with a narrow projection), the Khalani/Relay clients, SSRF-controlled RPC
 * verification (`./bridge-activity-repair-verification.js`), the
 * idempotent-by-execution-id balance enqueue, and W5's reveal-clear. Every
 * lazy import mirrors the Phase-1 `buildProductionRepairDeps` shape so the
 * module load stays IO-free.
 */

import {
  confirmBridgeExpectedFill,
  failActivityEvent,
  markBridgeLegObserved,
  attachProviderOrderId,
  touchLastChecked,
  clearVerificationStall,
  type BridgeChainFamily,
} from "@vex-agent/db/repos/agent-activity.js";
import { clearRelayRouteReveal } from "@vex-agent/tools/registry/relay-reveal.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import type { BridgeRepairDeps, BridgeSweepRow } from "./bridge-activity-repair-contracts.js";
import { verifyBridgeLegOnChain } from "./bridge-activity-repair-verification.js";
import { fetchDebridgeFillHash } from "./bridge-activity-repair-debridge-lookup.js";

/** Extract an optional string field from the logical row's `route_provenance` JSONB (quote/route ids). */
function readProvenanceString(provenance: unknown, key: string): string | null {
  if (typeof provenance !== "object" || provenance === null) return null;
  const value = (provenance as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map a raw `agent_activity` logical row (+ joined deposit hash) to the narrow sweep read model. */
function toSweepRow(r: Record<string, unknown>): BridgeSweepRow {
  return {
    id: Number(r.id),
    protocolExecutionId: Number(r.protocol_execution_id),
    protocol: String(r.protocol),
    providerOrderId: r.provider_order_id === null || r.provider_order_id === undefined ? null : String(r.provider_order_id),
    fromChainId: r.from_chain_id === null || r.from_chain_id === undefined ? null : Number(r.from_chain_id),
    toChainId: r.to_chain_id === null || r.to_chain_id === undefined ? null : Number(r.to_chain_id),
    destChainFamily: (r.chain_family as BridgeChainFamily) ?? "eip155",
    tokenInAddress: r.token_in_address === null || r.token_in_address === undefined ? null : String(r.token_in_address),
    tokenOutAddress: r.token_out_address === null || r.token_out_address === undefined ? null : String(r.token_out_address),
    walletAddress: String(r.wallet_address),
    depositTxHash: r.deposit_tx_hash === null || r.deposit_tx_hash === undefined ? null : String(r.deposit_tx_hash),
    quoteId: readProvenanceString(r.route_provenance, "quoteId"),
    routeId: readProvenanceString(r.route_provenance, "routeId"),
    sessionId: r.session_id === null || r.session_id === undefined ? null : String(r.session_id),
    normalizedRoute: r.normalized_route === null || r.normalized_route === undefined ? null : String(r.normalized_route),
    lastAttemptedAt: toIsoOrNull(r.last_attempted_at),
    createdAt: toIso(r.created_at),
  };
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}

/** Read a positive integer field from a provider payload (passthrough boundary validation), else undefined. */
function readOptionalChainId(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Read an optional string[] field from a provider payload (passthrough boundary validation), else undefined. */
function readOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const v of value) if (typeof v === "string") out.push(v);
  return out;
}

/**
 * Real `BridgeRepairDeps`: raw fair-scheduling SQL (the bridge sweep queries are
 * NOT part of W-SPINE's repo API and MUST NOT be added to it — this module owns
 * them, reading through the shared `db/client` primitives with a narrow
 * projection), the Khalani/Relay clients, SSRF-controlled RPC verification, the
 * idempotent-by-execution-id balance enqueue, and W5's reveal-clear. Every lazy
 * import mirrors the Phase-1 `buildProductionRepairDeps` shape so the module load
 * stays IO-free.
 */
export function buildProductionBridgeRepairDeps(): BridgeRepairDeps {
  return {
    listSweepCandidates: async (limit) => {
      const { query } = await import("@vex-agent/db/client.js");
      // The logical row + its sibling `bridge_deposit` staged hash (R6 deposit
      // correlation), fair-scheduled oldest-touched first.
      const rows = await query<Record<string, unknown>>(
        `SELECT lg.*,
                (SELECT dep.tx_hash FROM agent_activity dep
                  WHERE dep.protocol_execution_id = lg.protocol_execution_id
                    AND dep.event_role = 'bridge_deposit'
                    AND dep.tx_hash IS NOT NULL
                  ORDER BY dep.event_index ASC
                  LIMIT 1) AS deposit_tx_hash
           FROM agent_activity lg
          WHERE lg.event_role = 'bridge_fill_expected'
            AND lg.status = 'pending'
            AND lg.provider_order_id IS NOT NULL
          ORDER BY COALESCE(lg.last_attempted_at, lg.created_at) ASC, lg.id ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map(toSweepRow);
    },

    listOrderIdRecoveryCandidates: async (limit) => {
      const { query } = await import("@vex-agent/db/client.js");
      // Pending Khalani logical rows with NO order id yet, whose sibling
      // `bridge_deposit` leg has a staged hash (the crash-after-broadcast window).
      const rows = await query<Record<string, unknown>>(
        `SELECT lg.protocol_execution_id AS execution_id, lg.protocol AS protocol,
                lg.wallet_address AS wallet_address, dep.tx_hash AS deposit_tx_hash,
                lg.from_chain_id AS from_chain_id, lg.to_chain_id AS to_chain_id
           FROM agent_activity lg
           JOIN agent_activity dep
             ON dep.protocol_execution_id = lg.protocol_execution_id
            AND dep.event_role = 'bridge_deposit'
            AND dep.tx_hash IS NOT NULL
          WHERE lg.event_role = 'bridge_fill_expected'
            AND lg.status = 'pending'
            AND lg.provider_order_id IS NULL
            AND lg.protocol = 'khalani'
          ORDER BY COALESCE(lg.last_attempted_at, lg.created_at) ASC, lg.protocol_execution_id ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        executionId: Number(r.execution_id),
        protocol: String(r.protocol),
        walletAddress: String(r.wallet_address),
        depositTxHash: String(r.deposit_tx_hash),
        fromChainId: Number(r.from_chain_id),
        toChainId: Number(r.to_chain_id),
      }));
    },

    listConfirmedNeedingBalanceRefresh: async (limit) => {
      const { query } = await import("@vex-agent/db/client.js");
      // Confirmed logical bridge rows whose execution has NO balance-refresh run
      // for its provider namespace yet (C3 recovery). NO age cutoff (Blocker 11):
      // a row that sat unenqueued through a long outage must still recover. Bounded
      // + fair-ordered by `confirmed_at ASC`; once enqueued it drops out
      // permanently (`protocol_sync_runs` are never deleted). `session_id` +
      // `normalized_route` are returned so recovery can re-clear a stranded reveal.
      const rows = await query<Record<string, unknown>>(
        `SELECT a.protocol_execution_id AS execution_id, a.protocol AS protocol,
                a.session_id AS session_id, a.normalized_route AS normalized_route
           FROM agent_activity a
          WHERE a.event_role = 'bridge_fill_expected'
            AND a.status = 'confirmed'
            AND NOT EXISTS (
              SELECT 1 FROM protocol_sync_runs r
              JOIN protocol_sync_jobs j ON j.id = r.sync_job_id
              WHERE r.execution_id = a.protocol_execution_id
                AND j.sync_type = 'balances'
                AND j.namespace = a.protocol
            )
          ORDER BY a.confirmed_at ASC, a.id ASC
          LIMIT $1`,
        [limit],
      );
      return rows.map((r) => ({
        executionId: Number(r.execution_id),
        protocol: String(r.protocol),
        sessionId: r.session_id === null || r.session_id === undefined ? null : String(r.session_id),
        normalizedRoute: r.normalized_route === null || r.normalized_route === undefined ? null : String(r.normalized_route),
      }));
    },

    touchAttempt: async (executionId) => {
      const { execute } = await import("@vex-agent/db/client.js");
      await execute(
        `UPDATE agent_activity SET last_attempted_at = NOW(), updated_at = NOW()
          WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected' AND status = 'pending'`,
        [executionId],
      );
    },

    touchChecked: async (executionId, providerStatus) => {
      const { execute } = await import("@vex-agent/db/client.js");
      await execute(
        `UPDATE agent_activity SET last_checked_at = NOW(), provider_status = $2, updated_at = NOW()
          WHERE protocol_execution_id = $1 AND event_role = 'bridge_fill_expected' AND status = 'pending'`,
        [executionId, providerStatus],
      );
    },

    // Migration 065 — the W-SPINE repo primitives, keyed by the logical ROW id.
    // No new SQL here: `touchLastChecked` and `clearVerificationStall` already
    // own the increment/reset semantics (and both are guarded to
    // `status = 'pending'`, so a row that terminalized in between is a no-op).
    noteVerificationInconclusive: (logicalRowId, reason) => touchLastChecked(logicalRowId, reason),
    noteVerificationConclusive: (logicalRowId) => clearVerificationStall(logicalRowId),

    fetchKhalaniOrder: async (orderId) => {
      try {
        const { getKhalaniClient } = await import("@tools/khalani/client.js");
        const order = await getKhalaniClient().getOrderById(orderId);
        // `order.transactions` is `Record<string, KhalaniTransactionInfo>`; its value
        // type widens structurally into the sweep's tolerant `KhalaniOrderTx` view.
        return {
          id: order.id,
          status: order.status,
          fromChainId: order.fromChainId,
          toChainId: order.toChainId,
          quoteId: order.quoteId,
          routeId: order.routeId,
          fromToken: order.fromToken,
          toToken: order.toToken,
          author: order.author,
          depositTxHash: order.depositTxHash,
          // F2: the client already validates these three; the sweep needs them to
          // cross-check a recovered DeBridge fill hash against OUR destination.
          externalOrderId: order.externalOrderId,
          recipient: order.recipient,
          destAmount: order.destAmount,
          transactions: order.transactions,
        };
      } catch (err) {
        logger.warn("bridge.repair.khalani_fetch_failed", { orderId, error: summarizeProtocolError(err).message });
        return null;
      }
    },

    fetchRelayStatus: async (requestId) => {
      try {
        const { getRelayClient } = await import("@tools/relay/client.js");
        const status = await getRelayClient().getIntentStatus(requestId);
        // The client schema `.passthrough()`s the canonical route/origin fields
        // (`inTxHashes`, `originChainId`, `destinationChainId`) without typing them —
        // validate them at THIS boundary (Blocker 6) rather than trusting an unsafe cast.
        const raw = status as unknown as Record<string, unknown>;
        return {
          status: status.status,
          txHashes: status.txHashes,
          destinationTxHashes: status.destinationTxHashes,
          inTxHashes: readOptionalStringArray(raw.inTxHashes),
          originChainId: readOptionalChainId(raw.originChainId),
          destinationChainId: readOptionalChainId(raw.destinationChainId),
        };
      } catch (err) {
        logger.warn("bridge.repair.relay_fetch_failed", { requestId, error: summarizeProtocolError(err).message });
        return null;
      }
    },

    // Read-only GET against deBridge's FIXED stats host; the module owns the SSRF
    // guard, the boundary schema, and the destination correlation (F2).
    fetchDebridgeFillHash: (input) => fetchDebridgeFillHash(input),

    recoverKhalaniOrderId: async (candidate) => {
      // Lookup-only (never re-signs/re-broadcasts): match the persisted deposit
      // hash against orders-by-address (R5). Idempotent-resubmit → DuplicateRecord
      // is a named future option, deliberately not used here to keep the
      // background sweep free of any state-changing provider call.
      try {
        const { getKhalaniClient } = await import("@tools/khalani/client.js");
        const orders = await getKhalaniClient().getOrders(candidate.walletAddress, {
          txHashSearch: candidate.depositTxHash,
          fromChainId: candidate.fromChainId,
          toChainId: candidate.toChainId,
        });
        const match = orders.data.find(
          (o) => o.depositTxHash?.toLowerCase() === candidate.depositTxHash.toLowerCase(),
        );
        return match?.id ?? null;
      } catch (err) {
        logger.warn("bridge.repair.khalani_recover_failed", {
          executionId: candidate.executionId,
          error: summarizeProtocolError(err).message,
        });
        return null;
      }
    },

    verifyFill: (input) => verifyBridgeLegOnChain(input),

    confirmExpectedFill: (input) => confirmBridgeExpectedFill(input),
    failLogical: (logicalRowId, failureCode, failureReason) =>
      failActivityEvent(logicalRowId, { failureCode, failureReason }),
    appendFillObserved: (input) =>
      markBridgeLegObserved({
        executionId: input.executionId,
        eventRole: "bridge_fill_observed",
        protocol: input.protocol,
        chainId: input.chainId,
        chainFamily: input.chainFamily,
        txHash: input.txHash,
        evidenceSource: input.evidenceSource,
        providerStatus: input.providerStatus,
      }),
    appendRefundEvidence: (input) =>
      markBridgeLegObserved({
        executionId: input.executionId,
        eventRole: "bridge_refund",
        protocol: input.protocol,
        chainId: input.chainId,
        chainFamily: input.chainFamily,
        txHash: input.txHash,
        evidenceSource: input.evidenceSource,
        providerStatus: input.providerStatus,
      }),
    attachOrderId: (input) => attachProviderOrderId(input),

    enqueueBalanceRefresh: async ({ namespace, executionId }) => {
      const { getJobsForNamespace } = await import("@vex-agent/db/repos/sync.js");
      const { execute } = await import("@vex-agent/db/client.js");
      const jobs = await getJobsForNamespace(namespace);
      for (const job of jobs) {
        if (job.syncType !== "balances") continue;
        // Idempotent by (job, execution): one balance-refresh run per confirmed
        // bridge, concurrency-safe. The partial unique index on
        // `protocol_sync_runs (sync_job_id, execution_id) WHERE execution_id IS NOT
        // NULL` (migration 046) is the authority; ON CONFLICT DO NOTHING makes two
        // concurrent sweeps a no-op instead of a duplicate run (Blocker 11).
        await execute(
          `INSERT INTO protocol_sync_runs (sync_job_id, execution_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (sync_job_id, execution_id) WHERE execution_id IS NOT NULL DO NOTHING`,
          [job.id, executionId],
        );
      }
    },

    clearRelayReveal: (sessionId, routeKey) => clearRelayRouteReveal(sessionId, routeKey),
  };
}
