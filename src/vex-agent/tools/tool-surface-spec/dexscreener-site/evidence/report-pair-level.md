# DexScreener internal website API - PAIR-LEVEL reconnaissance (live, read-only)

Date of measurement: 2026-08-23, ~12:50-13:10 UTC. All calls via `curl_cffi` with Chrome TLS
impersonation and `Origin: https://dexscreener.com`. Plain curl/node/python TLS is blocked by
Cloudflare; Chrome impersonation was never challenged once during ~90 requests and 6 WS sessions.

## 0. Test subjects (resolved live)

| # | chain | pair id (canonical) | dexId | labels | `type.value.a` (ammId) | base | quote |
|---|-------|--------------------|-------|--------|------------------------|------|-------|
| A | solana | `Gyz6RxJfnB3yjP2J2E7HMoNojGQEKZuxEEUjurncQJ1w` | pumpswap | [] | **pumpfundex** | CATLIST `BKaXDgZxUSC9njpX89xpQ5USh2pnK1yzZvgk8Mg7pump` | SOL `So111...112` |
| B | robinhood | `0xe35635d91eccd183aa5925c7a26bdaedef1fa07e312742689cc39afd8f04e121` | uniswap | [v4] | **uniswapv4** | SEMI `0x5F038759F6DE38fD3A85C0440daff1240238BaC8` | MU `0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD` |
| C | ethereum | `0xA43fe16908251ee70EF74718545e4FE6C5cCEc9f` | uniswap | [v2] | **uniswap** | PEPE `0x6982508145454Ce325dDbE47a25d4ec3d2311933` | WETH `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

The owner's lowercased Solana id `gyz6rxjf...` resolves on the public API, on the SSR page, on
pair-details and on the pair WS - but **NOT** on the chart-bars endpoint (see 4.6).

## 1. SSR pair page

**URL template:** `GET https://dexscreener.com/{chainSlug}/{pairIdOrTokenAddress}`

No params. HTML only. Parse `window.__SERVER_DATA = {...}` (a JS literal, not JSON: contains
`BigInt("..")`, `undefined`, `new Date(..)`, `new URL("..")`). A second global,
`window.__DS_ENV = {...}`, is plain JSON and carries the production host map.

### Measured

| target | status | bytes | latency | cache |
|--------|--------|-------|---------|-------|
| `/solana/Gyz6Rx...QJ1w` | 200 | 910,448 | 0.82 s | `cache-control: public, max-age=0, must-revalidate`, `cf-cache-status: DYNAMIC` |
| `/ethereum/0xA43fe...ec9f` | 200 | 906,147 | 1.18 s | same |
| `/robinhood/0xe356...e121` | 200 | 902,414 | 0.78 s | same |
| `/solana/BKaXDg...pump` (TOKEN mint) | 200 | 911,966 | 1.15 s | same |
| `/solana/gyz6rxjf...` (lowercased) | 200 | ~910 KB | ~1 s | same |

### Route shape (identical for all five)

```
route = { id: "pairDetail", platformId: "<chainSlug>", pairAddress: "<echo of URL segment>",
          data: { pair, pairDetails, trendingPairs } }
```

- `route.pairAddress` echoes exactly what you put in the URL (lowercase stays lowercase; a token
  mint stays a token mint). `route.data.pair.pairAddress` is the **canonical** pair id.
- **Token address in the pair slot works**: `/solana/{tokenMint}` returns `route.id="pairDetail"`
  with `pair` = the token's top pair (`Gyz6Rx...QJ1w`), plus that pair's `pairDetails`. There is no
  separate "token view" route and no HTTP redirect. This is a free token-to-best-pair resolver.
- `route.data.pair` = full `dex_screener_schema.Pair` as JSON (same object as the WS in section 2).
- `route.data.pairDetails` = the **complete** pair-details payload of section 3, already embedded.
  One SSR fetch = pair + audits + holders + locks, no second call.
- `route.data.trendingPairs` = 30 `dex_trending.Pair` rows, **chain-scoped to the page's chain**
  (robinhood page returned robinhood trending, solana page returned solana trending). Fields:
  `chainId, pairId, boosts{active}, baseToken{address,name,symbol}, tokenIconId, createdAt,
  priceChange{m5,h1,h6,h24}, marketCap, volume{m5,h1,h6,h24}, fdv, liquidity{usd,base,quote}`.

### Top-level `__SERVER_DATA` keys (all pages)

`isBrandingEnabled, isDsApp, time` (server epoch ms), `random, route, chains` (74 entries),
`dexes` (602 entries), `activePairDetailsAds` (17), `metas` (18), `thresholdedPairDetailsAdIds` (17),
`activePairDetailsAdsRandom, activeTrendingBarAds` (1), `activeTrendingBarAdsRandom,
recentAds` (75), `build{id,hash}`, `helmet`.

`chains[]` carries `slug, name, nativeChainId, shortName, blockExplorer{accountURL, assetURL,
txnsURL, holdersURL}, dexes[], wrappedNativeToken, rpcURL, integrations{coinGecko, goPlus,
tokenSniffer, deBank, ...}, isHidden, order, screeners, indexers`. `dexes[]` carries
`name, slug, defaultURL, defaultSwapURL, deployments[{chain:{id}}], _id`. Both are the same
catalogs `dd.dexscreener.com` serves (section 6) - free with any page load.

`window.__DS_ENV` (production values, verified):

```
DS_DEX_FEED_PUBLIC_URL      https://io.dexscreener.com     DS_DATA_SERVER_PUBLIC_ORIGIN  https://dd.dexscreener.com
DS_DEX_CHART_AMM_HOST       https://io.dexscreener.com     DS_CDN_PUBLIC_ORIGIN          https://cdn.dexscreener.com
DS_DEX_LOG_AMM_HOST         https://io.dexscreener.com     DS_WEB_HYPE_SERVER_HOST       https://io.dexscreener.com
DS_DEX_SCREENER_SEARCH_...  https://io.dexscreener.com     DS_METAS_SERVER_HOST          https://io.dexscreener.com
DS_WEB_DEX_SCREENER_WSS_HOST wss://io.dexscreener.com      DS_BOOSTS_PUBLIC_ORIGIN       https://mp.dexscreener.com
DS_WEB_PAIR_DETAILS_SERVER_HOST https://io.dexscreener.com DS_DEX_FEED_WS_ENCODE_JSON    False
```

**Cost/benefit:** ~910 KB and ~1 s for everything. Good as a one-shot cold-start; bad as a poll.

## 2. Live pair WS

**URL template:** `wss://io.dexscreener.com/dex/screener/v7/pair/{chainId}/{pairId}`
The site lowercases the pair id client-side (`${s.pairId.toLowerCase()}`); both cases work.
No query string, no subscribe command - the server pushes on connect.

