/**
 * Shaping vocabulary owned by the S3 resolve and market-context tools.
 *
 * Separate from `./screen-params/shaping.ts` because the bounds mean different
 * things. The screening family's `limit` maps onto a 100-row provider page
 * that offset paging can walk past; the spotlight's feeds arrive whole in one
 * document with no continuation at all, so a limit above the feed size returns
 * the whole feed rather than reaching further. Sharing one constant would
 * advertise a continuation that does not exist.
 */

import type { ProtocolParamDef } from "../../types.js";
import {
  MAX_PRESENCE_CLAUSE,
  SCREEN_THRESHOLD_PARAMS,
} from "./screen-params/thresholds.js";

/** The feeds the spotlight document carries, plus the combined selector. */
export const SPOTLIGHT_FEED_VALUES = [
  "topBoosts",
  "recentBoosts",
  "latestProfiles",
  "all",
] as const;

export type SpotlightFeedSelector = (typeof SPOTLIGHT_FEED_VALUES)[number];

/**
 * Rows per feed by default.
 *
 * There is NO maximum. The provider's feeds were measured at 30, 30 and 36
 * rows, but a feed is a BOUND and not a promise: a fresh recent-boosts feed was
 * measured at 28. A ceiling derived from one measurement would refuse a legal
 * request the day the provider serves one more row, so the limit is bounded
 * only from below and a limit above the feed returns the whole feed (owner
 * decision D-DS5, no artificial Vex-side caps). Per-feed sizes come back in
 * `providerWindow.feedSizes` on every answer.
 */
export const SPOTLIGHT_LIMIT_MIN = 1;
export const SPOTLIGHT_LIMIT_DEFAULT = 10;

/** The largest feed size measured so far. Descriptive, never enforced. */
export const SPOTLIGHT_MEASURED_FEED_SIZES = "30, 30 and 36";

/* ------------------------------------------------------------------ */
/* Spotlight row field groups                                          */
/* ------------------------------------------------------------------ */

/**
 * Field GROUPS a spotlight row may carry. `core` is always included.
 *
 * Its OWN vocabulary rather than `screen-core/fields.ts`: a spotlight row is
 * not a `dex_screener_schema.Pair` and carries none of the metric groups. The
 * two optional groups are the ones with a context cost worth deciding about,
 * and both exist only on the `latestProfiles` feed:
 *
 *  - `description`: the issuer-authored blurb and the provider's nsfw flag.
 *    Unbounded issuer prose, which is why it is not in the default projection.
 *  - `links`: the issuer's claimed website and social links.
 *  - `media`: the provider's own image identifiers - `tokenImageUrl` on a
 *    boost row (a CDN URL, measured on 30 of 30 top rows), and `iconId` plus
 *    `headerId` on a profile row (measured on 36 of 36 and 34 of 36). These
 *    are PROVIDER-hosted asset references, not issuer text, so they are
 *    neither sanitized nor counted as external content. They are out of the
 *    default projection because a text model cannot read an image: they exist
 *    for a caller that will render or fetch one, and shipping them by default
 *    would spend context on URLs nobody follows.
 *
 * `description` and `links` are issuer CLAIMS, sanitized and reported in
 * `sanitizedFields` like any other untrusted text.
 */
export const SPOTLIGHT_FIELD_GROUPS = [
  "core",
  "description",
  "links",
  "media",
] as const;

export type SpotlightFieldGroup = (typeof SPOTLIGHT_FIELD_GROUPS)[number];

/** What ships when the caller says nothing. */
export const SPOTLIGHT_FIELD_GROUPS_DEFAULT: readonly SpotlightFieldGroup[] = [
  "core",
];

/* ------------------------------------------------------------------ */
/* Search-backed tools (7 and 8)                                       */
/* ------------------------------------------------------------------ */

/**
 * Row bounds for the two search-backed tools.
 *
 * There is no ceiling to declare: what arrives is the provider's own
 * per-request window (`SEARCH_PROVIDER_WINDOW`) times the number of chains the
 * call fanned out over, and `maxChains` is what the caller raises. A limit
 * above what the provider sent returns everything it sent; it cannot reach
 * further, because this channel has no continuation of any kind.
 */
export const SEARCH_LIMIT_MIN = 1;
export const SEARCH_LIMIT_DEFAULT = 20;

/** How the search-backed tools may order the window they were handed. */
export const SEARCH_SORT_KEYS = [
  "relevance",
  "liquidityUsd",
  "volumeUsd",
  "marketCapUsd",
  "priceChangePct",
  "pairAgeSeconds",
] as const;

