/**
 * THE SOLANA ARM of the amount-correction fallback: a confirmed Solana row that
 * still owes its executed amounts, repaired from its finalized transaction body.
 *
 * WHY IT IS A SEPARATE LANE. The EVM arm's whole apparatus - `eth_getTransactionReceipt`,
 * logs, ERC-20 topics, venue log decoders - has no meaning on Solana, and asking
 * a Solana RPC an EVM question is exactly the confusion that made the server's
 * verifier declare every Solana row unverifiable. This lane issues NO EVM RPC
 * method at all. It reads the same finalized, raw-json `getTransaction` through
 * the same genesis-verified, SSRF-safe port the pending sweep uses, and hands
 * the body to the same decoders
 * (`../solana-activity-repair/amount-decode-lane.js`), so a row repaired late
 * gets the identical answer it would have got at confirm time.
 *
 * IT NEVER WRITES A STATUS. These rows are already terminal; only their AMOUNTS
 * are in question, so the write is `fillExecutedAmountsOnConfirmed` (a
 * compare-before-fill CAS that quarantines a disagreement) and never a confirm.
 *
 * WHAT EACH OUTCOME MEANS, and why the distinction is load-bearing:
 *   filled     - the body proved the legs; amounts and block time written;
 *   declined   - the body was READ and refused, or this row can never be bounded
 *                (no mint to bound by, or the signature is gone from history).
 *                Stamped, so the row stops being re-read forever;
 *   deferred   - nothing was learned (RPC unavailable, per-pass budget spent).
 *                The row keeps its eligibility; the ORCHESTRATOR rotates it
 *                through its own confirmed-row writer, which is why this lane
 *                has no rotation of its own - one writer, both arms;
 *   conflicted - two readings of the same money disagree; the writer quarantined
 *                the row and nothing was written.
 */

