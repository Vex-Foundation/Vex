/**
 * The NARRATIVE handlers — `trending` (the narrative list) and `meta` (one
 * narrative plus the pools inside it).
 *
 * DexScreener calls these "metas": themes such as `cat`, `ai`, `dog`,
 * `knockoff-legends`. Together they are the only market-wide rotation signal this
 * API offers: `trending` says which themes exist and how big they are, `meta`
 * says which pools sit inside one.
 *
 * `trending` had one parameter (`limit`, no maximum, `0` meaning the opposite of
 * what it means in `search`) and `meta` had none but `slug` — so a 30-pair
 * narrative arrived at 17,161 B with no way to narrow it. Both now carry the
 * shared list vocabulary.
 *
 * `meta` EMITS `AgentDexPair`, NOT THE LEGACY ROW. It was the last caller of
 * `projectors.ts`, which meant this namespace shipped two different pair shapes:
 * one with units in every field name and one with bare `fdv`, `marketCap` and
 * `pairCreatedAt`. That file is now deleted. A narrative's pools are pools, and an
 * agent that has learned to read a `search` row can read these.
 *
 * ONE MEASURED CAVEAT, surfaced in the output rather than hidden here: 29 of 31
 * live narrative pairs carried `pairCreatedAt` and only 10 of 31 carried `labels`,
 * so age and pool-variant filters bite harder on this endpoint than on
 * `tokenPairs`. `droppedByFilter.unknownAge` makes that visible.
 *
 * FAILURES ARE NOT SWALLOWED — see the note in `./feeds.ts`.
 */

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { ProtocolHandler } from "../../types.js";
import { str, ok, fail } from "../../handler-helpers.js";
import {
  NARRATIVE_SUBSET_NOTE,
  buildNarrativeList,
  parseNarrativeListQuery,
} from "../narrative-list/index.js";
import { buildPairList, parsePairListQuery } from "../pair-list/index.js";

export const DEXSCREENER_NARRATIVE_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.trending": async (p) => {
    const parsed = parseNarrativeListQuery(p);
    if (!parsed.ok) return fail(`dexscreener.trending: ${parsed.reason}`);

    const client = getDexScreenerClient();
    const metas = await client.getMetasTrending();
    return ok(
      buildNarrativeList({
        endpoint: "/metas/trending/v1",
        providerMetas: metas,
        query: parsed.query,
        asOfMs: Date.now(),
      }),
    );
  },

  "dexscreener.meta": async (p) => {
    const slug = str(p, "slug");
    if (!slug) return fail("Missing required: slug");
    // `slug` is a NARRATIVE slug from dexscreener.trending, not a chain slug.
    // `chainIds` IS allowed here, unlike on `trending`: measured live, one
    // narrative's 31 pools spanned six chains, so the filter has something to
    // match and "the cat meta on base" is an answerable question.
    const parsed = parsePairListQuery(p, { sortBy: "liquidityUsd", allowChainFilter: true });
    if (!parsed.ok) return fail(`dexscreener.meta: ${parsed.reason}`);

    const asOfMs = Date.now();
    const client = getDexScreenerClient();
    const detail = await client.getMeta(slug);
    // `null` is the tolerant validator's verdict on a body it could not read at
    // all. That IS an established cause — the provider answered and the payload
    // did not match the narrative shape — so it is reported as exactly that,
    // and as a failure. No claim is made about WHY the shape changed.
    if (!detail) {
      return fail(
        `dexscreener.meta could not read the narrative feed for "${slug}": the endpoint responded but the payload did not match the expected shape. Retrying will not change it. Check the slug against dexscreener.trending.`,
      );
    }

    const list = buildPairList({
      endpoint: "/metas/meta/v1",
      providerOrder: "unspecified",
      providerPairs: detail.pairs,
      query: parsed.query,
      asOfMs,
    });

    return ok({
      slug: detail.slug,
      name: detail.name,
      description: detail.description,
      // THREE DISTINCT NUMBERS where the provider offered two that could be
      // confused. See `../narrative-list/narrative-pipeline.ts` for the
      // measurements: `marketCap` is exactly the sum of the pairs this endpoint
      // sent, `tokenCount` is exactly how many pairs it sent, and the trending
      // feed reported more than twice as many tokens for the same slug in the
      // same minute.
      narrativeSubsetTokenCount: detail.tokenCount,
      pairsReturned: list.returned,
      subsetMarketCapSumUsd: detail.marketCap,
      // NOT sums of the returned pairs — measured 23,354,089.77 reported against
      // 21,774,508.92 summed. Named as the provider's own aggregate so neither can
      // be mistaken for a total over these rows.
      providerNarrativeLiquidityUsd: detail.liquidity,
      providerNarrativeVolumeUsdH24: detail.volume,
      marketCapChangePct: detail.marketCapChange,
      narrativeSubsetNote: NARRATIVE_SUBSET_NOTE,
      ...list,
    });
  },
};
