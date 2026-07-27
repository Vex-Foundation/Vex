# DexScreener Module Map — Multi-Chain DEX Analytics, Narratives & Real-Time Streams

This document maps every `.ts` file in `src/tools/dexscreener/` to the data it
provides for token research, pair analytics, trending narratives, attention
signals, community takeovers, and real-time WebSocket streaming, plus how the
agent reaches it.

**Last updated: 2026-07-04**

**LLM maintainers:** If you modify any file in this folder, update this document
to reflect the change — add/remove endpoints, update types, fix stale references.

**Docs:** https://docs.dexscreener.com/api/reference
**Base URL**: `https://api.dexscreener.com`
**Auth**: None required (open API)
**Rate limits**: 60 req/min (profiles, boosts, CTO, ads, orders, metas), 300
req/min (search, pairs, tokens, token-pairs). Enforced client-side per process by
`throttle.ts` (see below).

---

## What DexScreener Does

DexScreener is a multi-chain DEX analytics platform. It automatically tracks
every token listed on any DEX with at least one transaction. The API provides:

- **Pair/token data**: price, volume, liquidity, transactions, FDV, market cap across all chains
- **Token profiles**: projects with descriptions, icons, social links; plus a recent-updates change feed
- **Token boosts**: promoted tokens with boost amounts (paid visibility)
- **Trending narratives (metas)**: trending themes/categories (AI, dogs, "knockoff legends") with aggregate stats, and a drill-down to the pairs inside one narrative
- **Community takeovers (CTO)**: tokens where community has reclaimed control — strong trading signal
- **Ads**: paid promotional placements with impressions and duration
- **Orders**: verification of paid promotional orders per token
- **Real-time WebSocket**: streaming updates for profiles, boosts, CTOs, and ads

All read-only. No wallet, signing, or API key needed.

### Documented vs live-but-undocumented surface

The metas endpoints (`/metas/trending/v1`, `/metas/meta/v1/{slug}`) and the
profile recent-updates feed (`/token-profiles/recent-updates/v1`) are
**live-verified but absent from the official reference**. They are implemented
behind TOLERANT validators (unknown fields pass, missing fields become null) and
their agent tools degrade to a clear "feed unavailable" result on any error
(HTTP 4xx/5xx, drift) rather than throwing through the namespace. Their tool
descriptions are marked "live but undocumented API surface — may change".

Note: a bad narrative slug on `/metas/meta/v1/{slug}` returns **HTTP 500** (not
404); the tolerant handler surfaces "feed unavailable" for it.

---

## File Map (`src/tools/dexscreener/`)

| File | Role |
|------|------|
| `client.ts` | `DexScreenerClient` — 13 REST methods, singleton via `getDexScreenerClient()`. Every request runs through the throttle/cache. |
| `throttle.ts` | `DexScreenerThrottle` — per-process token buckets (300/min + 60/min), TTL cache (fast ~8s / slow ~60s), in-flight dedupe, bounded cache, `Retry-After` honoring. |
| `types.ts` | TypeScript interfaces: `DexPair`, `DexTokenProfile`, `DexBoost`, `DexCommunityTakeover`, `DexAd`, `DexOrder`, `DexTrendingItem`, `DexMeta`/`DexMetaDetail`, `DexProfileUpdate`, WS types |
| `validation.ts` | Barrel re-exporting the 14 documented-surface validators (pairs/search/tokens, profiles, boosts, orders, community/ads, websocket) |
| `validation/metas.ts` | Tolerant validators for `/metas/trending/v1` and `/metas/meta/v1/{slug}` |
| `validation/profiles.ts` | `validateProfilesResponse` + tolerant `validateProfilesRecentResponse` |
| `validation/pairs.ts` | Pair/search/token validators; exports `parsePair` (reused by metas detail) |
| `errors.ts` | `mapDexScreenerError()` + `mapTransportError()` — HTTP status to typed `VexError` |
| `ws-client.ts` | `DexScreenerStream` — EventEmitter WebSocket client with auto-reconnect (5 channels) |

There is **no** `src/commands/dexscreener` CLI. The agent reaches DexScreener
exclusively through the protocol tools in
`src/vex-agent/tools/protocols/dexscreener/` (see "Agent Tools" below).

---

## REST Endpoints (13 methods)

