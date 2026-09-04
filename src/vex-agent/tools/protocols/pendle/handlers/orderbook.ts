/**
 * `pendle.orderbook` - the resting limit-order depth on one Pendle market.
 *
 * WHY A READ-ONLY TOOL IS THE WHOLE POINT. Every Pendle convert quote Vex builds
 * pins `useLimitOrder: false` - a deliberate safety pin, because filling a limit
 * order widens the calldata Vex would have to decode before signing. The cost is
 * price quality on 83 of 84 whitelisted markets, and until now the agent could
 * not even see what it was giving up (G-11/G-12). This tool shows the depth and
 * states plainly that Vex cannot reach it. It never signs anything; the maker
 * surface and its EIP-712 primitive stay out of scope (owner Q21).
 *
 * TWO PROVIDER FACTS ENCODED HERE:
 *   - a market that is NOT limit-order whitelisted answers HTTP 404, not an
 *     empty book. Live-verified on the deepest chain-1 market. So an empty book
 *     from this tool means "whitelisted, nothing resting", and a 404 becomes
 *     `whitelisted: false` - an answer, not a failure.
 *   - sizes are raw base units of the market's PY unit with NO decimals on this
 *     endpoint. They are resolved through the injected asset lookup or shipped
 *     explicitly unreadable; they are never rendered at an assumed 18.
 */

import { getPendleReadClient } from "@tools/pendle/read/client.js";
import type { PendleReadOrderbookLevel } from "@tools/pendle/read/types.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import { VexError } from "../../../../../errors.js";
import type { ToolResult } from "../../../types.js";
import { ok, fail } from "../../handler-helpers.js";
import {
  PENDLE_UNREADABLE_AMOUNT_NOTE,
  readToken,
  readableAmount,
  resolveAssetFacts,
  type PendleReadAmount,
  type PendleReadAssetFactsLookup,
  type PendleReadToken,
} from "../asset-decimals.js";
import { percentString } from "../money-format.js";
import { parsePendleOrderbookParams } from "../market-read-params.js";
import { resolveMarketForRead } from "../market-read.js";
import { trustedNumber, trustedText } from "../trusted-fields.js";
import { marketAbsenceAnswer } from "./market-absence.js";
import { failureDetail } from "./read-shared.js";

const TOOL_ID = "pendle.orderbook";

/**
 * The sentence this tool exists to deliver. Fixed text, asserted by a test: an
 * agent reading depth it cannot trade against must be told so every time, not
 * only when the wording happens to survive an edit.
 */
const AMM_ONLY_NOTE =
  "Vex Pendle quotes are AMM-only; resting orders here may offer a better price - Vex cannot fill them.";

interface ProjectedLevel {
  impliedApyPercent: string | null;
  size: PendleReadAmount;
  /** Portion of the level that qualifies for Pendle's limit-order incentive. */
  incentiveQualifiedSize: PendleReadAmount | null;
}

function projectLevel(level: PendleReadOrderbookLevel, decimals: number | null): ProjectedLevel {
  return {
    // The book's APY axis is a decimal fraction rounded to the requested
    // precision; the unit travels in the field name.
    impliedApyPercent: percentString(trustedNumber(level.impliedApy, 100)),
    size: readableAmount(level.limitOrderSizeRaw, decimals),
    incentiveQualifiedSize:
      level.incentiveQualifiedPySizeRaw === null ? null : readableAmount(level.incentiveQualifiedPySizeRaw, decimals),
  };
}

/**
 * The best price on a side, stated FACTUALLY.
 *
 * Long-yield entries are ranked by the highest implied APY and short-yield by
 * the lowest, because that is what the numbers are. Which side benefits a given
 * trade depends on the direction the agent is taking, and this tool does not
 * claim to know it - nothing here is a recommendation.
 */
function bestLevel(levels: readonly ProjectedLevel[], pick: "highest" | "lowest"): ProjectedLevel | null {
  let best: ProjectedLevel | null = null;
  let bestApy: number | null = null;
  for (const level of levels) {
    const apy = level.impliedApyPercent === null ? null : Number(level.impliedApyPercent);
    if (apy === null || !Number.isFinite(apy)) continue;
    if (bestApy === null || (pick === "highest" ? apy > bestApy : apy < bestApy)) {
      best = level;
      bestApy = apy;
    }
  }
  return best;
}