Frames: TEXT `"ping"` (answer `"pong"`), plus binary `dex_screener.PairChannelMessage`
(`payload` oneof, only case `pair` observed; `pair.pair` is a `dex_screener_schema.Pair`).

### Measured cadence

| pair | frame size | frames | intervals |
|------|-----------|--------|-----------|
| A solana CATLIST/SOL | 1,131 B constant | 6 in 14.8 s | 0.49, 2.00, 5.19, 8.39, 11.60, 14.80 s -> **~3.2 s** |
| C ethereum PEPE/WETH | 960 B constant | 3 in 6.1 s | 0.52, 2.92, 6.12 s -> **~3.2 s** |

The server re-sends the whole Pair on a fixed ~3.2 s tick **even when nothing changed** (identical
priceUSD/txns on consecutive frames). No delta encoding. Budget ~1 KB per pair per 3.2 s.

### Full `dex_screener_schema.Pair` field inventory (as delivered)

```
type            oneof: typeAMM{a, cgi?, launchpad{progress,creator,migrationDEX,meta[]}}
                     | typeUniswapLegacy{} | typeUniswap{} | typeBalancer{pn} | typeOsmosis{cgi}
chainId         string          dexId          string        labels[]  string[]  (e.g. ["v2"],["v4"],["CLMM"],["DLMM"])
pairAddress     string (canonical case)
baseToken       {address,name,symbol,decimals?,totalSupply?}
quoteToken      {address,name,symbol,decimals?,totalSupply?}
price           string (native, decimal-as-string)     priceUSD  string
txns            {m5,h1,h6,h24}.{buys,sells}            (uint64 as string)
buyers          {m5,h1,h6,h24}  uint64                 sellers {m5,h1,h6,h24}  makers {m5,h1,h6,h24}
volume          {m5,h1,h6,h24}  double USD             volumeBuy {..}  volumeSell {..}
priceChange     {m5,h1,h6,h24}  double percent
liquidity       {usd, base, quote}  double
marketCap       double          fdv  double            pairCreatedAt  google.protobuf.Timestamp
profile         {eti,header,website,twitter,discord,linkCount,imgKey,nsfw}   (legacy; never seen populated)
cmsProfile      {headerId, iconId, description, links[{label?,url,type:LinkType}], nsfw}
isBoostable     bool            boosts {active: uint64}
isDEXFeedStreamEnabled bool
```

Notes:
- `txns/buyers/sellers/makers` are uint64 - JSON-mapped to **strings**, must be parsed as integers.
- Fields are proto3 `optional`; absent means "no data", not zero. On pair C, `volumeBuy.m5` was
  simply absent while `volumeSell.m5` was present.
- `type.value.a` is the **ammId** required by sections 4 and 5, and it is NOT `dexId` (see 9.1).
- `cmsProfile.iconId` / `headerId` -> `https://cdn.dexscreener.com/cms/images/{id}?width=64&height=64&fit=crop&quality=95&format=auto`.
- `isDEXFeedStreamEnabled` was `false` on all three test pairs; see 5.3 for what it gates.

## 3. Pair details HTTP

**URL template:** `GET https://io.dexscreener.com/dex/pair-details/v4/{chainId}/{pairId}[?inverted=1]`

- The site lowercases **the whole path** (`` `/dex/pair-details/v4/${chainId}/${pairId}`.toLowerCase() ``).
  Verified: canonical-case and lowercase Solana ids both return identical bodies.
- `inverted=1` (only when true) switches the subject from base token to **quote** token. Verified on
  pair C: default returns PEPE audits, `?inverted=1` returns WETH audits + a `cg` block for WETH.
- A **token address** in the pairId slot also works and returns that token's details.

### Measured

| call | status | bytes | latency | cache |
|------|--------|-------|---------|-------|
| solana A | 200 | 4,989 | 0.24 s | `cache-control: public, max-age=60`, `cf-cache-status: EXPIRED` -> `HIT` (age 27) on repeat |
| ethereum C | 200 | 10,353 | 0.23 s | max-age=60, MISS -> HIT (0.07 s) |
| robinhood B | 200 | 6,097 | 0.02 s | max-age=60, HIT (age 27) |
| ethereum C `?inverted=1` | 200 | 6,479 | 0.25 s | MISS |
| ethereum token `0x6982...1933` | 200 | 12,007 | 0.23 s | MISS |
| bsc `0x0eD7...4fD0` (CAKE/WBNB) | 200 | 6,530 | 0.20 s | MISS |
| base `0xd0b5...F224` (WETH/USDC v3) | 200 | 15,398 | 0.22 s | MISS |

`content-type: application/json; charset=utf-8`, `access-control-allow-origin: https://dexscreener.com`,
`vary: Origin, Accept-Encoding`.

### Key inventory (13 keys, always present, mostly nullable)

| key | source | shape | seen non-null on |
|-----|--------|-------|------------------|
| `gp` | GoPlus | 38 fields | ethereum, robinhood, bsc, base |
| `cg` | CoinGecko | 10 fields | ethereum (token query + inverted WETH) |
| `ts` | (TokenSniffer, dead) | **always null** - the client hard-maps it: `ts: h.unknown().transform(()=>null)` | never |
| `cmc` | CoinMarketCap | 15 fields | base |
| `qi` | QuickIntel | 7 fields incl. 28-field `quickiAudit` | ethereum, robinhood, bsc, base |
| `hpi` | honeypot.is | `{isHoneypot?, isOpenSource?, isProxy?, buyTax?, sellTax?, holderCount?}` | never in 8 samples |
| `ti` | DS CMS "token info" (superset of `cms`) | full CMS token record | never in 8 samples |
| `cms` | DS token profile | 10-13 fields | all 8 samples |
| `ll` | liquidity locks | `{totalPercentage, locks[{tag,address,amount,percentage,url?}]}` | solana, bsc, base |
| `holders` | token holders | `{count, totalSupply, holders[{id,label?,balance,percentage,tag?}]}` | **solana only** |
| `lpHolders` | LP holders, same shape | never in 8 samples (EVM LP holders arrive inside `gp.lpHolders`) |
| `su` | supply | `{circulatingSupply, totalSupply?}` | ethereum, base |
| `ta` | chain token authority | `{solana?:{isMintable, bridgeMintOnly?, isFreezable, mintableReason?:"bridged"\|"elastic-supply"}}` | **solana only** |

### Per-chain nullability observed

