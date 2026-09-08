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
 * misreports the money (Codex H0 round 2, correction 6):
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
import type { LighterTrade } from "@tools/lighter/types.js";
import logger from "@utils/logger.js";

/** Spot markets start here; below it a market is a perpetual. */
const LIGHTER_SPOT_MARKET_INDEX_FLOOR = 2048;

/** The venue asset id namespace. Lighter assets have no EVM address and none is invented. */
export function lighterVenueAssetId(environment: LighterEnvironment, assetId: string | number): string {
  return `lighter:${environment}:asset:${assetId}`;
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
  readonly collectorAccountIndex: number | null;
  readonly feeAuthorizationIntentId: string | null;
  /** Whether this fill is on a spot market. Decides the reported kind and role. */
  readonly spot: boolean;
}

/** Why a trade record could not become a fill row. Never thrown: a bad record must not kill a reconciliation. */
export interface LighterFillBuildFailure {
  readonly kind: "unbuildable";
  readonly reason: "malformed_amount" | "missing_trade_identity";
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
 * PURE: one provider trade record plus the intent it matched -> one fill row.
 *
 * The maker/taker side is derived the way `order-evidence.ts` derives it (the
 * account is the maker when it was on the maker side of this trade), because
 * the integrator tick and the exchange tier fee both differ between the two
 * and reading the wrong one misreports the money.
 */
export function buildLighterFillRecord(input: {
  readonly trade: LighterTrade;
  readonly intent: LighterFillIntentFacts;
  readonly market: LighterMarketAssets;
  readonly feeTerms: LighterFillFeeTerms;
}): LighterFillRecord | LighterFillBuildFailure {
  const { trade, intent, market, feeTerms } = input;
  const providerTradeId = nonEmpty(trade.trade_id_str);
  const blockHeight = integerString(trade.block_height);
  if (providerTradeId === null || blockHeight === null) {
    return { kind: "unbuildable", reason: "missing_trade_identity" };
  }
  if (!DECIMAL.test(trade.price) || !DECIMAL.test(trade.size)) {
    return { kind: "unbuildable", reason: "malformed_amount" };
  }
  const quoteNotional = multiplyDecimals(trade.size, trade.price);
  if (quoteNotional === null) return { kind: "unbuildable", reason: "malformed_amount" };

  const maker = intent.side === "sell" ? trade.is_maker_ask : !trade.is_maker_ask;
  const feeSide = maker ? "maker" : "taker";
  const providerOrderId = nonEmpty(intent.side === "buy" ? trade.bid_id_str : trade.ask_id_str);
  const spot = intent.marketIndex >= LIGHTER_SPOT_MARKET_INDEX_FLOOR;

  // A SPOT BUY IS CHARGED ON THE RECEIVED BASE, every other case on the quote
  // notional. `order-evidence.ts` established this from the provider's own
  // behaviour; the basis travels with the estimate so a reader can never be
  // left guessing which number the percentage was applied to.
  const receivedBase = spot && intent.side === "buy";
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
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      marketIndex: intent.marketIndex,
      providerTradeId,
    }),
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    marketIndex: intent.marketIndex,
    providerTradeId,
    providerOrderId,
    clientOrderId: intent.clientOrderIndex,
    executionIntentId: intent.intentId,
    marketSymbol: market.marketSymbol,
    side: intent.side,
    price: trade.price,
    baseSize: trade.size,
    quoteNotional,
    baseAsset: market.baseAsset,
    quoteAsset: market.quoteAsset,
    blockHeight,
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
   * The same identity was already recorded with DIFFERENT economics. Refused
   * and logged: a fill's price, size and side are immutable, so a
   * contradiction is a defect in whoever produced the second report, and
   * overwriting would destroy the only copy of the truth.
   */
  | { readonly kind: "conflict"; readonly fillId: number; readonly fields: readonly string[] };

/** The economics a repeat report must match exactly. */
const IMMUTABLE_FILL_FIELDS = ["side", "price", "base_size", "quote_notional", "block_height"] as const;

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
  };
  const fields = IMMUTABLE_FILL_FIELDS.filter((field) => String(existing[field]) !== proposed[field]);
  const fillId = Number(existing.id);
  if (fields.length === 0) return { kind: "duplicate", fillId };

  logger.error("lighter.agentscan.fill_identity_conflict", {
    canonicalIdentity: record.canonicalIdentity,
    fields: [...fields],
  });
  return { kind: "conflict", fillId, fields: [...fields] };
}

const INSERT_FILL_SQL = `
  INSERT INTO lighter_fills (
    canonical_identity, environment, account_index, market_index, provider_trade_id,
    provider_order_id, client_order_id, execution_intent_id, market_symbol, side,
    price, base_size, quote_notional,
    base_asset_id, base_asset_symbol, base_asset_decimals,
    quote_asset_id, quote_asset_symbol, quote_asset_decimals,
    block_height, fee_side,
    integrator_fee_tick_authorized, integrator_fee_tick_observed,
    integrator_fee_asset_id, integrator_fee_asset_symbol, integrator_fee_asset_decimals,
    integrator_fee_estimated_raw, integrator_fee_estimate_basis, integrator_fee_estimate_tick_source,
    integrator_fee_charged_raw,
    exchange_fee_tick_observed, exchange_fee_charged_raw, collector_account_index, fee_authorization_intent_id
  ) VALUES (
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
    $22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34
  )
  ON CONFLICT (canonical_identity) DO NOTHING
  RETURNING id`;

const SELECT_FILL_BY_IDENTITY_SQL = `
  SELECT id, side, price, base_size, quote_notional, block_height
    FROM lighter_fills WHERE canonical_identity = $1`;

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

// ── The exchange funding legs ───────────────────────────────────────────────

/**
 * What a deposit or a claimed withdrawal reports.
 *
 * These are `agent_activity` rows: the identity is the SETTLEMENT chain and
 * transaction, which is what a receipt reader can independently verify. The L2
 * side (the credit that followed the deposit, the withdrawal the claim
 * released) is client-reported evidence and is never presented as proven by
 * the receipt.
 */
export interface LighterExchangeFundingRow {
  readonly kind: "exchange";
  readonly eventRole: "exchange_deposit" | "exchange_withdrawal";
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
 * PURE: settlement transaction identity -> the deposit row.
 *
 * `amountRaw` is integer units of the asset's own decimals; the caller has
 * both from the transfer it authorized, and neither is derived here from a
 * price or a float.
 */
export function buildLighterDepositActivityRow(input: {
  readonly settlementChainId: number;
  readonly txHash: string;
  readonly asset: LighterExchangeFundingRow["asset"];
  readonly amountRaw: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}): LighterExchangeFundingRow {
  return fundingRow("exchange_deposit", input);
}

/** PURE: the claim's settlement transaction identity -> the withdrawal row. */
export function buildLighterWithdrawalActivityRow(input: {
  readonly settlementChainId: number;
  readonly txHash: string;
  readonly asset: LighterExchangeFundingRow["asset"];
  readonly amountRaw: string;
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
}): LighterExchangeFundingRow {
  return fundingRow("exchange_withdrawal", input);
}

function fundingRow(
  eventRole: LighterExchangeFundingRow["eventRole"],
  input: {
    readonly settlementChainId: number;
    readonly txHash: string;
    readonly asset: LighterExchangeFundingRow["asset"];
    readonly amountRaw: string;
    readonly environment: LighterEnvironment;
    readonly accountIndex: number;
  },
): LighterExchangeFundingRow {
  return {
    kind: "exchange",
    eventRole,
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