export async function pendleOrderbook(
  p: Record<string, unknown>,
  assets: PendleReadAssetFactsLookup,
  nowMs: number = Date.now(),
): Promise<ToolResult> {
  const parsed = parsePendleOrderbookParams(p);
  if (!parsed.ok) return fail(parsed.rejection.message);
  const q = parsed.value;
  const asOf = new Date(nowMs).toISOString();
  const chain = pendleChainSlug(q.chainId) ?? String(q.chainId);

  let lookup;
  try {
    lookup = await resolveMarketForRead(q.chainId, q.market, nowMs);
  } catch (err) {
    return fail(`Pendle market lookup failed (${failureDetail(TOOL_ID, err)})`);
  }
  if (lookup.status !== "found") {
    // No book call: the endpoint would answer 404 for an address the catalogue
    // does not carry, and that 404 would be indistinguishable from "not
    // whitelisted" - two different answers.
    return ok(marketAbsenceAnswer(lookup.status, chain, q.market, "market", asOf));
  }

  const market = lookup.market;
  const assetFacts = await resolveAssetFacts(assets, q.chainId);
  // Sizes are denominated in the market's PY unit - PT and YT share it. SY is the
  // documented fallback when the catalogue does not carry the PT.
  const sizeUnit: PendleReadToken | null =
    readToken(market.pt, assetFacts.facts) ?? readToken(market.sy, assetFacts.facts);
  const decimals = sizeUnit?.decimals ?? null;
  const amountsNote =
    decimals !== null
      ? undefined
      : assetFacts.failure === null
        ? PENDLE_UNREADABLE_AMOUNT_NOTE
        : `${PENDLE_UNREADABLE_AMOUNT_NOTE} The catalogue read itself failed: ${failureDetail(TOOL_ID, assetFacts.failure)}.`;

  const identity = {
    chain,
    market: market.address,
    marketName: trustedText(market.name),
    matured: lookup.matured,
    precision: q.precision,
    sizeUnit,
    asOf,
    note: AMM_ONLY_NOTE,
  };

  let book;
  try {
    book = await getPendleReadClient().getOrderbook(q.chainId, market.address, { precisionDecimal: q.precision });
  } catch (err) {
    if (err instanceof VexError && err.httpStatus === 404) {
      return ok({
        summary:
          `${trustedText(market.name) ?? "This market"} on ${chain} has NO limit-order book - Pendle has not ` +
          "whitelisted it for limit orders, so all of its liquidity is AMM liquidity and a Pendle quote already sees it.",
        ...identity,
        whitelisted: false,
        levels: null,
        best: null,
        nextStep:
          "Nothing is being missed here: quote the trade with pendle__pt_quote / pendle__yt_quote. Use pendle__market_get " +
          "for the market's current AMM rates.",
      });
    }
    return fail(`Pendle order book unavailable (${failureDetail(TOOL_ID, err)})`);
  }

  const longYield = book.longYieldEntries.map((level) => projectLevel(level, decimals));
  const shortYield = book.shortYieldEntries.map((level) => projectLevel(level, decimals));
  const truncated = longYield.length > q.limit || shortYield.length > q.limit;
  const best = {
    longYield: bestLevel(longYield, "highest"),
    shortYield: bestLevel(shortYield, "lowest"),
  };

  return ok({
    summary: summarize(chain, trustedText(market.name), longYield.length, shortYield.length, best),
    ...identity,
    whitelisted: true,
    best,
    bestNote:
      "`best.longYield` is the HIGHEST implied APY resting on the long-yield side and `best.shortYield` the LOWEST on " +
      "the short-yield side. They describe the book, not a recommendation, and Vex cannot fill either.",
    levelCounts: { longYield: longYield.length, shortYield: shortYield.length },
    truncated,
    ...(truncated
      ? {
          truncationNote:
            `Only the first ${q.limit} level(s) per side are shown; levelCounts reports how many exist. Raise \`limit\` to see more.`,
        }
      : {}),
    levels: { longYield: longYield.slice(0, q.limit), shortYield: shortYield.slice(0, q.limit) },
    ...(amountsNote === undefined ? {} : { amountsNote }),
    nextStep:
      "Depth here is informational. Vex trades this market through the AMM only - call pendle__pt_quote or " +
      "pendle__yt_quote for a price Vex can actually execute, and pendle__market_get for the market's own rates.",
  });
}

function summarize(
  chain: string,
  name: string | null,
  longCount: number,
  shortCount: number,
  best: { longYield: ProjectedLevel | null; shortYield: ProjectedLevel | null },
): string {
  const label = name ?? "This Pendle market";
  if (longCount === 0 && shortCount === 0) {
    return `${label} on ${chain} is limit-order whitelisted but has NO resting orders on either side right now.`;
  }
  const long = best.longYield?.impliedApyPercent;
  const short = best.shortYield?.impliedApyPercent;
  return (
    `${label} on ${chain}: ${longCount} long-yield and ${shortCount} short-yield level(s) resting` +
    (long === undefined || long === null ? "" : `, best long-yield ${long}%`) +
    (short === undefined || short === null ? "" : `, best short-yield ${short}%`) +
    ". Vex cannot fill these - its quotes are AMM-only."
  );
}
