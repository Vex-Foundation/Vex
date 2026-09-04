/**
 * Agent Scan - transactions view: the unified tx feed (PRIMARY view, Agent
 * Scan plan v3 §1.9/§4.2 output-polish).
 *
 * FUSES `agent_activity` (new-format swap attempts: pending/confirmed/
 * definitively_failed) with legacy successful activity (proj_activity) and
 * legacy FAILED trade-impacting mutation attempts (protocol_executions,
 * THIS session only), filtered by productType, keyset-paginated, with a
 * txHash anchor. The repo (`db/repos/transactions.ts`) owns the SQL + the
 * cursor semantics; this handler decodes the opaque cursor (bounded-fail on
 * garbage), calls the repo, and shapes the bounded result.
 *
 * Output polish (owner: "write it the way you'd want to receive it"): every
 * row gets a compact human `summary` line up front (amounts with symbols,
 * USD labeled as an estimate, status, short tx hash) ahead of the full
 * machine fields. Rows with a resolvable chain+hash also feed `_explorerRefs`
 * (metadata-only, model-invisible - same mechanism `wallet/send` uses for a
 * linkable-but-uncaptured tx ref) so the desktop app can render a real
 * explorer deep link without this module needing its own chain→URL map.
 */

import type { ToolResult } from "../../types.js";
import { ok, fail } from "../types.js";
import { annotateNativeSymbol } from "@tools/evm-chains/native-currency.js";
import type { TransactionRow } from "@vex-agent/db/repos/transactions.js";

export interface InspectTransactionsParams {
  productType?: string;
  namespace?: string;
  txHash?: string;
  cursor?: string;
  limit?: number;
}

