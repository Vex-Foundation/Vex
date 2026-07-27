/**
 * `pendle.market.get` — everything an agent needs about ONE Pendle market
 * before it quotes: identity, maturity, the tokens the market accepts, and
 * Pendle's own live PT/YT rates.
 *
 * It exists because both halves were previously unreachable. The accepted-token
 * sets are what a convert request must be built against — an off-list `tokenOut`
 * is the documented cause of Pendle's "tokenOut must be in the SY token out
 * list" 400 (G-05) — and the only way to learn a current PT/YT rate was a 5-CU
 * convert quote, which Pendle's own docs say not to use as a price source (G-04).
 *
 * THREE ANSWERS THIS TOOL MUST KEEP DISTINCT:
 *   - the market is MATURED. `swapping-prices` answers HTTP 404 for it, which is
 *     a definitive provider verdict about a live market that no longer trades —
 *     so the identity and the accepted tokens are still returned, `rates` is
 *     null, and a sentence says why. It is not an error.
 *   - the market is NOT in the catalogue, and the catalogue was read to
 *     exhaustion — a determined absence.
 *   - the market was not found but the walk ran out of page budget — absence is
 *     UNPROVEN and must be reported as such (rules/90: refuse rather than guess).
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadMarketTokens, PendleReadSwappingPrices } from "@tools/pendle/read/types.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import { VexError } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  readToken,
  resolveAssetFacts,
  type PendleReadAssetFactsLookup,
  type PendleReadToken,
} from "../asset-decimals.js";
import { daysUntil, percentString } from "../money-format.js";
import { parsePendleMarketGetParams } from "../market-read-params.js";
import { resolveMarketForRead } from "../market-read.js";
import { trustedAddress, trustedIsoTimestamp, trustedNumber, trustedText } from "../trusted-fields.js";
import { marketAbsenceAnswer } from "./market-absence.js";
import { failureDetail } from "./read-shared.js";

const TOOL_ID = "pendle.market.get";

/**
 * Accepted-token lists are bounded because the live ones are long: the recorded
 * chain-1 body carries ~150 `tokensIn`. The cap is EXPLICIT — the total and a
 * `truncated` flag travel with every list — because the owner rule is that an
 * agent-facing output is never silently trimmed.
 */
const MAX_ACCEPTED_TOKENS = 25;

interface BoundedTokenList {
  total: number;
  tokens: string[];
  truncated: boolean;
}

function boundedTokens(addresses: readonly string[]): BoundedTokenList {
  const checked = addresses.map((a) => trustedAddress(a)).filter((a): a is string => a !== null);
  return {
    total: checked.length,
    tokens: checked.slice(0, MAX_ACCEPTED_TOKENS),
    truncated: checked.length > MAX_ACCEPTED_TOKENS,
  };
}

function projectAccepts(tokens: PendleReadMarketTokens): Record<string, BoundedTokenList> {
  return {
    tokensMintSy: boundedTokens(tokens.tokensMintSy),
    tokensRedeemSy: boundedTokens(tokens.tokensRedeemSy),
    tokensIn: boundedTokens(tokens.tokensIn),
    tokensOut: boundedTokens(tokens.tokensOut),
  };
}

function acceptsTruncationNote(accepts: Record<string, BoundedTokenList>): string | undefined {
  const bounded = Object.entries(accepts).filter(([, list]) => list.truncated);
  if (bounded.length === 0) return undefined;
  return (
    `Long token lists are capped at ${MAX_ACCEPTED_TOKENS} entries each — ` +
    bounded.map(([name, list]) => `${name} shows ${list.tokens.length} of ${list.total}`).join(", ") +
    ". The entries kept are the first Pendle returned; nothing was dropped silently, and a token absent from the " +
    "shown slice may still be accepted."
  );
}

interface ProjectedRates {
  underlyingToken: string | null;
  underlyingToPt: number | null;
  ptToUnderlying: number | null;
  underlyingToYt: number | null;
  ytToUnderlying: number | null;
  impliedApyPercent: string | null;
  asOf: string;
}

function projectRates(prices: PendleReadSwappingPrices, asOf: string): ProjectedRates {
  return {
    underlyingToken: trustedAddress(prices.underlyingToken),
    underlyingToPt: trustedNumber(prices.underlyingTokenToPtRate),
    ptToUnderlying: trustedNumber(prices.ptToUnderlyingTokenRate),
    underlyingToYt: trustedNumber(prices.underlyingTokenToYtRate),
    ytToUnderlying: trustedNumber(prices.ytToUnderlyingTokenRate),
    // Pendle returns every APY as a decimal fraction; the unit lives in the name.
    impliedApyPercent: percentString(trustedNumber(prices.impliedApy, 100)),
    asOf,
  };
}

/** A null leg means Pendle says that swap cannot be done — never a rate of zero. */
function nullLegNote(rates: ProjectedRates): string | undefined {
  const missing = (["underlyingToPt", "ptToUnderlying", "underlyingToYt", "ytToUnderlying"] as const).filter(
    (leg) => rates[leg] === null,
  );
  if (missing.length === 0) return undefined;
  return (
    `Pendle returned no rate for ${missing.join(", ")}. That means the swap cannot currently be done ` +
    "(usually thin liquidity) — it is NOT a rate of zero, and it must not be quoted as one."
  );
}

/** True only for a definitive provider verdict — a 404 the request earned. */
function isDefinitiveNotFound(err: unknown): boolean {
  return err instanceof VexError && err.httpStatus === 404;
}