| pair | non-null keys |
|------|---------------|
| solana A (pumpswap) | `cms, ll, holders, ta` |
| robinhood B (uni v4) | `gp, qi, cms` |
| ethereum C (uni v2) | `gp, qi, cms, su` (+ `cg` when queried by token address) |
| bsc CAKE/WBNB | `gp, qi, ll` |
| base WETH/USDC | `gp, cmc, cms, qi, ll, su` |

So: **EVM chains get contract audits (`gp`,`qi`) but no `holders`; Solana gets `holders`+`ta`+`ll`
but no `gp`/`qi`.** An agent must not present "no audit" as "clean".

### Complete sub-object fields (from the site's own zod schema, so including never-seen fields)

**`gp` (GoPlus):** `dataStatus:"complete"|"partial", isInDex, isOpenSource, isProxy, isTrueToken?,
buyTax?(string|null), canTakeBackOwnership?, cannotSellAll?, creatorAddress?, creatorBalance?,
creatorPercent?, dex?[{name,liquidity,pair}], externalCall?, holderCount?,
holders?[{address,isLocked,isContract,balance,percent,tag?}], isAntiWhale?, antiWhaleModifiable?,
isBlacklisted?, isHoneypot?, isMintable, isWhitelisted?, lpHolderCount?, lpTotalSupply?,
lpHolders?[same], ownerAddress?, ownerBalance?, ownerChangeBalance?, ownerPercent?, hiddenOwner?,
sellTax?(string|null), slippageModifiable?, totalSupply?, transferPausable, tradingCooldown?,
tokenName?, tokenSymbol?, trustList?, otherPotentialRisks?, note?, updatedAt?`
Live PEPE sample: `holderCount 580,992`, `lpHolderCount 71`, top-10 `holders` and `lpHolders`,
`dex[]` 26 venues with per-venue liquidity, `isBlacklisted true`, `transferPausable true`.

**`qi` (QuickIntel):** `isScam?, contractVerified?, chainId, tokenAddress, updatedAt`,
`tokenDetails{tokenName,tokenSymbol,tokenDecimals,tokenOwner?,tokenSupply,tokenCreatedDate?,
quickiTokenHash{exactQHash,similarQHash}}`,
`tokenDynamicDetails{lastUpdatedTimestamp,isHoneypot,buyTax?,sellTax?,transferTax?,lpPair?,lpSupply?,
lpBurnedPercent?,priceImpact?,problem?,extra?,tokenSupplyBurned?}`,
`quickiAudit{contractCreator?,contractOwner?,contractName,contractChain,contractAddress,
contractRenounced,hiddenOwner,isProxy,hasExternalContractRisk?,hasObfuscatedAddressRisk?,canMint,
cantMintRenounced?,canBurn,canBlacklist,cantBlacklistRenounced,canMultiBlacklist,canWhitelist,
cantWhitelistRenounced?,canUpdateFees,cantUpdateFeesRenounced?,canUpdateMaxWallet,
cantUpdateMaxWalletRenounced?,canUpdateMaxTx,cantUpdateMaxTxRenounced?,canPauseTrading,
cantPauseTradingRenounced,hasTradingCooldown,canUpdateWallets,hasSuspiciousFunctions,
hasExternalFunctions,hasFeeWarning?,hasModifiedTransferWarning,modifiedTransferFunctions?[],
suspiciousFunctions?[],externalFunctions?[],auditFunctions?[],hasScams,matchedScams?,scamFunctions?[],
contractLinks[],functions[],onlyOwnerFunctions?[],multiBlacklistFunctions?[],
hasGeneralVulnerabilities?,generalVulnerabilities?[]}`
Robinhood SEMI sample returned the **verbatim Solidity source** of two external functions
(`setMinter`, `mint`) - concrete, showable risk evidence.

**`cg` (CoinGecko):** `id, url, description?, maxSupply?, totalSupply?, circulatingSupply?,
websites[], social[], imageUrl?, categories?[]`

**`cmc` (CoinMarketCap):** `id, name, symbol, description, logo, tags?[],
urls{website?,twitter?,message_board?,chat?,facebook?,explorer?,reddit?,technicalDoc?,sourceCode?,
announcement?}, dateLaunched?, contractAddresses[{chainId,tokenAddress}], selfReportedCirculatingSupply?,
selfReportedMarketCap?, selfReportedTags?[], infiniteSupply?, updatedAt`

**`cms`:** `chainId, name, symbol, address, pairAddresses[], description?, links[{label,url}],
icon{id}, header{id}, createdAt, updatedAt, claims[], metaIds[], nsfw?`

Saved bodies: `pair-details-solana.json`, `pair-details-ethereum.json`, `pair-details-robinhood.json`.

## 4. Chart bars (OHLCV) - AVRO-like binary

**URL template:**
```
GET https://io.dexscreener.com/dex/chart/amm/v3/{ammId}/bars/{chainId}/{pairId}
    ?res={RES}&cb={countBack}&q={quoteTokenAddress}
    [&uo=0] [&i=1] [&bbn={beforeBlockNumber}] [&abn={afterBlockNumber}] [&mc=1&cs={circulatingSupply}]
```

### Params

| param | type | required | allowed / effect |
|-------|------|----------|------------------|
| `{ammId}` | path | yes | `pair.type.value.a`, lowercased by the site; server also accepts uppercase. **A wrong ammId returns HTTP 200 with an empty bar list, never an error.** |
| `{pairId}` | path | yes | **case-sensitive on Solana**: lowercase -> 200 with 0 bars |
| `res` | string | yes | verified OK: `1S, 15S, 30S, 1, 3, 5, 15, 30, 60, 120, 240, 480, 720`. Verified **400**: `5S, 1D, 3D, 1W, 1M, 2D, 2, 1d`. Daily and above only exist on the feed WS (5.2). |
| `cb` | int | yes | count back. **Server cap = 999 bars** (`cb=1000/5000/20000/100000` all returned 999). `cb=0` -> 0 bars (8-byte body). `cb=abc` -> 400. |
| `q` | address | **yes** (400 without) | the quote token address. **Case-sensitive on Solana**, and a non-matching value silently produces an INVERTED series instead of an error (see 4.6). |
| `uo` | `0` | no | "usdOnly off". No observable difference on pair C (446 B both ways, identical USD fields). |
| `i` | `1` | no | invert. Pair C -> WETH/PEPE: `close=600356154.8118` native, `closeUsd=2426.41` (= WETH price). |
| `bbn` | uint | no | page backwards; **exclusive** of that block |
| `abn` | uint | no | page forwards; **exclusive** |
| `mc` | `1` | no | market-cap candles. **`mc=1` alone -> HTTP 500. `cs` is mandatory with it.** |
| `cs` | number | with `mc=1` | circulating supply. Pair C with `cs=413772355232943`: `closeUsd=1672310818.30` = PEPE market cap, matching `pair.marketCap` exactly. |