import {
  fillExecutedAmountsOnConfirmed,
  noteSettledBlockTime,
  noteSettlementDeclined,
  noteSettlementDecodeVersion,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import logger from "@utils/logger.js";

import {
  amountBounds,
  decodeAmountsForBounds,
  readBlockTimeIso,
} from "../solana-activity-repair/amount-decode-lane.js";
import { buildProductionSolanaRepairDeps } from "../solana-activity-repair-deps.js";
import type { SolanaRpcLookup } from "../solana-activity-repair/sweep-port.js";

/**
 * Transaction bodies this lane may fetch per PASS.
 *
 * Deliberately below the pass's own candidate limit: the repair is a background
 * correction of history, it shares the sync worker with three sweeps, and a row
 * it cannot serve this pass rotates to the back of the window rather than being
 * lost.
 */
export const SOLANA_AMOUNT_REPAIR_BODY_FETCH_LIMIT = 5;

/** The ONE external read this lane performs. */
export interface SolanaTransactionBodyPort {
  readonly getFinalizedTransaction: (signature: string) => Promise<SolanaRpcLookup<unknown>>;
}

export type SolanaRepairOutcome = "filled" | "declined" | "deferred" | "conflicted";

export interface SolanaRepairLane {
  repairRow: (row: AgentActivityEvent) => Promise<SolanaRepairOutcome>;
}

export interface SolanaRepairLaneInput {
  /**
   * The decoder-set identity the orchestrator stamps on a completed decline.
   * PASSED IN rather than imported, so the dependency stays one-way: the
   * orchestrator routes to this lane, never the reverse.
   */
  readonly decoderSetVersion: string;
  /** Injected by tests; production omits it and gets the health-gated port. */
  readonly port?: SolanaTransactionBodyPort;
}

/**
 * One lane per PASS: it carries the pass's body-fetch budget, and memoizes the
 * production port so a pass costs one genesis health check rather than one per
 * row.
 */
export function createSolanaRepairLane(input: SolanaRepairLaneInput): SolanaRepairLane {
  let remainingFetches = SOLANA_AMOUNT_REPAIR_BODY_FETCH_LIMIT;
  let resolvedPort = input.port;
  const portFor = (): SolanaTransactionBodyPort => {
    resolvedPort ??= buildProductionSolanaRepairDeps();
    return resolvedPort;
  };

  return {
    repairRow: async (row) => {
      const txHash = row.txHash;
      if (txHash === null) return defer(row, "no_signature");

      const bounds = amountBounds(row);
      if (bounds === null) {
        // Nothing on this row names the mints a decode would be bounded by, and
        // no later pass can change that: a completed decline, not a deferral.
        return decline(row, input.decoderSetVersion, "unbounded_row");
      }

      if (remainingFetches <= 0) return defer(row, "fetch_budget_spent");
      remainingFetches -= 1;
      const lookup = await portFor().getFinalizedTransaction(txHash);
      if (lookup.outcome === "unavailable") return defer(row, "body_unavailable");
      if (lookup.outcome === "not_found") {
        // A TRUSTED RPC says this signature is not in its history. Old bodies do
        // age out, and re-asking the same endpoint forever cannot change the
        // answer, so this is a final conclusion about the amounts.
        return decline(row, input.decoderSetVersion, "body_not_in_history");
      }

      const decoded = decodeAmountsForBounds(lookup.value, bounds);
      if (decoded.outcome === "declined") return decline(row, input.decoderSetVersion, decoded.reason);

      const result = await fillExecutedAmountsOnConfirmed({
        id: row.id,
        // Bound to the row's OWN signature and chain, so a decode of another
        // transaction can never land on it.
        expectedTxHash: txHash,
        expectedChainId: row.chainId,
        amounts: decoded.amounts,
      });

      if (result.outcome === "applied") {
        await recordBlockTime(row, lookup.value);
        logger.info("sync.amount_fallback.solana_filled", { id: row.id, protocol: row.protocol });
        return "filled";
      }
      if (result.outcome === "conflict") {
        // SURFACED, never merged: the writer has already quarantined the row.
        logger.warn("sync.amount_fallback.solana_conflict", {
          id: row.id,
          protocol: row.protocol,
          hint: "the stored and decoded amounts disagree; the row is quarantined and NO amount was written",
        });
        return "conflicted";
      }
      // `already_complete` / `not_eligible`: someone else finished this row first.
      return defer(row, result.outcome);
    },
  };
}

/**
 * A COMPLETED refusal: the provenance stamp says the amounts are not coming, and
 * the decoder-version marker stops this row being re-read until the decoders
 * themselves change.
 */
async function decline(
  row: AgentActivityEvent,
  decoderSetVersion: string,
  reason: string,
): Promise<SolanaRepairOutcome> {
  await noteSettlementDeclined(row.id, "amounts_undecodable");
  // Written ONLY NOW, after the decline is final: claiming before the attempt
  // would let a crash exclude the row from this decoder version permanently.
  await noteSettlementDecodeVersion(row.id, decoderSetVersion);
  logger.debug("sync.amount_fallback.solana_declined", { id: row.id, protocol: row.protocol, reason });
  return "declined";
}

/**
 * Nothing was learned, so nothing is concluded here. The caller rotates the row
 * in the candidate window - the same rotation the EVM arm's deferrals get.
 */
function defer(row: AgentActivityEvent, reason: string): SolanaRepairOutcome {
  logger.debug("sync.amount_fallback.solana_deferred", { id: row.id, protocol: row.protocol, reason });
  return "deferred";
}

/**
 * The settling block's time, from the same body that proved the amounts. Caught,
 * never thrown: the money write already succeeded, and a precision write failing
 * must not turn a repaired row into a failed pass.
 */
async function recordBlockTime(row: AgentActivityEvent, body: unknown): Promise<void> {
  const blockTimeIso = readBlockTimeIso(body);
  if (blockTimeIso === null) return;
  try {
    await noteSettledBlockTime(row.id, blockTimeIso);
  } catch (error) {
    logger.warn("sync.amount_fallback.solana_block_time_write_failed", {
      id: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
