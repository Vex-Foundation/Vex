/**
 * THE FILL OBSERVATION BOUNDARY - every Lighter trade Vex sees becomes a
 * ledger row, once.
 *
 * ## Why this is not a post-transition hook
 *
 * The obvious place to record a fill is "after the intent advanced to
 * partially_filled". It is the wrong place, and three separate paths prove it:
 *
 *   - the account stream selects ONE trade per intent and then DEDUPLICATES
 *     against the outcome evidence it already holds, so a frame carrying two
 *     fills of the same order advances the intent once and a post-transition
 *     hook would record one of the two;
 *   - order repair returns active- or inactive-order evidence BEFORE it ever
 *     looks at the trade list, so a repair that classifies an order from its
 *     order row would record none of the trades it had already read;
 *   - a transition that is refused (a stale generation, a concurrent writer)
 *     is not evidence that the fill did not happen - the provider's trade
 *     record is.
 *
 * So the ledger write happens where the TRADES ARE OBSERVED, and it is
 * independent of what the intent's mutable status does next. That is also what
 * makes the two writes safely separable: a failed ledger write must NEVER
 * misrepresent a confirmed provider outcome, so the outcome commits on its own
 * and the ledger write is retried by the next observation of the same trade -
 * which is idempotent by canonical identity, so a replay after an interrupted
 * write produces no duplicate and loses no row.
 *
 * ## When no trade was observed at all
 *
 * An order can settle from ORDER evidence alone - an order frame, an
 * inactive-order read, an active-order read with a filled amount - before any
 * trade reaches Vex. Measured live: that is the ORDINARY path for an IOC, not
 * an edge. Those sites therefore trigger one bounded follow-up read of the
 * account's own trades at the terminal commit point
 * ({@link observeLighterFillsFromAccountTrades}), which feeds the same
 * recording path as every other observation.
 *
 * ## Unattributed fills
 *
 * A fill observed before its Vex intent is known is recorded with a NULL
 * execution intent id and attached later by the explicit attach operation,
 * which revalidates environment, account, market and the account's own order
 * id against the durable intent. Attribution by collector index or by position
 * in a list is never performed here.
 *
 * ## What this module is allowed to read
 *
 * The market's symbol and its two assets with their own decimals are provider
 * facts; they are read once per environment through the ordinary public
 * endpoints and cached for a short window, because a wrong quote decimal
 * silently multiplies every reported amount by a power of ten. The integrator
 * terms come from the approved fee authorization, and they travel as TERMS -
 * `agentscan-activity.ts` keeps them apart from the tick the provider stamped
 * on the trade itself.
 */

import { getAddress } from "viem";

import {
  getLighterClient,
  type LighterClient,
  type LighterPrivilegedAccountAuth,
} from "@tools/lighter/client.js";
import type { LighterEnvironment } from "@tools/lighter/constants.js";
import type { LighterAssetDetail, LighterMarketDetail, LighterTrade } from "@tools/lighter/types.js";
import type { LighterIntegratorFees } from "@tools/lighter/fee-policy.js";
import { getLighterFundingDeployment } from "@tools/lighter/wallet-funding/deployments.js";
import * as feeAuthorizationsRepo from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import logger from "@utils/logger.js";
import {
  buildLighterFillRecord,
  isLighterFillBuildFailure,
  lighterPerpVenueAssetId,
  lighterVenueAssetId,
  recordedLighterFillBaseSizeForIntent,
  recordLighterFillActivity,
  type LighterFillFeeTerms,
  type LighterFillIntentFacts,
  type LighterFillRecord,
  type LighterMarketAssets,
  type LighterVenueAssetRef,
} from "./agentscan-activity.js";
import { findMatchingLighterTrade } from "./order-evidence.js";
import type { LighterOrderEvidenceScope } from "./order-evidence.js";

/**
 * How long a market's symbol and asset decimals stand before they are read
 * again. Market metadata is stable on the order of days; the window exists so
 * a market that is listed while the app runs is picked up without a restart,
 * not because the values churn.
 */