/** Bounded set of explorer refs derived from this page's rows - same shape `wallet/send` attaches under `data._explorerRefs`. */
function buildExplorerRefs(items: readonly TransactionRow[]): Array<{ chain: string; txRef: string }> {
  const seen = new Set<string>();
  const refs: Array<{ chain: string; txRef: string }> = [];
  const add = (chain: string | null, txRef: string | null | undefined): void => {
    if (!chain || !txRef) return;
    const key = `${chain}:${txRef}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ chain, txRef });
  };
  for (const item of items) {
    // A bridge logical row fans its on-chain hashes across its legs (deposit,
    // fill, refund, extra fills) - each on its OWN chain. Derive a ref from
    // EVERY leg, not only the row's top-level fill hash, so a pending deposit /
    // refund / extra-fill link is never invisible (Codex FIX-ROUND-1 finding
    // 13). The canonical fill leg is included in `legs`, so the top-level hash
    // is still covered. Non-bridge rows keep the top-level-hash derivation.
    if (item.legs && item.legs.length > 0) {
      for (const leg of item.legs) {
        const chain = leg.chainSlug ?? (leg.chainId != null ? String(leg.chainId) : null);
        add(chain, leg.txHash);
      }
      continue;
    }
    const chain = item.chain ?? (item.chainId != null ? String(item.chainId) : null);
    add(chain, item.txHash);
  }
  return refs;
}

function shortHash(hash: string | null | undefined): string | null {
  if (!hash) return null;
  return hash.length <= 14 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/**
 * One amount leg (`amount token`). When the row's `amountBasis` is a quote
 * (`estimated` - Q2 for bridges, R5 for a lend/prediction/swap confirmation
 * without decoder-proven executed legs) it is marked explicitly (`~… est.`)
 * so a quoted amount never reads as an executed quantity (Codex FIX-ROUND-1
 * finding 12 / R14, extended to every kind by W5/R5).
 *
 * `legChainId` is the chain THIS leg settled on - the source chain for a
 * bridge's input leg, the destination chain for its output leg. It exists only
 * to annotate the chain-agnostic `NATIVE` sentinel with the real gas-asset
 * ticker, so `0.0004 NATIVE` reads `0.0004 NATIVE (ETH)`. Annotation happens
 * HERE, at projection, rather than at write time: it repairs rows already in
 * the table, and it keeps the stored column ticker-shaped for vex-app's
 * `sanitizeTokenSymbol` allowlist. Passing the wrong chain would print a
 * confident lie, so a leg whose own chain id is unknown is left bare.
 */
function formatLeg(
  amount: string | null | undefined,
  token: string | null | undefined,
  estimated: boolean,
  legChainId: number | null | undefined,
): string | null {
  if (amount == null || token == null) return null;
  const label = annotateNativeSymbol(token, legChainId);
  return estimated ? `~${amount} ${label} est.` : `${amount} ${label}`;
}

function usdEstimate(value: number | null | undefined): string | null {
  return value != null && Number.isFinite(value) ? `~$${value.toFixed(2)} est.` : null;
}

/**
 * The Vex fee clause for a human summary line (owner decree 2026-08-03).
 *
 * The fee fields were already on every row, but only in the raw spread - the
 * summary the agent reads first never mentioned them, so "what did that cost
 * me?" had no answer at a glance.
 *
 * Two deliberate refusals here. It renders the EXACT token amount, never the
 * USD estimate alone: `usdVexFeeEst` is nullable precisely when no trustworthy
 * price existed, and a summary that showed only USD would print "no fee" for a
 * fee that was charged. And it renders nothing at all when there is no fee
 * amount - a failed attempt is not charged, and inventing a "fee: 0" line would
 * assert something the record does not say.
 */
function vexFeeClause(row: TransactionRow): string | null {
  const amount = row.vexFeeAmountHuman;
  if (typeof amount !== "string" || amount.length === 0) return null;
  const symbol = row.vexFeeTokenSymbol;
  const fee = symbol ? `${amount} ${symbol}` : amount;
  const usd = usdEstimate(row.usdVexFeeEst != null ? Number(row.usdVexFeeEst) : null);
  return usd ? `Vex fee ${fee} (${usd})` : `Vex fee ${fee}`;
}

/** Chain display for a bridge route endpoint - slug preferred, numeric id as fallback. */
function routeEndpoint(slug: string | null | undefined, id: number | null | undefined): string | null {
  return slug ?? (id != null ? String(id) : null);
}

/**
 * Compact human line for a bridge logical row (Codex FIX-ROUND-1 finding 13):
 * origin→destination route + amount marked by `amountBasis` + venue + status +
 * the fill hash. A refund/failed row surfaces its failure code and drops the
 * amount (money-back is not a settled quantity).
 */
function summarizeBridge(row: TransactionRow, hash: string | null): string {
  const from = routeEndpoint(row.fromChainSlug, row.fromChainId);
  const to = routeEndpoint(row.toChainSlug, row.toChainId);
  const route = from && to ? `${from} → ${to}` : (from ?? to ?? "unknown route");
  const venue = row.protocol ?? row.namespace;
  const status = row.status ?? "pending";
  const estimated = row.amountBasis === "estimated";
  // A bridge's two legs sit on DIFFERENT chains (Base → BSC moves ETH out and
  // BNB in), so each leg is labelled from its own endpoint id. There is no
  // fallback to `row.chainId`: guessing the destination asset from the source
  // chain is exactly the confident-wrong-label failure this avoids.
  const inLeg = formatLeg(row.inputAmount, row.inputToken, estimated, row.fromChainId);
  const outLeg = formatLeg(row.outputAmount, row.outputToken, estimated, row.toChainId);
  const amount = inLeg && outLeg ? `${inLeg} → ${outLeg}` : (inLeg ?? outLeg ?? null);
  const head = amount != null ? `Bridging ${amount} (${route})` : `Bridge ${route}`;

  const parts = [`${head} via ${venue} - ${status}`];
  const usd = usdEstimate(row.valueUsd ?? null);
  if (usd) parts.push(usd);
  if (row.failureCode) parts.push(`(${row.failureCode})`);
  const bridgeFee = vexFeeClause(row);
  if (bridgeFee) parts.push(bridgeFee);
  const observed = chainObservationClause(row);
  if (observed) parts.push(observed);
  const stalled = observed ? null : stalledVerificationClause(row);
  if (stalled) parts.push(stalled);
  if (hash) parts.push(`tx ${hash}`);
  return parts.join(" - ");
}

/**
 * Consecutive inconclusive verification attempts before a pending row says so.
 * Mirrors `STALLED_VERIFICATION_ATTEMPTS` in the agent-activity repo.
 */
const STALLED_ATTEMPTS = 20;

/**
 * The agent-facing half of the Wave P stall surfacing (migration 065).
 *
 * A `pending` row tells the agent nothing about WHY it is pending. If Vex has
 * been unable to verify it - most often `no_safe_rpc`, which is permanent for
 * that chain, not transient - the agent will keep waiting or, worse, re-broadcast
 * a transaction that may already have settled. That is the exact blind-retry
 * failure the agent-facing-errors decree exists to stop, applied to a NON-error.
 *
 * The clause therefore states three things and no more: that VERIFICATION (not
 * the transaction) stalled, the verifier's own reason verbatim, and the two
 * instructions that follow from it. It never claims the transaction failed -
 * an unverifiable transaction's outcome is UNKNOWN, and saying otherwise about
 * real funds is the thing the never-auto-fail policy forbids.
 */
function stalledVerificationClause(row: TransactionRow): string | null {
  if ((row.status ?? "") !== "pending") return null;
  if ((row.verificationAttempts ?? 0) < STALLED_ATTEMPTS) return null;
  const reason = row.lastVerificationReason ?? "unknown";
  return (
    `verification stalled (${reason}): Vex has repeatedly been unable to read this `
    + `transaction's status on chain. It may still be settled. Do not re-broadcast`
  );
}


