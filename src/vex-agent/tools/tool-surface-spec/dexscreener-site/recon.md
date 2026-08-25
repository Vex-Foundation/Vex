# DexScreener website API recon (live, 2026-08-23)

Owner decision (2026-08-23): the current DexScreener tools (public `api.dexscreener.com`,
12 tools) are retired and rebuilt on the website's own endpoints, used "as a browser
user". CoinGecko joins later as a keyed alternative (tool stays visible without a key and
returns a setup instruction). This document is the measured inventory that the rebuild is
planned against. Every number below was measured on 2026-08-23 from one machine; the raw
reports with every probe are in `evidence/`.

Evidence files:

- `evidence/report-screener-level.md` - routes, 19 rankBy keys, every filter family,
  pagination, trending bar, metas, session limits (60 HTTP + 155 WS probes).
- `evidence/report-pair-level.md` - pair page, pair WS, pair-details v4, OHLCV, trades,
  top traders, token insights, search, catalogs (~90 HTTP + 6 WS probes).
- `evidence/report-electron-spike.md` - how the Electron app reaches these endpoints.
- `evidence/dexscreener-schemas.proto.txt` - all 25 protobuf files extracted from the
  site bundle, human readable. `evidence/dexscreener-descriptors.pb` is the same set as a
  serialized `FileDescriptorSet` (decoder input). `evidence/extract-descriptors-from-bundle.py`
  regenerates both from the downloaded bundle (the bundle hash changes with every deploy).
- `evidence/table-chains.json` (74 chains), `evidence/table-metas.json` (18 narratives),
  dumped from `window.__SERVER_DATA`. `evidence/parse-server-data.py` parses that literal.

## 1. Transport: being a browser user

| fact | measurement |
|---|---|
| Cloudflare blocks by TLS/HTTP2 fingerprint, not by JS challenge | plain curl, Node fetch/undici, Python websockets: 403. Chrome-fingerprint client (`curl_cffi impersonate=chrome`): 200 on every host, no challenge, no cookies needed |
| Electron main `net.fetch` (Chromium network service) | `io.dexscreener.com`: 200 with Chrome UA + `Origin: https://dexscreener.com` + `Referer`. `dexscreener.com` SSR HTML: 403 challenge with UA only, **200 with the full Chrome navigation header set** (Accept, Accept-Language, Upgrade-Insecure-Requests, Sec-Fetch-Dest/Mode/Site/User, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform) |
| WebSockets from Electron | main process has no Chromium WebSocket. A hidden sandboxed `BrowserWindow` in an isolated `session.fromPartition` works: local `data:` page + `webRequest.onBeforeSendHeaders` setting `Origin: https://dexscreener.com` on `io.dexscreener.com` requests -> screener WS OPEN, first 100-pair frame (106 KB) in 648 ms. Loading a real site page (`/robots.txt`, 2 requests, 1 MB JS heap) also works. Preferred: local page, no remote code |
| `Origin` header | required on every WS upgrade (403 without). HTTP endpoints echo `access-control-allow-origin: https://dexscreener.com` |
| keepalive | the SCREENER channels send a TEXT frame `"ping"` (~27 s); client must answer `"pong"` (JSON string with quotes). **CORRECTED 2026-08-25 (EP11): `feed/ws` sends NO text ping at all** - none in 60 s across two sessions, so "every WS" was wrong and answering a ping cannot hold that socket open. `feed/ws` sends **0-byte keepalives every ~15 s** (measured at t=16.8 s, 30.6 s, 46.9 s), and frame flags show they are `BINARY` DATA frames of length 0, not protocol PING control frames, so a browser `WebSocket` fires `onmessage` for each one. A frame budget that counts them cannot be met before a 25 s deadline; a zero-length binary frame is a keepalive and must not count toward `binaryFrames` (see the `WsExpectation` contract). `feed/ws` also drops an INACTIVE socket at **~60 s** (60.1 s and 60.5 s), abruptly and with no close frame |
| rate limits | `dexscreener.com` SSR: 30 page loads in ~9 s -> **429, `Retry-After: 40`**, recovers after 45 s; 3 s spacing never tripped. `io.dexscreener.com` HTTP: 14 back-to-back, no limit seen. WS: 155 connects in 25 min, no limit seen |
| cookies | only `__cf_bm` (bot management, 30 min) and `DS-Country`. No auth for anonymous reads |
| content-type lies | on `io.dexscreener.com` the header says `application/json` for bodies that are protobuf (`/dex/search/*`) or the site's Avro dialect (`/dex/chart/*`, `/dex/log/*`, `/dex/trending/v6`, `/metas/*`). Dispatch decoding by endpoint, never by header |
| encodings | protobuf (schemas in evidence), site Avro dialect (arrays/maps = zigzag count + items, no terminating block; unions = zigzag branch index; "long" written as double), JSON (pair-details v4, dd catalogs), JS literal (`window.__SERVER_DATA` with `BigInt("..")`, `undefined`, `new Date(..)`, `new URL("..")`) |
| error contract | fail-closed for malformed enum/number values (WS upgrade 422, HTTP 400 empty body), **fail-open for unknown filter names (silently dropped), wrong ammId (200, empty), wrong-case Solana ids (200, empty), wrong quote token (200, inverted series)**. Connect-RPC is the only endpoint with a structured error (`400 {"code":"invalid_argument"}`) |

