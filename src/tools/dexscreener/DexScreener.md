# DexScreener lane

**Last updated: 2026-08-25 (S8).**

This directory holds TWO surfaces that no longer overlap. Read the split first;
almost every stale assumption about this lane comes from conflating them.

| Surface | Files | Who calls it |
|---|---|---|
| **Site surface** (current) | `transport.ts`, `site-errors.ts`, `sanitize.ts`, `codec/`, `endpoints/`, `screen-core/` | Every one of the 18 agent tools in `src/vex-agent/tools/protocols/dexscreener/` |
| **Public-API remnant** (retired as a tool backend) | `client.ts`, `types.ts`, `throttle.ts`, `errors.ts`, `validation.ts`, `validation/` | No agent tool. Three client methods survive as an internal price and pool source. |

`token-watch-price.ts` and `token-watch-price/` sit on the remnant side: they
derive the one canonical USD price of a watched token from the pool list
`/token-pairs/v1` returns.

There is no `src/commands/dexscreener` CLI, and there is no DexScreener
WebSocket client on the remnant side.

---

## The site surface

The agent tools do not talk to `api.dexscreener.com`. They talk to the two
hosts the website itself uses:

- `io.dexscreener.com` - screener and pair channels (WebSocket), search,
  spotlight, narratives, bars, trades, Connect-RPC endpoints;
- `dd.dexscreener.com` - the chains catalog and the dexes catalog.

### Transport seam (`transport.ts`)

Both hosts sit behind Cloudflare, which blocks on the TLS and HTTP/2
fingerprint: Node `fetch`, `undici` and every Node WebSocket client get 403.
The site surface is therefore reachable only through the desktop bridge, which
drives a real browser context. A headless caller reaches the default public-API
transport and gets a typed `SITE_TRANSPORT_UNAVAILABLE` naming the remedy,
which is the honest answer rather than an empty result. Never "fix" a site
endpoint by pointing it at Node `fetch`.

Every response carries its headers lowercased. Pass them to
`readCacheObservation` (`screen-core/envelope.ts`): the edge's
`cf-cache-status` and `age` are the only evidence of how stale an answer is,
and a hardcoded `"not_cached"` was measured asserting freshness for documents
Cloudflare had held for up to 25 seconds. `"not_cached"` is correct ONLY for a
WebSocket channel, where no cache sits between a frame and its socket.

### Codecs (`codec/`)

The site speaks three wire formats and lies about all of them in
`content-type`, which is usually `application/json`:

- **protobuf** over Connect-RPC and over the WebSocket channels, decoded
  through a captured descriptor set with a NAME ALLOWLIST (`protobuf.ts`); a
  message not on the list is refused by name.
- **DexScreener's own Avro dialect** (`dsavro.ts` plus the schema tables in
  `dsavro-schemas.ts`) for `/metas/v1/*`, `/dex/trending/v6`, bars and
  top-makers. Field ORDER is the schema; a table that drifts fails the decode
  loudly rather than mis-projecting.
- **plain JSON** for the `dd.dexscreener.com` catalogs.

### Endpoints and their owners (`endpoints/`)

| Module | Provider surface |
|---|---|
| `screener.ts`, `tokens-screener.ts` | the screener WebSocket channel: every board tool (trending, top, gainers, losers, new, launchpad) and `tokens_screen` |
| `pair-live.ts`, `pair-subject.ts`, `pair-details.ts` | one pair: live snapshot, subject resolution, the audit and safety document |
| `pairs-batch.ts` | the v8 batch channel for watchlists |
| `search.ts` | `/dex/search/v12/pairs` |
| `bars.ts`, `trades.ts`, `top-traders.ts` | candles, trade history, per-trader aggregates |
| `spotlight.ts` | boosts and the newest token profiles |
| `metas.ts` | narratives: `/metas/v1/all` (the catalog) and `/metas/v1/trending` |
| `chains-catalog.ts` | the 74-chain vocabulary, behind a 24 hour TTL |

`screen-core/` is shared by every module that projects a
`dex_screener_schema.Pair`: request building, field groups, row projection,
the response envelope and its source observation.

### Two provider facts that keep being re-learned

- **`features.metas.isEnabled` is a website visibility label, not a data
  gate.** It is true on solana, bsc, base and ethereum only, and the
  narratives endpoint still serves real aggregates elsewhere (measured
  2026-08-25: robinhood 7 narratives led by cat at $253.8 M over 15 tokens, ton
  3, polygon 1). A chain with no narrative activity answers HTTP 200 with an
  empty array: that is a QUIET chain, reported as "0 of 18 active", never a
  refusal.