### Response encoding

`content-type: application/json` is a **lie** - the body is binary in DexScreener's own avsc-like
codec (not standard Avro OCF: no header, no schema, arrays are `zigzagLong(count)` + items with no
terminating block, unions are `zigzagLong(branchIndex)` + branch, and what the schema calls a
"long" is written by `writeDouble`). Exact schema, lifted from `js/pages_catch-all.C1WgEscV.js`
around offset 839,316 (`VQe` / `UQe`):

```
BarsResponse = record { schemaVersion: string, bars: union[null, array<Bar>] }
Bar = record {
  timestamp:      double  (epoch ms)
  open:           string      openUsd:  union[null,string]
  high:           string      highUsd:  union[null,string]
  low:            string      lowUsd:   union[null,string]
  close:          string      closeUsd: union[null,string]
  volumeUsd:      union[null,string]
  minBlockNumber: double      maxBlockNumber: double
}
```
`schemaVersion` observed: `"1.0.0"`. Working decoder written: `pl_avro.py` (+ `bars.py`, `bars3.py`);
every response decoded with `consumed == len(body)`, so the schema is exact.

### Measured

| call | status | bytes | latency | bars | span |
|------|--------|-------|---------|------|------|
| A, res=5, cb=50 | 200 | 5,978 | 0.27 s | 50 | 08:45 -> 12:50 UTC |
| C, res=60, cb=1000 | 200 | 145,539 | 0.96 s | **999** | 2026-07-12 19:00 -> 08-23 12:00 |
| C, res=1, cb=20000 | 200 | 144,627 | 1.25 s | **999** | 2026-08-22 06:32 -> 08-23 12:53 |
| C, res=60, cb=1000, bbn=25518506 | 200 | 145,311 | 1.88 s | 999 | 2026-05-31 20:00 -> 07-12 18:00 |
| C, res=1, cb=1000, abn=25808911 | 200 | 144,628 | 0.31 s | 999 | forward page, minBlk 25808912 |
| C, res=60, cb=3 | 200 | 446 | 0.40 s | 3 | |
| B, res=60, cb=3 (`uniswapv4`) | 200 | 347 | 0.23 s | 3 | |

**Paging backwards:** take `bars[0].minBlockNumber` of the current page and pass it as `bbn`. The
next page ends one block earlier - verified: page 1 min block 25518506, page 2 covers 05-31 -> 07-12.

Sample rows (pair A, res=5):
```
2026-08-23T12:45:00Z o=0.000009926 h=0.00001009 l=0.000009464 c=0.000009555 cUsd=0.0009037 volUsd=15366.85 blk=441160393
2026-08-23T12:50:00Z o=0.000009555 h=0.000009701 l=0.000009313 c=0.000009674 cUsd=0.0009150 volUsd=7048.29  blk=441161207
```

### 4.6 Cross-check against the public API (same instant)

| pair | bars last `close` / `closeUsd` | public `/latest/dex/pairs` `priceNative` / `priceUsd` |
|------|-------------------------------|------------------------------------------------------|
| C ethereum | `0.000000001665` / `0.000004041` | `0.000000001665` / `0.000004041` - **exact** |
| B robinhood | `0.00002062` / `0.02005` | `0.00002062` / `0.02005` - **exact** |

**Two silent-wrong-answer traps (both verified live, both return HTTP 200):**
1. Wrong `ammId` -> `bars: []` (8-byte body). `uniswapv2`, `uniswapv3`, `uniswapv4`, `raydium`, `zzzz`
   on pair C all returned 0 bars; only `uniswap` (and `UNISWAP`) returned data.
2. Wrong-case or wrong `q` -> a silently INVERTED series. Pair A with
   `q=so11111...` (lowercased) returned `close=102854.5788` (CATLIST per SOL) instead of
   `0.0000094` - and pair C with `q=0x0000...0000` returned exactly the `i=1` inverted series.
   An agent that trusts `q` blindly will report a price off by ~10^10.

## 5. Trades feed - WS and Connect-RPC

**WS:** `wss://io.dexscreener.com/feed/ws`, binary in `dex_feed.WSCommand`, binary out
`dex_feed.WSMessage`. Server sends TEXT `"ping"` (answer `"pong"`) and **zero-length binary
keepalives roughly every 14-16 s**. No handshake or auth needed; commands can be pipelined
immediately after open.

### 5.1 `getHistoricalTransactions` -> `historicalTransactions`

Request fields: `cid(uint32), chainId, ammId, pairId, quoteTokenId, type(enum
UNSPECIFIED|BUY|SELL|BUY_OR_SELL|ADD|REMOVE|ADD_OR_REMOVE), volumeUSDMin/Max, amount0Min/Max,
amount1Min/Max (string-wrapped decimals), timestampStart/End (Timestamp), maker(string),
before/after (TransactionIdentity{blockNumber, transactionIndex, eventIndex})`.

Measured on pair A:

