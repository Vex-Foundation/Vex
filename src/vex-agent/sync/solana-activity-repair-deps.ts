/**
 * Production wiring for the Solana activity sweep's `SolanaActivitySweepDeps`
 * port — MOVE-ONLY extraction out of `solana-activity-repair.ts` (which owns
 * the sweep's POLICY: candidate eligibility, the no-give-up rail, the expiry
 * gate, settlement dispatch). No policy lives here; every function below is a
 * thin, health-gated adapter over one external read.
 *
 * The two files have different reasons to change: this one changes when an
 * endpoint, transport, or response shape changes; the sweep changes when the
 * terminality rules change. Splitting them also restored the headroom the
 * prediction fill-settlement lane needed under the repo's 500-line cap.
 *
 * `buildProductionSolanaRepairDeps` is RE-EXPORTED from
 * `solana-activity-repair.ts` so every existing import site — including the
 * dynamic `await import("./solana-activity-repair.js")` call sites in
 * `worker.ts` and `index.ts`, which no typecheck would catch — keeps working
 * unchanged.
 *
 * HEALTH GATE: the single configured `cfg.solana.rpcUrl` (the SAME trusted
 * endpoint `prepareVersionedTx`/`getSolanaConnection` already use for strictly
 * MORE consequential operations — signing and broadcasting), health-verified
 * via the genesis-hash echo (`solana-rpc-safety.js`) ONCE per sweep run and
 * cached for every candidate this run processes (avoids one genesis round-trip
 * per RPC call). `null`/unhealthy genesis ⇒ every RPC dep in this run reports
 * `"unavailable"` — the sweep then leaves every candidate pending, never
 * guessing from an unverified endpoint.
 */

import { loadConfig } from "@config/store.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

import { confirmSolanaMainnetGenesis, solanaRpcCall } from "./solana-rpc-safety.js";
import type { SolanaActivitySweepDeps } from "./solana-activity-repair.js";
import { fetchPredictionOrderHistory } from "./solana-prediction-fill-settlement.js";

export function buildProductionSolanaRepairDeps(): SolanaActivitySweepDeps {
  let healthyRpcUrl: Promise<string | null> | null = null;
  const resolveHealthyRpcUrl = (): Promise<string | null> => {
    if (!healthyRpcUrl) {
      healthyRpcUrl = (async () => {
        const rpcUrl = loadConfig().solana.rpcUrl;
        return (await confirmSolanaMainnetGenesis(rpcUrl)) ? rpcUrl : null;
      })();
    }
    return healthyRpcUrl;
  };

  return {
    getSignatureStatus: async (signature) => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        const result = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
          [signature],
          { searchTransactionHistory: true },
        ]);
        const value = isRecord(result) ? result.value : undefined;
        const entry = Array.isArray(value) ? value[0] : undefined;
        if (entry === null || entry === undefined) return { outcome: "not_found" };
        if (!isRecord(entry)) return { outcome: "unavailable" };
        const confirmationStatus = typeof entry.confirmationStatus === "string" ? entry.confirmationStatus : null;
        return { outcome: "found", value: { err: entry.err ?? null, confirmationStatus } };
      } catch (err) {
        logger.debug("solana_activity_repair.signature_status_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },

    getFinalizedTransaction: async (signature) => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        const result = await solanaRpcCall(rpcUrl, "getTransaction", [
          signature,
          { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 },
        ]);
        if (result === null || result === undefined) return { outcome: "not_found" };
        return { outcome: "found", value: result };
      } catch (err) {
        logger.debug("solana_activity_repair.get_transaction_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },

    getCurrentBlockHeight: async () => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        // `commitment: "finalized"` (not the confirmation guide's general
        // "confirmed" polling suggestion): finalized height always lags
        // confirmed height by a slot or two, so this can only ever make
        // expiry HARDER to prove, never easier — the conservative choice for
        // an irreversible `definitively_failed` write.
        const result = await solanaRpcCall(rpcUrl, "getBlockHeight", [{ commitment: "finalized" }]);
        if (typeof result !== "number" || !Number.isFinite(result)) return { outcome: "unavailable" };
        return { outcome: "found", value: result };
      } catch (err) {
        logger.debug("solana_activity_repair.block_height_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },

    /**
     * Signatures that touched ONE address, newest first — the prediction
     * fill-settlement lane's discovery read, because a keeper's settle
     * transaction appears in no provider history and is reachable only through
     * the escrow ATA it drained. A malformed entry declines the WHOLE lookup
     * rather than silently shortening the candidate set.
     */
    getSignaturesForAddress: async (address, limit) => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        const result = await solanaRpcCall(rpcUrl, "getSignaturesForAddress", [
          address,
          { limit, commitment: "finalized" },
        ]);
        if (!Array.isArray(result)) return { outcome: "unavailable" };
        const entries: Array<{ signature: string; err: unknown }> = [];
        for (const entry of result) {
          if (!isRecord(entry) || typeof entry.signature !== "string") return { outcome: "unavailable" };
          entries.push({ signature: entry.signature, err: entry.err ?? null });
        }
        return { outcome: "found", value: entries };
      } catch (err) {
        logger.debug("solana_activity_repair.signatures_for_address_rpc_failed", {
          error: summarizeProtocolError(err).message,
        });
        return { outcome: "unavailable" };
      }
    },

    /**
     * The Jupiter Prediction `/history` read. NOT an RPC call and deliberately
     * NOT genesis-gated — it is a provider HTTP read, and its own adapter
     * degrades every failure (429, 5xx, transport, schema) to `"unavailable"`
     * so the lane leaves the row pending instead of erroring the sweep.
     */
    getPredictionOrderHistory: fetchPredictionOrderHistory,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
