/**
 * Jupiter Prediction FILL-SETTLEMENT lane — the second, keeper-side arm of
 * prediction payout settlement (P1). Entered ONLY after the sweep has proven
 * the row's own transaction landed clean AND the own-tx payout decoder
 * (`solana-prediction-payout-settlement.ts`) declined it.
 *
 * WHAT THE CHAIN PROVED (2026-07-26 captures, fixtures under
 * `src/__tests__/vex-agent/sync/fixtures/prediction-fill-settlement/`): a
 * prediction sell/close is THREE transactions, not one.
 *   1. order create — OUR tx (the row's `tx_hash`), moving ZERO tokens. This
 *      is why the own-tx decoder can never confirm the row: there is nothing
 *      in that transaction to decode. Two live rows sat `pending` with the
 *      money already sitting in the wallet.
 *   2. a keeper's FILL — vault → an escrow ATA owned by the ORDER PDA. Present
 *      in the provider's `/history` as `order_filled`. Our wallet is not a
 *      party to it.
 *   3. a keeper's SETTLE, ~2 seconds later — escrow → our wallet's JupUSD ATA,
 *      escrow closed. NOT in the provider's history at all. The only way to
 *      find it is `getSignaturesForAddress` on the escrow ATA, whose entire
 *      life is exactly three signatures.
 *
 * THE PROOF CHAIN, and why each link is required:
 *   - the provider's history is used ONLY to learn the `orderPubkey` behind a
 *     signature Vex itself broadcast. The match is exact on all four of
 *     eventType/owner/signature/position — a provider row that does not name
 *     OUR signature tells us nothing about OUR order;
 *   - the escrow ATA is DERIVED (`getAssociatedTokenAddressSync(payout mint,
 *     orderPubkey, allowOwnerOffCurve)`), never read from a provider field, so
 *     the address we scan is a function of the order key we matched;
 *   - the settling transaction must carry BOTH legs: a JupUSD DEBIT on an
 *     account owned by that order PDA and a STRICTLY POSITIVE JupUSD CREDIT to
 *     our wallet, of EQUAL magnitude. One leg alone is not a payout — a
 *     credit-only shape would let an unrelated transfer confirm this row, and
 *     a debit-only shape is the keeper's fill, which pays the escrow and not
 *     us. Equality is what makes "this money is that money" a proof rather
 *     than a coincidence.
 *
 * THE DEBIT IS BOUND TO THE DERIVED ACCOUNT ITSELF. An earlier version of
 * this lane matched the debit by `owner === orderPubkey` + mint, which is NOT
 * the same claim: an order PDA can own more than one JupUSD account, and
 * anyone can create another one with that owner. A transaction that merely
 * touched the escrow (enough to appear in its signature history), drained a
 * different order-owned account and credited our wallet the same amount would
 * have satisfied it. `decodeTokenAccountDelta` resolves each balance entry's
 * `accountIndex` against the transaction's combined account-key list and
 * requires the debited account to BE the derived escrow ATA. Only the wallet
 * side stays an owner+mint sum, where "how much did this wallet's holding
 * grow" is genuinely the question.
 *
 * ONE UNFILTERED HISTORY PAGE PER WALLET PER RUN. The provider's
 * `positionPubkey` filter is accepted and then returns an EMPTY page while
 * reporting a non-zero count (live-probed 2026-07-26 — see
 * `fetchPredictionOrderHistory`), which reads exactly like an authoritative
 * "no such order" and stalls the row forever. So the position never reaches
 * the request; it is applied locally to the returned events instead.
 *
 * NEVER THE PROVIDER'S NUMBER. `netProceedsUsd` is logged as a cross-check and
 * warned about on mismatch; the amount written is always the chain's own
 * balance delta. DECLINE IS NOT FAILURE: every unproven path leaves the row
 * `pending` for the next sweep tick — a provider 429, an RPC outage, a missing
 * match, or an unprovable candidate. This module never terminalizes anything
 * and never throws into the sweep.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

import { JUPITER_PREDICTION_PAYOUT_MINT } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/constants.js";
import { getJupiterPredictionHistory } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js";
import { readPredictionOrderPositionPubkey } from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-order-provenance.js";
import {
  confirmJupiterPredictionPayoutSettlement,
  type AgentActivityEvent,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";

import { withExactExecutedAmountHuman } from "./solana-executed-amount-human.js";
import {
  decodeTokenAccountDelta,
  decodeTokenBalanceDelta,
  parseSolanaTransactionResult,
} from "./solana-settlement-decoders.js";
import type { SolanaRpcLookup } from "./solana-activity-repair.js";

/**
 * An escrow ATA's whole life is create → fill → settle. Ten is a generous
 * bound that still refuses to walk an unbounded history if the account is
 * ever reused.
 */