| Method | Endpoint | Rate class | Surface |
|--------|----------|-----------|---------|
| `search(query)` | `GET /latest/dex/search?q={query}` | fast (300/min) | documented |
| `getPairs(chainId, pairId)` | `GET /latest/dex/pairs/{chainId}/{pairId}` | fast | documented |
| `getTokens(chainId, addresses)` | `GET /tokens/v1/{chainId}/{addresses}` | fast | documented |
| `getTokenPairs(chainId, address)` | `GET /token-pairs/v1/{chainId}/{address}` | fast | documented |
| `getProfiles()` | `GET /token-profiles/latest/v1` | slow (60/min) | documented |
| `getProfilesRecentUpdates()` | `GET /token-profiles/recent-updates/v1` | slow | **undocumented** |
| `getBoosts()` | `GET /token-boosts/latest/v1` | slow | documented |
| `getTopBoosts()` | `GET /token-boosts/top/v1` | slow | documented |
| `getCommunityTakeovers()` | `GET /community-takeovers/latest/v1` | slow | documented |
| `getMetasTrending()` | `GET /metas/trending/v1` | slow | **undocumented** |
| `getMeta(slug)` | `GET /metas/meta/v1/{slug}` | slow | **undocumented** |
| `getAds()` | `GET /ads/latest/v1` | slow | documented |
| `getOrders(chainId, address)` | `GET /orders/v1/{chainId}/{address}` | slow | documented |

### WebSocket (real-time streaming, `ws-client.ts`)

| Channel | WS Path | Data Type |
|---------|---------|-----------|
| `profiles` | `wss://api.dexscreener.com/token-profiles/latest/v1` | `DexTokenProfile` |
| `boosts` | `wss://api.dexscreener.com/token-boosts/latest/v1` | `DexBoost` |
| `boosts-top` | `wss://api.dexscreener.com/token-boosts/top/v1` | `DexBoost` |
| `community-takeovers` | `wss://api.dexscreener.com/community-takeovers/latest/v1` | `DexCommunityTakeover` |
| `ads` | `wss://api.dexscreener.com/ads/latest/v1` | `DexAd` |

**WS protocol**: First message is handshake `{ limit, data: T[] }` (initial
snapshot). Subsequent messages are individual updates. Auto-reconnect with
exponential backoff (1s→30s) + jitter. (DexScreener has **no** price WebSocket —
the WS surface is profiles/boosts/CTO/ads only.)

---

## Throttle & Cache (`throttle.ts`)

Every `DexScreenerClient.request()` runs through a per-instance
`DexScreenerThrottle` (constructed once per process via the client singleton).
**Per-process only — no cross-process coordination.**

- **Token bucket per rate class**: `fast` (300/min) for search/pairs/tokens/token-pairs, `slow` (60/min) for everything else. `acquire()` waits for a token before a fetch fires.
- **TTL cache** keyed by the normalized request URL: `fast` ~8s, `slow` ~60s. Bounded (256 entries, oldest-first eviction).
- **In-flight dedupe**: concurrent identical requests share one promise (one fetch, one token).
- **`Retry-After` honoring**: on a 429 the client calls `throttle.penalize(rateClass, ms)`, parking the whole rate class until the delay elapses.

Errors are never cached and never left in the in-flight map.

---

## Agent Tools (`src/vex-agent/tools/protocols/dexscreener/`)

14 read-only tools. Typical research flow: **search → tokenPairs (pick deepest
pool) → pairs (deep stats)**; discovery flow: **trending (narratives) → meta
(drill into one)**.

| Tool ID | Backing method | Notes |
|---------|----------------|-------|
| `dexscreener.search` | `search` | Optional `chainId` / `minLiquidityUsd` / `limit` client-side filters; sorted by liquidity |
| `dexscreener.pairs` | `getPairs` | Concise pair for one pool |
| `dexscreener.tokens` | `getTokens` | Batch (≤30) concise pairs |
| `dexscreener.tokenPairs` | `getTokenPairs` | All pools for a token, deepest first; canonical pool resolver |
| `dexscreener.profiles` | `getProfiles` | Latest profiles |
| `dexscreener.profiles.recent` | `getProfilesRecentUpdates` | **undocumented** — recently updated profiles + `updatedAt`/`cto` |
| `dexscreener.boosts` | `getBoosts` | Latest boosts |
| `dexscreener.boosts.top` | `getTopBoosts` | Top boosts |
| `dexscreener.communityTakeovers` | `getCommunityTakeovers` | CTO events |
| `dexscreener.attention` | `getProfiles` + `getBoosts` | Synthetic merge (boost + profile), ranked. NOT the trending feed. |
| `dexscreener.trending` | `getMetasTrending` | **undocumented** — official trending NARRATIVES/themes (not tokens) |
| `dexscreener.meta` | `getMeta(slug)` | **undocumented** — one narrative + its pairs; `slug` is a NARRATIVE slug from `dexscreener.trending`, not a chain slug |
| `dexscreener.orders` | `getOrders` | Paid-order verification |
| `dexscreener.ads` | `getAds` | Latest ads |

