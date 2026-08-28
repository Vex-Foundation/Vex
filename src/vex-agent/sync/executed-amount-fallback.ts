/**
 * THE AMOUNT-CORRECTION FALLBACK (R2 stage F) — the repair for a row that is
 * CONFIRMED but still cannot tell the user what it actually executed.
 *
 * This is the owner's own case, stated precisely: a KyberSwap CAT→native swap
 * that mined `success`, was confirmed status-only, and then showed a QUOTE
 * labelled "estimated" forever, because the decoder of the day declined that
 * receipt shape and nothing ever asked again.
 *
 * ── THIS MODULE HOLDS NO VENUE KNOWLEDGE ───────────────────────────────────
 *
 * It owns the PLUMBING only: which rows to try, when to stop trying, fetching
 * the receipt, and the CAS orchestration around the writers. Every actual decode
 * is delegated to the venue's OWN exported decoder. That split is the adjudicated
 * R1/R2 boundary, and it exists because venue settlement semantics are genuinely
 * different — Uniswap binds registered routers, Pendle has role and second-leg
 * rules, Trench verifies the Diamond — so a "generic" decoder here would be a
 * second, drifting implementation of five venues' money rules.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
 *
 * - It never writes a `status`. The row is already terminal; only its AMOUNTS
 *   are in question, and those are a separate column family with a separate
 *   writer (`fillExecutedAmountsOnConfirmed`).
 * - It never overwrites a stored amount. A decode that DISAGREES with one is a
 *   defect to surface, not a merge to perform: the writer quarantines the row
 *   and this module logs it. Two writers disagreeing about money is never
 *   settled by last-write-wins.
 * - It never re-derives the role contract. `roleLegsIncomplete` is imported, and
 *   the writers re-enforce it inside their own SQL.
 * - It never guesses an input. A venue whose decoder inputs cannot be resolved
 *   from persisted columns plus repo constants DECLINES BY NAME.
 *
 * ── LEGACY ROWS ARE IN SCOPE, and that is the point ────────────────────────
 *
 * `settlementDecode` (R1's persisted hint) is an ACCELERATOR, not a gate. The
 * owner's own row predates it and carries only `{routeID, checksum}`, so a
 * hint-gated fallback would have excluded the exact transaction that motivated
 * the workstream. Without a hint the inputs come from validated persisted
 * columns plus the venue's own registry, and a missing one declines.
 */

