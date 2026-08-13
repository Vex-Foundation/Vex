/**
 * Production wiring for the Solana activity sweep's `SolanaActivitySweepDeps`
 * port — MOVE-ONLY extraction out of `solana-activity-repair.ts` (which owns
 * the sweep's POLICY: candidate eligibility, the no-give-up rail, the expiry
 * gate). No policy lives here; every function below is a
 * thin, health-gated adapter over one external read.
 *
 * The two files have different reasons to change: this one changes when an
 * endpoint, transport, or response shape changes; the sweep changes when the
 * terminality rules change.
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
import type { SolanaActivitySweepDeps } from "./solana-activity-repair/sweep-port.js";

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
    /**
     * BATCHED: `getSignatureStatuses` takes an array, so one sweep run costs one
     * round trip for its whole due batch (bounded by
     * `SOLANA_SWEEP_BATCH_LIMIT`, far under the RPC's own array cap). A
     * malformed envelope, or an array shorter than the request, declines the
     * WHOLE call as `"unavailable"` rather than silently reporting rows as
     * not-found — absence must only ever come from a trusted, complete answer.
     */
    getSignatureStatuses: async (signatures) => {
      const rpcUrl = await resolveHealthyRpcUrl();
      if (!rpcUrl) return { outcome: "unavailable" };
      try {
        const result = await solanaRpcCall(rpcUrl, "getSignatureStatuses", [
          [...signatures],
          { searchTransactionHistory: true },
        ]);
        const value = isRecord(result) ? result.value : undefined;
        if (!Array.isArray(value) || value.length < signatures.length) return { outcome: "unavailable" };
        const entries: Array<{ err: unknown; confirmationStatus: string | null } | null> = [];
        for (const entry of value.slice(0, signatures.length)) {
          if (entry === null || entry === undefined) {
            entries.push(null); // a trusted "no such signature"
            continue;
          }
          // A present-but-unreadable entry is AMBIGUITY, not absence: reporting
          // it as not-found would feed the expiry gate, the one path that can
          // terminalize a row without proof.
          if (!isRecord(entry)) return { outcome: "unavailable" };
          // ABSENT IS NOT NULL. `err: null` is the RPC's proof of success;
          // an entry with no `err` key at all is a shape we do not recognize,
          // and coercing it to `null` would confirm a transaction whose outcome
          // we never read. Decline the whole call instead.
          if (!Object.prototype.hasOwnProperty.call(entry, "err")) return { outcome: "unavailable" };
          const confirmationStatus = typeof entry.confirmationStatus === "string" ? entry.confirmationStatus : null;
          entries.push({ err: entry.err, confirmationStatus });
        }
        return { outcome: "found", value: entries };
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
        // `encoding: "json"` is a CONTRACT, not a preference (see the port's own
        // doc): the sweep's decoders read compiled instructions and resolve
        // account indexes against `accountKeys` + `meta.loadedAddresses`, and the
        // repository's fixtures are captured in this same shape. `jsonParsed`
        // would return a different, program-dependent shape, so a decoder proven
        // on the fixtures would not be proven on production data.
        const result = await solanaRpcCall(rpcUrl, "getTransaction", [
          signature,
          { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 },
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