The market-data tools (search/pairs/tokens/tokenPairs) and the metas-detail
pairs return the **unified concise projection** (`projectors.ts`) — a flat row
keeping chainId/dexId/pairAddress, base/quote token, priceUsd/priceNative,
liquidityUsd, fdv/marketCap, volumeH24, priceChangeH1/H24, txnsH24, pairCreatedAt,
labels — and dropping `info`/`url`/`boosts` and the non-h24 timeframe windows
(context economy). The renderer's link/image features read those dropped fields
off the raw client responses, not off this projected tool output.

Chain slugs are DexScreener string ids: `ethereum`, `base`, `solana`, `bsc`,
`arbitrum`, `polygon`, `avalanche`, `optimism`, `robinhood` (chainId 4663), and
more.

---

## Data Types

### DexPair (core schema)

```typescript
{
  chainId: string;           // "solana", "ethereum", "bsc", "robinhood", etc.
  dexId: string;             // "raydium", "uniswap", etc.
  url: string;               // DexScreener URL
  pairAddress: string;       // Pool contract address
  labels: string[] | null;   // ["v2"], ["v3"], etc.
  baseToken: { address, name, symbol };
  quoteToken: { address, name, symbol }; // nullable fields
  priceNative: string;       // Price in quote token
  priceUsd: string | null;   // USD price
  txns: { h24: { buys, sells }, m5: {...}, h1: {...}, h6: {...} };
  volume: { h24: number, h6: number, h1: number, m5: number };
  priceChange: { h24: number, h6: number, h1: number, m5: number } | null;
  liquidity: { usd: number | null, base: number, quote: number } | null;
  fdv: number | null;        // Fully diluted valuation
  marketCap: number | null;  // Market cap (uses circulating supply if available)
  pairCreatedAt: number | null; // Unix timestamp ms
  info: { imageUrl, websites[], socials[] } | null;
  boosts: { active: number } | null;
}
```

### DexMeta / DexMetaDetail (metas / narratives)

```typescript
// /metas/trending/v1 → DexMeta[]
{
  slug: string | null;       // narrative slug, e.g. "knockoff-legends"
  name: string | null;
  description: string | null;
  icon: { type: string | null, value: string | null } | null; // e.g. {type:"emoji", value:"🎨"}
  marketCap: number | null;  // aggregate across the narrative
  liquidity: number | null;
  volume: number | null;
  tokenCount: number | null;
  marketCapChange: { m5, h1, h6, h24 } | null; // percent
  marketCapDelta:  { m5, h1, h6, h24 } | null; // absolute USD
}
// /metas/meta/v1/{slug} → DexMetaDetail = DexMeta & { pairs: DexPair[] }
```

### DexProfileUpdate (recent-updates feed)

```typescript
// /token-profiles/recent-updates/v1 → DexProfileUpdate[]
// Superset of DexTokenProfile:
{ url, chainId, tokenAddress, icon, header, description, links,
  updatedAt: string | null,  // ISO 8601
  cto: boolean | null }
```

### DexTokenProfile

```typescript
{ url, chainId, tokenAddress, icon, header: string | null,
  description: string | null, links: Array<{ type, label, url }> | null }
```

### DexBoost

```typescript
{ url, chainId, tokenAddress,
  amount: number | null, totalAmount: number | null,
  icon: string | null, header: string | null, description: string | null,
  links: Array<{ type, label, url }> | null }
```

One shape serves both boost endpoints, and both amounts are nullable.
`/token-boosts/latest/v1` sends `amount` on every row; `/token-boosts/top/v1`
sends it on none (live-verified 2026-07-27 — requiring it made
`dexscreener.boosts.top` throw on 100% of calls). `null` means "the endpoint
did not report it", which is not the same as a boost of zero.

`validateBoostsResponse` returns `{ boosts, skipped }`, not a bare array: a row
that fails to parse is dropped and COUNTED rather than throwing the feed away.

### DexCommunityTakeover

```typescript
{ url, chainId, tokenAddress, icon, header, description, links,
  claimDate: string /* ISO 8601 */ }
```

### DexAd

```typescript
{ url, chainId, tokenAddress, date /* ISO 8601 */, type,
  durationHours: number | null, impressions: number | null }
```

### DexOrdersResponse