| call | resp bytes | latency | n |
|------|-----------|---------|---|
| type=BUY_OR_SELL | 28,481 | 0.35 s | **100** |
| type=SELL, volumeUSDMin="500" | 28,770 | 0.38 s | 100 (all SELL, all > $500) |
| maker="CQuR26Ax...4cnw" | 20,135 | 0.50 s | 71 (that wallet's full history on the pair) |
| type=ADD_OR_REMOVE | 6 | 0.16 s | 0 (no join/exit events surfaced for this pumpswap pair) |
| before={441162492,23,7} | 28,316 | 0.46 s | 100, newest block 441162491 - **exact, exclusive paging** |
| pairId="NOPE" | 6 | 0.20 s | 0, `code = WS_COMMAND_CODE_OK` - **bad ids fail silently** |

**Page size is a hard 100.** Page backwards by taking the oldest row's
`{blockNumber, transactionIndex, eventIndex}` into `before`.

Full `Transaction` shape (all 24 leaf fields present on 100/100 rows):
```
swap { type: TYPE_BUY|TYPE_SELL, priceNative, priceUSD, volumeUSD,
       metadata[{key,value}],                    <- absent on all sampled pairs
       latest{ marketCapNative, marketCapUSD } } <- absent on all sampled pairs
joinExit { type: TYPE_ADD|TYPE_REMOVE }          <- alternative to swap in the oneof
blockNumber (uint64 as string), blockTimestamp (Timestamp), id (txn hash/signature),
transactionIndex (uint32), eventIndex (uint32), traderId (wallet), amount0, amount1
traderScreener { buys, sells, volumeUSDBuy, volumeUSDSell, volumeBuy, volumeSell,
                 balanceAmount, balancePercentage (float), isNew (bool), firstSwap (Timestamp) }
```
Real row:
```json
{"swap":{"type":"TYPE_BUY","priceUSD":"0.0009274","volumeUSD":"5.14","priceNative":"0.000009804"},
 "blockNumber":"441162736","blockTimestamp":"2026-08-23T12:59:19Z","id":"DkDm6tY8...78pCQ",
 "transactionIndex":91,"eventIndex":10,"traderId":"CQuR26Axdts52mtcDjSQc1fLSSTS28cHKHFwoHpf4cnw",
 "traderScreener":{"buys":"43","sells":"24","volumeUSDBuy":"162.47","volumeUSDSell":"155.32",
   "volumeBuy":"168166.47","volumeSell":"159749.82","balanceAmount":"8416.64",
   "balancePercentage":5.0049,"isNew":false,"firstSwap":"2026-08-23T03:56:40Z"},
 "amount0":"5545.86","amount1":"0.05437"}
```
`traderScreener` on **every** trade is the highest-value thing here: for each counterparty you get
their lifetime buys/sells on this pair, USD in/out, current balance and % of supply, whether they
are new, and when they first traded. That is per-trade wallet profiling for free.

### 5.2 `getHistoricalBars` -> `historicalBars`

Request: `cid, limit(int32), chainId, pairId, ammId, resolution(BarResolution enum), type(BarType),
quoteTokenId, beforeBlockNumber(uint64)`.

| call | bytes | n | note |
|------|-------|---|------|
| res=D1(15), limit=5 | 267 | 1 | pair is 10 h old |
| res=MO1(18), limit=3 | 267 | 1 | **monthly works here, 400 on the HTTP endpoint** |
| res=W1(17), limit=3 | 267 | 1 | weekly likewise |
| res=H1(10), limit=500 | 3,035 | 12 | all available |
| res=M5(7), limit=2000 | 30,264 | 122 | all available; limit=2000 accepted, no cap hit |
| res=M5(7), limit=50, beforeBlockNumber=441120971 | 12,316 | 50 | ends 08:40, i.e. before that block |
| res=H1(10), **type=BAR_TYPE_MARKET_CAP(2)**, limit=3 | 782 | 3 | `closeUSD = 909475.88` = market cap, **no `cs` param needed** |

Bar fields here are the richer protobuf `dex_feed.Bar`: `timestamp, openNative, openUSD, highNative,
highUSD, lowNative, lowUSD, closeNative, closeUSD, volumeToken0, volumeToken1, volumeUSD,
minBlockNumber, maxBlockNumber`. Compared with section 4 the WS adds `volumeToken0/volumeToken1`,
adds D1/D3/W1/MO1, and gives market-cap bars without a supply argument. `BarResolution` enum:
`S1=1,S5=2,S15=3,S30=4,M1=5,M3=6,M5=7,M15=8,M30=9,H1=10,H2=11,H4=12,H8=13,H12=14,D1=15,D3=16,W1=17,MO1=18`.
`BarType`: `PRICE=1, MARKET_CAP=2`.

### 5.3 `subscribeTransactions` -> live `transactions`

Params: `{chainId, ammId, pairId, quoteTokenId}`. The server acknowledges immediately with a
`transactions` frame echoing the params and `transactions: []` (115 B), then **nothing**.
Held open 60 s on pair A (49,224 buys / 26,214 sells in 24 h, i.e. ~35 trades/minute) - **zero live
trade frames**, only 0-byte keepalives. Both sampled pairs have `isDEXFeedStreamEnabled: false`, and
the site's own code only wires this stream when that flag is true (or when `?dex-feed-stream=1` /
`window.NEW_FEED_ENABLED` forces it). **Working conclusion: live push is gated per pair by
`isDEXFeedStreamEnabled`.** Not proven for a pair where the flag is true - I did not find one in this
session. For an agent, poll `getHistoricalTransactions` / the Connect GET instead.

### 5.4 `getTokenInsight` / `subscribeTokenInsights` -> AI-written token news

`getTokenInsight{cid, chainId, tokenId}`. On CATLIST (solana): 1,127 B,
`code = WS_COMMAND_CODE_OK`, and the payload is a **generated news article**:

> title: "CATLIST Rockets 1000% in Explosive Solana Pump"
> content: "CATLIST surged over 1000% in the past hour on Solana, drawing intense short-term trading
> interest with roughly $760,000 in volume against limited liquidity near $66,000. The token, launched
> via pump.fun, fits the classic micro-cap meme pattern where thin liquidity amplifies rapid price
> swings as buyers pile in. ..."

On PEPE/ethereum: `code = WS_COMMAND_CODE_NOT_FOUND` - coverage is partial and appears to target
freshly-trending small caps.

`TokenInsight` fields: `tokenId, chainId, title, content, createdAt,
token{name,symbol,iconId,headerId}, pair{volumeH24, priceChangeH24, marketCap, createdAt}`.

`subscribeTokenInsights{params:{}}` (no filter fields at all) immediately pushed a **1,365,620-byte**
frame containing the whole global insight feed. Bandwidth-hostile; there is no per-token
subscription. Use `getTokenInsight` for a specific token.

### 5.5 Connect-RPC unary GET (stateless HTTP alternative) - **works**

```
GET https://io.dexscreener.com/feed/rpc/dex_feed.PublicService/GetTransactions
    ?connect=v1&encoding=proto&base64=1&message={urlsafe-base64(GetTransactionsRequest), '=' stripped}
```
-> `200`, `content-type: application/proto`, body = `dex_feed.GetTransactionsResponse`,
`access-control-allow-origin: https://dexscreener.com`, `cf-cache-status: MISS`.

`GetTransactionsRequest` exposes a **superset** of the WS command:
`chainId, ammId, pairId, invert(bool), quoteTokenAddress, beforeBlockNumber, afterBlockNumber,
timestampStart, timestampEnd, type(StringValue - lowercase strings, NOT the enum), maker,
volumeUSDMin/Max, amount0Min/Max, amount1Min/Max`.

| call | status | bytes | latency | n | result |
|------|--------|-------|---------|---|--------|
| baseline | 200 | 28,424 | 0.29 s | 100 | |
| `type="sell"` | 200 | 28,330 | 0.27 s | 100 | all TYPE_SELL |
| `type="SELL"` | **400** | - | 0.17 s | - | `{"code":"invalid_argument"}` (`application/json`) - **type is case-sensitive lowercase** |
| `type="buy"`, `volumeUSDMin="1000"` | 200 | 604 | 0.21 s | 2 | |
| `beforeBlockNumber=441162492` | 200 | 28,428 | 0.24 s | 100 | newest 441162491 (exclusive) |
| `afterBlockNumber=441163401` | 200 | 11,048 | 0.28 s | 39 | newest 441163477 (exclusive) |
| `invert=true` | 200 | 25,790 | 0.26 s | 100 | |
| `amount0Min="100000"` | 200 | 28,464 | 0.25 s | 100 | |
| `timestampStart/End` = 04:00-05:00Z | 200 | 27,700 | 0.23 s | 100 | window respected |

