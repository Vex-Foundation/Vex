/**
 * THE LIGHTER ROW WRITERS - what AgentScan is told about a Lighter account,
 * and the one place that decides it.
 *
 * Three public units, and the shape of each is the H0 contract, not a
 * convenience:
 *
 *   - a FILL is written to the durable `lighter_fills` ledger (migration 152),
 *     one row per distinct matched fill, at the same durable transition where
 *     an order execution intent learns it was filled. The ledger exists
 *     because the intent's own outcome evidence is MUTABLE and holds one
 *     trade: two fills in one stream frame, or a fill re-observed by recovery,
 *     collapse there into a single fact. AgentScan dedupes on a source row id,
 *     so what it is told about has to be a row that never moves and never
 *     merges.
 *
 *   - a DEPOSIT and a claimed WITHDRAWAL are ordinary `agent_activity` rows.
 *     They are settlement-chain transactions with real receipts, so they ride
 *     the path that already verifies receipts rather than inventing a second
 *     one. What a receipt proves is the SETTLEMENT transaction and its
 *     amounts - never the L2 credit, and never a withdrawal's provenance.
 *
 *   - a POSITION SNAPSHOT is neither: no transaction, no Vex authorship, and
 *     account-wide by construction. It is a local observation projection
 *     (`../../../sync/lighter-position-snapshot.ts`), reported as observed and
 *     labelled as covering trading Vex did not do.
 *
 * ## What is never a row
 *
 * A cancel, a modify, a partial state and a close produce NOTHING here. A
 * close is one or more fills, and reporting it as its own unit would double
 * the volume it represents. A cancelled order moved no money.
 *
 * ## Immutable economics, explicit enrichment
 *
 * A fill's identity, side, price and size never change. `recordLighterFill`
 * inserts and, on a repeat of the same identity, either does nothing (the
 * facts match: idempotent) or reports a typed conflict (the facts differ: a
 * defect, logged, never a silent overwrite). The ONLY later write is
 * {@link enrichLighterFillChargedFees}, which fills exact charged amounts that
 * were unknown at fill time and refuses to touch one that is already known.
 * A verification outcome is never written here at all: verification belongs to
 * the server, and a client that stamped its own would be attesting to itself.
 *
 * ## Authorized fee terms are not observed fees
 *
 * FOUR different numbers, four columns, and collapsing any two of them
 * misreports the money (H0 revision 2, correction 6):
 *
 *   - the AUTHORIZED integrator tick, from the fee-authorization terms: what
 *     the approval PERMITS on this side of the book. It is a term, and a term
 *     is not evidence that it was applied to anything;
 *   - the OBSERVED integrator tick, which the provider stamped on THIS trade
 *     record (`integrator_maker_fee` / `integrator_taker_fee`), null when the
 *     record carries none;
 *   - the OBSERVED exchange tick (`maker_fee` / `taker_fee`). Measured live
 *     2026-09-08: these are RATE TICKS in millionths of notional - 350 on RHC,
 *     100 and 28 on Core beside notionals under one dollar - the same unit as
 *     `current_taker_fee_tick`, and not amounts. Reading them as amounts would
 *     overstate a sub-dollar trade's fee by orders of magnitude;
 *   - the ESTIMATE, arithmetic on this fill's own basis, computed from the
 *     OBSERVED tick when the provider gave one and from the authorized term
 *     otherwise - and it says which, because an estimate on an authorized
 *     basis is the weaker claim.
 *
 * The CHARGED amount is the provider's own figure and is none of the above.
 * An unproven charged amount stays NULL - never zero, because a zero is a
 * proven amount and reads as "no fee was taken".
 *
 * ## Privacy
 *
 * The account index is part of a fill's venue identity and is stored. Nothing
 * else about identity is: no L1 address, no session id, no nonce, no
 * credential, no signed payload, no raw provider response, and none of the
 * counterparty fields a public trade record carries (their account id, their
 * order id, their position size). The builders below name every field they
 * read; there is no spread and no passthrough anywhere in this file.
 */

import type { PoolClient } from "pg";

import { execute, executeWith, queryOne, queryOneWith } from "@vex-agent/db/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterTrade, LighterTradeType } from "@tools/lighter/types.js";
import logger from "@utils/logger.js";

import {
  classifyLighterPositionEffect,
  readLighterAccountFillFacts,
  type LighterAccountFillFacts,
  type LighterPositionEffect,
} from "./fill-position-effect.js";

/** Spot markets start here; below it a market is a perpetual. */
const LIGHTER_SPOT_MARKET_INDEX_FLOOR = 2048;

/** The venue asset id namespace. Lighter assets have no EVM address and none is invented. */
export function lighterVenueAssetId(environment: LighterEnvironment, assetId: string | number): string {
  return `lighter:${environment}:asset:${assetId}`;
}

/**
 * The venue id of a PERPETUAL'S INSTRUMENT, the base leg of a perp fill.
 *
 * A perpetual has no base asset: measured live on 2026-09-08, Lighter's
 * `orderBookDetails` reports `base_asset_id: 0, quote_asset_id: 0` for every
 * perp on Core and on Robinhood Chain (asset id 0 names nothing), while a spot
 * market carries the real ids of its two assets. Naming the instrument by its
 * market keeps every perp distinct and keeps asset id 0 out of the ledger.
 */
export function lighterPerpVenueAssetId(environment: LighterEnvironment, marketIndex: number): string {
  return `lighter:${environment}:perp:${marketIndex}`;
}