/**
 * WHAT THE CHAIN OBSERVATION ESTABLISHED - the clause that answers "why is this
 * not moving?" before the agent spends a `LoopDefer` cycle guessing.
 *
 * It runs BEFORE the stall clause because these are CONCLUSIVE observations: we
 * looked and learned something definite. A stall is the opposite - "we could not
 * look" - and reporting both would describe one observation as a conclusion and
 * a failure at once.
 *
 * THE COPY IS BOUNDED BY WHAT THE LANE ACTUALLY PROVED:
 *
 * - `in_mempool` is the HEALTHY answer, and the instruction that matters is "do
 *   not re-broadcast" - re-broadcasting a mempool-resident transaction is how a
 *   user pays for the same action twice.
 * - `nonce_superseded` establishes only that ANOTHER transaction from this
 *   wallet used this nonce and that THIS hash has no receipt. It does NOT
 *   establish that nothing was spent or that a retry is safe: a replacement
 *   reusing the nonce may have carried the same calldata and done the same
 *   thing. Correlating the replacement is strictly more work than the lane does,
 *   so this line must never claim it.
 *
 * NO CHECK INTERVAL IS STATED. The row's real cadence is 5 s for its first ten
 * minutes and 30 s after, derived from `submit_attempted_at` - which this read
 * model does not carry. A fixed "every 5s" would therefore be FALSE for any
 * older row, and inventing a cadence is exactly the claim-beyond-the-evidence
 * this file spends its other clauses avoiding.
 */
function chainObservationClause(row: TransactionRow): string | null {
  const reason = row.lastVerificationReason ?? null;
  const terminalUnproven = (row.status ?? "") === "superseded_unproven";

  if (terminalUnproven) {
    return (
      "Vex is no longer tracking this transaction as in flight and its outcome is "
      + "UNPROVEN: the original hash appears superseded and what the replacement did "
      + "has not been checked. This is NOT a failure. Check the wallet/token state "
      + "before deciding whether to act again"
    );
  }
  if ((row.status ?? "") !== "pending") return null;

  if (reason === "in_mempool") {
    return (
      "in the mempool, not yet mined: a node knows this transaction and it is "
      + "waiting for inclusion. Vex is re-checking it automatically - do not re-broadcast"
    );
  }
  if (reason === "nonce_superseded") {
    return (
      "this transaction hash appears superseded - another transaction from the same "
      + "wallet has already used its nonce, and this hash has no receipt. What the "
      + "replacement did has not been checked, so it may or may not have completed "
      + "this action. Do not retry until you have checked the wallet/token state"
    );
  }
  if (reason === "tx_unknown_to_node") {
    return (
      "no node we asked has heard of this transaction yet. That is not proof it was "
      + "dropped - it may be sitting in a mempool we did not query - so Vex keeps "
      + "checking. Do not re-broadcast"
    );
  }
  return null;
}