- **Explorer placeholder NAMES do not identify their slots.** Substitute by the
  FIELD the template came from. Measured: `holdersURL` wants a token address on
  the 21 chains that spell it `{{txns}}`, `taiko.holdersURL` spells the same
  slot `{{token}}`, `beam.assetURL` spells a token slot `{{address}}`, and
  `oasissapphire.txnsURL` spells a TRANSACTION HASH slot `{{address}}`.

---

## The public-API remnant

`client.ts` still wraps 13 REST methods of `api.dexscreener.com` behind
`throttle.ts` (per-process token buckets, 300/min fast and 60/min slow, TTL
cache, in-flight dedupe, `Retry-After` honouring). None of them backs an agent
tool any more. Three are live production dependencies of code OUTSIDE the tool
surface:

| Method | Surviving caller |
|---|---|
| `getTokenPairs` | wake token-price watches and the poller, through `token-watch-price.ts`; the own-token banner |
| `getTokens` | `src/tools/evm-chains/balances.ts`, uniswap swap quote safety |
| `getPairs` | uniswap swap quote safety |

The other ten (`search`, `getProfiles`, `getProfilesRecentUpdates`,
`getBoosts`, `getTopBoosts`, `getCommunityTakeovers`, `getMetasTrending`,
`getMeta`, `getAds`, `getOrders`) have no production caller left, and neither
do the `validateWs*` parsers or `validation/metas.ts`. They are a known
dead-code pass, deliberately not folded into the site-surface work.

Useful remnant facts that are still true and still cost money when forgotten:
`priceChange.*` is ALREADY a percentage, `pairCreatedAt` and
`paymentTimestampMs` are milliseconds, and DexScreener computes
`FDV = (total supply - burned supply) * price` with market cap equal to FDV
unless the token reports a circulating supply.

---

## Named omissions

Under the provider-depth decree every unconsumed provider surface is declared
with a measured reason.

- **`/dex/trending/v6` and Connect `dex_trending.GetTrendingPairs`** are not
  consumed. The screener's `trendingScore{TF}` board reproduces their order
  exactly (re-verified 4/4 boards, 30/30 rows, 2026-08-25) and every trending
  field is a strict subset of the screener row, including `tokenIconId`
  (identical on 30/30). They are capped at 30 rows with no pagination, are edge
  cached about 30 seconds, and were measured disagreeing with each other on
  marketCap and priceChange. Their DECODERS are kept on purpose (`TRENDING_V6`,
  the two `dex_trending.*` allowlist names) as the independent oracle for the
  homepage-ordering claim the trending tool makes and cannot verify from its
  own board. Both halves have a committed fixture and a decode test; the
  removal condition is written at `TRENDING_PAIR` in `dsavro-schemas.ts`.
- **`/ds-data/dexes`** is not consumed. It is the only MACHINE source of the
  dex label vocabulary (25 values including the uppercase variants V1/V2/V3,
  which `recon.md`'s hand-written list of 22 omits), plus dex display names and
  swap-deeplink templates. The `labels` parameter teaches that vocabulary by
  example and matches case-insensitively, so nothing false is claimed today;
  wiring this catalog in would turn `labels` into a validated closed set.
- **`/ds-data/v4/tokens/latest`** is not consumed, and the assumption that
  spotlight's `latestProfiles` covers it is FALSE: measured within 8 minutes of
  each other, both feeds carried exactly 36 rows and their (chain, address)
  sets were DISJOINT, with the ds-data feed lagging about 7 hours. It is
  omitted on freshness, not on redundancy.
- **`/ds-data/v2/chains/by-txns`** is a public, differently ranked view of the
  same 74 chains. No tool has an ordering contract, so it buys nothing.
- **`/metas/v1/by-slug`** is not consumed: its record is a strict subset of
  `/metas/v1/all`, which is fetched whole. It answers an unknown or empty slug
  with HTTP 500 and an empty body.

`chains/by-trending` ordering carries no meaning. The rank is live and drifts:
two reads nine minutes apart showed 20+ adjacent transpositions in the tail,
and each chain's own `dexes[]` churned inside two minutes. Membership is stable
at 74; order is not, and a 24 hour cached copy can hand out a day-old one.

---

## Verification discipline

Rule 10 governs this lane: when the endpoint is reachable, the endpoint is the
specification. Fixtures are real captured bytes under
`src/__tests__/dexscreener-site/fixtures/`, each with a `.provenance.json`
naming the endpoint, request, capture time and sha256; the loader re-hashes on
every read, so an edited fixture fails loudly. Every optional field a
projection reads must be present in at least one fixture, and every declared
response variant needs one that exercises it (which is why the quiet-chain
one-byte narratives body and the metasEnabled-false robinhood body are both
committed).

Wire names, enum members and field spellings come from the checked-in
descriptor and schema artifacts, never from convention. Tests live in
`src/__tests__/dexscreener-site/`; the older `src/__tests__/dexscreener/`
protects what is left of the public-API remnant.

**If you change a file in this directory, update this document in the same
change.**
