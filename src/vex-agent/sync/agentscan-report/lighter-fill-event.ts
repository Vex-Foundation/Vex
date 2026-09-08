/**
 * One `lighter_fills` ledger row -> one ingest event.
 *
 * The sibling of `../../agentscan/mapper.ts` for the OTHER local ledger, and
 * it keeps that module's structural privacy rule verbatim: the payload is
 * built exclusively from named fields, with no spread, no passthrough and no
 * "copy the rest". The ledger row is a database row of our own, but the facts
 * on it came from a public provider trade record that also carries the
 * COUNTERPARTY - their account id, their order id, their position size - and
 * none of that has a line here that reads it. Neither has any credential, any
 * signed payload, any nonce or session material, or the L1 address (H0
 * revision 2, R2.6).
 *
 * ## Why the source row id is namespaced
 *
 * AgentScan dedupes on `(agent_hash, source_row_id)`. Two local ledgers with
 * independent id sequences would collide there silently: `agent_activity` row
 * 41 and `lighter_fills` row 41 are different facts with the same name, and
 * whichever arrived second would be dropped as a duplicate of the first. So a
 * fill reports `lighter_fill:<ledgerId>` (Codex H0 round 2, correction 1), and
 * the canonical venue identity travels beside it in the typed payload.
 *
 * ## Why a fill is `confirmed` and carries no transaction hash
 *
 * The event's status is the ECONOMIC lifecycle, and a fill's economics are
 * settled the moment the provider matched it: there is no proposal that might
 * fail later, so there is no pending snapshot and no terminal transition. The
 * `txHash` is null because a Lighter fill has no settlement-chain transaction
 * to point at; the server verifies it against the venue's own public trade
 * record instead, and says so in its own verification field. Nothing here
 * asserts verification - that is the server's word, never the client's.
 *
 * ## Fees: authorized, observed, estimated, charged
 *
 * Four different things, four different fields, and collapsing any two is the
 * defect this shape exists to prevent (H0 Codex correction 6). The AUTHORIZED
 * tick is a term - what the integrator approval permits. The OBSERVED ticks
 * are what the provider stamped on this trade record, integrator and exchange
 * alike, in millionths of notional. The ESTIMATE is arithmetic on this fill's
 * own basis and says which tick it used. The CHARGED amount is the provider's
 * own report; it is null until proven, and null never becomes zero, because a
 * zero is a proven amount and would be read as "no fee was taken".
 *
 * ## The enrichment event
 *
 * A charged amount frequently becomes known AFTER the fill has been delivered,
 * and the fill's own outbox row is terminal by then. {@link
 * mapLighterFillEnrichmentToEvent} is the update that carries it: the SAME
 * `sourceRowId`, so the server updates the fill it already holds rather than
 * accepting a second one, and NO economics at all - no price, no size, no
 * notional, no legs. There is nothing in that payload that could revise what
 * the fill already said.
 */

import type { AgentscanEvent, AgentscanTokenRef } from "../../agentscan/mapper.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";

/** The prefix that keeps the fill ledger's ids out of `agent_activity`'s id space. */
export const LIGHTER_FILL_SOURCE_ROW_PREFIX = "lighter_fill:";

/** Spot markets start here; below it a market is a perpetual. */
const LIGHTER_SPOT_MARKET_INDEX_FLOOR = 2048;

/**
 * A venue asset reference. Lighter assets have no EVM address, and inventing
 * one would be a lie a verifier could not check, so the address slot carries
 * the venue asset id - `lighter:<environment>:asset:<assetId>` - and the
 * chain family `lighter` is what makes that explicit rather than ambiguous.
 */