const ESCROW_SIGNATURE_SCAN_LIMIT = 10;

/** The provider history event this lane matches on. */
const ORDER_CREATED_EVENT_TYPE = "order_created";
/** The sibling event carrying the provider's own proceeds figure (cross-check only). */
const ORDER_FILLED_EVENT_TYPE = "order_filled";

const PAYOUT_MINT_KEY = new PublicKey(JUPITER_PREDICTION_PAYOUT_MINT);

// ── The narrow provider view + the lane's dependency port ─────────────────

/**
 * The only history fields this lane reads. Financially-consumed fields
 * (`signature`, `orderPubkey`, `positionPubkey`, `ownerPubkey`, `eventType`)
 * are strict; `netProceedsUsd` is a display/cross-check field and is therefore
 * nullable — the tolerant-reader rule.
 */
export interface PredictionHistoryEventView {
  readonly eventType: string;
  readonly signature: string;
  readonly orderPubkey: string;
  readonly positionPubkey: string;
  readonly ownerPubkey: string;
  readonly netProceedsUsd: string | null;
}

export type PredictionHistoryLookup =
  | { readonly outcome: "found"; readonly events: readonly PredictionHistoryEventView[] }
  | { readonly outcome: "unavailable" };

/**
 * PER-WALLET ONLY, deliberately — there is no `positionPubkey` field here and
 * there must not be one. See `fetchPredictionOrderHistory` for the live
 * evidence that the provider's own position filter returns an EMPTY page.
 */
export interface PredictionHistoryQuery {
  readonly ownerPubkey: string;
}

export interface SolanaSignatureEntry {
  readonly signature: string;
  readonly err: unknown;
}

/**
 * The reads this lane may perform. Structurally a subset of
 * `SolanaActivitySweepDeps`, so the sweep passes its own port straight
 * through; declared separately so the lane's surface stays exactly what it
 * uses and its tests need nothing more.
 */
export interface PredictionFillSettlementDeps {
  readonly getFinalizedTransaction: (signature: string) => Promise<SolanaRpcLookup<unknown>>;
  readonly getSignaturesForAddress: (
    address: string,
    limit: number,
  ) => Promise<SolanaRpcLookup<readonly SolanaSignatureEntry[]>>;
  readonly getPredictionOrderHistory: (query: PredictionHistoryQuery) => Promise<PredictionHistoryLookup>;
}

/**
 * One history response per WALLET per SWEEP RUN — including a negative result,
 * so a rate-limited provider is asked once and not once per candidate row. One
 * page of a wallet's history answers every candidate row of that wallet,
 * whatever position each one closed.
 */
export interface PredictionHistoryCache {
  readonly entries: Map<string, PredictionHistoryLookup>;
}

export function createPredictionHistoryCache(): PredictionHistoryCache {
  return { entries: new Map<string, PredictionHistoryLookup>() };
}

export type PredictionFillSettlementOutcome = "confirmed" | "pending" | "duplicate";

// ── Entry condition ───────────────────────────────────────────────────────

/**
 * `predict_sell` (single close) and `predict_close` (a `closeAll` fan-out
 * item) only. `predict_claim` is deliberately excluded: the claim path has
 * never executed live, so its settlement shape is UNVERIFIED and this lane's
 * proof was never tested against it — a claim row stays pending on the
 * existing path, which is honest. Nothing outside Jupiter's prediction rows
 * can enter at all.
 */