export type SearchSortKey = (typeof SEARCH_SORT_KEYS)[number];

/**
 * The sentence every client-side threshold on these two tools carries.
 *
 * It is the OPPOSITE of the screening family's threshold contract and the
 * difference is the whole point: there, a threshold changes which rows the
 * provider ranks; here, the provider has already chosen and capped the window
 * before Vex sees a single row, so a threshold can only remove rows from that
 * window and can never reach a row the provider did not send.
 */
export const SEARCH_CLIENT_FILTER_CLAUSE =
  "Applied HERE, to the bounded window the provider already returned, NOT on the provider: it can "
  + "only remove rows from that window and can never reach a row the provider did not send, so a "
  + "narrow threshold on a capped window is a sample and not a survey. droppedByFilter reports "
  + "every row it removed and why. OMIT it to keep every row; null is not a legal value for any "
  + "threshold on this surface (plan 14.6 item 1) and is refused by name rather than guessed at.";

/* ------------------------------------------------------------------ */
/* The full client-side threshold family (tools 8 and 17)              */
/* ------------------------------------------------------------------ */

/**
 * The correction every screening threshold needs before it may appear on a
 * tool that filters LOCALLY.
 *
 * `SCREEN_THRESHOLD_PARAMS` is reused verbatim rather than re-declared, so the
 * 21 keys, their units and their meanings keep one owner. Three of its
 * sentences are only true on the screening channel, and this clause overrides
 * all three by name rather than leaving the agent to notice the mismatch:
 * there is no default floor to remove here, there is no `thresholdWindow`
 * param, and the filter runs after the rows arrived instead of choosing which
 * rows the provider ranks.
 *
 * The last sentence is the `?? 0` ruling (plan 14.6 item 10): a row the
 * provider reported no metric for is NOT compared against the bound, is kept,
 * and is counted in `clientFiltering.notEvaluated`. Missing is not zero.
 */
const CLIENT_THRESHOLD_CORRECTION =
  "ON THIS TOOL the comparison runs HERE, over the rows already in hand, and NOT on the provider: "
  + "this tool applies no default floor, so there is nothing to remove and no disableQualityFloor "
  + "to send; there is no separate thresholdWindow, so a windowed threshold measures "
  + "over window; and null is not a legal value here, so OMIT the parameter to keep every row. "
  + "droppedByFilter counts every row removed and by which threshold. A row whose "
  + "metric the provider did not report is NOT compared and NOT dropped: it is kept and counted in "
  + "clientFiltering.notEvaluated, because a missing measurement is not a measurement of zero.";

/** What the clause adds on `pairs_batch_get`: the set is the caller's own. */
export const BATCH_CLIENT_FILTER_CLAUSE =
  `${CLIENT_THRESHOLD_CORRECTION} The filtered set is the explicit list you passed, so the `
  + "filtering is exhaustive over that list rather than a sample.";

/** What it adds on `token_pairs_list`: the window was the provider's choice. */
export const TOKEN_PAIRS_CLIENT_FILTER_CLAUSE =
  `${CLIENT_THRESHOLD_CORRECTION} ${SEARCH_CLIENT_FILTER_CLAUSE}`;

/**
 * The 21 threshold keys the local evaluator can answer for, in the order it
 * applies them.
 *
 * The order is part of the contract: `droppedByFilter` attributes a row to the
 * FIRST threshold that removed it, so a row failing three of them is counted
 * once and the counts sum exactly to the number of rows removed.
 *
 * WHAT IS DELIBERATELY ABSENT, and why (rule: name every omission). The four
 * `SCREEN_QUALITY_PARAMS` - `requireProfile`, `onlyBoosted`, `onlyAds`,
 * `onlyRecentAds` - are NOT offered locally. `onlyAds` and `onlyRecentAds`
 * have no field on a projected row at all, and `requireProfile` would need the
 * heavy `profile` group fetched for every row just to filter it away. A
 * parameter that cannot be answered from the rows in hand would have to guess,
 * and a guessed filter is the failure the whole echo contract exists to
 * prevent. `minBoostCount` is offered because it is answerable on every row
 * without a guess: the provider sends a `boosts` block only on a pair that has
 * active boosts, so a row WITHOUT one has an active boost amount of zero and is
 * compared as 0 (`thresholdSubject` in `handlers/resolve.ts`), not kept as
 * not-evaluated. `boostsActive` itself is null on such a row.
 */