/**
 * The canonical fill identity, and the ONLY spelling of it.
 *
 * `lighter:<environment>:<accountIndex>:<marketIndex>:<providerTradeId>` -
 * enforced as a unique column in migration 152 as well as by the tuple, so a
 * disagreement between the two spellings is a constraint violation rather than
 * a silent duplicate.
 */
export function lighterFillIdentity(input: {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly providerTradeId: string;
}): string {
  return `lighter:${input.environment}:${input.accountIndex}:${input.marketIndex}:${input.providerTradeId}`;
}

/** A venue asset as it is stored on a fill row. */
export interface LighterVenueAssetRef {
  readonly venueAssetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * The market facts a fill needs that the trade record does not carry: the
 * symbol a human reads and the two assets with their own decimals.
 *
 * Read from the provider (`orderBookDetails.market_config` and the asset
 * details), never assumed - a quote asset's decimals are a provider fact, and
 * a wrong one silently multiplies every reported amount by a power of ten.
 */
export interface LighterMarketAssets {
  readonly marketSymbol: string;
  readonly baseAsset: LighterVenueAssetRef;
  readonly quoteAsset: LighterVenueAssetRef;
}

/** The authorized integrator terms in force for the order this fill belongs to. */
export interface LighterFillFeeTerms {
  readonly integratorMakerFeeTick: number | null;
  readonly integratorTakerFeeTick: number | null;
  readonly collectorAccountIndex: number | null;
  readonly feeAuthorizationIntentId: string | null;
  /** The asset the integrator fee is denominated in, when it is known. */
  readonly feeAsset: LighterVenueAssetRef | null;
}

/** What one fill looks like once every source has been read. */
export interface LighterFillRecord {
  readonly canonicalIdentity: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly providerTradeId: string;
  readonly providerOrderId: string | null;
  readonly clientOrderId: string | null;
  readonly executionIntentId: string | null;
  readonly marketSymbol: string;
  readonly side: "buy" | "sell";
  readonly price: string;
  readonly baseSize: string;
  readonly quoteNotional: string;
  readonly baseAsset: LighterVenueAssetRef;
  readonly quoteAsset: LighterVenueAssetRef;
  readonly blockHeight: string;
  /** Lighter's own classification of the record: trade, liquidation, deleverage, market-settlement. */
  readonly tradeType: LighterTradeType;
  /**
   * When the VENUE matched the fill, from `trade.timestamp`. MEASURED
   * 2026-09-08 against the live public endpoint: epoch MILLISECONDS
   * (1788858716527 beside a wall clock of 1788858717535), and
   * `transaction_time` beside it is epoch MICROSECONDS. This is the campaign
   * API's "time", and it is the provider's, never our observation time.
   */
  readonly tradedAt: string;
  /** `trade.transaction_time`, epoch microseconds, as a lossless decimal string. */
  readonly transactionTimeUs: string | null;
  /**
   * LIGHTER'S OWN USD notional for the fill (`usd_amount`), which is what the
   * campaign sums as volume. Distinct from `quoteNotional` below, which is our
   * own exact product of size and price in the QUOTE asset: the two agree on a
   * USD-quoted market and would not on any other, and only one of them is the
   * provider's word.
   */
  readonly usdAmount: string;
  /**
   * The account's own half of the trade record, or null when the observation
   * was a public row that does not carry it. Established ONCE: a later
   * authenticated observation fills it through the merge rule and nothing ever
   * revises it.
   */
  readonly accountFacts: LighterAccountFillFacts | null;
  /** Null exactly when {@link accountFacts} is null. Established with it, once. */
  readonly positionEffect: LighterPositionEffect | null;
  readonly feeSide: "maker" | "taker";
  /** The tick the fee AUTHORIZATION permits for this side. A term, not evidence. */
  readonly integratorFeeTickAuthorized: number | null;
  /** The integrator tick the provider stamped on this trade record. Null when absent. */
  readonly integratorFeeTickObserved: number | null;
  readonly integratorFeeAsset: LighterVenueAssetRef | null;
  readonly integratorFeeEstimatedRaw: string | null;
  readonly integratorFeeEstimateBasis: "quote_notional" | "received_base" | null;
  /** Which tick the estimate was computed from. Null exactly when there is no estimate. */
  readonly integratorFeeEstimateTickSource: "observed" | "authorized" | null;
  /** EXACT provider-reported amount. Null until proven; never zero as a placeholder. */
  readonly integratorFeeChargedRaw: string | null;
  /** The exchange tier tick observed on this trade record, in millionths of notional. */
  readonly exchangeFeeTickObserved: number | null;
  readonly exchangeFeeChargedRaw: string | null;
  /**
   * THE FEE ESTIMATES IN USD, computed on LIGHTER'S OWN `usd_amount` and never
   * on an assumed stablecoin parity: the campaign asks for fees in USD, and
   * treating a quote-asset amount as dollars because the symbol looks like a
   * dollar is exactly the assumption that breaks on the first non-USD market.
   * Null when the tick is absent, and null for the integrator fee on a spot
   * BUY, which is charged in the received base and keeps that denomination
   * rather than being converted by a rate nobody measured.
   */
  readonly integratorFeeEstimatedUsd: string | null;
  readonly exchangeFeeEstimatedUsd: string | null;
  readonly collectorAccountIndex: number | null;
  readonly feeAuthorizationIntentId: string | null;
  /** Whether this fill is on a spot market. Decides the reported kind and role. */
  readonly spot: boolean;
}

/** Why a trade record could not become a fill row. Never thrown: a bad record must not kill a reconciliation. */
export interface LighterFillBuildFailure {
  readonly kind: "unbuildable";
  readonly reason:
    | "malformed_amount"
    | "missing_trade_identity"
    /** No intent AND no observation scope: nothing says which account this fill belongs to. */
    | "missing_observation_scope"
    /** The scope's account is on neither side of this trade record, or on both. */
    | "account_not_party_to_trade";
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * The intent facts a fill is built against. A narrow structural type rather
 * than the execution intent row itself: this module must not depend on the
 * execution owner's shape, and every field it needs is one the caller already
 * has in hand at the commit point.
 */
export interface LighterFillIntentFacts {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  readonly side: "buy" | "sell";
  readonly clientOrderIndex: string | null;
}

/**
 * The scope a fill was OBSERVED in, when no intent is known yet.
 *
 * Recovery after a crash reads the account's trades and finds fills whose Vex
 * intent has not been recovered. Those fills are facts and are written; what
 * they are NOT is attributed activity, so the row is HELD (execution intent
 * null, excluded from the outbox) until {@link attachLighterFillToIntent}
 * proves which durable intent it belongs to.
 */
export interface LighterFillObservationScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
}

/**
 * PURE: one provider trade record plus the intent it matched -> one fill row.
 *
 * The maker/taker side is derived the way `order-evidence.ts` derives it (the
 * account is the maker when it was on the maker side of this trade), because
 * the integrator tick and the exchange tier fee both differ between the two
 * and reading the wrong one misreports the money.
 */
export function buildLighterFillRecord(input: {
  readonly trade: LighterTrade;
  /**
   * The Vex order execution intent this fill belongs to, or NULL when the
   * observation found the fill before its intent was known. A null intent
   * requires {@link LighterFillObservationScope} and produces a HELD row.
   */
  readonly intent: LighterFillIntentFacts | null;
  /** Required when `intent` is null; ignored when an intent is given. */
  readonly observation?: LighterFillObservationScope;
  readonly market: LighterMarketAssets;
  readonly feeTerms: LighterFillFeeTerms;
}): LighterFillRecord | LighterFillBuildFailure {
  const { trade, intent, market, feeTerms } = input;
  const scope: LighterFillObservationScope | undefined = intent === null
    ? input.observation
    : { environment: intent.environment, accountIndex: intent.accountIndex, marketIndex: intent.marketIndex };
  if (scope === undefined) return { kind: "unbuildable", reason: "missing_observation_scope" };

  // WITHOUT AN INTENT THE SIDE COMES FROM THE TRADE RECORD, which names both
  // parties: the account is the seller when it is the ask, the buyer when it
  // is the bid. Neither (or both, which is an account trading with itself)
  // leaves no side to report, and a guessed side would put the fill on the
  // wrong half of every fee and every position figure below.
  const side = intent !== null ? intent.side : tradeSideForAccount(trade, scope.accountIndex);
  if (side === null) return { kind: "unbuildable", reason: "account_not_party_to_trade" };

  const providerTradeId = nonEmpty(trade.trade_id_str);
  const blockHeight = integerString(trade.block_height);
  const tradedAt = epochMillisecondsIso(trade.timestamp);
  if (providerTradeId === null || blockHeight === null || tradedAt === null) {
    return { kind: "unbuildable", reason: "missing_trade_identity" };
  }
  if (!DECIMAL.test(trade.price) || !DECIMAL.test(trade.size)) {
    return { kind: "unbuildable", reason: "malformed_amount" };
  }
  if (typeof trade.usd_amount !== "string" || !DECIMAL.test(trade.usd_amount)) {
    return { kind: "unbuildable", reason: "malformed_amount" };
  }
  const quoteNotional = multiplyDecimals(trade.size, trade.price);
  if (quoteNotional === null) return { kind: "unbuildable", reason: "malformed_amount" };

  const maker = side === "sell" ? trade.is_maker_ask : !trade.is_maker_ask;
  const feeSide = maker ? "maker" : "taker";
  const providerOrderId = nonEmpty(side === "buy" ? trade.bid_id_str : trade.ask_id_str);
  const spot = scope.marketIndex >= LIGHTER_SPOT_MARKET_INDEX_FLOOR;

  // THE ACCOUNT'S OWN HALF, or nothing. A public row carries the position
  // sizes but neither the sign-changed flag nor the realized PnL, and half the
  // fields is not a classification - so the effect stays NULL and a later
  // authenticated observation establishes it once, through the merge rule.
  const accountFacts = readLighterAccountFillFacts({ trade, role: feeSide, side });
  const positionEffect = accountFacts === null
    ? null
    : classifyLighterPositionEffect({
        positionSizeBefore: accountFacts.positionSizeBefore,
        positionSignChanged: accountFacts.positionSignChanged,
        fillBaseSize: trade.size,
        side,
      });

  // A SPOT BUY IS CHARGED ON THE RECEIVED BASE, every other case on the quote
  // notional. `order-evidence.ts` established this from the provider's own
  // behaviour; the basis travels with the estimate so a reader can never be
  // left guessing which number the percentage was applied to.
  const receivedBase = spot && side === "buy";
  const integratorFeeTickAuthorized = maker
    ? feeTerms.integratorMakerFeeTick
    : feeTerms.integratorTakerFeeTick;
  // THE PROVIDER'S OWN TICK FOR THIS TRADE, read from the side the account was
  // actually on. It is evidence; the authorization above is a term.
  const integratorFeeTickObserved = feeRateTick(
    maker ? trade.integrator_maker_fee : trade.integrator_taker_fee,
  );
  const exchangeFeeTickObserved = feeRateTick(maker ? trade.maker_fee : trade.taker_fee);
  // ESTIMATE FROM WHAT THE PROVIDER DID when the provider said what it did,
  // and from the authorized term only when it did not - labelled either way.
  const estimateTickSource = integratorFeeTickObserved !== null ? "observed" : "authorized";
  const estimateTick = integratorFeeTickObserved ?? integratorFeeTickAuthorized;
  const estimate = estimateTick === null || feeTerms.feeAsset === null
    ? null
    : estimateIntegratorFeeRaw(
        receivedBase ? trade.size : quoteNotional,
        estimateTick,
        feeTerms.feeAsset.decimals,
      );

  return {
    canonicalIdentity: lighterFillIdentity({
      environment: scope.environment,
      accountIndex: scope.accountIndex,
      marketIndex: scope.marketIndex,
      providerTradeId,
    }),
    environment: scope.environment,
    accountIndex: scope.accountIndex,
    marketIndex: scope.marketIndex,
    providerTradeId,
    providerOrderId,
    clientOrderId: intent?.clientOrderIndex ?? null,
    executionIntentId: intent?.intentId ?? null,
    marketSymbol: market.marketSymbol,
    side,
    price: trade.price,
    baseSize: trade.size,
    quoteNotional,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    blockHeight,
    tradeType: trade.type,
    tradedAt,
    transactionTimeUs: integerString(trade.transaction_time),
    usdAmount: trade.usd_amount,
    accountFacts,
    positionEffect,
    feeSide,
    integratorFeeTickAuthorized,
    integratorFeeTickObserved,
    integratorFeeAsset: estimate === null ? null : feeTerms.feeAsset,
    integratorFeeEstimatedRaw: estimate,
    integratorFeeEstimateBasis: estimate === null ? null : receivedBase ? "received_base" : "quote_notional",
    integratorFeeEstimateTickSource: estimate === null ? null : estimateTickSource,
    // NEVER derived. The exact charged amount is the provider's own figure and
    // is written only by the enrichment path, when it exists.
    integratorFeeChargedRaw: null,
    exchangeFeeTickObserved,
    exchangeFeeChargedRaw: null,
    // USD estimates on Lighter's own `usd_amount`. The integrator estimate is
    // withheld on a spot buy: that fee is taken in the received base, and
    // converting it here would need a rate this module has not measured.
    integratorFeeEstimatedUsd: receivedBase ? null : estimateFeeUsd(trade.usd_amount, estimateTick),
    exchangeFeeEstimatedUsd: estimateFeeUsd(trade.usd_amount, exchangeFeeTickObserved),
    collectorAccountIndex: feeTerms.collectorAccountIndex,
    feeAuthorizationIntentId: feeTerms.feeAuthorizationIntentId,
    spot,
  };
}

/** Whether a build result is the failure arm. */
export function isLighterFillBuildFailure(
  result: LighterFillRecord | LighterFillBuildFailure,
): result is LighterFillBuildFailure {
  return "kind" in result && result.kind === "unbuildable";
}

/** What writing one fill did. */
export type LighterFillWriteOutcome =
  | { readonly kind: "recorded"; readonly fillId: number }
  /** The same identity was already recorded with the same economics. Nothing changed. */
  | { readonly kind: "duplicate"; readonly fillId: number }
  /**
   * The same identity was already held WITHOUT the account's own fields, and
   * this observation supplied them. The economics were untouched; the row
   * learned what it did not know, once, and its revision moved so the
   * knowledge reaches AgentScan as an update to the fill already delivered.
   */
  | { readonly kind: "enriched"; readonly fillId: number; readonly revision: number }
  /**
   * The same identity was already recorded with DIFFERENT economics. Refused
   * and logged: a fill's price, size and side are immutable, so a
   * contradiction is a defect in whoever produced the second report, and
   * overwriting would destroy the only copy of the truth.
   */
  | { readonly kind: "conflict"; readonly fillId: number; readonly fields: readonly string[] };

/**
 * The economics a repeat report must match exactly.
 *
 * Every one of these is on the trade record from the FIRST observation
 * onwards, public or authenticated alike, so a difference is a contradiction
 * rather than a source knowing more. The account-relative columns are
 * deliberately absent from this list: they are the ones a public row leaves
 * null, and filling a null is not a revision.
 */
const IMMUTABLE_FILL_FIELDS = [
  "side",
  "price",
  "base_size",
  "quote_notional",
  "block_height",
  "trade_type",
  "usd_amount",
  "traded_at",
] as const;

/**
 * THE FILL COMMIT POINT.
 *
 * Call it at the same durable transition where an order execution intent
 * becomes `partially_filled` or `filled`, inside that transition's own
 * transaction where one exists, so a fill is recorded exactly when the
 * execution owner commits the fact that produced it. Passing the client is
 * what makes the two one commit; the client-less form exists for the recovery
 * and replay paths that have no surrounding transaction of their own.
 *
 * Idempotent by identity, so a re-observation (a recovery sweep, a stream
 * resnapshot, a replayed frame) records nothing new and reports `duplicate`.
 */
export async function recordLighterFillActivity(
  record: LighterFillRecord,
  client?: PoolClient,
): Promise<LighterFillWriteOutcome> {
  const params = [
    record.canonicalIdentity,
    record.environment,
    record.accountIndex,
    record.marketIndex,
    record.providerTradeId,
    record.providerOrderId,
    record.clientOrderId,
    record.executionIntentId,
    record.marketSymbol,
    record.side,
    record.price,
    record.baseSize,
    record.quoteNotional,
    record.baseAsset.venueAssetId,
    record.baseAsset.symbol,
    record.baseAsset.decimals,
    record.quoteAsset.venueAssetId,
    record.quoteAsset.symbol,
    record.quoteAsset.decimals,
    record.blockHeight,
    record.tradeType,
    record.tradedAt,
    record.transactionTimeUs,
    record.usdAmount,
    record.accountFacts?.positionSizeBefore ?? null,
    record.accountFacts?.positionSignChanged ?? null,
    record.accountFacts?.entryQuoteBefore ?? null,
    record.accountFacts?.accountPnl ?? null,
    record.positionEffect,
    record.feeSide,
    record.integratorFeeTickAuthorized,
    record.integratorFeeTickObserved,
    record.integratorFeeAsset?.venueAssetId ?? null,
    record.integratorFeeAsset?.symbol ?? null,
    record.integratorFeeAsset?.decimals ?? null,
    record.integratorFeeEstimatedRaw,
    record.integratorFeeEstimateBasis,
    record.integratorFeeEstimateTickSource,
    record.integratorFeeChargedRaw,
    record.exchangeFeeTickObserved,
    record.exchangeFeeChargedRaw,
    record.integratorFeeEstimatedUsd,
    record.exchangeFeeEstimatedUsd,
    record.collectorAccountIndex,
    record.feeAuthorizationIntentId,
  ];

  // DO NOTHING, never DO UPDATE: an insert conflict is a fill we already hold,
  // and its economics are not up for revision.
  const inserted = client === undefined
    ? await queryOne<{ id: string | number }>(INSERT_FILL_SQL, params)
    : await queryOneWith<{ id: string | number }>(client, INSERT_FILL_SQL, params);
  if (inserted !== null) return { kind: "recorded", fillId: Number(inserted.id) };

  const existing = client === undefined
    ? await queryOne<Record<string, unknown>>(SELECT_FILL_BY_IDENTITY_SQL, [record.canonicalIdentity])
    : await queryOneWith<Record<string, unknown>>(client, SELECT_FILL_BY_IDENTITY_SQL, [record.canonicalIdentity]);
  if (existing === null) {
    // The row was deleted between the insert and this read. Nothing was
    // written and nothing is claimed; the next observation records it again.
    throw new Error("lighter_fills: insert conflicted but the conflicting row is gone");
  }

  const proposed: Record<string, string> = {
    side: record.side,
    price: record.price,
    base_size: record.baseSize,
    quote_notional: record.quoteNotional,
    block_height: record.blockHeight,
    trade_type: record.tradeType,
    usd_amount: record.usdAmount,
    // Compared as the same ISO 8601 spelling the record carries: the SELECT
    // formats the column in UTC with milliseconds, so two identical instants
    // never read as a difference because of a session time zone.
    traded_at: record.tradedAt,
  };
  const fields = IMMUTABLE_FILL_FIELDS.filter((field) => String(existing[field]) !== proposed[field]);
  const fillId = Number(existing.id);
  if (fields.length > 0) {
    logger.error("lighter.agentscan.fill_identity_conflict", {
      canonicalIdentity: record.canonicalIdentity,
      fields: [...fields],
    });
    return { kind: "conflict", fillId, fields: [...fields] };
  }

  // THE ECONOMICS AGREE. If this observation knows the account's own half and
  // the held row does not, that is knowledge arriving, not a revision: fill it
  // once and move the revision so it reaches a server that already has the
  // fill. If the row already knows, or this observation does not, nothing
  // happens and the report is an ordinary duplicate.
  if (record.accountFacts === null || existing.position_size_before !== null) {
    return { kind: "duplicate", fillId };
  }
  const mergeParams = [
    record.canonicalIdentity,
    record.accountFacts.positionSizeBefore,
    record.accountFacts.positionSignChanged,
    record.accountFacts.entryQuoteBefore,
    record.accountFacts.accountPnl,
    record.positionEffect,
  ];
  const merged = client === undefined
    ? await queryOne<{ id: string | number; revision: number }>(MERGE_FILL_ACCOUNT_FACTS_SQL, mergeParams)
    : await queryOneWith<{ id: string | number; revision: number }>(client, MERGE_FILL_ACCOUNT_FACTS_SQL, mergeParams);
  // A concurrent observation won the race and established the same knowledge
  // first. Nothing was lost and nothing is claimed twice.
  if (merged === null) return { kind: "duplicate", fillId };
  return { kind: "enriched", fillId: Number(merged.id), revision: Number(merged.revision) };
}

/**
 * ATTACHING A HELD FILL TO THE VEX INTENT THAT PRODUCED IT.
 *
 * A fill found by recovery before its intent was known is written HELD:
 * `execution_intent_id` null, and excluded from the AgentScan outbox by that
 * null (`agentscan-reporting.ts`). Attribution is the claim "Vex created this
 * order", so it is granted only on evidence that the venue itself carries.
 *
 * FOUR FACTS MUST AGREE, and the fourth is the one that does the work: the
 * environment, the account index, the market index, and THE ACCOUNT'S OWN
 * ORDER ID on the venue - the bid id when the account bought, the ask id when
 * it sold - against the provider order id the durable intent recorded when the
 * exchange accepted it. The integrator COLLECTOR index attributes nothing: it
 * says a fee was routed to Vex's collector, which is equally true of a fill
 * from an order some other client placed under the same integrator terms.
 *
 * A mismatch is a typed refusal, never a best-effort attach: an attribution
 * granted on a near-match is a claim about someone else's trading.
 */
export type LighterFillAttachOutcome =
  | { readonly kind: "attached"; readonly fillId: number }
  /** Already attached to this same intent. Idempotent; a replayed recovery is not an error. */
  | { readonly kind: "already_attached"; readonly fillId: number }
  | {
      readonly kind: "refused";
      readonly reason:
        | "unknown_fill"
        | "scope_mismatch"
        | "provider_order_id_mismatch"
        | "attached_to_other_intent";
    };

/** The durable intent facts an attachment is proved against. */
export interface LighterFillAttachIntent {
  readonly intentId: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly marketIndex: number;
  /** The provider order id the exchange returned for the Vex order. */
  readonly providerOrderId: string;
  readonly clientOrderIndex: string | null;
}

export async function attachLighterFillToIntent(
  input: {
    readonly canonicalIdentity: string;
    readonly intent: LighterFillAttachIntent;
  },
  client?: PoolClient,
): Promise<LighterFillAttachOutcome> {
  const { canonicalIdentity, intent } = input;
  const params = [canonicalIdentity];
  const existing = client === undefined
    ? await queryOne<Record<string, unknown>>(SELECT_FILL_FOR_ATTACH_SQL, params)
    : await queryOneWith<Record<string, unknown>>(client, SELECT_FILL_FOR_ATTACH_SQL, params);
  if (existing === null) return { kind: "refused", reason: "unknown_fill" };

  const attached = existing.execution_intent_id;
  if (typeof attached === "string" && attached.length > 0) {
    return attached === intent.intentId
      ? { kind: "already_attached", fillId: Number(existing.id) }
      : { kind: "refused", reason: "attached_to_other_intent" };
  }
  if (
    existing.environment !== intent.environment
    || String(existing.account_index) !== String(intent.accountIndex)
    || Number(existing.market_index) !== intent.marketIndex
  ) {
    return { kind: "refused", reason: "scope_mismatch" };
  }
  if (String(existing.provider_order_id) !== intent.providerOrderId) {
    return { kind: "refused", reason: "provider_order_id_mismatch" };
  }

  const attachParams = [canonicalIdentity, intent.intentId, intent.clientOrderIndex];
  const updated = client === undefined
    ? await queryOne<{ id: string | number }>(ATTACH_FILL_SQL, attachParams)
    : await queryOneWith<{ id: string | number }>(client, ATTACH_FILL_SQL, attachParams);
  // A concurrent attach won. The row is attached either way; the caller's
  // claim is not, so the outcome is the honest one.
  if (updated === null) return { kind: "refused", reason: "attached_to_other_intent" };
  return { kind: "attached", fillId: Number(updated.id) };
}

/**
 * How much base quantity the ledger already holds for this Vex intent, as an
 * exact decimal string ("0" when it holds nothing).
 *
 * The question a SELF-HEALING follow-up read asks before it spends a
 * privileged provider request, and it is COMPLETENESS, never existence.
 * Existence loses fills for good: a partial-fill frame records fill A, the
 * order then settles `filled` from an order row, and a follow-up gated on "is
 * there any row" skips every read from that moment on - so fill B, whose trade
 * arrives later, never reaches the ledger and never reaches AgentScan. The sum
 * compared against the filled quantity the provider itself reported for the
 * order says whether the ledger is actually behind the venue.
 *
 * Summed in SQL over `base_size`, whose column CHECK admits only a
 * non-negative decimal string, so the numeric cast is total. Never floating
 * point: the caller compares the result as a decimal string.
 */
export async function recordedLighterFillBaseSizeForIntent(executionIntentId: string): Promise<string> {
  const row = await queryOne<{ base_size_total: string | null }>(
    SELECT_FILL_BASE_SIZE_TOTAL_FOR_INTENT_SQL,
    [executionIntentId],
  );
  const total = row?.base_size_total ?? null;
  return typeof total === "string" && total.length > 0 ? total : "0";
}

const SELECT_FILL_BASE_SIZE_TOTAL_FOR_INTENT_SQL = `
  SELECT COALESCE(SUM(base_size::numeric), 0)::text AS base_size_total
    FROM lighter_fills WHERE execution_intent_id = $1`;

const SELECT_FILL_FOR_ATTACH_SQL = `
  SELECT id, environment, account_index, market_index, provider_order_id, execution_intent_id
    FROM lighter_fills WHERE canonical_identity = $1`;

/**
 * The attach write. `execution_intent_id IS NULL` is the fence: only a HELD
 * row can be attached, so two racing recoveries cannot move a fill from one
 * intent to another, and the client order id travels with the attribution
 * because it is part of the same claim.
 */
const ATTACH_FILL_SQL = `
  UPDATE lighter_fills
     SET execution_intent_id = $2,
         client_order_id = COALESCE(client_order_id, $3),
         updated_at = NOW()
   WHERE canonical_identity = $1
     AND execution_intent_id IS NULL
  RETURNING id`;

/**
 * NO ARBITER ON THE CONFLICT CLAUSE, on purpose.
 *
 * The row carries two unique identities that name the same fill: the
 * canonical string and the (environment, account, market, trade id) tuple it
 * is derived from. Naming `(canonical_identity)` as the arbiter made only that
 * index arbitrated: the arbiter pre-check runs unlocked, so a second observer
 * racing the first can miss the winner's insertion there and go on to collide
 * on the tuple index, which is not arbitrated and raises `unique_violation`
 * instead of resolving to "already held". Measured 2026-09-11 on a live
 * install: the order-evidence follow-up and a concurrent observation of the
 * same trade, 8 ms apart, and the loser logged `ledger_write_failed` for a
 * fill the ledger held. With no arbiter named, every unique index arbitrates,
 * so a concurrent duplicate waits for the winner and resolves to DO NOTHING,
 * which is what idempotence by identity promised all along.
 */
const INSERT_FILL_SQL = `
  INSERT INTO lighter_fills (
    canonical_identity, environment, account_index, market_index, provider_trade_id,
    provider_order_id, client_order_id, execution_intent_id, market_symbol, side,
    price, base_size, quote_notional,
    base_asset_id, base_asset_symbol, base_asset_decimals,
    quote_asset_id, quote_asset_symbol, quote_asset_decimals,
    block_height,
    trade_type, traded_at, transaction_time_us, usd_amount,
    position_size_before, position_sign_changed, entry_quote_before, account_pnl, position_effect,
    fee_side,
    integrator_fee_tick_authorized, integrator_fee_tick_observed,
    integrator_fee_asset_id, integrator_fee_asset_symbol, integrator_fee_asset_decimals,
    integrator_fee_estimated_raw, integrator_fee_estimate_basis, integrator_fee_estimate_tick_source,
    integrator_fee_charged_raw,
    exchange_fee_tick_observed, exchange_fee_charged_raw,
    integrator_fee_estimated_usd, exchange_fee_estimated_usd,
    collector_account_index, fee_authorization_intent_id
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
    $21,$22::timestamptz,$23,$24,$25,$26,$27,$28,$29,$30,
    $31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45
  )
  ON CONFLICT DO NOTHING
  RETURNING id`;

const SELECT_FILL_BY_IDENTITY_SQL = `
  SELECT id, side, price, base_size, quote_notional, block_height,
         trade_type, usd_amount, to_char(traded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS traded_at,
         position_size_before, execution_intent_id
    FROM lighter_fills WHERE canonical_identity = $1`;

/**
 * THE KNOWLEDGE MERGE, and the whole of it.
 *
 * Fills the account-relative columns ONLY while they are null, all five in one
 * statement, so the account's own view of a fill is established atomically and
 * once. `position_size_before IS NULL` is the marker for "this row has no
 * own-account knowledge yet": the five arrive together from one authenticated
 * observation and are never partially present.
 *
 * Economics are not in this statement AT ALL - there is no column here through
 * which a second observation could revise a price, a size or a notional - and
 * the revision bump is what carries the new knowledge to a server that already
 * holds the fill.
 */
const MERGE_FILL_ACCOUNT_FACTS_SQL = `
  UPDATE lighter_fills
     SET position_size_before = $2,
         position_sign_changed = $3,
         entry_quote_before = $4,
         account_pnl = $5,
         position_effect = $6,
         revision = revision + 1,
         updated_at = NOW()
   WHERE canonical_identity = $1
     AND position_size_before IS NULL
     AND $2::text IS NOT NULL
  RETURNING id, revision`;

/**
 * THE ENRICHMENT PATH - the only write that may touch a recorded fill.
 *
 * Exact charged fees are frequently unknown at fill time and become known
 * later. Writing them is not a second fill and is not a change of economics:
 * the `IS NULL` guard refuses to revise an amount that is already proven, so
 * the transition is one-way (unknown -> known) and can never be replayed into
 * a different figure. Nothing else about the row is writable at all.
 *
 * Pass the client to enrich inside a caller's own transaction.
 *
 * THE REVISION IS BUMPED IN THE SAME STATEMENT, and it is the reason a fee
 * proven after delivery ever reaches AgentScan at all. The fill's own outbox
 * row is terminal once sent, so without a monotonic token there is nothing for
 * the diff scan to notice: `enqueueEligibleLighterFills` enqueues one
 * enrichment row per (fill, revision) pair, and a repeat enrichment - which
 * updates no row, because the `IS NULL` guard refuses to revise a proven
 * amount - leaves the revision where it was and produces no second row.
 *
 * Returns whether a row was enriched. `false` means the fill is unknown, or
 * the amount was already proven - both ordinary, neither an error.
 */
export async function enrichLighterFillChargedFees(
  input: {
    readonly canonicalIdentity: string;
    readonly integratorFeeChargedRaw?: string | null;
    readonly exchangeFeeChargedRaw?: string | null;
  },
  client?: PoolClient,
): Promise<boolean> {
  const integrator = input.integratorFeeChargedRaw ?? null;
  const exchange = input.exchangeFeeChargedRaw ?? null;
  if (integrator === null && exchange === null) return false;
  const params = [input.canonicalIdentity, integrator, exchange];
  const rows = client === undefined
    ? await execute(ENRICH_FILL_FEES_SQL, params)
    : await executeWith(client, ENRICH_FILL_FEES_SQL, params);
  return rows > 0;
}

const ENRICH_FILL_FEES_SQL = `
  UPDATE lighter_fills
     SET integrator_fee_charged_raw =
           CASE WHEN integrator_fee_charged_raw IS NULL
                THEN COALESCE($2::text, integrator_fee_charged_raw)
                ELSE integrator_fee_charged_raw END,
         exchange_fee_charged_raw =
           CASE WHEN exchange_fee_charged_raw IS NULL
                THEN COALESCE($3::text, exchange_fee_charged_raw)
                ELSE exchange_fee_charged_raw END,
         revision = revision + 1,
         updated_at = NOW()
   WHERE canonical_identity = $1
     AND ((integrator_fee_charged_raw IS NULL AND $2::text IS NOT NULL)
          OR (exchange_fee_charged_raw IS NULL AND $3::text IS NOT NULL))`;

// ── The exchange funding leg a claimed withdrawal reports ───────────────────

/**
 * What a claimed withdrawal reports.
 *
 * This is an `agent_activity` row: the identity is the SETTLEMENT chain and
 * transaction, which is what a receipt reader can independently verify. The L2
 * side (the withdrawal the claim released) is client-reported evidence and is
 * never presented as proven by the receipt. A credited DEPOSIT has no
 * descriptor here: `sync/lighter-deposit-repair.ts` writes its row straight
 * through the settlement-proven writer inside the credit transaction.
 */
export interface LighterExchangeFundingRow {
  readonly kind: "exchange";
  readonly eventRole: "exchange_withdrawal";
  readonly protocol: "lighter";
  readonly chainFamily: "eip155";
  /** The SETTLEMENT chain, not the Lighter L2 - the receipt lives there. */
  readonly chainId: number;
  readonly txHash: string;
  readonly asset: { readonly address: string; readonly symbol: string; readonly decimals: number };
  readonly amountRaw: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}

/**
 * PURE: the claim's settlement transaction identity -> the withdrawal row.
 *
 * `amountRaw` is integer units of the asset's own decimals; the caller has
 * both from the transfer it authorized, and neither is derived here from a
 * price or a float.
 */
export function buildLighterWithdrawalActivityRow(input: {
  readonly settlementChainId: number;
  readonly txHash: string;
  readonly asset: LighterExchangeFundingRow["asset"];
  readonly amountRaw: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}): LighterExchangeFundingRow {
  return {
    kind: "exchange",
    eventRole: "exchange_withdrawal",
    protocol: "lighter",
    chainFamily: "eip155",
    chainId: input.settlementChainId,
    txHash: input.txHash,
    asset: input.asset,
    amountRaw: input.amountRaw,
    environment: input.environment,
    accountIndex: input.accountIndex,
  };
}

// ── arithmetic ─────────────────────────────────────────────────────────────

/**
 * Exact decimal multiplication, string in and string out.
 *
 * Never floating point: a token amount that has been through a double has
 * already lost the digits that make it a money figure. The two operands are
 * scaled to integers, multiplied as bigints and rescaled, so the result is
 * exact for every input the provider can produce.
 */
export function multiplyDecimals(a: string, b: string): string | null {
  const left = splitDecimal(a);
  const right = splitDecimal(b);
  if (left === null || right === null) return null;
  const product = left.units * right.units;
  const scale = left.decimals + right.decimals;
  if (scale === 0) return product.toString();
  const text = product.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, text.length - scale);
  const fraction = text.slice(text.length - scale).replace(/0+$/, "");
  return fraction.length === 0 ? whole : `${whole}.${fraction}`;
}