export interface LighterVenueAsset {
  readonly venueAssetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** The typed fill object that rides the event. Every field is named; nothing is copied. */
export interface LighterFillPayload {
  readonly canonicalIdentity: string;
  readonly environment: LighterEnvironment;
  readonly lighterChainId: number;
  readonly accountIndex: string;
  readonly marketIndex: number;
  readonly marketSymbol: string;
  readonly side: "buy" | "sell";
  readonly providerTradeId: string;
  readonly providerOrderId: string | null;
  readonly clientOrderId: string | null;
  readonly blockHeight: string;
  readonly price: string;
  readonly baseSize: string;
  readonly quoteNotional: string;
  readonly baseAsset: LighterVenueAsset;
  readonly quoteAsset: LighterVenueAsset;
  readonly feeSide: "maker" | "taker";
  /** The tick the integrator approval PERMITS on this side. A term, not evidence. */
  readonly integratorFeeTickAuthorized: number | null;
  /** The integrator tick the provider stamped on this trade record. Null when absent. */
  readonly integratorFeeTickObserved: number | null;
  readonly integratorFeeEstimatedRaw: string | null;
  readonly integratorFeeEstimateBasis: "quote_notional" | "received_base" | null;
  /** Which tick the estimate used. Null exactly when there is no estimate. */
  readonly integratorFeeEstimateTickSource: "observed" | "authorized" | null;
  readonly integratorFeeChargedRaw: string | null;
  readonly integratorFeeAsset: LighterVenueAsset | null;
  /** The exchange tier tick observed on this trade record, in millionths of notional. */
  readonly exchangeFeeTickObserved: number | null;
  readonly exchangeFeeChargedRaw: string | null;
  readonly collectorAccountIndex: string | null;
  readonly feeAuthorizationIntentId: string | null;
  /**
   * "This order was created by Vex" is the CLIENT's assertion, carried as one.
   * A public trade record proves the trade; it cannot prove who authored the
   * order, so the server displays this as asserted and never as verified
   * origin.
   */
  readonly attribution: "client_asserted";
}

/** The ingest event a fill produces: the contract event plus its typed fill object. */
export type LighterFillEvent = AgentscanEvent & { readonly lighterFill: LighterFillPayload };

/** A ledger row the mapper could not read into a reportable event, and why. */
export interface LighterFillMappingFailure {
  readonly kind: "unmappable";
  readonly reason:
    | "missing_identity"
    | "malformed_amount"
    | "malformed_asset"
    | "unknown_environment";
}

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const INTEGER = /^[0-9]+$/;
const SIGNED_INTEGER = /^-?[0-9]+$/;

/**
 * Map one ledger row.
 *
 * Returns a typed failure rather than throwing or emitting a half-event: a row
 * this function cannot read is a row the server must not be asked to accept,
 * and the caller holds it with the reason instead of sending something the
 * ingest schema would refuse item by item.
 */
export function mapLighterFillToEvent(row: Record<string, unknown>): LighterFillEvent | LighterFillMappingFailure {
  const id = num(row.id);
  const canonicalIdentity = str(row.canonical_identity);
  const environment = str(row.environment);
  if (id === null || canonicalIdentity === null) return unmappable("missing_identity");
  if (environment !== "core" && environment !== "rhc") return unmappable("unknown_environment");

  const marketIndex = num(row.market_index);
  const accountIndex = idString(row.account_index);
  const providerTradeId = guarded(row.provider_trade_id, INTEGER);
  const blockHeight = guarded(row.block_height, INTEGER);
  const marketSymbol = str(row.market_symbol);
  const side = str(row.side);
  if (
    marketIndex === null || accountIndex === null || providerTradeId === null
    || blockHeight === null || marketSymbol === null || (side !== "buy" && side !== "sell")
  ) {
    return unmappable("missing_identity");
  }

  const price = guarded(row.price, DECIMAL);
  const baseSize = guarded(row.base_size, DECIMAL);
  const quoteNotional = guarded(row.quote_notional, DECIMAL);
  if (price === null || baseSize === null || quoteNotional === null) return unmappable("malformed_amount");

  const baseAsset = venueAsset(row.base_asset_id, row.base_asset_symbol, row.base_asset_decimals);
  const quoteAsset = venueAsset(row.quote_asset_id, row.quote_asset_symbol, row.quote_asset_decimals);
  if (baseAsset === null || quoteAsset === null) return unmappable("malformed_asset");

  const feeSide = str(row.fee_side);
  if (feeSide !== "maker" && feeSide !== "taker") return unmappable("missing_identity");

  const spot = marketIndex >= LIGHTER_SPOT_MARKET_INDEX_FLOOR;
  const observedAt = iso(row.observed_at);
  const createdAt = iso(row.created_at) ?? observedAt ?? new Date(0).toISOString();
  const chainId = getLighterFundingDeployment(environment).lighterSignerChainId;

  // The two legs a fill moves, in the direction the account traded: a buy
  // spends quote and receives base. Amounts stay decimal strings with their
  // own decimals; nothing here converts to a float or to raw integer units
  // whose decimals would then have to be guessed.
  const legs = fillLegs(side, baseAsset, quoteAsset);

  return {
    sourceRowId: `${LIGHTER_FILL_SOURCE_ROW_PREFIX}${id}`,
    // The execution grouping: every fill of one Vex order shares it. A fill
    // whose intent is unknown (recovery found it without a live intent) groups
    // under its own venue identity rather than under a guess.
    sourceExecutionId: str(row.execution_intent_id) ?? canonicalIdentity,
    eventIndex: 0,
    kind: spot ? "exchange" : "perp",
    eventRole: spot ? "spot_fill" : "perp_fill",
    status: "confirmed",
    protocol: "lighter",
    chainFamily: "lighter",
    chainId: String(chainId),
    fromChainId: null,
    toChainId: null,
    tokenIn: legs.tokenIn,
    tokenOut: legs.tokenOut,
    amountInRaw: null,
    amountOutRaw: null,
    executedInRaw: null,
    executedOutRaw: null,
    tokenIn2: null,
    tokenOut2: null,
    amountIn2Raw: null,
    amountOut2Raw: null,
    executedIn2Raw: null,
    executedOut2Raw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdSource: null,
    // No settlement-chain transaction exists for a fill; the venue verifier is
    // what proves it, and a hash-shaped null is what tells the server so.
    txHash: null,
    failureCode: null,
    createdAt,
    // The provider's own execution time is not carried on the ledger row; the
    // block height above is what orders a fill on the venue. Reporting our own
    // observation time as the confirmation time is what the activity mapper
    // refuses to do, and it is refused here for the same reason.
    confirmedAt: null,
    observedAt,
    lighterFill: {
      canonicalIdentity,
      environment,
      lighterChainId: chainId,
      accountIndex,
      marketIndex,
      marketSymbol,
      side,
      providerTradeId,
      providerOrderId: guarded(row.provider_order_id, INTEGER),
      clientOrderId: guarded(row.client_order_id, INTEGER),
      blockHeight,
      price,
      baseSize,
      quoteNotional,
      baseAsset,
      quoteAsset,
      feeSide,
      integratorFeeTickAuthorized: num(row.integrator_fee_tick_authorized),
      integratorFeeTickObserved: num(row.integrator_fee_tick_observed),
      integratorFeeEstimatedRaw: guarded(row.integrator_fee_estimated_raw, INTEGER),
      integratorFeeEstimateBasis: feeEstimateBasis(row.integrator_fee_estimate_basis),
      integratorFeeEstimateTickSource: feeEstimateTickSource(row.integrator_fee_estimate_tick_source),
      integratorFeeChargedRaw: guarded(row.integrator_fee_charged_raw, INTEGER),
      integratorFeeAsset: venueAsset(
        row.integrator_fee_asset_id,
        row.integrator_fee_asset_symbol,
        row.integrator_fee_asset_decimals,
      ),
      exchangeFeeTickObserved: num(row.exchange_fee_tick_observed),
      exchangeFeeChargedRaw: guarded(row.exchange_fee_charged_raw, SIGNED_INTEGER),
      collectorAccountIndex: idString(row.collector_account_index),
      feeAuthorizationIntentId: str(row.fee_authorization_intent_id),
      attribution: "client_asserted",
    },
  };
}

/**
 * The typed enrichment object: the identity, the revision it delivers, and the
 * exact charged amounts. NOTHING ELSE. No price, no size, no notional, no
 * side, no legs - there is deliberately no field here through which an
 * enrichment could revise an economic fact the fill already established
 * (H0 Codex correction 4: enrichment never creates another fill and never
 * changes established economics).
 */
export interface LighterFillEnrichmentPayload {
  readonly canonicalIdentity: string;
  /**
   * The `lighter_fills.revision` this update carries. Monotonic per fill and
   * bumped only by the enrichment write, so the server can apply updates in
   * order and ignore one it has already applied.
   */
  readonly revision: number;
  readonly integratorFeeChargedRaw: string | null;
  readonly exchangeFeeChargedRaw: string | null;
  readonly integratorFeeAsset: LighterVenueAsset | null;
}

/** The ingest event an enrichment produces. Same identity, no economics. */
export type LighterFillEnrichmentEvent = AgentscanEvent & {
  readonly lighterFillEnrichment: LighterFillEnrichmentPayload;
};

/**
 * Map one already-delivered ledger row into the update that carries its newly
 * proven fees.
 *
 * The `sourceRowId` is the fill's own, unchanged: AgentScan dedupes on
 * (agent_hash, source_row_id), and this event is by construction a second
 * report of that identity. Under H0 correction 4 the server treats it as an
 * enrichment of the fill it already holds rather than as a duplicate fill;
 * nothing in the payload could turn it into a new one, because nothing in the
 * payload is an economic fact.
 *
 * `revision` comes from the OUTBOX ROW rather than from the ledger, because
 * the ledger row can be enriched again between enqueue and drain: the row that
 * was queued names the revision it is delivering, and a later revision gets
 * its own row.
 */
export function mapLighterFillEnrichmentToEvent(
  row: Record<string, unknown>,
  revision: number,
): LighterFillEnrichmentEvent | LighterFillMappingFailure {
  const id = num(row.id);
  const canonicalIdentity = str(row.canonical_identity);
  const environment = str(row.environment);
  if (id === null || canonicalIdentity === null) return unmappable("missing_identity");
  if (environment !== "core" && environment !== "rhc") return unmappable("unknown_environment");
  if (!Number.isSafeInteger(revision) || revision <= 0) return unmappable("missing_identity");

  const marketIndex = num(row.market_index);
  if (marketIndex === null) return unmappable("missing_identity");
  const spot = marketIndex >= LIGHTER_SPOT_MARKET_INDEX_FLOOR;
  const observedAt = iso(row.observed_at);
  const createdAt = iso(row.created_at) ?? observedAt ?? new Date(0).toISOString();
  const chainId = getLighterFundingDeployment(environment).lighterSignerChainId;

  return {
    sourceRowId: `${LIGHTER_FILL_SOURCE_ROW_PREFIX}${id}`,
    sourceExecutionId: str(row.execution_intent_id) ?? canonicalIdentity,
    eventIndex: 0,
    // The routing fields the server needs to find the fill this updates, and
    // nothing beyond them.
    kind: spot ? "exchange" : "perp",
    eventRole: spot ? "spot_fill" : "perp_fill",
    status: "confirmed",
    protocol: "lighter",
    chainFamily: "lighter",
    chainId: String(chainId),
    fromChainId: null,
    toChainId: null,
    // EVERY ECONOMIC FIELD IS NULL, deliberately and structurally: an
    // enrichment has no authority over what the fill said it traded.
    tokenIn: null,
    tokenOut: null,
    amountInRaw: null,
    amountOutRaw: null,
    executedInRaw: null,
    executedOutRaw: null,
    tokenIn2: null,
    tokenOut2: null,
    amountIn2Raw: null,
    amountOut2Raw: null,
    executedIn2Raw: null,
    executedOut2Raw: null,
    usdInEst: null,
    usdOutEst: null,
    usdFeeEst: null,
    usdSource: null,
    txHash: null,
    failureCode: null,
    createdAt,
    confirmedAt: null,
    observedAt,
    lighterFillEnrichment: {
      canonicalIdentity,
      revision,
      integratorFeeChargedRaw: guarded(row.integrator_fee_charged_raw, INTEGER),
      exchangeFeeChargedRaw: guarded(row.exchange_fee_charged_raw, SIGNED_INTEGER),
      integratorFeeAsset: venueAsset(
        row.integrator_fee_asset_id,
        row.integrator_fee_asset_symbol,
        row.integrator_fee_asset_decimals,
      ),
    },
  };
}

/** Whether a mapping result - a fill's or an enrichment's - is the failure arm. */
export function isLighterFillMappingFailure(
  result: LighterFillEvent | LighterFillEnrichmentEvent | LighterFillMappingFailure,
): result is LighterFillMappingFailure {
  return "kind" in result && result.kind === "unmappable";
}

/**
 * The legs, in the account's own direction. A buy receives base and spends
 * quote; a sell is the mirror. The amounts stay OFF these refs deliberately:
 * the contract's raw-amount fields are integer strings whose decimals come
 * from the token ref, and a Lighter size is a decimal string in base units
 * already. Putting a decimal string into an integer field would be refused by
 * the ingest schema, and rounding it to fit would be a fabricated amount. The
 * exact figures ride the typed fill object, where they keep their own form.
 */
function fillLegs(
  side: "buy" | "sell",
  baseAsset: LighterVenueAsset,
  quoteAsset: LighterVenueAsset,
): { tokenIn: AgentscanTokenRef; tokenOut: AgentscanTokenRef } {
  const base: AgentscanTokenRef = {
    address: baseAsset.venueAssetId,
    symbol: baseAsset.symbol,
    decimals: baseAsset.decimals,
  };
  const quote: AgentscanTokenRef = {
    address: quoteAsset.venueAssetId,
    symbol: quoteAsset.symbol,
    decimals: quoteAsset.decimals,
  };
  return side === "buy" ? { tokenIn: quote, tokenOut: base } : { tokenIn: base, tokenOut: quote };
}

function unmappable(reason: LighterFillMappingFailure["reason"]): LighterFillMappingFailure {
  return { kind: "unmappable", reason };
}

function venueAsset(id: unknown, symbol: unknown, decimals: unknown): LighterVenueAsset | null {
  const venueAssetId = str(id);
  const sym = str(symbol);
  const dec = num(decimals);
  if (venueAssetId === null || sym === null || dec === null || !Number.isInteger(dec) || dec < 0) return null;
  return { venueAssetId, symbol: sym, decimals: dec };
}

function feeEstimateBasis(value: unknown): "quote_notional" | "received_base" | null {
  return value === "quote_notional" || value === "received_base" ? value : null;
}

function feeEstimateTickSource(value: unknown): "observed" | "authorized" | null {
  return value === "observed" || value === "authorized" ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** A bigint-ish column (pg returns int8 as a string) as a lossless decimal string. */
function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return INTEGER.test(text) ? text : null;
}

function guarded(value: unknown, shape: RegExp): string | null {
  const text = str(value);
  return text !== null && shape.test(text) ? text : null;
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}