export function isPredictionFillSettlementCandidate(event: AgentActivityEvent): boolean {
  return event.protocol === "jupiter"
    && event.kind === "prediction"
    && (event.eventRole === "predict_sell" || event.eventRole === "predict_close")
    && event.txHash !== null;
}

// ── Orchestration ─────────────────────────────────────────────────────────

export async function settlePredictionFillIfProven(input: {
  readonly event: AgentActivityEvent;
  readonly deps: PredictionFillSettlementDeps;
  readonly historyCache: PredictionHistoryCache;
}): Promise<PredictionFillSettlementOutcome> {
  const { event, deps, historyCache } = input;
  const createSignature = event.txHash;
  if (createSignature === null) return "pending"; // defensive; the entry gate already required it.

  const positionPubkey = readPredictionOrderPositionPubkey(event.routeProvenance);
  const history = await loadHistory(deps, historyCache, event.walletAddress);
  if (history.outcome === "unavailable") {
    logger.warn("prediction_fill_settlement.history_unavailable", { id: event.id });
    return "pending";
  }

  const matched = matchOrderCreatedEvent(history.events, {
    walletAddress: event.walletAddress,
    createSignature,
    positionPubkey,
  });
  if (!matched) {
    logger.warn("prediction_fill_settlement.no_matching_order_event", {
      id: event.id,
      hasPositionProvenance: positionPubkey !== null,
      historyEvents: history.events.length,
      hint: "provider history has no order_created for this wallet+signature — leaving row pending",
    });
    return "pending";
  }

  const orderKey = parsePublicKey(matched.orderPubkey);
  if (!orderKey) {
    logger.warn("prediction_fill_settlement.unparseable_order_pubkey", { id: event.id });
    return "pending";
  }

  const escrowAta = getAssociatedTokenAddressSync(PAYOUT_MINT_KEY, orderKey, true).toBase58();
  const proven = await proveEscrowPayout({
    deps,
    escrowAta,
    orderPubkey: matched.orderPubkey,
    walletAddress: event.walletAddress,
    createSignature,
  });
  if (!proven) {
    logger.warn("prediction_fill_settlement.no_proven_settlement", {
      id: event.id,
      escrowAta,
      hint: "no escrow transaction proved both legs — leaving row pending",
    });
    return "pending";
  }

  crossCheckProviderProceeds(event.id, history.events, matched.orderPubkey, proven.amountRaw);

  return finalizeProvenPayout(event, {
    amountRaw: proven.amountRaw,
    settleSignature: proven.settleSignature,
    escrowAta,
    orderPubkey: matched.orderPubkey,
    createSignature,
    matchedEventType: matched.eventType,
  });
}

// ── Provider history ──────────────────────────────────────────────────────

async function loadHistory(
  deps: PredictionFillSettlementDeps,
  cache: PredictionHistoryCache,
  ownerPubkey: string,
): Promise<PredictionHistoryLookup> {
  const cached = cache.entries.get(ownerPubkey);
  if (cached) return cached;

  const lookup = await deps.getPredictionOrderHistory({ ownerPubkey });
  cache.entries.set(ownerPubkey, lookup);
  return lookup;
}

/**
 * The provider event proving which ORDER our own signature created, selected
 * LOCALLY out of the wallet's whole history page. Every clause is required: a
 * different event type describes a different moment, a different owner is a
 * different wallet, a different signature is a different transaction, and —
 * when the row knows its own position — a different position is a SIBLING
 * row's close.
 *
 * That last clause is the ONLY position guarantee in this lane, because the
 * provider's server-side position filter is broken (see
 * `fetchPredictionOrderHistory`). Doing it here is also strictly stronger than
 * trusting the server would have been: the filter could only ever narrow the
 * page, whereas this rejects a mismatch outright, and it is what stops a
 * `closeAll` fan-out from settling one row against another's money.
 */