## 2. Screener (pages `/`, `/{chain}`, `/{chain}/{dex}`, `/new-pairs`, `/gainers`, `/losers`, `/metas/{slug}`)

### 2.1 Channel

```
wss://io.dexscreener.com/dex/screener/v7/pairs/{m5|h1|h6|h24}/{page}?{qs}
qs = qs.stringify({rankBy:{key,order}, filters:{...}}, {encodeValuesOnly:true, strictNullHandling:true, allowEmptyArrays:true})
response frames: dex_screener.PairsChannelMessage = pairs{stats{m5,h1,h6,h24}{txns,volumeUSD}, pairs[<=100], pairsCount} | latestBlock{blockNumber, blockTimestamp}
```

- 100 rows per page, page is 1-based, no page cap (page 531 of 531 returned), past the end an empty
  `pairs` frame (~69 bytes). `pairsCount` is a live estimate (drifts by a few units).
- First frame in 0.6-1.0 s, 42-93 KB for 100 rows (trendingScore rows carry `cmsProfile`, largest).
  While subscribed: full 100-row snapshot every ~3.2 s (no deltas, ~29 KB/s) plus a `latestBlock`
  frame every ~1 s. Tool shape: connect, take the first `pairs` frame, close.
- SSR fallback: `GET https://dexscreener.com/{route}?{aliases}` returns page 1 in
  `window.__SERVER_DATA.route.data.dexScreenerData` (1.3-1.7 MB, 0.5-1.3 s, 429 after 30 loads in 9 s).
  Same data; use only if the WS bridge is unavailable.

### 2.2 Path timeframe semantics (measured, solana, rankBy volume)

| segment | pairsCount | meaning |
|---|---|---|
| m5 | 2 513 | only pairs active in the last 5 min; `txns/buys/sells/volume` rank by the m5 metric |
| h1 | 13 001 | same for 1 h |
| h6 | 28 472 | same for 6 h |
| h24 | 53 088 | same for 24 h |

`filters[includePairsInactiveInTimeframe]=true` lifts the activity gate (m5 -> 53 088).
`priceChange*`, `trendingScore*`, `liquidity`, `marketCap`, `pairAge`, `launchpadProgress`,
`activeBoosts` name their own window and ignore the path segment.

### 2.3 rankBy keys (19), `rankBy[order]=asc|desc`

| key | status |
|---|---|
| `txns`, `buys`, `sells`, `volume` | OK, metric of the path timeframe |
| `priceChangeM5`, `priceChangeH1`, `priceChangeH6`, `priceChangeH24` | OK, percent; unfiltered top rows are junk (+7e12 %), always pair with quality filters |
| `trendingScoreM5`, `trendingScoreH1`, `trendingScoreH6`, `trendingScoreH24` | OK, opaque score, identical order to the trending bar |
| `liquidity`, `marketCap`, `activeBoosts`, `launchpadProgress` | OK |
| `pairAge` | OK with `asc` (newest first); `desc` puts null-`pairCreatedAt` rows first |
| `fdv` | **server defect: returns the `txns` ordering (100/100 identical). Do not expose. Use `marketCap`** |
| `moonshotProgress` | accepted, 0 rows everywhere |
| omitted | defaults to `txns desc` |
| invalid key/order | WS upgrade refused with HTTP 422 |