import {
  fillExecutedAmountsOnConfirmed,
  listAmountCorrectionCandidates,
  noteSettlementDecodeVersion,
  noteSettlementDeclined,
  readSettlementDecodeHint,
  roleLegsIncomplete,
  touchAmountCorrectionChecked,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

import { asJsonRpcClient, readReceiptStatus } from "./agent-activity-repair/observation.js";
import { resolveReadOnlyReceiptClient } from "./agent-activity-repair.js";
import {
  createSolanaRepairLane,
  type SolanaRepairLane,
  type SolanaTransactionBodyPort,
} from "./executed-amount-fallback/solana-lane.js";
import {
  decodeVenueSettlement,
  type VenueDecodeLog,
} from "./executed-amount-fallback/venue-dispatch.js";
import { assessRepairedFill } from "./executed-amount-fallback/approved-floor.js";
import type {
  DepositEvidenceDeps,
  MinedTransaction,
} from "./executed-amount-fallback/deposit-evidence-resolver.js";

/**
 * The decoder-set identity+version stamped on a COMPLETED decline.
 *
 * BUMP THIS whenever any venue decoder's rules change, because that is the exact
 * event that makes previously-declined rows worth re-reading. It is the only
 * thing that makes a row eligible again — a timestamp could only re-run the same
 * decode against the same immutable receipt forever.
 */
export const SETTLEMENT_DECODER_SET_VERSION = "2026-08-28.uniswap-venue-branch";

/** Bounded per pass — this shares the sync worker with the balance and bridge sweeps. */
export const AMOUNT_CORRECTION_BATCH_LIMIT = 10;

export interface AmountFallbackDeps extends DepositEvidenceDeps {
  /**
   * The mined receipt's logs, by hash. Read-only, and the ONLY dependency this
   * module has — it holds no signer and never re-quotes or re-executes.
   *
   * `null` when the receipt cannot be read right now, which is NOT a decline:
   * nothing was learned, so the row keeps its eligibility for the next pass.
   */
  readonly fetchReceiptLogs: (input: {
    chainId: number;
    txHash: string;
  }) => Promise<readonly VenueDecodeLog[] | null>;
  /**
   * The Solana body port, injected by tests only. Production omits it and the
   * Solana lane builds the same genesis-verified, SSRF-safe port the pending
   * sweep uses - lazily, so a pass with no Solana candidate costs no health
   * check at all.
   */
  readonly solanaBodyPort?: SolanaTransactionBodyPort;
}

export interface AmountFallbackResult {
  readonly checked: number;
  readonly filled: number;
  readonly declined: number;
  /** A receipt or transaction was unreadable this pass: the row keeps its eligibility. */
  readonly deferred: number;
  readonly conflicted: number;
}

/**
 * One bounded pass over confirmed rows that still owe their amounts.
 */
export async function repairMissingExecutedAmounts(
  deps: AmountFallbackDeps,
  limit: number = AMOUNT_CORRECTION_BATCH_LIMIT,
): Promise<AmountFallbackResult> {
  const candidates = await listAmountCorrectionCandidates(limit, SETTLEMENT_DECODER_SET_VERSION);
  // ONE lane per pass: it carries the Solana body-fetch budget and memoizes the
  // port, and is created eagerly only because it costs nothing until a Solana
  // candidate actually asks it for a body.
  const solanaLane = createSolanaRepairLane({
    decoderSetVersion: SETTLEMENT_DECODER_SET_VERSION,
    ...(deps.solanaBodyPort ? { port: deps.solanaBodyPort } : {}),
  });
  let checked = 0;
  let filled = 0;
  let declined = 0;
  let deferred = 0;
  let conflicted = 0;

  for (const row of candidates) {
    // THE AUTHORITATIVE completeness decision, imported: the SQL above is only
    // a prefilter, and a `yield_claim` with no input leg is COMPLETE.
    if (!roleLegsIncomplete(row)) {
      // It still has to ROTATE. The prefilter keeps selecting rows the role
      // contract calls complete (a bridge deposit legitimately has no output
      // leg), and a row that is skipped without touching the ordering column
      // stays at the head of the window for every future pass.
      await rotateCandidate(row.id);
      continue;
    }
    checked++;

    const outcome = await repairOneRow(row, deps, solanaLane);
    if (outcome === "filled") {
      filled++;
      // A SUCCESSFUL decode is just as final as a refusal, and it must be
      // marked as such. A role whose contract wants BOTH legs (prediction, and a
      // lend row that declared both token sides)
      // stays `roleLegsIncomplete` when the chain only proves one of them, so
      // without this stamp the row remains a candidate, keeps its ordering key,
      // and is re-decoded from the same immutable receipt on every single pass -
      // one wasted chain read per row per tick, and on Solana the whole body
      // budget spent re-proving what is already stored.
      await noteSettlementDecodeVersion(row.id, SETTLEMENT_DECODER_SET_VERSION);
    }
    else if (outcome === "declined") declined++;
    else if (outcome === "conflicted") conflicted++;
    else {
      deferred++;
      // A deferral concluded nothing, so it writes no decline and no decoder
      // version. Without a rotation it would also write NOTHING at all, and the
      // candidate window is ordered by exactly the column it did not write:
      // enough permanently deferring rows and the lane re-serves the same batch
      // forever, never reaching a later candidate.
      await rotateCandidate(row.id);
    }
  }

  return { checked, filled, declined, deferred, conflicted };
}

/**
 * Production deps — the mined receipt's LOGS, read through the same three chain
 * sources and the same EIP-1193 `request` the pending lane uses, so a chain one
 * of them can resolve is a chain both can read.
 *
 * Per-run client memo, same economics as the lane: one client per distinct chain
 * per pass rather than one per row.
 *
 * Every failure is `null` — "we could not read it" — never an empty log array,
 * which the decoder would read as "the receipt genuinely had no logs" and
 * decline on, burning the row's eligibility for a transport hiccup.
 */
export function buildProductionAmountFallbackDeps(): AmountFallbackDeps {
  const clientsByChainId = new Map<number, Promise<unknown>>();
  const clientFor = async (chainId: number) => {
    let cached = clientsByChainId.get(chainId);
    if (!cached) {
      cached = resolveReadOnlyReceiptClient(chainId);
      clientsByChainId.set(chainId, cached);
    }
    return asJsonRpcClient(await cached);
  };

  return {
    fetchReceiptStatus: async ({ chainId, txHash }) => {
      const client = await clientFor(chainId);
      if (!client) return null;
      try {
        const receipt = await client.request({
          method: "eth_getTransactionReceipt",
          params: [txHash],
        });
        // The ONE reading of that field in this repository, imported rather than
        // repeated: a status neither `0x1` nor `0x0` is unreadable, never a revert.
        return readReceiptStatus(receipt);
      } catch (err) {
        logger.debug("sync.amount_fallback.receipt_status_unreadable", {
          chainId,
          error: summarizeProtocolError(err).message,
        });
        return null;
      }
    },
    fetchTransaction: async ({ chainId, txHash }) => {
      const client = await clientFor(chainId);
      if (!client) return null;
      try {
        const transaction = await client.request({
          method: "eth_getTransactionByHash",
          params: [txHash],
        });
        return readMinedTransaction(transaction);
      } catch (err) {
        logger.debug("sync.amount_fallback.transaction_unreadable", {
          chainId,
          error: summarizeProtocolError(err).message,
        });
        return null;
      }
    },
    fetchReceiptLogs: async ({ chainId, txHash }) => {
      const client = await clientFor(chainId);
      if (!client) return null;
      try {
        const receipt = await client.request({
          method: "eth_getTransactionReceipt",
          params: [txHash],
        });
        return readReceiptLogs(receipt);
      } catch (err) {
        logger.debug("sync.amount_fallback.receipt_unreadable", {
          chainId,
          error: summarizeProtocolError(err).message,
        });
        return null;
      }
    },
  };
}

/**
 * The raw JSON-RPC transaction is UNTRUSTED: every field a money decision can
 * touch is validated here, and anything malformed reads as UNREADABLE (`null`),
 * never as a transaction with missing parts.
 *
 * `value` arrives as a hex quantity and leaves as decimal atomic units, because
 * that is the only form the amount columns and the bounds ever speak.
 */
function readMinedTransaction(transaction: unknown): MinedTransaction | null {
  if (typeof transaction !== "object" || transaction === null) return null;
  const { from, to, input, value } = transaction as Record<string, unknown>;
  if (typeof from !== "string" || typeof input !== "string") return null;
  if (to !== null && typeof to !== "string") return null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  return { from, to: to ?? null, input, valueRaw: BigInt(value).toString() };
}

/**
 * The raw JSON-RPC receipt is UNTRUSTED — validated as `unknown` before any of
 * it can reach a money decision. A receipt whose `logs` is not an array of
 * log-shaped objects reads as UNREADABLE (`null`), never as an empty receipt.
 */
function readReceiptLogs(receipt: unknown): readonly VenueDecodeLog[] | null {
  if (typeof receipt !== "object" || receipt === null) return null;
  const logs = (receipt as { logs?: unknown }).logs;
  if (!Array.isArray(logs)) return null;
  const parsed: VenueDecodeLog[] = [];
  for (const entry of logs) {
    if (typeof entry !== "object" || entry === null) return null;
    const { address, topics, data } = entry as Record<string, unknown>;
    if (typeof address !== "string" || typeof data !== "string") return null;
    if (!Array.isArray(topics) || topics.some((t) => typeof t !== "string")) return null;
    parsed.push({ address, topics: topics as string[], data });
  }
  return parsed;
}

/**
 * Move a row to the BACK of the candidate window after a pass that concluded
 * nothing about it. Best effort: failing to rotate must not fail the pass, and
 * the next tick simply re-serves the row.
 */
async function rotateCandidate(id: number): Promise<void> {
  try {
    await touchAmountCorrectionChecked(id);
  } catch (err) {
    logger.debug("sync.amount_fallback.rotate_failed", {
      id,
      error: summarizeProtocolError(err).message,
    });
  }
}

type RowOutcome = "filled" | "declined" | "conflicted" | "deferred";

async function repairOneRow(
  row: AgentActivityEvent,
  deps: AmountFallbackDeps,
  solanaLane: SolanaRepairLane,
): Promise<RowOutcome> {
  // THE FAMILY SPLIT, before any EVM read: a Solana row is repaired from its
  // finalized transaction body by its own lane, and no EVM RPC method is ever
  // issued against a Solana endpoint.
  if (row.chainFamily === "solana") return solanaLane.repairRow(row);

  const txHash = row.txHash;
  if (txHash === null) return "deferred";

  const logs = await deps.fetchReceiptLogs({ chainId: row.chainId, txHash });
  if (logs === null) {
    // We could not READ the receipt. Nothing was decided, so nothing is marked:
    // marking here would burn the row's eligibility on a transport failure.
    return "deferred";
  }

  const decoded = await decodeVenueSettlement({
    row,
    logs,
    hint: readSettlementDecodeHint(row.routeProvenance),
    deps,
  });

  if (decoded.kind === "deferred") {
    // A chain read the decode needed did not answer. Nothing was decided, so the
    // row keeps its eligibility instead of burning it on a transport failure.
    logger.debug("sync.amount_fallback.deferred", {
      id: row.id,
      protocol: row.protocol,
      detail: decoded.detail,
    });
    return "deferred";
  }

  if (decoded.kind === "declined") {
    await noteSettlementDeclined(row.id, decoded.reason);
    // The marker is written ONLY NOW — after a COMPLETED decline. Writing it
    // before the attempt would be a crash poison.
    //
    // AND NOT AT ALL when the decline is EVIDENCE rather than completion. A
    // decoder reporting "the receipt contradicts the approved amount" has
    // learned something about the MONEY; it has not hit a limit of this decoder
    // set. Burning the row's eligibility there would hide an unresolved anomaly
    // until somebody bumped the version, so such a row stays a candidate of
    // every later pass.
    if (decoded.keepsEligibility !== true) {
      await noteSettlementDecodeVersion(row.id, SETTLEMENT_DECODER_SET_VERSION);
    }
    logger.debug("sync.amount_fallback.declined", {
      id: row.id,
      protocol: row.protocol,
      reason: decoded.reason,
      detail: decoded.detail,
      keptEligibility: decoded.keepsEligibility === true,
    });
    return "declined";
  }

  const result = await fillExecutedAmountsOnConfirmed({
    id: row.id,
    // The decode is bound to the row's OWN hash and chain, so a decode of the
    // wrong transaction can never land on it.
    expectedTxHash: txHash,
    expectedChainId: row.chainId,
    amounts: decoded.amounts,
  });

  if (result.outcome === "applied") {
    logger.info("sync.amount_fallback.filled", { id: row.id, protocol: row.protocol });
    // PARITY WITH THE IMMEDIATE PATH, after the amounts are durably written.
    // Both venue handlers assess the fill they decoded against the approved
    // floor; a settlement that got its amounts HERE instead deserves the same
    // named verdict, or the rows nobody was watching are the rows nobody
    // checked. Detection only - the status is already decided and stays.
    const floorAssessment = assessRepairedFill({
      row,
      executedAmountOutRaw: decoded.amounts.executedAmountOutRaw,
    });
    if (floorAssessment.kind === "materially_short") {
      logger.warn("sync.amount_fallback.fill_below_approved_floor", {
        id: row.id,
        protocol: row.protocol,
        txHash,
        shortfallRaw: floorAssessment.shortfallRaw.toString(),
        verdict: floorAssessment.verdict,
      });
    }
    return "filled";
  }
  if (result.outcome === "conflict") {
    // SURFACED, never merged and never silently dropped: two readings of the
    // same money disagree, and the writer has quarantined the row.
    logger.warn("sync.amount_fallback.conflict", {
      id: row.id,
      protocol: row.protocol,
      hint: "the stored and decoded amounts disagree; the row is quarantined and NO amount was written",
    });
    return "conflicted";
  }
  // `already_complete` / `not_eligible`: someone else finished the row first.
  return "deferred";
}