function matchOrderCreatedEvent(
  events: readonly PredictionHistoryEventView[],
  criteria: {
    readonly walletAddress: string;
    readonly createSignature: string;
    readonly positionPubkey: string | null;
  },
): PredictionHistoryEventView | null {
  for (const event of events) {
    if (event.eventType !== ORDER_CREATED_EVENT_TYPE) continue;
    if (event.ownerPubkey !== criteria.walletAddress) continue;
    if (event.signature !== criteria.createSignature) continue;
    if (criteria.positionPubkey !== null && event.positionPubkey !== criteria.positionPubkey) continue;
    return event;
  }
  return null;
}

/**
 * The production adapter for `/history`. Any failure — 429, 5xx, transport,
 * schema rejection — degrades to `"unavailable"`, which the lane reads as
 * "ask again next tick", never as "there is no such order".
 *
 * NEVER SENDS `positionPubkey`. The provider accepts the parameter and then
 * returns an EMPTY PAGE while reporting a non-zero count — probed live
 * 2026-07-26 (`agents_dm/verify/probe-prediction-history-position-filter.ts`):
 * `{ownerPubkey}` returned 7 events of `total: 21`, while adding row 42's
 * `positionPubkey` returned 0 events with `pagination {start: 0, end: 0,
 * total: 4}`, and row 47's returned 0 of `total: 2`. A filter that reports
 * matches it will not hand over is worse than one that is merely ignored: it
 * looks like an authoritative "this order does not exist", and it stalled a
 * fresh row that HAD provenance while legacy rows kept settling only because
 * their lookup was unfiltered. The position is used for LOCAL matching only —
 * see `matchOrderCreatedEvent`.
 */
export async function fetchPredictionOrderHistory(
  query: PredictionHistoryQuery,
): Promise<PredictionHistoryLookup> {
  try {
    const response = await getJupiterPredictionHistory({ ownerPubkey: query.ownerPubkey });
    return {
      outcome: "found",
      events: response.data.map((event) => ({
        eventType: event.eventType,
        signature: event.signature,
        orderPubkey: event.orderPubkey,
        positionPubkey: event.positionPubkey,
        ownerPubkey: event.ownerPubkey,
        netProceedsUsd: typeof event.netProceedsUsd === "string" ? event.netProceedsUsd : null,
      })),
    };
  } catch (err) {
    logger.warn("prediction_fill_settlement.history_request_failed", {
      error: summarizeProtocolError(err).message,
    });
    return { outcome: "unavailable" };
  }
}

// ── The on-chain proof ────────────────────────────────────────────────────

interface ProvenPayout {
  readonly amountRaw: string;
  readonly settleSignature: string;
}

/**
 * Scan the escrow ATA's own (short) signature history for the ONE transaction
 * that proves both legs. A candidate that failed on chain, could not be
 * fetched, or cannot prove both legs is skipped and the scan continues; if
 * none proves, the row simply stays pending.
 */
async function proveEscrowPayout(input: {
  readonly deps: PredictionFillSettlementDeps;
  readonly escrowAta: string;
  readonly orderPubkey: string;
  readonly walletAddress: string;
  readonly createSignature: string;
}): Promise<ProvenPayout | null> {
  const signatures = await input.deps.getSignaturesForAddress(input.escrowAta, ESCROW_SIGNATURE_SCAN_LIMIT);
  if (signatures.outcome !== "found") return null;

  for (const entry of signatures.value) {
    if (entry.err !== null && entry.err !== undefined) continue; // a failed tx moved nothing.
    if (entry.signature === input.createSignature) continue; // our own create moves zero tokens.
    const lookup = await input.deps.getFinalizedTransaction(entry.signature);
    if (lookup.outcome !== "found") continue;
    const amount = provePayoutLegs(lookup.value, {
      walletAddress: input.walletAddress,
      orderPubkey: input.orderPubkey,
      escrowAta: input.escrowAta,
    });
    if (amount === null) continue;
    return { amountRaw: amount.toString(), settleSignature: entry.signature };
  }
  return null;
}

