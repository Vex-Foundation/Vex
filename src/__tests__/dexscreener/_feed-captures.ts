/**
 * Recorded DexScreener FEED and NARRATIVE windows, run through the REAL validators.
 *
 * Same contract as `./_pair-captures.ts`: every number the feed tests assert —
 * byte budgets, drop accounting, the aggregate disagreement — is measured over
 * bytes the provider actually sent, parsed by the validators production uses.
 *
 * `rules/90-vex-project.md` names the two failure modes these files exist to
 * prevent: fixtures that only encode the empty collection, and tests that
 * re-implement the logic under test. Every capture here is non-empty and none of
 * them is hand-written.
 *
 * See `fixtures/live-captures/README.md` for provenance and regeneration.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type {
  DexAd,
  DexBoostFeed,
  DexCommunityTakeover,
  DexMeta,
  DexMetaDetail,
  DexTokenProfile,
} from "@tools/dexscreener/types.js";
import { validateBoostsResponse } from "@tools/dexscreener/validation/boosts.js";
import {
  validateAdsResponse,
  validateCommunityTakeoversResponse,
} from "@tools/dexscreener/validation/community-ads.js";
import {
  validateMetaDetailResponse,
  validateMetasTrendingResponse,
} from "@tools/dexscreener/validation/metas.js";
import {
  validateProfilesRecentResponse,
  validateProfilesResponse,
} from "@tools/dexscreener/validation/profiles.js";

interface Capture {
  readonly endpoint: string;
  readonly capturedAt: string;
  readonly response: unknown;
}

function loadCapture(name: string): Capture {
  const path = fileURLToPath(new URL(`./fixtures/live-captures/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as Capture;
}

/**
 * `/token-profiles/latest/v1` — 30 rows, `updatedAt` and `cto` on 30/30 (both
 * fields were parsed and DISCARDED by this feed's validator until card D-2), and
 * 13 of the 30 on the `robinhood` chain, which is the owner's worked example.
 */
export function profilesLatest(): DexTokenProfile[] {
  return validateProfilesResponse(loadCapture("token-profiles-latest-v1").response);
}

/**
 * `/token-profiles/recent-updates/v1` — 30 rows across 6 chains, 11 of them on
 * `base`. The 40 KB blob witness: this feed's uncapped payload was 40,089 B, 2.45x
 * the context cap, with no parameter of any kind to shrink it.
 *
 * Shares only ONE token with {@link profilesLatest} captured in the same second,
 * so the two feeds are different windows on the market and neither is a superset.
 */
export function profilesRecent(): DexTokenProfile[] {
  return validateProfilesRecentResponse(
    loadCapture("token-profiles-recent-updates-v1").response,
  );
}

/** `/token-boosts/latest/v1` — 30 rows, `amount` AND `totalAmount` on all of them. */
export function boostsLatest(): DexBoostFeed {
  return validateBoostsResponse(loadCapture("token-boosts-latest-v1").response);
}

/** `/token-boosts/top/v1` — 30 rows with `amount` absent on every one. */
export function boostsTop(): DexBoostFeed {
  return validateBoostsResponse(loadCapture("token-boosts-top-v1").response);
}

/** `/community-takeovers/latest/v1` — 28 rows, each with a `claimDate`. */
export function communityTakeovers(): DexCommunityTakeover[] {
  return validateCommunityTakeoversResponse(
    loadCapture("community-takeovers-latest-v1").response,
  );
}

/** `/ads/latest/v1` — 30 rows; `impressions` is 10,000 or `null`, never anything else. */
export function adsLatest(): DexAd[] {
  return validateAdsResponse(loadCapture("ads-latest-v1").response);
}

/** `/metas/trending/v1` — 19 narratives. `cat` reports 67 tokens here. */
export function metasTrending(): DexMeta[] {
  return validateMetasTrendingResponse(loadCapture("metas-trending-v1").response);
}

/**
 * `/metas/meta/v1/cat` — the aggregate-disagreement witness, captured in the same
 * second as {@link metasTrending}.
 *
 * `marketCap` is EXACTLY `sum(pairs[].marketCap)` (228,639,930 both sides),
 * `tokenCount` is EXACTLY `pairs.length` (31) while the trending feed says 67 for
 * the same slug, and `liquidity` is NOT a sum of the same pairs (23,493,587.84
 * against 21,906,813.54).
 */
export function metaCat(): DexMetaDetail {
  const detail = validateMetaDetailResponse(loadCapture("metas-meta-v1-cat").response);
  if (detail === null) throw new Error("metas-meta-v1-cat fixture did not validate");
  return detail;
}