### 2.4 Filters: working (measured on solana, baseline pairsCount ~53 085)

| filter (qs form) | unit | proof |
|---|---|---|
| `filters[chainIds][N]=slug` | chain slug, OR | solana+bsc+base -> 140 063; unknown slug -> pairsCount 0 |
| `filters[dexIds][N]=slug` | dex slug, OR | raydium 14 967; meteora+orca 19 207 |
| `filters[excludedDexIds][N]=slug` / `filters[excludedDexIds][]=` | dex slug | see the launchpad trap in 2.6 |
| `filters[liquidity][min|max]` | USD | min 100 000 -> 5 010; max 1 000 -> 19 838 |
| `filters[marketCap][min|max]` | USD | min 1e9 -> 1 803 |
| `filters[fdv][min|max]` | USD | max 10 000 -> 25 229 (filter works, sort does not) |
| `filters[pairAge][min|max]` | **hours**, fractional | max 1 -> 236 (ages 0.67 h); min 2 & max 3 -> 212 |
| `filters[volume][m5|h1|h6|h24][min|max]` | USD | h24 min 1e6 -> 473; m5 min 1 000 -> 273 |
| `filters[txns][tf][min|max]` | count | h1 min 100 -> 648 |
| `filters[buys][tf][min|max]` | count | h24 min 1 000 -> 2 222 |
| `filters[sells][tf][min|max]` | count | h24 min 1 000 -> 1 881; m5 max 0 -> 51 213 |
| `filters[priceChange][tf][min|max]` | percent | h6 min 50 -> 1 218; h24 max -50 -> 2 495 |
| `filters[enhancedTokenInfo]=true|false` | bool, "has token profile" | 28 080 / 25 014, exact partition |
| `filters[activeBoosts][min|max]` | boost count | min 1 -> 110 |
| `filters[recentPurchasedImpressions][min]=1` | paid ad slot (site alias `ads=1`) | 12 |
| `filters[currentPurchasedImpressions][min]=1` | currently running ad | 5 |
| `filters[labels][N]=v3|CLMM|DLMM|...` | case-insensitive | CLMM+raydium 4 800; v3 on base 2 021 |
| `filters[baseTokenSuffixes][N]=pump|bonk` | mint address suffix | pump 20 852; bonk 1 595 |
| `filters[metaIds][N]=<meta ID>` | **ID from /metas/v1/all, not slug**, OR | ai 243; cat 417; both 660; slug `ai` -> 0 |
| `filters[launchpadIds][N]=pumpfun|launchlab|fourmeme` | launchpad origin, **graduates only** | pumpfun 17 398 (all `dexId=pumpswap`) |
| `filters[launchpadProgress][min|max]` | percent 0-100 | max 50 -> 47 171 (with empty excludedDexIds); min 100 -> 22 031 |
| `filters[includePairsInactiveInTimeframe]=true` | bool | m5 2 522 -> 53 088 |

Minimum filters also require the field to be present (`liquidity.min=-5` drops null-liquidity rows).

### 2.5 Filters accepted and silently ignored (dead on this surface)

`isHoneyPot`, `isHoneypot`, `isRenounced`, `isOpenSource`, `isFlagged`, `buyTax`, `sellTax`,
`holderCount`, `lpHolderCount`, `tokenSnifferScore` (tested on bsc, ethereum, solana: pairsCount
unchanged), `categories`, `circulatingSupply`, `pairCreator`, `moonshotPairCreator`,
`moonshotProgress`, `moonshotMigrationDexIds`, `baseTokens`, and any unknown key. A Vex tool must
whitelist filter names locally and must not advertise audit/tax/holder screening.

### 2.6 Launchpad trap and launchpad boards

The server applies a hidden default exclusion of bonding-curve launchpad dexes. Sending
`filters[excludedDexIds]` at all, even empty, replaces that default:

```
solana                                   53 094
solana + filters[excludedDexIds][]=     102 676   (+93 %)
solana + dexIds=pumpfun                        0   (default exclusion wins)
solana + dexIds=pumpfun + excludedDexIds[]=  47 470
```

- Pre-graduation board: `chainIds=[chain] & excludedDexIds[]= & dexIds=[launchpad] & launchpadProgress.max=99.99`,
  ranked by `launchpadProgress` / `priceChangeM5` / `volume` / `txns` / `pairAge asc`.
