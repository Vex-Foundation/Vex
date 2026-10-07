# DexScreener lane

**Last updated: 2026-10-07 (feed socket moved to the `util_envelope` protocol).**

This directory holds TWO surfaces that no longer overlap. Read the split first;
almost every stale assumption about this lane comes from conflating them.

| Surface | Files | Who calls it |
|---|---|---|
| **Site surface** (current) | `transport.ts`, `site-errors.ts`, `sanitize.ts`, `codec/`, `endpoints/`, `screen-core/` | Every one of the 18 agent tools in `src/vex-agent/tools/protocols/dexscreener/` |
| **Public-API seam** (non-agent consumers) | `price-read.ts`, `candles-read.ts`, `types.ts`, `throttle.ts`, `errors.ts`, `validation/` | No agent tool. The wake price-watch poller, the `$VEX` banner, Uniswap quote safety, EVM balance valuation, and the desktop market widget. |

`token-watch-price.ts` and `token-watch-price/` sit on the public-API side:
they derive the one canonical USD price of a watched token from the pool list
`/token-pairs/v1` returns.

There is no `src/commands/dexscreener` CLI, and there is no DexScreener
WebSocket client on the public-API side.

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
  message not on the list is refused by name. Encoding has its own allowlist
  (`encode.ts`). The feed socket wraps its protobuf in the `util_envelope`
  request/response envelope (`feed-envelope.ts`, next section).
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
| `bars.ts`, `trades.ts`, `top-traders.ts` | candles (HTTP chart, or the feed socket's `GetHistoricalBars` for 5s and daily-and-above), trade history (Connect, or the feed socket's `GetHistoricalTransactions` for `swap`/`liquidity` and every cursor page), per-trader aggregates |
| `spotlight.ts` | boosts and the newest token profiles |
| `metas.ts` | narratives: `/metas/v1/all` (the catalog) and `/metas/v1/trending` |
| `chains-catalog.ts` | the 74-chain vocabulary, behind a 24 hour TTL |

`screen-core/` is shared by every module that projects a
`dex_screener_schema.Pair`: request building, field groups, row projection,
the response envelope and its source observation.

### The feed socket (`wss://io.dexscreener.com/feed/ws`)

The site's 2026-10 deploy replaced the socket's protocol. The old
`dex_feed.WSCommand` / `dex_feed.WSMessage` pair (and `TransactionsParams`,
`TokenInsightsParams`) is gone from the bundle and old commands go
UNANSWERED, which is how daily/5s candles, socket-served trades and the token
insight all became timeouts at once. The replacement, reversed from the
captured bundle (`assets/entries/pages_catch-all.DvxFsOuQ.js`, the `Oht`
envelope client and the `spt` dex-feed client) and measured live on
2026-10-07:

- **Socket.** ``new WebSocket(new URL(`${DS_DEX_FEED_PUBLIC_URL}/feed/ws`))``,
  binary frames, with `DS_DEX_FEED_PUBLIC_URL = https://io.dexscreener.com`
  and `DS_DEX_FEED_WS_ENCODE_JSON = false` in the served config (a
  `?encoding=json` variant exists and is unused).
- **Request.** One frame `util_envelope.ClientEnvelope{id, request{method,
  payload, trace}}`. `method` is `/${service}/${Method}`, here
  `/dex_feed.PublicWSService/GetHistoricalBars`, `.../GetHistoricalTransactions`
  and `.../GetTokenInsight`; `payload` is the request message's protobuf bytes;
  `trace` is OpenTelemetry propagation and optional (we send none). The site
  numbers `id` per socket from 1; we use one process-wide counter
  (`nextFeedRequestId`) so bars, trades and insight can never share an id.