export const LIGHTER_MARKET_ASSETS_TTL_MS = 10 * 60 * 1000;

/**
 * The observation boundary's own dependencies.
 *
 * OPTIONAL ON EVERY OWNER, and defaulted in that owner's production deps
 * factory rather than inside the call, so a caller that assembles its own deps
 * (a test, a narrowed sweep) neither reaches the network nor writes to the
 * database by accident. Production always goes through the factory.
 */
export interface LighterFillObservationDeps {
  readonly client: Pick<LighterClient, "getMarketDetails" | "getAssetDetails">;
  readonly recordFill: typeof recordLighterFillActivity;
  /** The approved integrator terms in force for this account, or null when none is. */
  readonly findFeeAuthorization: typeof feeAuthorizationsRepo.findLatestApprovedLighterFeeAuthorization;
  /**
   * How much base quantity the ledger already holds for a given intent. Read
   * ONLY by {@link observeLighterFillsFromAccountTrades} when its caller asked
   * for the self-healing form, so a trigger for an intent the ledger is
   * already level with costs one local query instead of a privileged provider
   * request.
   */
  readonly recordedFillBaseSize: typeof recordedLighterFillBaseSizeForIntent;
}

export function defaultLighterFillObservationDeps(): LighterFillObservationDeps {
  return {
    client: getLighterClient(),
    recordFill: recordLighterFillActivity,
    findFeeAuthorization: feeAuthorizationsRepo.findLatestApprovedLighterFeeAuthorization,
    recordedFillBaseSize: recordedLighterFillBaseSizeForIntent,
  };
}

/** What one observation did. Counts only; the rows themselves are the ledger. */
export interface LighterFillObservationReport {
  /** Trades that matched the intent in this observation. */
  readonly observed: number;
  /** Ledger rows this observation inserted. */
  readonly recorded: number;
  /** Trades already held with identical economics. Ordinary, never an error. */
  readonly duplicates: number;
  /**
   * Trades this observation could not record: an unbuildable trade record, an
   * unreadable market, a refused write, or an identity conflict. Counted and
   * logged, never thrown - the provider outcome that produced them is a
   * separate fact and must not be lost with them.
   */
  readonly failed: number;
}

const NOTHING_OBSERVED: LighterFillObservationReport = {
  observed: 0,
  recorded: 0,
  duplicates: 0,
  failed: 0,
};

/**
 * Every trade in `trades` that belongs to this intent, in the order the
 * provider listed them.
 *
 * It applies the SAME matching rule the evidence path uses, by asking
 * `findMatchingLighterTrade` again over what is left, so there is exactly one
 * definition of "this trade belongs to this order" in the repository. The
 * frames and pages this runs over are bounded (a stream frame, a 100-row
 * provider page), so the repeated scan is bounded with them.
 */
export function matchingLighterTrades(
  trades: readonly LighterTrade[],
  scope: LighterOrderEvidenceScope,
  clientOrderIndex: string,
  submittedTxHash: string,
): readonly LighterTrade[] {
  const matched: LighterTrade[] = [];
  let remaining: readonly LighterTrade[] = trades;
  for (;;) {
    const trade = findMatchingLighterTrade(remaining, scope, clientOrderIndex, submittedTxHash);
    if (trade === null) return matched;
    matched.push(trade);
    remaining = remaining.filter((candidate) => candidate !== trade);
  }
}

/**
 * Rows the follow-up read asks for. Lighter's own documented maximum page for
 * the trades endpoint, and the same bound the trade branches already use, so
 * the follow-up costs no more provider weight than a read the repair path
 * would have made anyway.
 */
export const LIGHTER_FILL_FOLLOW_UP_TRADES_LIMIT = 100;

/**
 * What a follow-up read needs from the site that triggers it: the site's OWN
 * client call and the privileged account auth it already holds, never a global
 * client and never a token minted here.
 */