- Graduated board: `chainIds=[chain] & launchpadIds=[launchpad] & launchpadProgress.min=100`,
  ranked by `trendingScoreH6` / `pairAge asc` / `marketCap`.
- Live launchpads: solana `pumpfun` (46 489 pre / 17 398 graduated), `launchlab` (317 / 1 286),
  `meteoradbc` (1 684), `bags` (76), bsc `fourmeme` (1 543 / 2 847). `base/virtuals`, `abstract/moonit`: empty.
- Launchpad routes on the site are `/{chain}/{dex}` for: solana/pumpfun, launchlab, meteoradbc, moonit,
  bags; abstract/moonit; bsc/fourmeme, flap; base/virtuals; ton/uranus; any chain/printr.

### 2.7 Site presets (what the UI buttons send)

| page | rankBy | filters |
|---|---|---|
| `/`, `/{chain}`, `/{chain}/{dex}` trending | `trendingScore{M5,H1,H6*,H24}` desc | none |
| same, top volume | `volume` desc | `txns.h24.min=50, liquidity.min=25000, enhancedTokenInfo=true` |
| same, top txns | `txns` desc | `enhancedTokenInfo=true` |
| same, gainers tab | `priceChange{TF}` desc | `txns.h24.min=50, liquidity.min=25000, volume.h24.min=10000, enhancedTokenInfo=true` |
| `/new-pairs` | trending / `pairAge asc` / volume / txns / gainers | `pairAge.max=24, liquidity.min=1000, enhancedTokenInfo=true` (newest: only eti) |
| `/gainers`, `/losers` | `priceChange{TF}` desc / asc | `txns.h24.min=300, sells.h24.min=30, volume.h24.min=100000, liquidity.min=250000, enhancedTokenInfo=true` |
| `/metas/{slug}` | `trendingScore{TF}` desc | `metaIds=[id]` (+ `chainIds`) |

URL aliases accepted by every screener route (SSR): `rankBy, order, chainIds, dexIds, minLiq/maxLiq,
minMarketCap/maxMarketCap, minFdv/maxFdv, minAge/maxAge, min{24H|6H|1H|5M}{Txns|Buys|Sells|Vol|Chg}
(+max*), ads=1, boosted=1, profile=1, launchpads=1 (= excludedDexIds[]), minLaunchpadProgress/
maxLaunchpadProgress, launchpadIds, labels, baseTokenSuffixes, metaIds`.

### 2.8 Row shape (`dex_screener_schema.Pair`, same on every channel)

`type` (oneof; `typeAMM.a` = **ammId**, plus `launchpad{progress, creator, migrationDEX}`), `chainId`,
`dexId`, `labels[]`, `pairAddress`, `baseToken{address,name,symbol}`, `quoteToken{...}`, `price`
(native, string), `priceUSD` (string), `txns{m5,h1,h6,h24}{buys,sells}`, `buyers/sellers/makers
{m5,h1,h6,h24}`, `volume/volumeBuy/volumeSell{h1,h6,h24[,m5]}` (USD), `priceChange{m5,h1,h6,h24}`
(percent), `liquidity{usd,base,quote}`, `marketCap`, `fdv`, `pairCreatedAt`, `cmsProfile{headerId,
iconId, description, links[{label,url,type}]}`, `isBoostable`, `boosts{active}`,
`isDEXFeedStreamEnabled`. **CORRECTED 2026-08-25 (EP9/EP10): "No token decimals" is true of the
SCREENER, PAIR and CHART channels and false of the surface as a whole** - `pair-details/v4` carries
`qi.tokenDetails.tokenDecimals` (measured populated: HEX 8, FLOKI 9, USDC 6, and on every captured
document with a QuickIntel block). It is not reachable from the bars or trades channels, which is
why `volumeToken0`/`volumeToken1` stay unprojected there, but it is not absent from the provider.
uint64 fields arrive as strings in JSON form.

### 2.9 Vocabularies

- chains: 74 slugs in `evidence/table-chains.json` (`slug, name, nativeChainId, architecture,
  blockExplorer templates, wrappedNativeToken, dexes[], integrations{goPlus,...},
  features.metas`). Robinhood = `robinhood` (4663, 18 dexes), Monad `monad` (143), Berachain
  `berachain` (80094), Solana `solana` (16 dexes).