- **Answer.** One frame `util_envelope.ServerEnvelope{id, response{status,
  payload}}` with the same id. Only `STATUS_OK` carries a payload (the
  method's `...Response` message). The site client rejects every other
  status, except that `GetTokenInsight` maps `STATUS_NOT_FOUND` to "no
  insight". We map `STATUS_TIMEOUT` / `STATUS_INTERNAL` to the transient
  codes (`BARS_PROVIDER_TRANSIENT`; trades say "one retry") and every other
  status to `BARS_INVALID` / `TRADES_INVALID`; no answer for the id is
  `BARS_NO_RESULT_FRAME` / `TRADES_NO_RESULT_FRAME`.
- **Streams** (not consumed): `subscribe{method, payload}` is answered by
  `stream_message` (full payload), `stream_delta` (a fossil-delta patch on the
  previous payload, with a checksum) and `stream_end{status}`; `unsubscribe{}`
  and `cancel{}` close one by id.
- **Keepalive.** The client sends nothing; it reconnects when no frame
  arrived for 60 s (checked every 5 s). The server sends zero-length binary
  frames (one measured at 15.4 s on an idle socket), which the transport
  contract already drops. An unparseable frame is ignored (no answer, socket
  stays open).

Measured answers (fixtures `feed-envelope-*`): D1 bars 16,688 bytes (60 bars)
and market-cap D1 bars with no supply argument; 100-row trades pages for
`TYPE_BUY_OR_SELL`, and the exact `before` triple continues strictly below
the previous page; an UNINDEXED pair answers `STATUS_OK` with an empty payload
for both bars and trades (ambiguous, as on HTTP); insight `STATUS_OK` (1,189
bytes), `STATUS_NOT_FOUND` (6 bytes; also for a lower-cased Solana `tokenId`
and for `Solana` instead of `solana`) and `STATUS_INVALID_ARGUMENT` for an
empty chainId/tokenId (the old protocol said INTERNAL there). The site also
validates ids client-side before sending (protovalidate): chain and AMM ids
must match `^[A-Za-z0-9-]+$`, pair, token and quote ids `^[0-9A-Za-z-_:.$]+$`.

**Never send a negative bars `limit`.** `limit: -1` closed the socket (1006,
no answer) and the next two upgrades were refused with HTTP 520 and 503 for
about eight seconds: it appears to take the feed backend down. The floor of 1
in `bars.ts` is the guard; the diagnostics no longer probe it.

**Connect trade history is now the site's "legacy" read.** The bundle calls
`dex_feed.PublicService/GetTransactions` as `getLegacyTransactions` and drives
its own trade table from the socket. It still answers; watch it on the next
drift report.

To re-verify the protocol after a site deploy, run the descriptor drift gate
against a fresh bundle (`VEX_DEXSCREENER_BUNDLE_DIR=<dir> VEX_DEXSCREENER_DRIFT=1
npx vitest run src/__tests__/dexscreener-site/descriptor-drift.gated.test.ts`);
the `feed-envelope-*` fixtures carry the request and answer bytes of every
measured exchange, with provenance.

### Provider facts that keep being re-learned

- **`activeBoosts` is an amount, not a count.** Purchased packs of
  10/30/50/100/500 add up, so a ceiling under 10 matches nothing, and a row
  with no `boosts` block has zero active boosts.
- **The token channel bounds summed metrics per pool.** It applies liquidity,
  volume, txns, buys and sells bounds to each pool and sums only the pools
  inside the bound, so a token row can exceed a requested maximum; maxima are
  enforced again client-side on the row sum.
- **Ascending order puts missing values first.** Rows without a value for the
  ranked metric lead an `asc` board; pair `asc` with that metric's ceiling to
  exclude them.

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

## The public-API seam

The old 13-method REST client (`client.ts`) was DELETED in S11 at measured zero
consumers, together with `validation.ts` and the `validateWs*` parsers it fed.
What replaced it is one narrow owner per question:

| Module | Reads | Who calls it |
|---|---|---|
| `price-read.ts` | `/token-pairs/v1`, `/latest/dex/pairs`, `/tokens/v1` | wake token-price watches and the poller (through `token-watch-price.ts`), the `$VEX` own-token banner, Uniswap swap quote safety, `src/tools/evm-chains/balances.ts`, the desktop `$VEX` market widget |
| `candles-read.ts` | the site `bars` channel | the desktop market widget's chart, board hydration |

`throttle.ts` survives underneath both (per-process token buckets, 300/min fast
and 60/min slow, TTL cache, in-flight dedupe, `Retry-After` honouring).

TRANSPORT, and the two halves differ on purpose. `price-read.ts` names
`defaultPublicApiTransport` DIRECTLY rather than asking the registry: its three
reads are all on `api.dexscreener.com`, which is ungated, and the registered
transport inside the desktop app is the site bridge, whose allowlist admits
`io.` and `dd.` only - so routing them through the registry threw before the
network in the shipped app while passing headless. `candles-read.ts` reads
`io.dexscreener.com`, which IS gated, so it keeps asking the registry and the
bridge serves it.

The other ten old methods (`search`, `getProfiles`,
`getProfilesRecentUpdates`, `getBoosts`, `getTopBoosts`,
`getCommunityTakeovers`, `getMetasTrending`, `getMeta`, `getAds`, `getOrders`)
went with the client; the agent asks those questions over the site surface.

Useful public-API facts that are still true and still cost money when forgotten:
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

- **The feed socket's streaming RPCs** (`SubscribeTransactions`,
  `SubscribeTokenInsights`, `SubscribeTokenInsightsByToken`,
  `SubscribeLatestBlock`, `SubscribePairs`, `SubscribeAggregatedPairs`) and
  the `stream_delta` patch format are not consumed. A tool answers one
  question and leaves, and each of these questions has a request-response
  channel (the screener and pair channels, the unary trade and insight RPCs).
  `SubscribeTokenInsights` is used only by the diagnostics, to find a token
  that has an insight (98 of 98 on solana, 2026-10-07).