Same 100-row page cap, same `Transaction` shape including `traderScreener`. **For an agent this is
strictly better than the WS**: stateless, cancellable, cacheable, one request per page, and it has
`invert`, `afterBlockNumber` and timestamp windows that the WS command does not expose.

## 6. `dd.dexscreener.com` - catalogs, not pair data

Paths found in the bundle (all under `DS_DATA_SERVER_PUBLIC_ORIGIN`):

| path | encoding | status | bytes | latency | cache | content |
|------|----------|--------|-------|---------|-------|---------|
| `/ds-data/v2/chains/by-trending` | JSON | 200 | 63,214 | 0.28 s | `public, max-age=10`, REVALIDATED | array of **74** chains: `slug, nativeChainId, name, blockExplorer{accountURL,assetURL,txnsURL,holdersURL}, rpcURL, shortName, dexes[], wrappedNativeToken, integrations{coinGecko,goPlus,tokenSniffer,deBank,...}`, ordered by trending |
| `/ds-data/dexes` | JSON | 200 | 372,542 | 0.19 s | `public, max-age=10`, REVALIDATED | array of **602** DEXes: `name, slug, defaultURL, defaultSwapURL` (with `{{baseTokenAddress}}` placeholder), `deployments[{chain:{id}}], _id` |
| `/ds-data/v4/tokens/latest` | Avro (site codec) | 200 | 9,379 | 0.24 s | `public, max-age=10`, MISS | `{tokens: array<Token>}`, 36 rows; Token = `id, chain{id}, address, name?, symbol?, description?, websites?[], socials?[{type,url}], createdAt?, profile?{header,website,twitter,discord,linkCount,imgKey,nsfw}` - the newest CMS-profiled tokens |
| `/ds-data/ads/active/v5` | Avro | not probed | | | | active ads (also mirrored in SSR `activePairDetailsAds`) |
| `/ds-data/ads/trending-bar/next-time-interval?duration=&chainId=` | Avro | not probed | | | | ad slot scheduling |
| `/ds-data/v2/private/chains/by-txns`, `/ds-data/private/dexes` | JSON | - | | | | require `?fullAccessToken=` - **not public** |

`access-control-allow-origin: https://dexscreener.com` on all. **Nothing pair-level, no holders, no
audits.** The chains and dexes catalogs are the useful part (explorer URL templates, swap-deeplink
templates, per-chain integration availability) and are also free in every SSR page load.

Related, on `io.dexscreener.com` (same avro codec, GET): `/metas/v1/all`, `/metas/v1/trending?chainId=&limit=`,
`/metas/v1/by-slug?slug=` - narrative/meta tags, also mirrored as SSR `metas` (18 rows).

## 7. Tokens channel WS

**URL template:** `wss://io.dexscreener.com/dex/screener/v2/tokens/{timeframe}/{page}?{qs}`
where `{timeframe}` in `m5|h1|h6|h24`, `{page}` is 1-based, and `{qs}` is the same
`qs.stringify(..., {encodeValuesOnly:true, strictNullHandling:true, allowEmptyArrays:true})`
bracket notation as `/dex/screener/v7/pairs/{timeframe}/{page}`.

Message: `dex_screener.TokensChannelMessage`, payload oneof `pairs{stats,pairs[],pairsCount}` |
`latestBlock{blockNumber, blockTimestamp}`. Byte-for-byte the same shape as `PairsChannelMessage`.

Measured, identical query `rankBy[key]=volume&rankBy[order]=desc&filters[chainIds][0]=solana`,
timeframe h24, page 1:

| channel | first payload | latency | rows | `pairsCount` | unique base tokens | row extras |
|---------|--------------|---------|------|--------------|--------------------|------------|
| `/dex/screener/v2/tokens/h24/1` | 92,318 B | 1.00 s | 100 | **100** | **100 / 100** | has `marketCap`, `fdv`, `pairCreatedAt`; **no `labels`** |
| `/dex/screener/v7/pairs/h24/1` | 52,777 B | 0.76 s | 100 | **53,065** | 92 / 100 | has `labels`; no `marketCap`/`fdv` in this sample |

**What it is:** one row per **base token** (deduplicated - the pairs channel returned TRUTH/SOL twice,
the tokens channel never repeats a base token address), carrying that token's representative pair
plus token-level `marketCap`/`fdv`. `pairsCount` is the page size (100), not a total, so the tokens
channel gives no result-set cardinality.

**Caveat (honest gap):** with `rankBy[key]=volume&rankBy[order]=desc` the tokens channel returned rows
whose visible `volume.h24` was **not** monotonically decreasing (CATE $82 M, CYBERLEEK $34 M,
PUMP $180 M, CATLIST $4.6 M, neko $0.5 M) while the pairs channel on the same query was strictly
sorted. The order matched the SSR `trendingPairs` order instead. Either the channel ranks on a
token-level aggregate not present in the row, or it ignored my `rankBy`. **Ranking semantics of
`/dex/screener/v2/tokens` are unverified** - do not build agent behaviour on them without a
dedicated test.

## 8. Site search and spotlight

**8.1** `GET https://io.dexscreener.com/dex/search/v12/pairs?q={q}[&ms=true]`
Only two params exist in the bundle: `q`, and `ms=true` which is the **moonshot** filter
(`filters?.moonshot && searchParams.append("ms","true")`). Response: protobuf
`dex_search.SearchPairsResponse{ pairs: repeated dex_screener_schema.Pair }`.
`content-type: application/json` (again a lie - it is protobuf), `cache-control: no-store`.

| query | status | bytes | latency | rows |
|-------|--------|-------|---------|------|
| `BKaXDgZxUSC9njpX89xpQ5USh2pnK1yzZvgk8Mg7pump` (exact token address) | 200 | 3,022 | 0.22 s | **3** - every pair of that token (pumpswap $85 k liq, raydium $0, pumpfun $0) |
| `SOL&ms=true` (symbol) | 200 | 15,553 | 0.40 s | **30** (hard cap) across arbitrum/base/bsc/polygon/solana |
| `PEPE` (symbol) | 200 | 21,282 | 0.34 s | **30**, same rows and same count as public `/latest/dex/search` |

So: **exact address -> complete pair list for that token; symbol -> 30-row cap.** Rows are full
`Pair` objects (same inventory as section 2, incl. `boosts`, `cmsProfile`, `isDEXFeedStreamEnabled`),
which the public `/latest/dex/search` does not give you.