- dexes: 602 entries in `__SERVER_DATA.dexes` / `GET https://dd.dexscreener.com/ds-data/dexes`
  (372 KB JSON, `name, slug, defaultURL, defaultSwapURL, deployments[{chain{id}, labels[]}]`).
- labels: `v1 v2 v3 v4 v5 v2.1 v2.2 v0 V0.5 V1.5 CLMM CPMM DLMM dlmm DYN DYN2 OMNI CLAMM stbl tri two wp`.
- metas: 18 `{id, slug, name}` in `evidence/table-metas.json` (ai = `B0vdapRmSrv73SufLMKZ`, cat = `oNGRXzDv836MmCfAAhLw`, ...).
- metas are enabled on 4 chains only: solana, bsc, base, ethereum.

## 3. Trending bar (top 30 per chain per timeframe)

| transport | URL | result |
|---|---|---|
| protobuf (recommended) | `GET https://io.dexscreener.com/dex/trending/dex_trending.PublicService/GetTrendingPairs?connect=v1&encoding=proto&base64=1&message={urlsafe-b64 GetTrendingPairsRequest{chainId, timeframeKey}}` | 200, 9.2 KB, 40 ms, 30 `dex_trending.Pair` (`chainId, pairId, boosts, baseToken, tokenIconId, createdAt, priceChange{m5,h1,h6,h24}, volume{...}, marketCap, fdv, liquidity`) |
| Avro | `GET https://io.dexscreener.com/dex/trending/v6?chainId={chain}&timeframeKey={m5|h1|h6|h24}` | 200, 14-18 KB, 30 rows with `cmsProfile`; edge-cached ~30 s |

Order is identical to the screener `rankBy=trendingScore{TF}` (verified m5/h1/h6/h24, solana and
robinhood). Omitting `chainId` returns the solana-dominated global list.

## 4. Narratives (`/metas`)

| URL | result |
|---|---|
| `GET https://io.dexscreener.com/metas/v1/all` | 18 metas `{id, slug, name, description, icon, alternativeSlugs}` (Avro, max-age 30) |
| `GET https://io.dexscreener.com/metas/v1/trending?chainId={chain}` | same 18 + `marketCap, liquidity, volume, tokenCount, marketCapChange{m5,h1,h6,h24} (percent), marketCapDelta{...} (USD)`; `chainId` honoured, `limit` ignored |
| `GET https://io.dexscreener.com/metas/v1/by-slug?slug=ai` | one meta |
| screener `filters[metaIds][0]={id}` | the narrative's pairs, any rankBy/filters |
| public API `/metas/trending/v1`, `/metas/meta/v1/{slug}` | still available (no chain aggregates) |

## 5. Pair page (`/{chain}/{pairId}` or `/{chain}/{tokenAddress}`)

### 5.1 Resolve and live quote

| what | URL | result |
|---|---|---|
| SSR (cold start, also token -> best pair resolver) | `GET https://dexscreener.com/{chain}/{pairIdOrTokenAddress}` | 900 KB, 0.8-1.2 s; `route.data = {pair, pairDetails (full 5.2 payload), trendingPairs[30] (chain-scoped)}`; any id case accepted |
| live pair WS | `wss://io.dexscreener.com/dex/screener/v7/pair/{chain}/{pairId lowercase}` | `dex_screener.PairChannelMessage`, full Pair ~1 KB every ~3.2 s even if unchanged |
| site search | `GET https://io.dexscreener.com/dex/search/v12/pairs?q={q}[&chainId={chain}][&ms=true]` -> `dex_search.SearchPairsResponse` | exact token address -> every pair of that token (3 rows); symbol/name -> 30-row cap (same as public API) but **`chainId` (singular) is honoured server-side**: `q=PEPE&chainId=solana` -> 30 solana rows, verified for solana, robinhood, base and for a name query (`cat`); the public API ignores chain entirely. Not in the bundle (the site never sends it). No `page`, `offset`, `limit`, `dexId`, `chainIds` (all ignored). Rows are full Pair objects incl. boosts/cmsProfile |
| spotlight | `GET https://io.dexscreener.com/dex/search/spotlight/v10` -> `dex_search.SpotlightResponse` | `boosts.top[30]`, `boosts.recent[30]`, `latestProfiles[36]` |

### 5.2 Pair details (audits, holders, locks, supply): plain JSON