- **`GetHistoricalBarsRequest.beforeTimestampInMs`** (new in 2026-10) is not
  sent: measured ignored on its own (D1, 30 days back, answered the newest
  five bars), and HTTP has no equivalent, so the block cursor stays the one
  both bar transports share.
- **`dex_screener_schema.Pair.Token.hasInsights`** (new in 2026-10) is decoded
  but not projected yet. It would let `pair_get` skip the insight request for
  a token that has none; that routing belongs to the pair projection and the
  `pair_get` handler, not to this directory.
- **Descriptor files left out of the checked-in set**, by name in
  `extract-descriptors-from-bundle.py`: `buf/validate/*`, `cel/expr/*` and
  `dex_feed/validation.proto` (client-side validation machinery, not wire
  messages, and not self-contained without `descriptor.proto`), and
  `dex_users_client/*` plus `dex_web/native_embed.proto` (signed-in chart
  settings and the native app's embed bridge, not network surfaces a tool can
  read). The drift gate needs the checked-in set to be a subset of the
  bundle, so leaving them out is safe.

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
descriptor and schema artifacts, never from convention. The feed socket's RPC
paths are read from the `dex_feed.PublicWSService` descriptor
(`feedMethodPath`), not typed by hand.

Regenerating the descriptors after a site deploy: download the site's `.js`
assets into a directory (the drift test's crawl, or a browser save), run
`python3 -P -E src/vex-agent/tools/tool-surface-spec/dexscreener-site/evidence/extract-descriptors-from-bundle.py <bundle-dir>`
(writes `dexscreener-descriptors.pb` and the readable
`dexscreener-schemas.proto.txt` beside itself), copy the `.pb` to
`codec/dexscreener-descriptors.pb`, run
`node src/tools/dexscreener/codec/generate-descriptors.mjs`, then the drift
gate (`VEX_DEXSCREENER_BUNDLE_DIR=<bundle-dir> VEX_DEXSCREENER_DRIFT=1 npx vitest run src/__tests__/dexscreener-site/descriptor-drift.gated.test.ts`). Tests live in
`src/__tests__/dexscreener-site/`; the older `src/__tests__/dexscreener/`
protects the public-API seam.

**If you change a file in this directory, update this document in the same
change.**