**8.2** `GET https://io.dexscreener.com/dex/search/spotlight/v10` -> `dex_search.SpotlightResponse`.
200, 24,555 B, 0.02 s (`cf-cache-status: HIT`), `cache-control: no-store`.
- `boosts.top`: **30** rows `{chainId, tokenAddress, tokenSymbol, totalAmount, tokenImageURL}`
- `boosts.recent`: **30** rows, same plus `amount` (the individual boost just purchased; duplicates
  appear when one token is boosted repeatedly)
- `latestProfiles`: **36** rows `{token: dexscreener_cms.PartialToken{id, chainId, address,
  description?, links[{label?,type,url}], name?, symbol?, createdAt, nsfw, icon{id}, header{id}},
  boosts?{legacyActive, active}}`

## 9. Cross-endpoint facts

### 9.1 ammId is NOT dexId - measured mapping (from 300 live rows)

| chain | dexId | labels | `type.value.a` (ammId) |
|-------|-------|--------|------------------------|
| solana | raydium | -, CLMM, CPMM | `solamm` |
| solana | orca | wp | `solamm` |
| solana | meteora | DLMM | `solamm` |
| solana | meteora | DYN2 | `meteora` |
| solana | pumpswap | - | `pumpfundex` |
| solana | pumpfun | - | `pumpfun` |
| solana | metadao | - | `metadao` |
| ethereum / base / polygon | uniswap | v2, v3 | `uniswap` |
| arbitrum / polygon | sushiswap | v3 | `uniswap` |
| base | aerodrome | - | `uniswap` or `velov2` |
| bsc / base | pancakeswap | v3 | `pcsv3` |
| robinhood | uniswap | v4 | `uniswapv4` |

The brief's guesses (`raydium`, `raydiumclmm`, `pumpswap`, `uniswapv2`, `uniswapv3`, `orca`) are all
**wrong as ammIds** and all return silent empty results. An agent must always read
`pair.type.value.a` from the SSR page, the pair WS, or search - never construct it.

### 9.2 Case sensitivity

| endpoint | pairId | quote token (`q`) |
|----------|--------|-------------------|
| SSR page | normalized (any case OK) | n/a |
| pair-details v4 | whole path lowercased by client, server normalizes | n/a |
| pair WS v7 | lowercased by client, either case OK | n/a |
| `/dex/chart/amm/v3` bars | **case-sensitive** (Solana lowercase -> 0 bars) | **case-sensitive**, wrong value -> silently inverted |
| feed WS / Connect RPC | canonical case used; unknown id -> `code OK, n=0` | canonical case used |
| `/dex/log/amm/v5` top | canonical case used | required |

### 9.3 Caching and CORS

| endpoint | `cache-control` | typical `cf-cache-status` | `access-control-allow-origin` |
|----------|-----------------|---------------------------|-------------------------------|
| SSR page | `public, max-age=0, must-revalidate` | DYNAMIC | - |
| pair-details v4 | `public, max-age=60` | MISS -> HIT (0.02-0.07 s on hit) | `https://dexscreener.com` |
| chart bars v3 | none | MISS | - |
| log/amm v5 top | none | MISS / BYPASS on 400 | - |
| search v12 / spotlight v10 | `no-store` | MISS / HIT | - |
| feed/rpc | none | MISS | `https://dexscreener.com` |
| dd.dexscreener.com | `public, max-age=10` | REVALIDATED | `https://dexscreener.com` |
| hype/reactions | none | DYNAMIC | `https://dexscreener.com` |

`Origin: https://dexscreener.com` was sent on every request; ACAO is echoed as an exact origin, so
these are not open-CORS APIs even though they answer without credentials.

### 9.4 Error contract

Mostly **fail-open, not fail-closed**, which is the single biggest agent risk here:
- bad `res`, missing `q`, bad `cb`, bad sort key -> `400` with an **empty body** (no JSON, no reason)
- `mc=1` without `cs` -> `500`, empty body
- bad ammId / bad pairId / wrong-case Solana pairId -> **`200` with an empty result**
- bad pairId over the feed WS -> `WS_COMMAND_CODE_OK` with `n=0`
- missing token insight -> `WS_COMMAND_CODE_NOT_FOUND` (the one honest not-found)
- Connect-RPC is the only endpoint with a structured error: `400 {"code":"invalid_argument"}`

## 10. Bonus pair-level endpoints found in the bundle (not in the brief)

### 10.1 Top traders - `/dex/log/amm/v5/{ammId}/top/{chainId}/{pairAddress}`

```
GET https://io.dexscreener.com/dex/log/amm/v5/{ammId}/top/{chainId}/{pairAddress}
    ?q={quoteTokenAddress}&s={sort}&sd={dir}[&mda={maxDaysAgo}][&k=1][&lpId={launchpadId}]
```
`s` and `sd` are **required** (400 without either). `s` in `bought | sold | pnl | unrealized`
(invalid -> 400). `sd` in `asc | desc`. `mda` = max days ago (1, 7, ... tested). `k=1` = KOL wallets
only. `lpId` = launchpad id filter. Response: site-Avro `array<TopMaker>`, **exactly 100 rows**:
```
TopMaker = { maker: string, label: union[null,string], url: union[null,string],
             buys: double, sells: double, volumeUsdBuy: double, volumeUsdSell: double,
             amountBuy: string, amountSell: string,
             balanceAmount: union[null,string], balancePercentage: union[null,double],
             firstSwap: double(ms), lastSwap: double(ms) }
```
Measured: ethereum C `s=pnl&sd=desc` -> 200, 11,991 B, 0.24 s, 100 rows; solana A -> 13,214 B,
0.23 s, 100 rows; robinhood B -> 11,540 B, 0.21 s, 100 rows; `mda=7` -> 11,954 B; `k=1` -> 1 B / 0 rows.
Sample: `0xeeFa4E26...1516 buys=24 sells=37 $buy=114,438.26 $sell=291,732.34 pnl=+177,294.08
first=2026-07-25 23:33 last=2026-08-23 12:34`. `pnl` is computed client-side as
`volumeUsdSell - volumeUsdBuy`; "unrealized" ranks by remaining balance value.
This is the pair page's "Top Traders" tab, and it is the single richest pair-level dataset here.

### 10.2 Pair reactions - `/hype/reactions/dexPair/{chainId}:{pairId}`