`GET https://io.dexscreener.com/dex/pair-details/v4/{chain}/{pairId}[?inverted=1]` (whole path
lowercased; token address accepted in the pair slot; `inverted=1` switches to the quote token).
6-15 KB, 0.2 s, `cache-control: public, max-age=60` (0.02 s on hit).

| key | source | content | seen on |
|---|---|---|---|
| `gp` | GoPlus | 38 fields: `isHoneypot, buyTax, sellTax, isMintable, isProxy, isOpenSource, isBlacklisted, transferPausable, hiddenOwner, ownerAddress, ownerPercent, creatorAddress, creatorPercent, holderCount, holders[10]{address,balance,percent,isLocked,isContract,tag}, lpHolderCount, lpHolders[], dex[]{name,liquidity,pair}, trustList, otherPotentialRisks, note` | robinhood, ethereum, bsc, base (21 GoPlus chains) |
| `qi` | QuickIntel | `isScam, contractVerified, tokenDetails{owner, supply, createdDate}, tokenDynamicDetails{isHoneypot, buyTax, sellTax, transferTax, lpBurnedPercent}, quickiAudit{contractRenounced, hiddenOwner, canMint, canBurn, canBlacklist, canPauseTrading, canUpdateFees, hasScams, suspiciousFunctions[], externalFunctions[] (verbatim Solidity), ...28 flags}` | EVM chains |
| `holders` | DexScreener | `{count, totalSupply, holders[]{id, label, balance, percentage, tag}}` | solana |
| `ta` | chain authority | `{solana{isMintable, isFreezable, bridgeMintOnly, mintableReason}}` | solana |
| `ll` | liquidity locks | `{totalPercentage, locks[]{tag, address, amount, percentage, url}}` | solana, bsc, base |
| `su` | supply | `{circulatingSupply, totalSupply}` | ethereum, base |
| `cg` | CoinGecko | `id, url, description, supplies, websites, social, categories` | ethereum |
| `cmc` | CoinMarketCap | `id, name, description, tags, urls{...}, dateLaunched, contractAddresses[], selfReported*` | base |
| `cms` | DexScreener profile | `name, symbol, description, links[], icon, header, claims[], metaIds[], nsfw` | all |
| `hpi`, `ti`, `lpHolders` | honeypot.is, token info, LP holders | schema known, null in all 8 samples | - |
| `ts` | TokenSniffer | always null (client hard-maps it to null) | - |

EVM chains get audits but no `holders`; Solana gets `holders` + `ta` + `ll` but no `gp`/`qi`. A
tool must present "no audit data" as unknown, never as clean.

### 5.3 OHLCV

| transport | URL / command | notes |
|---|---|---|
| HTTP, site Avro | `GET https://io.dexscreener.com/dex/chart/amm/v3/{ammId}/bars/{chain}/{pairId}?res={RES}&cb={countBack}&q={quoteTokenAddress}[&uo=0][&i=1][&bbn=beforeBlock][&abn=afterBlock][&mc=1&cs=circSupply]` | RES: `1S 15S 30S 1 3 5 15 30 60 120 240 480 720` (daily+ -> 400); cap **999 bars per call**; page back with `bbn = bars[0].minBlockNumber`; `i=1` inverts; **CORRECTED 2026-08-25 (EP10): `mc=1` does NOT need `cs`** - `mc=1` alone returns the provider-computed market cap and it matched the WS `BAR_TYPE_MARKET_CAP` series EXACTLY on completed bars; `cs` is a supply OVERRIDE (`mc=1&cs=1000000000` returns price x 1e9 exactly) and is a NAMED OMISSION rather than an exposed parameter; `abn` re-measured DEAD (byte-identical window to baseline); an invalid identity (wrong `ammId`, chain slug or `pairId`) answers **200 with a byte-identical empty page**, indistinguishable from a genuine end of history; record `{timestamp(ms), open, openUsd, high, highUsd, low, lowUsd, close, closeUsd, volumeUsd, minBlockNumber, maxBlockNumber}` (strings); last close matched the public API price exactly |
| feed WS, protobuf | `wss://io.dexscreener.com/feed/ws` `WSCommand.getHistoricalBars{cid, limit, chainId, pairId, ammId, resolution(BarResolution S1..MO1), type(PRICE|MARKET_CAP), quoteTokenId, beforeBlockNumber}` -> `WSMessage.historicalBars{bars[]}` | only source of `D1 D3 W1 MO1`; market-cap bars without supply; adds `volumeToken0/volumeToken1`; **CORRECTED 2026-08-25 (EP11): "limit 2000 accepted" is misleading - the true cap is 999.** `limit` 999, 1000, 1500, 2000, 2001, 5000 and 100000 all answer `WS_COMMAND_CODE_OK` with exactly 999 bars, byte-identical (sha `fc1ba90a`, 271,844 B): anything above 999 is accepted and SILENTLY CLAMPED. `limit=0` returns 0 bars; **`limit=-1` TEARS THE SOCKET DOWN with no answer at all** (4 of 4 attempts across two spaced sessions), which is what makes the client-side `limit >= 1` guard load-bearing rather than cosmetic. `cid` omitted (0) is never answered. `cancel` suppresses an answer SILENTLY and never yields `WS_COMMAND_CODE_CANCELED`. The socket MULTIPLEXES and REORDERS answers (20 concurrent cids answered out of send order), so dispatch is on `cid` and never on frame position |