export interface LighterFillFollowUpRead {
  readonly getAccountTrades: LighterClient["getAccountTrades"];
  readonly auth: LighterPrivilegedAccountAuth;
  /**
   * The transaction hash the intent recorded at submission, which matches a
   * trade even when the client order id does not. Sites with no hash pass
   * their own sentinel rather than an empty string, so an unrelated trade with
   * a missing hash can never match.
   */
  readonly submittedTxHash: string;
}

/**
 * Record every observed fill of one intent.
 *
 * NEVER THROWS and never propagates a storage failure to its caller: the
 * caller is in the middle of settling a provider outcome, and a ledger write
 * that failed is a row the next observation writes, not a reason to report an
 * executed order as unresolved.
 */
export async function observeLighterFills(input: {
  readonly intent: LighterFillIntentFacts;
  readonly trades: readonly LighterTrade[];
  /**
   * The integrator ticks BOUND ON THIS ORDER, from the intent the caller
   * already holds. Still a TERM: it is what the signed order permitted, never
   * evidence of the tick the exchange applied to a given trade - the trade
   * record answers that, and `agentscan-activity.ts` keeps the two apart.
   */
  readonly authorizedFees: LighterIntegratorFees | null;
  readonly deps: LighterFillObservationDeps;
}): Promise<LighterFillObservationReport> {
  if (input.trades.length === 0) return NOTHING_OBSERVED;

  let market: LighterResolvedMarketAssets | null;
  try {
    market = await resolveLighterMarketAssets(
      input.intent.environment,
      input.intent.marketIndex,
      input.deps,
    );
  } catch (error) {
    logger.warn("lighter.fill_observation.market_unreadable", {
      environment: input.intent.environment,
      marketIndex: input.intent.marketIndex,
      reason: error instanceof Error ? error.name : "unknown",
    });
    market = null;
  }
  if (market === null) {
    return { observed: input.trades.length, recorded: 0, duplicates: 0, failed: input.trades.length };
  }

  const feeTerms = await resolveLighterFillFeeTerms(
    input.intent,
    market,
    input.authorizedFees,
    input.deps,
  );

  let recorded = 0;
  let duplicates = 0;
  let failed = 0;
  for (const trade of input.trades) {
    const built = buildLighterFillRecord({ trade, intent: input.intent, market, feeTerms });
    if (isLighterFillBuildFailure(built)) {
      failed += 1;
      logger.warn("lighter.fill_observation.unbuildable_trade", {
        environment: input.intent.environment,
        marketIndex: input.intent.marketIndex,
        reason: built.reason,
      });
      continue;
    }
    const outcome = await writeFill(built, input.deps);
    if (outcome === "recorded") recorded += 1;
    else if (outcome === "duplicate") duplicates += 1;
    else failed += 1;
  }
  return { observed: input.trades.length, recorded, duplicates, failed };
}

/**
 * THE TERMINAL-COMMIT FOLLOW-UP READ: one bounded page of the account's own
 * trades, for an intent that just became filled or partially filled from
 * evidence THAT IS NOT A TRADE.
 *
 * ## Why it has to exist
 *
 * Measured live on 2026-09-08: one IOC buy settled from an
 * `update/account_all_orders` frame (status filled) before any trade frame was
 * consumed, the execution returned `filled` with `evidenceSource:
 * "inactive_order"`, and the repair that followed classified the intent
 * `already_terminal` without reading anything. The venue held the trade; the
 * fill ledger held nothing, so AgentScan would never hear of the fill. Every
 * order-shaped confirmation has that shape: an order row says HOW MUCH filled,
 * never WHICH trades did it, and only a trade record carries the identity,
 * price, size and fee ticks a ledger row is made of.
 *
 * ## What it is, and what it deliberately is not
 *
 * ONE page, ONE read per trigger, never a loop and never a poll: the caller
 * has just committed a terminal outcome, and if this read misses, the next
 * trigger (a later frame, a repair, `lighter__order_status`) reads again. The
 * page is the same bounded, newest-first page the trade branches already use,
 * through the caller's own client and the privileged auth the caller already
 * holds.
 *
 * NEVER THROWS and never changes the outcome that triggered it. A read failure
 * is logged with the intent id and counted as one failure - one, because a
 * failed read cannot say how many trades it would have returned - and the
 * outcome the caller committed stands untouched. Recording is idempotent by
 * canonical identity, so a second trigger over the same trade records nothing
 * new.
 *
 * `onlyWhenLedgerIncomplete` is the SELF-HEALING form, for triggers that can
 * repeat while an intent stays live (a re-sent order frame, a repair sweep).
 * It asks the ledger first and spends no provider request while the ledger is
 * LEVEL WITH THE VENUE - which is a question about COMPLETENESS, not about
 * existence. Gating on "the ledger holds a row for this intent" loses fills
 * for good: a partial-fill frame records fill A, a later filled-order frame
 * finds A already held and skips its read, the intent leaves the
 * stream-watchable set, and terminal repair applies the same test - so fill B,
 * whose trade frame arrived late, is never read for and never recorded. The
 * caller therefore passes the filled quantity the PROVIDER reported for the
 * order, and the read runs while the recorded sum is below it. A caller whose
 * evidence carries no filled quantity passes null and the read runs: an
 * unknown is not evidence of completeness.
 *
 * The terminal-transition sites leave the gate off entirely, because there the
 * read happens exactly once per transition.
 */