`/orders/v1/{chainId}/{tokenAddress}` answers with an **object**, not an array
(live-verified 2026-07-27). It carries the paid-order history AND the
boost-payment ledger for the same token; both are returned.

```typescript
// GET /orders/v1/{chainId}/{tokenAddress} → { orders: [...], boosts: [...] }
{ orders: DexOrder[];
  boostPayments: DexBoostPayment[];
  skippedOrders: number;         // rows dropped because they did not parse
  skippedBoostPayments: number }
```

```typescript
// DexOrder
{ chainId, tokenAddress,
  type: string;    // observed: "tokenProfile" | "communityTakeover" | "tokenAd" | "trendingBarAd"
  status: string;  // documented: "processing" | "cancelled" | "on-hold" | "approved" | "rejected"
  paymentTimestampMs: number | null }

// DexBoostPayment — one boost PURCHASE; a different shape from DexBoost
{ chainId, tokenAddress,
  id: string | null;             // opaque DexScreener payment id
  amount: number | null;
  paymentTimestampMs: number | null }
```

`type` and `status` are plain strings, not closed unions: DexScreener adds
promotional products, and a membership check would throw on the first new one.
The comments above document the observed vocabulary; the values are echoed to
the agent, never branched on.

---

## Value Formats

| Field | Format | Example | Display |
|-------|--------|---------|---------|
| `priceUsd` | String, USD | `"152.34"` | `$152.34` |
| `priceNative` | String, quote token | `"1.0"` | Native denomination |
| `volume.h24` | Number, USD | `1234567.89` | `$1.23M` |
| `liquidity.usd` | Number, USD | `5678901.23` | `$5.68M` |
| `fdv` / `marketCap` | Number, USD | `89000000000` | `$89.00B` |
| `priceChange.h24` | **Already percentage** | `2.5` = 2.5% | Display as `+2.50%` — do NOT multiply by 100 |
| `txns.h24.buys` / `sells` | Integer | `1234` | Transaction count |
| `pairCreatedAt` | Unix timestamp **ms** | `1672531200000` | `new Date(value)` |
| `paymentTimestampMs` | Unix timestamp **milliseconds** | `1785076668204` | `new Date(value)` — do NOT multiply by 1000 |
| `updatedAt` / `claimDate` / ad `date` | ISO 8601 string | `"2026-07-04T13:43:41.745Z"` | Date display |
| `meta.marketCapChange.*` | **Already percentage** | `24.21` = 24.21% | Aggregate narrative change |

---

## Error Handling

| HTTP | Error Code | Retryable | Hint |
|------|-----------|-----------|------|
| 429 | `DEXSCREENER_RATE_LIMITED` | Yes | 60/min or 300/min per class; `Retry-After` honored by the throttle |
| 404 | `DEXSCREENER_NOT_FOUND` | No | Check chainId and address |
| 5xx | `DEXSCREENER_API_ERROR` | Yes | Server error, retry later (also the bad-slug response on `/metas/meta`) |
| Timeout | `DEXSCREENER_TIMEOUT` | Yes | Request timed out |
| Parse fail | `DEXSCREENER_INVALID_RESPONSE` | No | Unexpected response shape (documented endpoints only) |

The undocumented metas / recent-updates tools do NOT surface these errors to the
agent — they degrade to `{ available: false, reason: "…" }` instead.

---

## Trading Agent Integration

DexScreener is the research layer. The agent uses it read-only, then executes
via other protocols:

```
1. DISCOVERY
   dexscreener.search (name/symbol/address, optional chain + liquidity filters)
   dexscreener.trending (trending narratives) → dexscreener.meta (tokens in a narrative)
   dexscreener.attention / boosts / profiles / communityTakeovers (attention signals)

2. ANALYSIS
   dexscreener.tokens / dexscreener.pairs (price, volume, liquidity, FDV, txns)
   dexscreener.tokenPairs (all pools, find deepest liquidity → pool address)
   dexscreener.orders (paid-promotion legitimacy signal)

3. REAL-TIME MONITORING (ws-client.ts)
   community-takeovers / boosts / profiles streams

4. EXECUTE (via other protocol namespaces)
   → Solana tokens: solana.swap.*
   → EVM tokens:    kyberswap.swap.* (and uniswap.* on Robinhood chain)
   → Cross-chain:   khalani.* / relay.*
```

## FDV and Market Cap

DexScreener formula: `FDV = (total supply - burned supply) * price`. Market cap
equals FDV unless the token reports a circulating supply (Enhanced Token Info or
CoinGecko), in which case market cap uses circulating supply.