**ammId is `pair.type.value.a`, never `dexId`.** Measured: solana raydium/orca/meteora(DLMM) ->
`solamm`, meteora DYN2 -> `meteora`, pumpswap -> `pumpfundex`, pumpfun -> `pumpfun`; uniswap
v2/v3 and sushiswap v3 and aerodrome -> `uniswap` (aerodrome sometimes `velov2`); pancakeswap
v3 -> `pcsv3`; robinhood uniswap v4 -> `uniswapv4`. Wrong ammId -> 200 with 0 bars. Solana pair
id and `q` are case-sensitive here; wrong `q` -> silently inverted series.

### 5.4 Trades and traders

| what | URL / command | notes |
|---|---|---|
| trade history (recommended) | `GET https://io.dexscreener.com/feed/rpc/dex_feed.PublicService/GetTransactions?connect=v1&encoding=proto&base64=1&message={urlsafe-b64 GetTransactionsRequest}` -> `GetTransactionsResponse` (`application/proto`) | 100 per page; request fields `chainId, ammId, pairId, invert, quoteTokenAddress, beforeBlockNumber, afterBlockNumber, timestampStart/End, type ("buy"/"sell"/... lowercase, case-sensitive), maker, volumeUSDMin/Max, amount0Min/Max, amount1Min/Max`; structured 400 on invalid input |
| trade history (WS) | `feed/ws` `getHistoricalTransactions{cid, chainId, ammId, pairId, quoteTokenId, type enum, volumeUSD/amount ranges, timestampStart/End, maker, before/after{blockNumber, transactionIndex, eventIndex}}` | same rows, 100 per page, exclusive paging; bad ids -> `code OK, 0 rows` |
| row shape | `Transaction{swap{type BUY/SELL, priceNative, priceUSD, volumeUSD} | joinExit{ADD/REMOVE}, blockNumber, blockTimestamp, id (tx hash), transactionIndex, eventIndex, traderId, amount0, amount1, traderScreener{buys, sells, volumeUSDBuy, volumeUSDSell, volumeBuy, volumeSell, balanceAmount, balancePercentage, isNew, firstSwap}}` | per-trade wallet profile on every row |
| live trade push | `feed/ws` `subscribeTransactions{params{chainId, ammId, pairId, quoteTokenId}}` | acknowledged, then **no frames** in 60 s on a 35-trades/min pair; gated by `isDEXFeedStreamEnabled`, which was `false` on all top-100 volume pairs of solana, ethereum and base. Not usable; poll GetTransactions instead |
| top traders | `GET https://io.dexscreener.com/dex/log/amm/v5/{ammId}/top/{chain}/{pairId}?q={quote}&s={bought|sold|pnl|unrealized}&sd={asc|desc}[&mda={maxDaysAgo}][&k=1][&lpId={launchpadId}]` (site Avro) | exactly 100 `TopMaker{maker, label, url, buys, sells, volumeUsdBuy, volumeUsdSell, amountBuy, amountSell, balanceAmount, balancePercentage, firstSwap, lastSwap}`; `s` and `sd` required |
| token insight (AI news blurb) | `feed/ws` `getTokenInsight{cid, chainId, tokenId}` -> `TokenInsight{title, content, createdAt, token{...}, pair{volumeH24, priceChangeH24, marketCap, createdAt}}` | partial coverage (`NOT_FOUND` on PEPE); `subscribeTokenInsights` pushes a 1.37 MB global frame, unusable |
| reactions | `GET https://io.dexscreener.com/hype/reactions/dexPair/{chain}:{pairId}` | `{reactions{poop, fire, rocket, triangular_flag_on_post}{total}}`, 133 bytes |