export const CLIENT_THRESHOLD_KEYS = [
  "minLiquidityUsd",
  "maxLiquidityUsd",
  "minMarketCapUsd",
  "maxMarketCapUsd",
  "minFdvUsd",
  "maxFdvUsd",
  "minVolumeUsd",
  "maxVolumeUsd",
  "minTxnCount",
  "maxTxnCount",
  "minBuyCount",
  "maxBuyCount",
  "minSellCount",
  "maxSellCount",
  "minPriceChangePct",
  "maxPriceChangePct",
  "minPairAgeSeconds",
  "maxPairAgeSeconds",
  "minLaunchpadProgressPct",
  "maxLaunchpadProgressPct",
  "minBoostCount",
] as const;

export type ClientThresholdKey = (typeof CLIENT_THRESHOLD_KEYS)[number];

/**
 * Build the client-side threshold params from the screening family's own
 * declarations, appending `clause` to each.
 *
 * Throws when a key in {@link CLIENT_THRESHOLD_KEYS} has no declaration in
 * `SCREEN_THRESHOLD_PARAMS`. That is the drift guard: if S2b renames or drops
 * a threshold, these two tools must not go on advertising a parameter their
 * evaluator answers for but the vocabulary no longer defines.
 */
export function clientThresholdParams(
  clause: string
): readonly ProtocolParamDef[] {
  const declared = new Map(
    SCREEN_THRESHOLD_PARAMS.map((param) => [param.key, param] as const)
  );
  return CLIENT_THRESHOLD_KEYS.map((key) => {
    const param = declared.get(key);
    if (param === undefined) {
      throw new Error(
        `clientThresholdParams: "${key}" has no declaration in SCREEN_THRESHOLD_PARAMS; `
        + "the local evaluator would answer for a parameter no tool advertises"
      );
    }
    const inherited = localPresenceRule(key, param.description);
    const note = CLIENT_KEY_NOTES[key];
    return {
      ...param,
      description: `${inherited} ${clause}${note === undefined ? "" : ` ${note}`}`,
    };
  });
}

/**
 * The ceiling sentence a LOCAL filter states in place of the provider's.
 *
 * Measured 2026-10-07: every `max...` param here inherited
 * `MAX_PRESENCE_CLAUSE` ("a row the provider reported no value for is
 * excluded"), and then the client clause said the opposite ("kept and counted
 * in notEvaluated"). Both were in one description and only the second is true
 * on these tools, so the first is REPLACED rather than contradicted.
 */
const CLIENT_CEILING_PRESENCE_CLAUSE =
  "PRESENCE ON THIS TOOL is the opposite of the screening boards: a maximum here does NOT require "
  + "the field. A row whose value the provider did not report is KEPT and counted in "
  + "clientFiltering.notEvaluated; only a row whose reported value is above the ceiling is "
  + "dropped.";

/**
 * Swap the provider presence clause for the local one. Throws when a ceiling no
 * longer carries the clause it is meant to replace: that is a reworded
 * `MAX_PRESENCE_CLAUSE`, and a silent miss would put the contradiction back.
 */
function localPresenceRule(key: ClientThresholdKey, description: string): string {
  if (!key.startsWith("max")) return description;
  if (!description.includes(MAX_PRESENCE_CLAUSE)) {
    throw new Error(
      `clientThresholdParams: "${key}" no longer carries MAX_PRESENCE_CLAUSE, so the local `
      + "presence rule cannot replace it; update localPresenceRule with the new wording"
    );
  }
  return description.replace(MAX_PRESENCE_CLAUSE, CLIENT_CEILING_PRESENCE_CLAUSE);
}

/**
 * Per-key exceptions to the client clause, appended AFTER it because each one
 * narrows a rule the clause states for the whole family.
 *
 * `minBoostCount`: the provider sends a `boosts` block only on a pair that has
 * active boosts, so a row without one is compared as zero (see the omission
 * note above and `thresholdSubject` in `handlers/resolve.ts`), which is the one
 * place "missing is not zero" does not apply.
 */
const CLIENT_KEY_NOTES: Partial<Record<ClientThresholdKey, string>> = {
  minBoostCount:
    "EXCEPTION for this key: a row with no boosts block has an active boost amount of ZERO, which "
    + "is a measurement, so it is compared as 0 and dropped by any floor above 0 rather than "
    + "counted in notEvaluated.",
};