/**
 * The integrator fee on a decimal basis, in the fee asset's own integer units.
 *
 * Ticks are millionths (the provider's own unit), and the result is FLOORED:
 * an estimate that rounded up would claim a charge larger than the one the
 * provider could have taken. It is an estimate either way, and it is stored
 * and displayed as one.
 */
export function estimateIntegratorFeeRaw(
  basis: string,
  feeTick: number,
  feeAssetDecimals: number,
): string | null {
  if (!Number.isSafeInteger(feeTick) || feeTick < 0 || feeTick > 1_000_000) return null;
  if (!Number.isSafeInteger(feeAssetDecimals) || feeAssetDecimals < 0 || feeAssetDecimals > 36) return null;
  const parsed = splitDecimal(basis);
  if (parsed === null) return null;
  // basis * tick / 1e6, expressed in 10^feeAssetDecimals units.
  const numerator = parsed.units * BigInt(feeTick) * 10n ** BigInt(feeAssetDecimals);
  const denominator = 1_000_000n * 10n ** BigInt(parsed.decimals);
  return (numerator / denominator).toString();
}

function splitDecimal(value: string): { units: bigint; decimals: number } | null {
  if (!DECIMAL.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return { units: BigInt(`${whole}${fraction}`), decimals: fraction.length };
}

/**
 * A fee estimate in USD, from Lighter's own `usd_amount` and a rate tick.
 *
 * Exact bigint arithmetic, floored at six decimal places: an estimate rounded
 * UP would claim a charge larger than the provider could have taken. Six
 * places because that is the smallest unit of the USD-quoted stablecoins on
 * both environments; it is an estimate either way and is stored and displayed
 * as one.
 */
export function estimateFeeUsd(usdAmount: string, feeTick: number | null): string | null {
  if (feeTick === null || !Number.isSafeInteger(feeTick) || feeTick < 0 || feeTick > 1_000_000) return null;
  const parsed = splitDecimal(usdAmount);
  if (parsed === null) return null;
  const micros = (parsed.units * BigInt(feeTick) * 10n ** 6n)
    / (1_000_000n * 10n ** BigInt(parsed.decimals));
  const text = micros.toString().padStart(7, "0");
  return `${text.slice(0, text.length - 6)}.${text.slice(text.length - 6)}`;
}

/**
 * Which side of a trade record an account was on, from the record's own party
 * ids. Null when the account is on neither side, or on both (it traded with
 * itself and there is no single side to report).
 */
function tradeSideForAccount(trade: LighterTrade, accountIndex: number): "buy" | "sell" | null {
  const isAsk = trade.ask_account_id === accountIndex;
  const isBid = trade.bid_account_id === accountIndex;
  if (isAsk === isBid) return null;
  return isAsk ? "sell" : "buy";
}

/**
 * `trade.timestamp` as ISO 8601 UTC. MEASURED epoch milliseconds against the
 * live public endpoint on 2026-09-08; a value read as seconds instead would
 * date every fill to 1970.
 */
function epochMillisecondsIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A provider fee RATE TICK, in millionths of notional.
 *
 * Bounded at 1e6 (one hundred percent) because a tick outside that range is
 * not a rate, and storing it as one would silently produce a fee estimate that
 * exceeds the trade. Out of range, or not an integer, reads as "the provider
 * did not report a tick here" rather than as a number to compute with.
 */
function feeRateTick(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= 0 && value <= 1_000_000 ? value : null;
}

function integerString(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}
