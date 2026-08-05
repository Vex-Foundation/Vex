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
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

import { asJsonRpcClient } from "./agent-activity-repair/observation.js";
import { resolveReadOnlyReceiptClient } from "./agent-activity-repair.js";
import {
  decodeVenueSettlement,
  type VenueDecodeLog,
} from "./executed-amount-fallback/venue-dispatch.js";

/**
 * The decoder-set identity+version stamped on a COMPLETED decline.
 *
 * BUMP THIS whenever any venue decoder's rules change, because that is the exact
 * event that makes previously-declined rows worth re-reading. It is the only
 * thing that makes a row eligible again — a timestamp could only re-run the same
 * decode against the same immutable receipt forever.
 */
export const SETTLEMENT_DECODER_SET_VERSION = "2026-08-04.kyber-correlated-native-out";

/** Bounded per pass — this shares the sync worker with the balance and bridge sweeps. */
export const AMOUNT_CORRECTION_BATCH_LIMIT = 10;

export interface AmountFallbackDeps {
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
}

export interface AmountFallbackResult {
  readonly checked: number;
  readonly filled: number;
  readonly declined: number;
  /** Receipt unreadable this pass — the row keeps its eligibility. */
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
  let checked = 0;
  let filled = 0;
  let declined = 0;
  let deferred = 0;
  let conflicted = 0;

  for (const row of candidates) {
    // THE AUTHORITATIVE completeness decision, imported — the SQL above is only
    // a prefilter, and a `yield_claim` with no input leg is COMPLETE.
    if (!roleLegsIncomplete(row)) continue;
    checked++;

    const outcome = await repairOneRow(row, deps);
    if (outcome === "filled") filled++;
    else if (outcome === "declined") declined++;
    else if (outcome === "conflicted") conflicted++;
    else deferred++;
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

  return {
    fetchReceiptLogs: async ({ chainId, txHash }) => {
      let cached = clientsByChainId.get(chainId);
      if (!cached) {
        cached = resolveReadOnlyReceiptClient(chainId);
        clientsByChainId.set(chainId, cached);
      }
      const client = asJsonRpcClient(await cached);
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

type RowOutcome = "filled" | "declined" | "conflicted" | "deferred";

async function repairOneRow(
  row: AgentActivityEvent,
  deps: AmountFallbackDeps,
): Promise<RowOutcome> {
  const txHash = row.txHash;
  if (txHash === null) return "deferred";

  const logs = await deps.fetchReceiptLogs({ chainId: row.chainId, txHash });
  if (logs === null) {
    // We could not READ the receipt. Nothing was decided, so nothing is marked:
    // marking here would burn the row's eligibility on a transport failure.
    return "deferred";
  }

  const decoded = decodeVenueSettlement({
    row,
    logs,
    hint: readSettlementDecodeHint(row.routeProvenance),
  });

  if (decoded.kind === "declined") {
    await noteSettlementDeclined(row.id, decoded.reason);
    // The marker is written ONLY NOW — after a COMPLETED decline. Writing it
    // before the attempt would be a crash poison.
    await noteSettlementDecodeVersion(row.id, SETTLEMENT_DECODER_SET_VERSION);
    logger.debug("sync.amount_fallback.declined", {
      id: row.id,
      protocol: row.protocol,
      reason: decoded.reason,
      detail: decoded.detail,
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