/**
 * The strictly-positive JupUSD credit to our wallet, but ONLY when the same
 * transaction debits THE DERIVED ESCROW ACCOUNT by exactly that magnitude.
 * `null` for every other shape — an unreadable transaction, an on-chain error,
 * a mint this transaction never touched, a credit with no matching debit, a
 * debit with no credit to us, unequal magnitudes, zero, or a negative
 * movement.
 *
 * The debit is bound to the derived escrow ACCOUNT, not merely to its owner —
 * see this module's doc for why that distinction is the whole proof.
 */
function provePayoutLegs(
  raw: unknown,
  legs: { readonly walletAddress: string; readonly orderPubkey: string; readonly escrowAta: string },
): bigint | null {
  const parsed = parseSolanaTransactionResult(raw);
  if (!parsed) return null;
  if (parsed.err !== null && parsed.err !== undefined) return null;

  const escrowDelta = decodeTokenAccountDelta(parsed, {
    address: legs.escrowAta,
    mint: JUPITER_PREDICTION_PAYOUT_MINT,
    owner: legs.orderPubkey,
  });
  if (escrowDelta === null || escrowDelta >= 0n) return null;

  const walletDelta = decodeTokenBalanceDelta(parsed, legs.walletAddress, JUPITER_PREDICTION_PAYOUT_MINT);
  if (walletDelta === null || walletDelta <= 0n) return null;

  if (-escrowDelta !== walletDelta) return null;
  return walletDelta;
}

function parsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

// ── Cross-check + finalize ────────────────────────────────────────────────

/**
 * The provider's own proceeds figure for the same order, compared against what
 * the chain proved. NEVER recorded — a mismatch means our reading of the
 * lifecycle deserves a second look, not that the provider's number is the
 * truth.
 */
function crossCheckProviderProceeds(
  id: number,
  events: readonly PredictionHistoryEventView[],
  orderPubkey: string,
  provenAmountRaw: string,
): void {
  const filled = events.find(
    (event) => event.eventType === ORDER_FILLED_EVENT_TYPE && event.orderPubkey === orderPubkey,
  );
  const reported = filled?.netProceedsUsd;
  if (reported === undefined || reported === null || !/^\d+$/.test(reported)) return;
  if (reported !== provenAmountRaw) {
    logger.warn("prediction_fill_settlement.provider_proceeds_mismatch", {
      id,
      provenAmountRaw,
      providerNetProceeds: reported,
      hint: "recorded the chain-proven magnitude; the provider figure is a cross-check only",
    });
  }
}

async function finalizeProvenPayout(
  event: AgentActivityEvent,
  proof: {
    readonly amountRaw: string;
    readonly settleSignature: string;
    readonly escrowAta: string;
    readonly orderPubkey: string;
    readonly createSignature: string;
    readonly matchedEventType: string;
  },
): Promise<PredictionFillSettlementOutcome> {
  // The exact-decimal sibling comes from the ROW's own persisted decimals —
  // the same "between the decode and the confirm" convention the sweep uses
  // for every other Solana settlement.
  const { executedAmountOutHuman } = withExactExecutedAmountHuman(
    { executedAmountOutRaw: proof.amountRaw },
    { tokenInDecimals: event.tokenInDecimals, tokenOutDecimals: event.tokenOutDecimals },
  );

  const outcome = await confirmJupiterPredictionPayoutSettlement(event.id, {
    executedAmountOutRaw: proof.amountRaw,
    ...(executedAmountOutHuman !== undefined ? { executedAmountOutHuman } : {}),
    orderPubkey: proof.orderPubkey,
    createSignature: proof.createSignature,
    matchedEventType: proof.matchedEventType,
    matchedAt: new Date().toISOString(),
    settleSignature: proof.settleSignature,
    escrowAta: proof.escrowAta,
  });

  if (outcome.applied) {
    logger.info("prediction_fill_settlement.confirmed", {
      id: event.id,
      executedAmountOutRaw: proof.amountRaw,
      settleSignature: proof.settleSignature,
    });
    return "confirmed";
  }
  logger.info("prediction_fill_settlement.duplicate_cas_miss", { id: event.id, status: outcome.row.status });
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}