### 5.5 Token-grouped screener (low confidence)

`wss://io.dexscreener.com/dex/screener/v2/tokens/{tf}/{page}?{same qs}` -> `TokensChannelMessage`:
one row per base token with `marketCap`/`fdv`, but `pairsCount` is the page size (no total) and
the `rankBy=volume` order did not reproduce. Do not build on it without a dedicated test.

## 6. Catalogs (`dd.dexscreener.com`)

| URL | result |
|---|---|
| `GET https://dd.dexscreener.com/ds-data/v2/chains/by-trending` | 74 chains JSON (same as `__SERVER_DATA.chains`), max-age 10 |
| `GET https://dd.dexscreener.com/ds-data/dexes` | 602 dexes JSON with swap deeplink templates |
| `GET https://dd.dexscreener.com/ds-data/v4/tokens/latest` | 36 newest CMS-profiled tokens (site Avro) |
| `/ds-data/v2/private/*` | need `fullAccessToken`, not public |

## 7. Capability map for the rebuilt tools

| capability | backing |
|---|---|
| trending per chain per window (5m/1h/6h/24h), any depth | screener WS `rankBy=trendingScore{TF}` + `chainIds`; top-30 via Connect `GetTrendingPairs` |
| top by volume / txns / buys / sells per window | path timeframe + rankBy |
| gainers / losers per window with quality floor | `rankBy=priceChange{TF}` + `txns/sells/volume/liquidity` mins + `enhancedTokenInfo` |
| new pairs with age / liquidity floor | `rankBy=pairAge asc` + `pairAge.max` (hours) + `liquidity.min` |
| boosted / ads / profile-only | `activeBoosts.min`, `recentPurchasedImpressions.min`, `enhancedTokenInfo` |
| launchpad boards (pre-graduation, graduated) | section 2.6 |
| dex-, label-, suffix-, narrative-scoped lists | `dexIds`, `labels`, `baseTokenSuffixes`, `metaIds` |
| narrative aggregates | `/metas/v1/trending?chainId=` |
| text search by symbol/name, chain-scoped (top 30 by relevance) | search v12 `q` + `chainId`; there is no text filter on the screener channel |
| token -> pairs, pair details, audits, holders, locks, supply | SSR pair page, search v12 by address, pair-details v4 |
| OHLCV (1 s to 12 h HTTP, daily+ via feed WS), market-cap candles | section 5.3 |
| trade history with filters and per-trade wallet profile | Connect `GetTransactions` |
| top traders by bought / sold / pnl / unrealized | `/dex/log/amm/v5/.../top` |
| live quote for a watched pair | pair WS, ~1 KB / 3.2 s |
| crowd sentiment, AI blurb | reactions, token insight (optional colour only) |
| NOT available | audit/tax/holder screening filters, `fdv` sort, live trade push (`subscribeTransactions` acknowledges and then sends nothing; re-measured 2026-08-25, and `isDEXFeedStreamEnabled` was false on 500 of 500 live pairs). Token decimals are NOT available on the screener, pair, bars or trades channels; they ARE available on `pair-details/v4` via `qi.tokenDetails.tokenDecimals`. The gapless substitute for the live push is polling `GetTransactions` with `afterBlockNumber` |

## 8. Open items

- `/dex/screener/v8/pairs-search` (subscribe by explicit `{chainId,id}` list) exists; tested only
  negatively (empty result without ids). Potential batch live-quote channel.
- `moonshot*` filters: dead or simply no live data; `base/virtuals` and `abstract/moonit` empty.
- Long WS sessions (reconnect policy, idle timeout) beyond 31 s untested; bundle reconnects at 5 s.
- `hpi`, `ti`, `lpHolders` never observed non-null.
- The bundle hash (currently `pages_catch-all.C1WgEscV.js`, build 3338) changes with deploys;
  protobuf descriptors must be re-extracted and diffed as a contract test.