export async function observeLighterFillsFromAccountTrades(input: {
  readonly intent: LighterFillIntentFacts;
  readonly authorizedFees: LighterIntegratorFees | null;
  readonly deps: LighterFillObservationDeps;
  readonly read: LighterFillFollowUpRead;
  readonly onlyWhenLedgerIncomplete?: LighterFillLedgerCompletenessGate;
}): Promise<LighterFillObservationReport> {
  const { intent, read } = input;
  // Without the account's own client order id there is no rule by which a
  // trade on this page belongs to this intent, and attributing one by position
  // in a list is exactly what the boundary refuses to do.
  if (intent.clientOrderIndex === null) return NOTHING_OBSERVED;

  const gate = input.onlyWhenLedgerIncomplete;
  if (gate !== undefined && await ledgerIsLevelWithVenue(intent.intentId, gate, input.deps)) {
    return NOTHING_OBSERVED;
  }

  let page: Awaited<ReturnType<LighterClient["getAccountTrades"]>>;
  try {
    page = await read.getAccountTrades(
      intent.environment,
      {
        accountIndex: intent.accountIndex,
        limit: LIGHTER_FILL_FOLLOW_UP_TRADES_LIMIT,
        sortBy: "timestamp",
      },
      read.auth,
    );
  } catch (error) {
    logger.warn("lighter.fill_observation.follow_up_read_failed", {
      intentId: intent.intentId,
      environment: intent.environment,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return { observed: 0, recorded: 0, duplicates: 0, failed: 1 };
  }

  return observeLighterFills({
    intent,
    trades: matchingLighterTrades(
      page.trades,
      { accountIndex: intent.accountIndex, marketIndex: intent.marketIndex, side: intent.side },
      intent.clientOrderIndex,
      read.submittedTxHash,
    ),
    authorizedFees: input.authorizedFees,
    deps: input.deps,
  });
}

/**
 * What a SELF-HEALING trigger knows about how much the venue says filled.
 *
 * The quantity is the provider's OWN figure for the order (an order row's
 * `filled_base_amount`, or the same field carried on the stored order
 * evidence), in the market's base units. NULL means the trigger's evidence
 * does not carry one - an older durable row, an outcome recorded before the
 * field was retained - and null is never read as "complete".
 */
export interface LighterFillLedgerCompletenessGate {
  readonly reportedFilledBaseSize: string | null;
}

/**
 * Is the ledger already level with the filled quantity the venue reported?
 *
 * Only then may a self-healing trigger skip its read. Every other answer -
 * an unknown reported quantity, an unreadable ledger, a figure neither side
 * can parse - resolves to reading, because the write that follows is
 * idempotent by canonical identity and a skipped read is a fill lost for good.
 */
async function ledgerIsLevelWithVenue(
  intentId: string,
  gate: LighterFillLedgerCompletenessGate,
  deps: LighterFillObservationDeps,
): Promise<boolean> {
  const reported = gate.reportedFilledBaseSize;
  if (reported === null) return false;
  let recorded: string;
  try {
    recorded = await deps.recordedFillBaseSize(intentId);
  } catch (error) {
    logger.warn("lighter.fill_observation.follow_up_ledger_unreadable", {
      intentId,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return false;
  }
  const comparison = compareLighterDecimalStrings(recorded, reported);
  if (comparison === null) {
    logger.warn("lighter.fill_observation.follow_up_quantity_unreadable", { intentId });
    return false;
  }
  return comparison >= 0;
}

/**
 * The provider's own filled-quantity figure, or null when the value is not a
 * decimal string this boundary may compare against a ledger sum.
 *
 * A guessed or coerced figure would silence the follow-up read for a fill that
 * is genuinely missing, so an unparsable value is an UNKNOWN, never a zero.
 */
export function reportedLighterFilledBaseSize(value: unknown): string | null {
  return typeof value === "string" && LIGHTER_DECIMAL.test(value) ? value : null;
}

const LIGHTER_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** The most decimal places either side of a comparison may carry. */
const LIGHTER_DECIMAL_MAX_PLACES = 36;

/**
 * Exact decimal-string comparison, or null when either side is not a decimal
 * this module may reason about.
 *
 * NEVER floating point: a fill quantity that has been through a double has
 * already lost the digits that decide whether the ledger is behind the venue.
 * The two operands are scaled to a common integer basis - the venue quotes
 * both the trade size and the order's filled amount in the market's own size
 * decimals, so the common scale IS that precision - and compared as bigints.
 */
function compareLighterDecimalStrings(left: string, right: string): number | null {
  const a = splitLighterDecimal(left);
  const b = splitLighterDecimal(right);
  if (a === null || b === null) return null;
  const scale = Math.max(a.places, b.places);
  const scaledLeft = a.units * 10n ** BigInt(scale - a.places);
  const scaledRight = b.units * 10n ** BigInt(scale - b.places);
  if (scaledLeft < scaledRight) return -1;
  return scaledLeft > scaledRight ? 1 : 0;
}

function splitLighterDecimal(value: string): { units: bigint; places: number } | null {
  if (!LIGHTER_DECIMAL.test(value)) return null;
  const [whole = "", fraction = ""] = value.split(".");
  if (fraction.length > LIGHTER_DECIMAL_MAX_PLACES) return null;
  return { units: BigInt(`${whole}${fraction}`), places: fraction.length };
}

async function writeFill(
  record: LighterFillRecord,
  deps: LighterFillObservationDeps,
): Promise<"recorded" | "duplicate" | "failed"> {
  try {
    const outcome = await deps.recordFill(record);
    if (outcome.kind === "recorded") return "recorded";
    if (outcome.kind === "duplicate") return "duplicate";
    // A conflict is already logged with its fields by the writer; it is a
    // defect in whoever produced the second report and never an overwrite.
    return "failed";
  } catch (error) {
    logger.warn("lighter.fill_observation.ledger_write_failed", {
      canonicalIdentity: record.canonicalIdentity,
      reason: error instanceof Error ? error.name : "unknown",
    });
    return "failed";
  }
}

/**
 * The integrator terms in force for this fill, as TERMS.
 *
 * The ticks come from the integrator fees BOUND ON THE ORDER, which is what
 * the approval permitted; whether the exchange applied them to this trade is a
 * different question that the trade record itself answers. An order with no
 * integrator fees is ordinary (an account that never authorized one) and
 * yields null ticks rather than a guess. The authorization intent id travels
 * as PROVENANCE only, never as proof that a fee was charged.
 *
 * The fee asset is the market's QUOTE asset, except for a spot BUY, which the
 * exchange charges on the received base - the same rule
 * `agentscan-activity.ts` computes the estimate on.
 */
async function resolveLighterFillFeeTerms(
  intent: LighterFillIntentFacts,
  market: LighterResolvedMarketAssets,
  authorizedFees: LighterIntegratorFees | null,
  deps: LighterFillObservationDeps,
): Promise<LighterFillFeeTerms> {
  let feeAuthorizationIntentId: string | null = null;
  try {
    const authorization = await deps.findFeeAuthorization(intent.environment, intent.accountIndex);
    feeAuthorizationIntentId = authorization?.intentId ?? null;
  } catch (error) {
    logger.warn("lighter.fill_observation.fee_authorization_unreadable", {
      environment: intent.environment,
      reason: error instanceof Error ? error.name : "unknown",
    });
  }
  const spotBuy = market.spot && intent.side === "buy";
  return {
    integratorMakerFeeTick: feeTickOrNull(authorizedFees?.integratorMakerFee),
    integratorTakerFeeTick: feeTickOrNull(authorizedFees?.integratorTakerFee),
    collectorAccountIndex: accountIndexOrNull(authorizedFees?.integratorAccountIndex),
    feeAuthorizationIntentId,
    feeAsset: spotBuy ? market.baseAsset : market.quoteAsset,
  };
}

function feeTickOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function accountIndexOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** The market facts a fill needs, plus whether the venue calls it a spot market. */
export interface LighterResolvedMarketAssets extends LighterMarketAssets {
  /** The provider's own classification, never inferred from the index. */
  readonly spot: boolean;
  /**
   * How many decimals the venue prices a POSITION SIZE in on this market
   * (`supported_size_decimals`). Distinct from the base asset's own decimals,
   * and the figure the position wire contract asks for beside a signed size.
   */
  readonly sizeDecimals: number;
}

interface CachedEnvironmentAssets {
  readonly assets: ReadonlyMap<number, LighterAssetDetail>;
  readonly readAtMs: number;
}

const assetCache = new Map<LighterEnvironment, CachedEnvironmentAssets>();
const marketCache = new Map<string, { readonly market: LighterResolvedMarketAssets; readonly readAtMs: number }>();

/** Test seam: forget every cached provider reading. */
export function resetLighterMarketAssetsCache(): void {
  assetCache.clear();
  marketCache.clear();
}

/**
 * The market symbol and its two assets with their own decimals, read from the
 * provider and cached for {@link LIGHTER_MARKET_ASSETS_TTL_MS}.
 *
 * Throws when the provider cannot name the market or one of its assets: a fill
 * row with an assumed decimal is worse than no fill row, because the row is
 * what the campaign totals are summed from.
 */
export async function resolveLighterMarketAssets(
  environment: LighterEnvironment,
  marketIndex: number,
  deps: LighterFillObservationDeps,
  nowMs: number = Date.now(),
): Promise<LighterResolvedMarketAssets> {
  const cacheKey = `${environment}:${marketIndex}`;
  const cached = marketCache.get(cacheKey);
  if (cached !== undefined && nowMs - cached.readAtMs < LIGHTER_MARKET_ASSETS_TTL_MS) {
    return cached.market;
  }

  const response = await deps.client.getMarketDetails(environment, { marketId: marketIndex, filter: "all" });
  const detail = [...response.order_book_details, ...response.spot_order_book_details]
    .find((candidate) => candidate.market_id === marketIndex);
  if (detail === undefined) {
    throw new Error(`Lighter did not return market ${marketIndex} on ${environment}.`);
  }
  const assets = await readEnvironmentAssets(environment, deps, nowMs);
  const sizeDecimals = sizeDecimalsOf(detail);
  // A SPOT market names its two assets; a PERPETUAL names none. Measured live
  // on 2026-09-08 on both environments: every perp's `orderBookDetails` row
  // carries `base_asset_id: 0, quote_asset_id: 0` (asset id 0 names nothing),
  // exactly why `order-preview.ts` reads those ids for spot markets only. A
  // perp's base leg is the instrument itself, in the venue's size decimals;
  // its quote leg is the environment's collateral, verified the way the
  // onboarding readers verify the deposit asset.
  const market: LighterResolvedMarketAssets = detail.market_type === "spot"
    ? {
        marketSymbol: detail.symbol,
        baseAsset: venueAsset(environment, detail.base_asset_id, assets, detail, "base"),
        quoteAsset: venueAsset(environment, detail.quote_asset_id, assets, detail, "quote"),
        spot: true,
        sizeDecimals,
      }
    : {
        marketSymbol: detail.symbol,
        baseAsset: {
          venueAssetId: lighterPerpVenueAssetId(environment, detail.market_id),
          symbol: detail.symbol,
          decimals: sizeDecimals,
        },
        quoteAsset: verifiedCollateralAsset(environment, assets),
        spot: false,
        sizeDecimals,
      };
  marketCache.set(cacheKey, { market, readAtMs: nowMs });
  return market;
}

/**
 * The environment's collateral asset, selected and verified by THE SAME RULE
 * `wallet-funding/onboarding-readers.ts` applies to the deposit asset: the row
 * whose id is the deployment's pinned settlement asset index, whose symbol,
 * both decimals and L1 address match the deployment, or nothing at all.
 *
 * Throws when the provider's list does not carry exactly that row: a perp fill
 * denominated in an unverified collateral would misstate every fee and every
 * quote leg the campaign sums.
 */
function verifiedCollateralAsset(
  environment: LighterEnvironment,
  assets: ReadonlyMap<number, LighterAssetDetail>,
): LighterVenueAssetRef {
  const funding = getLighterFundingDeployment(environment);
  const asset = assets.get(funding.settlementAssetIndex);
  if (
    asset === undefined
    || asset.symbol !== funding.settlementSymbol
    || asset.l1_decimals !== funding.settlementDecimals
    || asset.decimals !== funding.settlementDecimals
    || getAddress(asset.l1_address) !== funding.settlementTokenProxy
  ) {
    throw new Error(`Lighter did not return one verified ${environment} ${funding.settlementSymbol} collateral asset.`);
  }
  return {
    venueAssetId: lighterVenueAssetId(environment, asset.asset_id),
    symbol: asset.symbol,
    decimals: asset.decimals,
  };
}

/**
 * The market's size decimals, from the provider's own field. Never defaulted:
 * a wrong figure beside a signed size misstates the position by a power of
 * ten, which is the same failure a wrong asset decimal is.
 */
function sizeDecimalsOf(detail: LighterMarketDetail): number {
  const decimals = detail.supported_size_decimals;
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Lighter did not report size decimals for market ${detail.market_id}.`);
  }
  return decimals;
}

async function readEnvironmentAssets(
  environment: LighterEnvironment,
  deps: LighterFillObservationDeps,
  nowMs: number,
): Promise<ReadonlyMap<number, LighterAssetDetail>> {
  const cached = assetCache.get(environment);
  if (cached !== undefined && nowMs - cached.readAtMs < LIGHTER_MARKET_ASSETS_TTL_MS) return cached.assets;
  const response = await deps.client.getAssetDetails(environment);
  const assets = new Map<number, LighterAssetDetail>();
  for (const asset of response.asset_details) assets.set(asset.asset_id, asset);
  assetCache.set(environment, { assets, readAtMs: nowMs });
  return assets;
}

/**
 * One venue asset reference. The DECIMALS are the provider's own figure and
 * are never defaulted: an asset the provider did not describe is a market this
 * install cannot report amounts for.
 */
function venueAsset(
  environment: LighterEnvironment,
  assetId: number,
  assets: ReadonlyMap<number, LighterAssetDetail>,
  detail: LighterMarketDetail,
  leg: "base" | "quote",
): LighterVenueAssetRef {
  const asset = assets.get(assetId);
  if (asset === undefined || !Number.isInteger(asset.decimals) || asset.decimals < 0) {
    throw new Error(
      `Lighter did not describe the ${leg} asset ${assetId} of market ${detail.market_id} on ${environment}.`,
    );
  }
  return {
    venueAssetId: lighterVenueAssetId(environment, assetId),
    symbol: asset.symbol,
    decimals: asset.decimals,
  };
}