export async function pendleMarketGet(
  p: Record<string, unknown>,
  assets: PendleReadAssetFactsLookup,
  nowMs: number = Date.now(),
): Promise<ToolResult> {
  const parsed = parsePendleMarketGetParams(p);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const asOf = new Date(nowMs).toISOString();
  const chain = pendleChainSlug(q.chainId) ?? String(q.chainId);

  let lookup;
  try {
    lookup = await resolveMarketForRead(q.chainId, q.address, nowMs);
  } catch (err) {
    return fail(`Pendle market lookup failed (${failureDetail(TOOL_ID, err)})`);
  }

  if (lookup.status !== "found") {
    return ok(marketAbsenceAnswer(lookup.status, chain, q.address, q.addressParam, asOf));
  }

  const market = lookup.market;
  const client = getPendleReadClient();

  let accepts: Record<string, BoundedTokenList> | null = null;
  let acceptsNote: string | undefined;
  let acceptsFailed = false;
  try {
    accepts = projectAccepts(await client.getMarketTokens(q.chainId, market.address));
    acceptsNote = acceptsTruncationNote(accepts);
  } catch (err) {
    acceptsFailed = true;
    acceptsNote = `Pendle did not serve this market's accepted-token sets (${failureDetail(TOOL_ID, err)}). Do not assume a token is accepted.`;
  }

  let rates: ProjectedRates | null = null;
  let ratesNote: string | undefined;
  let ratesFailed = false;
  try {
    rates = projectRates(await client.getSwappingPrices(q.chainId, market.address), asOf);
    ratesNote = nullLegNote(rates);
  } catch (err) {
    if (lookup.matured && isDefinitiveNotFound(err)) {
      // The expected answer for a matured market, and the reason this tool does
      // not fail on it: the market is real, it simply no longer trades.
      ratesNote =
        "This market has MATURED, so Pendle serves no live PT/YT rates for it (the rates endpoint answers " +
        "'market is expired'). A matured PT is redeemed at its accounting value rather than swapped — see pendle.pt.redeem.";
    } else if (isDefinitiveNotFound(err)) {
      ratesNote =
        "Pendle serves no live rates for this market (it answered 404 for the rates endpoint). The market resolves in " +
        "the catalogue, so treat this as 'no quotable rate right now', not as a missing market.";
    } else {
      ratesFailed = true;
      ratesNote = `Live PT/YT rates could not be read (${failureDetail(TOOL_ID, err)}). No rate is shown rather than a stale or guessed one.`;
    }
  }

  const assetFacts = await resolveAssetFacts(assets, q.chainId);
  const legs = {
    pt: readToken(market.pt, assetFacts.facts),
    yt: readToken(market.yt, assetFacts.facts),
    sy: readToken(market.sy, assetFacts.facts),
    underlying: readToken(market.underlyingAsset, assetFacts.facts),
    accounting: readToken(market.accountingAsset, assetFacts.facts),
  };
  const decimalsNote = legsNote(
    legs,
    assetFacts.failure === null ? null : failureDetail(TOOL_ID, assetFacts.failure),
  );
  const expiry = trustedIsoTimestamp(market.expiry);
  const partial = acceptsFailed || ratesFailed;

  return ok({
    summary: summarize(market.name, chain, lookup.matured, expiry, rates, partial),
    resolution: "found",
    chain,
    matchedBy: lookup.matchedBy,
    catalogScope: lookup.catalogScope,
    market: {
      address: trustedAddress(market.address),
      name: trustedText(market.name),
      protocol: trustedText(market.protocol),
    },
    expiry,
    daysToExpiry: daysUntil(expiry, nowMs),
    matured: lookup.matured,
    state: lookup.matured ? "matured" : "active",
    stateNote: lookup.matured
      ? "MATURED: the fixed term has ended. PT can be redeemed for its accounting asset and LP can be removed; nothing new can be bought here."
      : "ACTIVE: the market trades and the PT still locks a fixed rate until expiry.",
    legs,
    ...(decimalsNote === undefined ? {} : { legsNote: decimalsNote }),
    accepts,
    ...(acceptsNote === undefined ? {} : { acceptsNote }),
    rates,
    ...(ratesNote === undefined ? {} : { ratesNote }),
    partial,
    asOf,
    nextStep:
      "Rates here are Pendle's own pre-trade source — cheaper and more honest than a convert quote, which Pendle says " +
      "not to use as a price. For the trend behind them call pendle.market.history; for resting limit-order depth call " +
      "pendle.orderbook; to trade, call pendle.pt.quote / pendle.yt.quote with a tokenIn and tokenOut from `accepts`. " +
      "Amounts on the quote and trade tools are HUMAN units, not base units.",
  });
}

function legsNote(legs: Record<string, PendleReadToken | null>, lookupFailure: string | null): string | undefined {
  const unknown = Object.entries(legs).filter(([, leg]) => leg !== null && leg.decimals === null);
  if (unknown.length === 0) return undefined;
  const cause =
    lookupFailure === null
      ? "Pendle's market catalogue does not publish them"
      : `the asset catalogue could not be read (${lookupFailure})`;
  return (
    `Decimals are not known for: ${unknown.map(([name]) => name).join(", ")} — ${cause}. ` +
    "This does not block trading: every Pendle quote and trade tool takes amounts in HUMAN units."
  );
}

function summarize(
  name: string | null,
  chain: string,
  matured: boolean,
  expiry: string | null,
  rates: ProjectedRates | null,
  partial: boolean,
): string {
  const label = trustedText(name) ?? "This Pendle market";
  const term = expiry === null ? "an unreported expiry" : `expiry ${expiry.slice(0, 10)}`;
  const rate =
    rates?.impliedApyPercent === undefined || rates?.impliedApyPercent === null
      ? "no live implied APY"
      : `implied APY ${rates.impliedApyPercent}%`;
  return (
    `${label} on ${chain} — ${matured ? "MATURED" : "active"}, ${term}, ${rate}.` +
    (partial ? " Part of this answer could not be read; see the notes." : "")
  );
}