```
GET https://io.dexscreener.com/hype/reactions/dexPair/{chainId}:{pairId}
-> { "userReaction": {}, "reactions": { "poop":{"total":N}, "fire":{...}, "rocket":{...},
                                        "triangular_flag_on_post":{...} } }
```
Measured: solana A -> 200, 133 B, 0.31 s, `{poop:4, fire:63, rocket:148, flag:1}`;
ethereum C -> 200, 142 B, 0.20 s, `{poop:1074, fire:1151, rocket:11041, flag:922}`.
Writing a reaction is `POST /hype/reactions/v2/dexPair/{id}?captchaValue=...` and requires a
Cloudflare Turnstile token (site key `0x4AAAAAAAyM2G1VxcnoBkKe`) - read-only is free.

### 10.3 Chain-scoped trending - `/dex/trending/v6?chainId=&timeframeKey=`
Avro, `array<Pair>` schemaVersion 1.5. Same 30 rows the SSR page embeds as `trendingPairs`.

## 11. Ranked: most useful for an agent

1. **`GET /dex/pair-details/v4/{chain}/{pair}[?inverted=1]`** - plain JSON, 60 s cacheable, 0.02 s on
   a cache hit, and it carries every safety signal an agent needs to refuse or warn on a trade:
   GoPlus honeypot/tax/blacklist/mint/owner, QuickIntel audit with actual function source, holder
   distribution, LP lock status, Solana mint/freeze authority, circulating supply. No decoding needed.
2. **`GET /feed/rpc/dex_feed.PublicService/GetTransactions` (Connect GET)** - stateless trade history
   with the full filter surface (type, maker, USD/amount ranges, block range, timestamp window,
   invert) and `traderScreener` wallet profiling on every row. 100/page, exclusive block paging,
   structured 400 errors. Better than the WS in every respect for an agent.
3. **`GET /dex/log/amm/v5/{ammId}/top/{chain}/{pair}?q&s&sd`** - 100 ranked traders with PnL,
   position, first/last trade. Nothing in the public API comes close.
4. **`GET /dex/chart/amm/v3/{ammId}/bars/...`** - OHLCV down to 1-second bars, 999 per page,
   backwards/forwards block paging, native+USD, and market-cap candles. Requires the custom Avro
   decoder and strict `ammId`/`q` correctness.
5. **`wss://.../dex/screener/v7/pair/{chain}/{pair}`** - ~1 KB every ~3.2 s, the complete live Pair.
   The cheapest way to hold a live quote for a watched pair. Repeats unchanged payloads, so dedupe.
6. **SSR `https://dexscreener.com/{chain}/{pairOrToken}`** - one 0.8-1.2 s / ~910 KB fetch gives
   pair + all pair details + 30 chain-trending + the 74-chain and 602-DEX catalogs + the real host
   map. Also the only free token-address -> canonical-pair resolver. Cold start only, never a poll.
7. **`GET /dex/search/v12/pairs?q=` and `/dex/search/spotlight/v10`** - address query returns every
   pair for a token; spotlight gives boosts and 36 newest profiles for discovery.
8. **feed WS `getHistoricalBars`** - the only source of D1/D3/W1/MO1 bars and of market-cap candles
   without a supplied circulating supply; also adds `volumeToken0`/`volumeToken1`.
9. **`getTokenInsight`** - a ready-made narrative paragraph per trending token. Partial coverage
   (`NOT_FOUND` on PEPE), so always treat it as optional colour, never as fact. `subscribeTokenInsights`
   is unusable at 1.37 MB per frame with no filter.
10. **`dd.dexscreener.com` catalogs** - explorer URL templates and swap deeplinks per chain/dex.
    Fetch once a day; also free in any SSR page.
11. **`/hype/reactions/dexPair/{chain}:{pair}`** - crowd sentiment, 133 B. Nice-to-have only.
12. **`wss://.../dex/screener/v2/tokens/...`** - token-deduplicated screener, but its ranking
    semantics did not reproduce and `pairsCount` is not a total. Lowest confidence of the set.

## 12. Gaps, unknowns, and nothing-denied

- **Nothing was denied by the sandbox command classifier.** All probes ran as written.
- `pairDetails.ti`, `.hpi`, `.lpHolders` were **null on all 8 sampled pairs**; their schemas are known
  (section 3) but no live sample was captured. `.ts` is dead by construction - the client maps it to
  `null` unconditionally, so it can never carry data regardless of what the server returns.
- Live `subscribeTransactions` never pushed a trade in 60 s on a 35-trade/minute pair. The
  `isDEXFeedStreamEnabled` gate is the strong hypothesis but is **not proven** - I did not locate a
  pair with the flag set to true to test the positive case.
- `/dex/screener/v2/tokens` ranking: unverified (section 7 caveat).
- `uo=0` produced no observable difference on the one pair tested; its real effect is unconfirmed.
- `getHistoricalBars` `limit` cap not established - 2000 was accepted but the pair only had 122 bars.
  The HTTP bars cap (999) is firm.
- `/ds-data/ads/active/v5` and `/ds-data/ads/trending-bar/next-time-interval` were not probed
  (ad plumbing, no agent value; the same ad rows appear in SSR).
- `/ds-data/v2/private/chains/by-txns` and `/ds-data/private/dexes` require `fullAccessToken`,
  which the public bundle does not contain. Not probed.
- Rate limits were not probed deliberately. ~90 HTTP requests and 6 WS sessions over ~20 minutes,
  sequential, drew no 429 and no Cloudflare challenge.
- All bodies labelled `application/json` on `io.dexscreener.com` that are actually binary:
  `/dex/chart/amm/v3/...` (site-Avro), `/dex/log/amm/v5/.../top/...` (site-Avro),
  `/dex/search/v12/pairs` and `/dex/search/spotlight/v10` (protobuf). Never trust the content-type
  header on this host; dispatch on the endpoint.

## 13. Artifacts left in the scratchpad

`pl_avro.py` (site-Avro decoder + Bar and TopMaker schemas), `bars.py`/`bars2.py`/`bars3.py`,
`pl_top.py`, `pl_feed.py`/`pl_feed2.py`/`pl_feed3.py`, `pl_connect.py`/`pl_connect2.py`,
`pl_wspair.py`, `pl_tokens.py`, `pl_search.py`, `pl_dd.py`, `pd.py`/`pd2.py`, `ssr2.py`,
plus captured bodies: `pair-details-{solana,ethereum,robinhood}.json`, `ssr-*.json`,
`wspair-first.json`, `wspair-eth.json`, `feed-histtx.json`, `feed-histbars.json`,
`feed-tokenInsight.json`, `feed-tokenInsights.json`, `connect-gettx.json`,
`tokens-first.json`, `pairs-first.json`, `spotlight.json`, `search-*.json`.

Note: `dsavro.py` in this scratchpad was overwritten mid-session by a parallel agent; all my code was
moved to the `pl_*` prefix to avoid further collisions.