/** Test seam: the summary line for ONE row, so the copy above can be pinned directly. */
export function summarizeTransactionRowForTest(row: TransactionRow): string {
  return summarize(row);
}

/** Compact human line for one row - leads the item, full fields follow. */
function summarize(row: TransactionRow): string {
  const hash = shortHash(row.txHash);

  if (row.source === "failure") {
    // Failure rows carry no economics (never produced a fill).
    const label = row.toolId ?? row.namespace;
    return hash ? `${label} failed (tx ${hash})` : `${label} failed - no tx broadcast`;
  }

  // Only the agent_activity bridge LOGICAL row carries the route endpoints,
  // legs, and amountBasis the bridge line needs. A legacy `success`-sourced
  // bridge (proj_activity, product_type 'bridge') has none of those and is a
  // settled fill, so it keeps the generic line (its prior behavior).
  if (row.source === "agent_activity" && row.productType === "bridge") {
    return summarizeBridge(row, hash);
  }

  const chain = row.chain ?? "unknown chain";
  const venue = row.protocol ?? row.namespace;
  // Swap/lend/prediction rows (R5): a confirmed row without decoder-proven
  // executed legs falls back to the quote, marked `~… est.` - never a bare
  // executed-looking quantity for an attempt the decoder couldn't prove.
  const estimated = row.amountBasis === "estimated";
  // Single-chain row: both legs settled on the row's own chain.
  const inLeg = formatLeg(row.inputAmount, row.inputToken, estimated, row.chainId);
  const outLeg = formatLeg(row.outputAmount, row.outputToken, estimated, row.chainId);
  const route = inLeg && outLeg ? `${inLeg} → ${outLeg}` : (inLeg ?? outLeg ?? venue);
  const status = row.status ?? "confirmed";

  const parts = [`${route} via ${venue} on ${chain} - ${status}`];
  const usd = usdEstimate(row.valueUsd ?? null);
  if (usd) parts.push(usd);
  if (status === "definitively_failed" && row.failureCode) parts.push(`(${row.failureCode})`);
  const fee = vexFeeClause(row);
  if (fee) parts.push(fee);
  // A CONCLUSIVE observation outranks the stall clause: the two answer opposite
  // questions, and only one of them can be true of the same check.
  const observed = chainObservationClause(row);
  if (observed) parts.push(observed);
  const stalled = observed ? null : stalledVerificationClause(row);
  if (stalled) parts.push(stalled);
  if (hash) parts.push(`tx ${hash}`);
  return parts.join(" - ");
}

export async function inspectTransactions(
  addresses: string[],
  sessionId: string | null,
  params: InspectTransactionsParams,
): Promise<ToolResult> {
  const { getTransactions } = await import("@vex-agent/db/repos/transactions.js");
  const { decodeCursor, CursorError } = await import("@vex-agent/db/repos/transactions-cursor.js");

  // Decode the opaque cursor at the boundary. Malformed input is rejected with a
  // bounded failure - never crashes the tool, never echoes the raw cursor.
  let cursor = null;
  if (params.cursor !== undefined && params.cursor !== "") {
    try {
      cursor = decodeCursor(params.cursor);
    } catch (err) {
      if (err instanceof CursorError) return fail("Invalid cursor");
      throw err;
    }
  }

  const limit = params.limit ?? 20;

  const { items, nextCursor, hasMore, failuresScope } = await getTransactions({
    addresses,
    sessionId,
    productType: params.productType,
    namespace: params.namespace,
    txHash: params.txHash,
    cursor,
    limit,
  });

  return ok({
    view: "transactions",
    count: items.length,
    failuresScope,
    transactions: items.map((item) => ({ summary: summarize(item), ...item })),
    nextCursor,
    hasMore,
    _explorerRefs: buildExplorerRefs(items),
  });
}
