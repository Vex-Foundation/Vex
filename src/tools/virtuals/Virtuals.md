# Virtuals Protocol - provider module

Read-only clients for the Virtuals agent-token launchpad: the Strapi content API
(`api.virtuals.io`), the bonding-curve trade tape (`vp-api.virtuals.io`) and the
pool candle source (`api.geckoterminal.com`). This module performs **no signing
and no DB writes**: it reads, it validates, and it hands typed domain shapes to
`src/vex-agent/tools/protocols/virtuals/`, which owns the model-facing surface.

The provider publishes **no documentation, no schema and no stability promise**.
Every fact in this file was MEASURED against the live endpoints on 2026-09-04 or
read out of a checked-in machine artifact (a contract source, the app bundle, or
the provider's own 400 body). Nothing is transcribed from convention.

Raw captures and the per-call ledger:

| what | where |
|---|---|
| 77 calls: every `filters[...]` operator, sort probes, pageSize 500/1000, populate, geneses, tokenomics, vp-api | `agents-colab/agents_dm/virtuals-probe-2026-09-04/captures/` |
| the app.virtuals.io bundle (the query builder is `virtual.api-DGEEKqdb.js`) | `agents-colab/agents_dm/virtuals-probe-2026-09-04/bundle/` |
| 24 calls: numeric status semantics, pageSize 2000/10000, deep page, `vibesInfo`, api2 mirror, the 403s | `agents-colab/agents_dm/virtuals-probe-2026-09-04b/captures/` |
| 103 calls made for THIS lane: sort direction, address `$or`, wallet, creator, genesis nesting, `noCache`/`skipStats`/`sparkline`/`range24h`, the 13 factory members, role and category vocabularies, geneses filters, per-chain bonding tapes, GeckoTerminal OHLCV and its three rejections | `agents-colab/agents_dm/virtuals-reads-2026-09-04/` (`probe1.mjs`-`probe4.mjs`, `captures/`) |
| contracts, chart XHR captures, the two live launches | `agents-colab/agents_dm/virtuals-contracts-2026-09-04/` |
| the Solana verdict | `agents-colab/agents_dm/virtuals-solana-2026-09-04/` |

Sanitized copies of the captures the tests depend on live in
`src/__tests__/virtuals/fixtures/`; no test reads `agents-colab`.

## What this module is

| File | Responsibility |
|---|---|
| `client.ts` | `VirtualsClient` + `getVirtualsClient()`. Owns the whole `filters[...]` / `sort[n]` / `pagination[...]` serialisation for `api.virtuals.io`. |
| `types.ts` | The CLOSED vocabularies (chains, status codes, 13 factories, 26 sort attributes, roles, genesis statuses, search scopes) and the normalized domain shapes. |
| `validation.ts` | Tolerant readers over raw `unknown`. Drops creator PII and keeps integer-string money fields verbatim. |
| `errors.ts` | `mapVirtualsError` / `mapVirtualsTransportError` to `ErrorCodes.VIRTUALS_*`. |
| `throttle.ts` | Token bucket + TTL cache + in-flight dedupe, per host, with a configurable rate. |
| `trades/vp-api.ts` | The bonding-curve trade tape, and the typed refusal for the chains it does not serve. |
| `candles/geckoterminal.ts` | Pool OHLCV over GeckoTerminal's PUBLIC v2 API, and the typed "pool not indexed" outcome. |
| `candles/bucketing.ts` | The exact OHLCV arithmetic both curve sources share: scaled-bigint prices and volumes, epoch-aligned buckets, no floats anywhere. |
| `candles/curve-tape.ts` | Bonding-curve candles built from the provider's own trade feed (base, solana), with the feed's cursorless ceiling reported as a ceiling. |
| `candles/curve-chain.ts` | Bonding-curve candles built from the pair's own `FPairV2` `Swap` logs (base, robinhood), the deepest and most precise source. |

Base URL is `services.virtualsApiUrl` in the Vex config; the other two hosts are
constants inside their own modules because they are not configurable endpoints.

## THE THREE QUIRKS THAT SHAPE EVERYTHING ELSE

**1. An unknown filter KEY is silently ignored and you get the whole
population.** `filters[bogusKeyXyz]=1` on BASE returned HTTP 200 and all 56,915
rows - the same count as no filter at all (`f_bogus`). A typo therefore reads as
"no filter", never as an error.

**2. An unknown VALUE inside a known key returns zero rows, HTTP 200.**
`filters[factory]=ZZZ_NOT_A_FACTORY`, `filters[role]=ZZZ_NOT_A_ROLE`,
`filters[category]=ZZZ_NOT_A_CAT` and `filters[vibesInfo][status]=ZZZ` each
answered `total: 0` - indistinguishable from a real empty market.

Between them, nothing about a wrong request is observable in the response. That
is why every value this client can emit is a closed set in `types.ts` and why
the protocol boundary refuses an unlisted value BY NAME.

**3. `filters[status]` works ONLY in the bare numeric form.** Measured on BASE
against a 56,915-row population:

| sent | total | verdict |
|---|---|---|
| `filters[status]=1` | 55,764 | UNDERGRAD (on the curve) |
| `filters[status]=2` | 956 | AVAILABLE (graduated) |
| `filters[status]=4` | 195 | GENESIS (Base-only: the same 195 rows come back with no chain filter) |
| `filters[status]=AVAILABLE` | 56,915 | IGNORED |
| `filters[status]=UNDERGRAD` | 56,915 | IGNORED |
| `filters[status][$eq]=AVAILABLE` | 56,915 | IGNORED |
| `filters[status][$eq]=2` | 56,915 | IGNORED - operators do not work either |
| `filters[status][$in][0..1]=1,2` | 56,915 | IGNORED |
| `filters[status]=3` / `=6` / `=7` | 56,915 | no-op codes |
| `filters[status]=5` | 56,689 | filters SOMETHING (236 rows) - unexplained |
| `filters[status]=0` | HTTP 401 | Unauthorized |

1, 2 and 4 partition the population (55,764 + 956 + 195 = 56,915). Codes 3, 5, 6
and 7 are recorded here and deliberately **not exposed**: 3/6/7 do nothing and 5
has no meaning we measured. The model-facing param stays the readable enum
(`undergrad` / `graduated` / `genesis` / `all`) and `client.ts` maps it.

## `GET /api/virtuals` - screen agents

`filters[chain]` is effectively required: a bare list answers the CROSS-CHAIN
population (82,834 rows), which is a different question. Chain totals on
2026-09-04: BASE 56,915, ROBINHOOD 25,307, SOLANA 610, ETH 2. An unknown chain
(`FOO`, `ARB`, `BSC`, `POLYGON`, `XLAYER`, `ARC`, `ABSTRACT`) returns zero rows.

### Filters, each with the operator we send and the probe that proved it

| model-facing param | wire expression | probe | live result |
|---|---|---|---|
| `status` | `filters[status]=<1\|2\|4>` | `f_status_num1/2`, `st_4` | see the table above |
| `query` + `searchScope=text` | `filters[$or][0][name][$containsi]`, `[1][symbol][$containsi]` | `f_name_containsi`, `name_containsi_case` | 51 / 5 rows |
| `query` + `searchScope=address` | `filters[$or][n][tokenAddress\|preToken][$eqi]` | `addr_or_eqi`, `addr_or_pretoken` | 1 row by either column |
| `query` + `searchScope=any` | all four clauses in one `$or` | `search_union` | 7 rows |
| `symbol` | `filters[symbol][$eqi]` | `f_symbol_eq` | 10 rows (symbols are NOT unique) |
| `tokenAddress` | `filters[$or][0][tokenAddress][$eqi]` + `[1][preToken][$eqi]` | `addr_or_eqi` | 1 row |
| `creatorWallet` | `filters[walletAddress][$eqi]` | `wallet_eqi` | 1 row |
| `factory` | `filters[factory]=<member>` | `fac_*` (13 probes) | see the factory table |
| `role` | `filters[role]=<member>` | `role_onchain` | 3,392 rows |
| `isVerified` | `filters[isVerified]=true` | `f_verified` | 45 |
| `isDevCommitted` | `filters[isDevCommitted]=true` | `f_devcommit` | 177 |
| `hasMarginTrading` | `filters[hasMarginTrading]=true` | `f_margin`, `rh_margin` | 0 on base AND robinhood |
| `hasFounderVideo` | `filters[hasFounderVideo]=true` | `f_founder` | 197 |
| `hasRevenueConnect` | `filters[revenueConnectWallet][$notNull]=true` | `f_revenue` | 6 |
| `hasStaking` | `filters[$or][0][stakingAddress][$notNull]` + `[1][agentStakingContract][$notNull]` | `f_staking` | 14 |
| `hasGraduated` | `filters[lpCreatedAt][$notNull]=true` | `f_lp_notnull` | 952 |
| `hasGenesis` | `filters[genesis][id][$notNull]=true` | `f_genesis_notnull` | 338 |
| `genesisStartsAfter` / `Before` | `filters[genesis][startsAt][$gte\|$lte]` | `genesis_startsat` | 1 |
| `createdAfter` | `filters[createdAt][$gte]` | `f_created_gte` | 2,198 |
| `launchedAfter` | `filters[launchedAt][$gte]` | `f_launchedat` | 2,199 |
| `min/maxMcapInVirtual` | `filters[mcapInVirtual][$gte\|$lte]` | `f_mcap_gte` | 125 |
| `min/maxHolderCount` | `filters[holderCount][$gte\|$lte]` | `f_holder_gte` | 536 |
| `min/maxVolume24h` | `filters[volume24h][$gte\|$lte]` | `f_vol24_gte` | 21 |
| `min/maxLiquidityUsd` | `filters[liquidityUsd][$gte\|$lte]` | (same operator family) | - |
| `min/maxPriceChangePercent24h` | `filters[priceChangePercent24h][$gte\|$lte]` | `f_pcp24_gte` | 8 |
| `min/maxTop10HolderPercentage` | `filters[top10HolderPercentage][$gte\|$lte]` | `f_top10_lte` | 7,304 |
| `hasAntiSniperTax` | `filters[launchInfo][antiSniperTaxType][$ne]=0` + `[$notNull]=true` | `f_li_sniper` | 17,591 |
| `hasAirdrop` | `filters[launchInfo][airdropPercent][$gt]=0` | `f_li_airdrop` | 787 |
| `launchRadarEnabled` | `filters[launchInfo][launchRadarEnabled][$eq]=true` | `f_li_radar` | 20 |
| `isRobotics` | `filters[launchInfo][isRobotics][$eq]=true` | `f_li_robotics` | 520 |
| `needAcf` | `filters[launchInfo][needAcf][$eq]=true` | `li_needacf` | 1,223 |
| `isProject60days` | `filters[launchInfo][isProject60days][$eq]=true` | `li_p60` | 52 |
| `vibesStatus` | `filters[vibesInfo][status]=PRECOMMIT` | `b_isPreCommit` | 19 |
| `excludeLaunchX` | `filters[category][$notIn][0..1]=X_LAUNCH,ACP_LAUNCH` | `f_cat_notin` | 34,614 |
| `includeLaunchX` | `filters[category][$in][0..1]=X_LAUNCH,ACP_LAUNCH` | `cat_xlaunch` | 60 |

Operator notes:
- `$eq` on `tokenAddress` matched a lowercase value against a checksummed stored
  one (`addr_token_eq_wrongcase`), so comparison is case-insensitive anyway; we
  send `$eqi` because relying on that is relying on an unstated behaviour.
- An unknown OPERATOR is one of the few real 400s:
  `filters[mcapInVirtual][$zzz]` -> `400 "Undefined attribute level operator $zzz"`.
- A bogus key under a KNOWN nested relation is a **500**:
  `filters[launchInfo][zzzBogus][$eq]=true` -> `500 Internal Server Error`
  (`li_bogus`). Only declared `launchInfo` sub-keys are ever emitted.
- `filters[creator][id][$eq]` does NOT filter (`creator_id` returned the full
  population). The app's own builder uses a FLAT `creator` scalar, and we expose
  `creatorWallet` (the row's `walletAddress`) instead, which does work.

### Sort

26 sortable attributes, each accepted live in a `sort[n]=<field>:desc` probe
(`sortA`, `sortB`, `sortC`, `sortD2`):

```
circulatingSupply  createdAt        devHoldingPercentage  fdvInVirtual
holderCount        holderCountPercent24h  launchedAt      level
liquidityUsd       lpCreatedAt      mcapInVirtual         mindshare
netVolume24h       priceChangePercent1h   priceChangePercent5m
priceChangePercent6h  priceChangePercent24h  top10HolderPercentage
totalValueLocked   updatedAt        virtualTokenValue     virtualsPoolVol24h
volume1h           volume5m         volume6h              volume24h
```

The provider validates the ATTRIBUTE and states the rejection itself:

- `sort[0]=totalSupply:desc` -> `400 "Attribute totalSupply not found on model api::virtual.virtual"`
- `sort[0]=zzzNotAField:desc` -> `400 "Attribute zzzNotAField not found on model api::virtual.virtual"`

It does **not** validate the direction:

- `sort[0]=holderCount` (no direction) -> `400 "Cannot read properties of undefined (reading 'toLowerCase')"`
- `sort[0]=holderCount:sideways` -> **HTTP 200, silently sorted descending**

so `sortDirection` is a closed `asc|desc` enum at our boundary. `asc` was
verified live (nulls first, then ascending).

**Declared omission - ordered multi-sort.** The provider accepts `sort[1]`,
`sort[2]`, ... and the app sends two keys. We send exactly ONE. Reason: an A/B
probe of `sort[0]=level&sort[1]=holderCount` against the reverse order returned
identical rows, so we have no measurement showing the tie-breaker changes an
answer, and a second key that changes nothing is a parameter the model would
spend calls on. Reachable through the provider; not exposed here.

### Pagination and the page bound

`pagination[page]` and `pagination[pageSize]`. The provider served
`pageSize=500`, `1000`, `2000` and `10000` with HTTP 200 and exactly that many
rows (`ps_500`, `ps_1000`, `b_ps2000`, `b_ps10000`); `page=560` at pageSize 100
returned a full page of row 55,900 onwards.

**Our bound is 100, and it is ours.** An agent row carries 84 fields including
three multi-KB free-text blobs, so a 10,000-row page is tens of megabytes of
untrusted JSON. The client caps at 200 and the model-facing tools cap at 100;
every row past the page is reachable with `page`, and `totalMatched` reports how
many the filter found. The reply carries `count`, `totalMatched`, `pageCount`,
`hasMore`, `nextPage` and a `truncationNote` naming the recovery, per
`tool-surface-spec/output-envelope.md` section 4.

### Payload-shaping params (all probed live, all exposed or named here)

| param | measured effect | exposed? |
|---|---|---|
| `skipStats=true` | drops six computed fields per row (`allowUpdateLaunchDate`, `displayRevenue`, `initialPairAmount`, `initialPurchase`, `initialPurchasedAmount`, `tokenomicsStatus`) | client-side only; not a model param, because the tools need those fields |
| `sparkline=true` | ADDS a `sparkline` array of `{timestamp, price}` 24 h samples | yes, as `includePriceSeries` |
| `range24h=true` | ADDS `range24h: [low, high]` | yes, with `includePriceSeries` |
| `noCache=true` | accepted, no observable difference in the response | **omitted**: it changes nothing we can see and the client has its own 30 s cache |
| `populate[n]` | the relations (`image`, `launchInfo`, `genesis`, `vibesInfo`, `creator`, `tokenomics.project`) | sent always; not a model param |

`sparkline` and `range24h` are LIST-endpoint only: the detail endpoint accepted
both and returned neither (`detail_sparkline_135655`). The detail projection
therefore never promises a price series.

### The factory enum (13 members, from the bundle, each probed live)

| member | BASE rows | note |
|---|---|---|
| `BONDING_V4` | 21,630 | |
| `BONDING_V5` | 19,473 | the current launch suite |
| `BONDING` | 15,326 | |
| `BONDING_V2` | 112 | |
| `VIBES_BONDING_V2` | 47 | |
| `ERC20` | 30 | |
| `ERC20_PRO` | 4 | |
| `BONDING_V3` | 3 | |
| `SOL_METEORA` | 0 | 98 on SOLANA |
| `ROBOTIC_BONDING_V2/V3/V4`, `ROBOTIC_ERC20_PRO` | 0 each | see below |

**ROBOTIC normalisation.** The bundle emits `ROBOTIC_*` as QUERY values and
rewrites the rows it receives back to the plain factory plus `isRobotics: true`.
Live, all four return zero rows while `launchInfo.isRobotics=true` returns 520,
so the stored factory is the plain one. The members stay in the enum because they
are legal wire values, and the tool's own param description points at
`isRobotics` as the screen that works. `OLD` appears on legacy ROWS but matches
nothing as a filter, so it is a row value, not a filter value.

### Row vocabularies

- `status` (row): `DRAFT`, `GENESIS`, `UNDERGRAD`, `AVAILABLE`, `INITIALIZED`,
  `PROCESSING`, `REJECTED` (the bundle's own enum).
- `role`: `ENTERTAINMENT` 194, `INFORMATION` 121, `ON_CHAIN` 117,
  `PRODUCTIVITY` 92, `CREATIVE` 65, empty 9,410 - counted over 10,000 sampled
  BASE rows. One row carries `Information` in mixed case: the provider does not
  normalise, so the value set is closed at OUR boundary, not theirs.
- `category`: `IP MIRROR` on 9,997 of 10,000 sampled rows, `FUNCTIONAL` on 3,
  plus the two launch tags `X_LAUNCH` / `ACP_LAUNCH` used only for filtering.
- `vibesInfo.status`: `PRECOMMIT` is the only value that matches anything.

## `GET /api/virtuals/{id}` - one agent

Same row shape plus the populated relations. Two facts worth keeping:

- `GET /api/virtuals/{id}/launch?buyAmount=` is **403** unauthenticated, as are
  `/me/delegated-tokens` and `/erc20pro/launch-amounts`. This module never calls
  an authenticated endpoint.
- `GET /api/virtuals/{id}/tokenomics/parameters` is public and returns the
  vesting parameter set; not wired, because the projected tokenomics summary
  answers the question the tools ask.

## `GET /api/geneses` - the launch calendar

A DIFFERENT spelling from the agents endpoint, and this is the trap: here
`filters[status]` takes the **string** form. `FINALIZED` -> 145, `CANCELLED` ->
33, an unknown value -> 0 with no 400. `filters[status][$ne]=FINALIZED` -> 218.
`filters[startsAt][$gte]` and `filters[virtual][chain]` (360 rows on BASE) both
work. Unlike `/api/virtuals`, this endpoint does **not** validate the sort
attribute: `sort[0]=zzz:desc` returned 200 and the default order, so the closed
`id|startsAt|endsAt` set is the only guard there is.

`GET /api/geneses/parameters` returns `{ reserveAmountTiers: [21000, 42000,
100000] }` - the VIRTUAL reserve targets a sale can be configured for. The
genesis tool returns them alongside the rows, and says so when the call failed
rather than inventing them.

Genesis row fields: `id`, `genesisId`, `status`, `startsAt`, `endsAt`,
`totalParticipants`, `totalPoints`, `totalVirtuals`, `genesisAddress`,
`genesisTx`, and the nested `virtual`.

## `vp-api.virtuals.io/vp-api/trades` - the bonding-curve tape

`?tokenAddress=&limit=&chainID=&tradeSideOption=`. Rows:
`{chainID, txSender, txHash, tokenAddress, isBuy, agentTokenAmt,
virtualTokenAmt, price, timestamp}` - amounts are WHOLE-TOKEN decimal strings
(not wei), timestamp is unix seconds.

`tradeSideOption`: 0 both, 1 buys only, 2 sells only (each verified: `tr_side1`
returned only `isBuy: true`, `tr_side2` only `isBuy: false`).

Coverage, measured per chain AND per lifecycle stage:

| chain | chainID | bonding agent | graduated agent |
|---|---|---|---|
| BASE | 0 | rows (`tr_ug`, `tr_ug_base_0x1984ed`) | EMPTY |
| SOLANA | 1 | rows (`tr_ug_solana_GpjfBr`) | EMPTY |
| ROBINHOOD | none | EMPTY at chainID 2, while the same agent's API row carried an 80-point price series | EMPTY |
| ETH | none | not offered | not offered |

The chain numbering is not a guess: Virtuals' own `vp-trade-sdk` declares
`enum KLINE_CHAIN_ID { BASE = 0, SOLANA = 1 }` and lists no other member
(`agents-colab/vp-trade-sdk/src/constant/common.ts`). `readVpApiTrades` REFUSES
Robinhood and Ethereum by name rather than returning `[]`, because an empty list
there would read as "this agent has never traded".

The tape is keyed by the BONDING token: `preToken` while on the curve (where
`tokenAddress` is null), the same address in both columns afterwards. Every
graduated token probed - both columns, every chainID, with and without the
parameter - returned an empty tape.

### THE TAPE HAS NO CURSOR, AND THAT SHAPES THE CANDLE BUILDER (probed 2026-09-05)

Every candidate pagination parameter was sent live against CULTOS (agent 135655,
BASE, 978 trades) and every one was SILENTLY IGNORED - each returned the
byte-identical newest window (newest 1788533585, oldest 1787628387):

| parameter sent | http | effect |
|---|---|---|
| `offset=200` | 200 | ignored |
| `page=2` | 200 | ignored |
| `skip=200` | 200 | ignored |
| `before=<ts>` | 200 | ignored |
| `beforeTimestamp=<ts>` | 200 | ignored |
| `endTime=<ts>` | 200 | ignored |
| `toTimestamp=<ts>` | 200 | ignored |

The only depth knob is `limit`, and the provider states its own ceiling in its
rejection body:

    limit=1001 -> HTTP 400 {"code":-400,"message":"param limit maxLimit 1000"}

So the tape is a NEWEST-1000 SNAPSHOT, not a walkable feed, and an agent past
1000 curve trades has history no parameter can reach. `VP_API_PROVIDER_MAX_LIMIT`
records the provider's ceiling; `VP_API_MAX_LIMIT` (200) stays as the trades
TOOL's own product bound. The candle builder asks for the full ceiling and
reports `coverage.stopReason: tape_ceiling` when the tape comes back full, so a
history bounded by the ceiling is never presented as the start of the curve.

**Tape amounts are float-damaged upstream.** The tape's newest CULTOS trade
(`0x42b74f0a...`) reports `virtualTokenAmt` "0.8766472852825719" - sixteen
significant digits - while the same trade's `Swap` log carries 876647285282571920
wei exactly. The provider computes these in floating point before we see them.
The on-chain source is strictly more precise, and the tool says which one it used.

## `vp-api/klines` - DEAD, and not wired

Twelve probes: granularity 60 and 3600, five windows, timestamps in seconds AND
milliseconds, three tokens including one whose TRADE tape was non-empty in the
same session. Every one returned `{"code":0,"data":{"Klines":[]}}`. The
production front end never calls it either (confirmed in the captured XHR list
of two real agent pages). No reader is built on it.

## `api.geckoterminal.com` - pool candles

`GET /api/v2/networks/{network}/pools/{pool}/ohlcv/{timeframe}` with
`aggregate`, `limit`, `currency`, `token`, `before_timestamp`. Rows are
`[unixSeconds, o, h, l, c, volume]`, newest-first upstream; we hand back
oldest-first as decimal strings.

Bounds read out of the provider's own 400 bodies, never from convention:

- `ohlcv/week` -> `400 "Invalid timeframe. Allowed values: day, hour, minute, second"`
- `?limit=2000` -> `400 "Invalid limit. must be positive integer less than or equal to 1000"`
- `ohlcv/hour?aggregate=7` -> `400 "Invalid aggregate. Allowed values: 1, 4, 12"`
- `ohlcv/day?aggregate=4` -> `400 "Invalid aggregate. Allowed values: 1"`
- `ohlcv/minute?aggregate=4` -> `400 "Invalid aggregate. Allowed values: 1, 5, 15"`

**`aggregate` is PER TIMEFRAME** - minute 1/5/15, hour 1/4/12, day 1 - and this
is a defect the FIRST LIVE HANDLER RUN caught. The module had one global set
read from the `hour` rejection, so `timeframe: "day", aggregate: 4` passed our
boundary and came back a 400 from the provider. The three rejections above are
now committed fixtures and the boundary checks the pair, not the value.

**Declared omission - the `second` timeframe.** Legal upstream, not exposed: a
Virtuals agent chart is never read at second resolution and the bucket count
explodes.

**Not used - `app.geckoterminal.com/api/p1/candlesticks/<id>/<id>`.** This is
what the Virtuals front end actually calls, and its two numeric ids are internal
to GeckoTerminal's own UI and are not derivable from a pool address by any public
call. Building on them would mean guessing identifiers.

Rate limit: five calls spaced 1.2 s apart earned a 429 pointing at CoinGecko's
paid plans, with no rate-limit headers on the successful responses. The module
runs its own 6/min bucket with a 60 s cache and surfaces a 429 as a RETRYABLE
failure, never as an empty chart.

Coverage, measured:

| chain x stage | candles |
|---|---|
| BASE / graduated | yes (`gt_ohlcv_base_tibbir`) |
| ROBINHOOD / graduated | yes (`gt_ohlcv_rh_vex_{day,hour,minute}`) |
| SOLANA / bonding | yes - the curve is a Meteora DBC pool GeckoTerminal indexes (`gt_ohlcv_solana_pool`) |
| BASE / bonding | **404 Not Found** (`gt_pool_base_bonding_pair`): an EVM curve pair is not an indexed AMM pool |
| ROBINHOOD / bonding | same shape as Base; not separately probed |
| ETH / any | GeckoTerminal's `eth` slug exists but no Virtuals ETH agent was probed through it |

Those two 404 cells are why the curve sources below exist. GeckoTerminal stays
the source for a GRADUATED pool on every chain, and for a SOLANA bonding agent
whose curve it genuinely indexes.

## The curve sources - candles where no indexer has any (added 2026-09-05)

An `FPairV2` bonding curve on an EVM chain is not an indexed AMM pool, so no
OHLCV provider carries it. That is exactly the pre-graduation population a
trader asks about, so the bars are BUILT from the two feeds that do exist. Both
fold through `candles/bucketing.ts`, so a bar means the same thing whichever
source produced it: epoch-aligned buckets, prices and volumes as exact decimal
strings from scaled bigints, and buckets with no trades ABSENT rather than
zero-filled.

### `FPairV2.Swap` - the on-chain source (`candles/curve-chain.ts`)

    event Swap(uint256 amount0In, uint256 amount0Out, uint256 amount1In, uint256 amount1Out)
    topic0 = 0x298c349c742327269dc8de6ad66687767310c948ea309df826f5bd103e19d207

All four words are non-indexed and there is no sender topic, so topic0 alone
selects the event. Index 0 is `tokenA` and index 1 is `tokenB`. THE ORDER IS
READ FROM THE PAIR, never assumed: both pairs measured put the agent token at
index 0 and VIRTUAL at index 1, but the module still calls `tokenA()` and
REFUSES a pair it cannot match against the agent's own bonding token, because an
inverted series looks exactly as authoritative as a correct one.

| pair | chain | tokenA | tokenB |
|---|---|---|---|
| `0x3e11e685...84a` (CULTOS) | Base 8453 | agent token | VIRTUAL `0x0b3e3284...` |
| `0x0f3Ff518...C2D` (FIDUCIA) | Robinhood 4663 | agent token | VIRTUAL `0xc6911796...` |

RPC bounds, each quoted from the endpoint's own rejection (2026-09-05):

| RPC | chain | bound |
|---|---|---|
| `base.drpc.org` | 8453 | "ranges over 10000 blocks are not supported on free plan" |
| `mainnet.base.org` | 8453 | "eth_getLogs is limited to a 10,000 range" |
| `base-rpc.publicnode.com` | 8453 | unusable: "Archive requests require a personal token" |
| `rpc.mainnet.chain.robinhood.com` | 4663 | no range cap; a heavy query answers "log query timed out" |

So Base is windowed at the 10,000 both usable endpoints state, and Robinhood is
windowed to bound query COST rather than range. Per-log block timestamps are read
in JSON-RPC batches of 10, the smallest cap measured (`mainnet.base.org`:
"maximum 10 calls in 1 batch"). The scan walks BACKWARDS from the requested end
so the work budget is always spent on the bars actually asked for, and
`coverage` reports the block range covered, the windows spent and which bound
stopped it.

**Cross-checked against the tape.** The captured Base window
(`src/__tests__/virtuals/fixtures/curve-swap-logs-base-cultos.json`) ends on the
same trade the tape served as its newest row, and the two agree on every field;
the log is the more precise of the two (see the tape section above).

### Source selection, per lifecycle stage and chain

| stage | chain | default source | also available |
|---|---|---|---|
| graduated | any | `geckoterminal` (the AMM pool) | - |
| bonding | solana | `geckoterminal` (Meteora DBC pool) | `tape` |
| bonding | base | `tape` | `onchain` |
| bonding | robinhood | `onchain` (the only source there) | - |
| bonding | ethereum | none; Virtuals runs no curve there | - |

The `source` parameter overrides the default and is REFUSED BY NAME when the
requested source cannot serve the agent. `currency` applies to GeckoTerminal
only: the curve sources price in VIRTUAL per agent token as the exact ratio of
the two token amounts each swap moved, and there is no per-bucket VIRTUAL/usd
rate on that path, so a `currency` request there is refused rather than answered
in a unit the caller did not ask for.

## Capability x chain matrix (the one the tool descriptions state)

| capability | Base | Robinhood 4663 | Solana | ETH |
|---|---|---|---|---|
| screen / detail / graduations / genesis | yes | yes | yes | yes (2 agents) |
| 24 h price samples (`includePriceSeries`) | yes | yes | present but empty on the row sampled | untested |
| curve trade tape | yes (chainID 0) | **no** (no chain id in the provider's feed) | yes (chainID 1) | **no** |
| pool candles, graduated | yes | yes | yes | untested |
| curve candles, bonding | yes (`tape`, or `onchain` for depth and exactness) | yes (`onchain`; the only source there) | yes (indexed Meteora DBC pool) | **no** (Virtuals runs no curve on ETH) |
| trade a graduated agent | kyberswap | uniswap | solana tools (Jupiter) | kyberswap |
| trade a bonding agent | no venue tool yet | no venue tool yet | Jupiter routes the DBC pool | no |
| launch an agent | later lane | later lane | **unsupported**: the Meteora DBC pool creation is signed by Virtuals' backend wallet as both creator and payer, so a self-custodial launch would not be a Virtuals agent | no |

## The projection and drop table

`src/vex-agent/tools/protocols/virtuals/projectors.ts` is the only place a raw
row becomes model-facing output. Every one of the provider's 84 row fields is
either projected or listed here with its reason.

### Kept

`id`, `uid` (validated, detail only), `virtualId`, `name`, `symbol`, `chain`,
`status`, `factory`, `role`, `category`, `level`, `tokenAddress`, `preToken`,
`preTokenPair`, `migrateTokenAddress`, `lpAddress`, `walletAddress` (as
`addresses.creatorWallet`), `daoAddress`, `tbaAddress`, `veTokenAddress`,
`stakingAddress`, `agentStakingContract`, `merkleDistributor`,
`airdropMerkleDistributor`, `taxRecipient`, `revenueConnectWallet`, `createdAt`,
`launchedAt`, `lpCreatedAt`, `mcapInVirtual`, `fdvInVirtual`, `liquidityUsd`,
`volume5m/1h/6h/24h`, `netVolume24h`, `priceChangePercent5m/1h/6h/24h`,
`holderCount`, `holderCountPercent24h`, `top10HolderPercentage`,
`devHoldingPercentage`, `mindshare`, `totalSupply`, `circulatingSupply`,
`virtualTokenValue`, `totalValueLocked`, `initialPurchase*`, `isVerified`,
`isDevCommitted`, `hasMarginTrading`, `showFounderVideo`, `displayRevenue`,
`image.url`, `cores`, `creator.id`, `creator.userSocials[0].walletAddress`,
`genesis`, `vibesInfo` (subset), `launchInfo` (all 11 fields), `socials`
(VERIFIED_* only), `tokenomics`, `tokenomicsStatus`, `sparkline`, `range24h`.

### Dropped, and why

| field | reason |
|---|---|
| `creator.email` | PII. Masked at the provider (`cm***mk@p***.com`) but still a partial address. Dropped in `validation.ts`, so no later change can leak it. |
| `creator.username` | PII: the Privy account DID. Same treatment. |
| `creator.displayName`, `creator.avatar`, `creator.socials`, `creator.socialCount` | identity decoration with no decision value. |
| `projectMembers[]` | a list of third parties with their bios, socials and avatars. Nothing in it drives a decision, and all of it is other people's data. |
| `overview`, `tokenUtility`, `roadmap`, `additionalDetails` | multi-KB marketing prose from an untrusted author. Dropped, and NAMED in the reply's `omittedFreeText` so the omission is visible. |
| `description` | not dropped but REDUCED: markdown stripped (a live agent's whole description is one `![Upload](https://s3...jpg)` embed), then sanitized and cut to 280 chars. |
| `socials.TWITTER` / `.TELEGRAM` / `.USER_LINKS` (unverified) | anyone can put any handle there; only `VERIFIED_LINKS` / `VERIFIED_USERNAMES` survive. |
| `socials.VIDEO_PITCH` | three remote media URLs the agent cannot open and must not be handed as prose. |
| `aidesc`, `firstMessage`, `metadata` | null on every row sampled; no consumer. |
| `sentientWalletAddress`, `usdcV3PoolAddress`, `valueFx`, `acpAgentId`, `v3AcpAgentId`, `shouldDisplayLaunchTime`, `allowUpdateLaunchDate`, `isDelegatedOwner`, `virtualsPoolVol*` | present in the domain shape, not projected: each is either a UI flag or a duplicate of a projected metric. Re-project any of them when a tool needs it. |
| `image.formats.*`, `image.provider*`, `image.hash`, `image.size` | CDN bookkeeping; only the URL is kept, and only if it passes the https validator. |
| `tokenomics[].project`, `[].recipients`, `[].releases`, `[].linear*` | the vesting mechanics. The summary keeps name, amount, lock state and start; the schedule belongs to a tool that has a reason to read it. |

Bounds that REPORT themselves: tokenomics allocations (6 kept, `truncated` +
`totalAllocations` stated), cores (8), socials (8), the 24 h price series (96
newest points, with the dropped count in the note).

### Money-shaped fields

`virtualTokenValue` is the price in VIRTUAL at **18 decimals** - verified
arithmetically: 6576470588235294 / 1e18 x 1e9 supply = 6,576,539.7, which is
exactly the `mcapInVirtual` the same row reports. It is projected as
`priceInVirtualRaw` + `priceInVirtualDecimals` and never parsed into a float.

`totalValueLocked`, `initialPurchase`, `initialPurchasedAmount` and
`initialPairAmount` arrive as integer strings whose scale the provider does not
declare (VEX: `totalValueLocked "250326"` against `liquidityUsd 363360.39`, so
it is plainly not wei). They travel RAW with no declared decimals, and the
projection says so.

Every other numeric metric is a display-grade float with no decimals metadata.
None of them is a money-path input (rule 90: provider estimates are hints).

## The anti-sniper window (and the defect this lane fixed)

The previous implementation described the window as a POST-GRADUATION buy tax on
the Uniswap pool, anchored on `lpCreatedAt`, applicable only to graduated agents,
with three types. All four statements are contradicted by the contracts:

- `FRouterV3` is the BONDING-CURVE router; its anti-sniper tax is charged on
  curve buys and sells and routed to `factory.antiSniperTaxVault()`.
- The clock starts at the bonding PAIR's trading start
  (`pair.taxStartTime()` or `pair.startTime()`), i.e. launch, not graduation. A
  60 s window has long expired by the time an agent graduates, so the old code
  reported an ACTIVE window exactly when there was none.
- There are SIX types (`BondingConfig.sol:30-35`), and 3/4/5 exist on live rows.

| type | constant | duration | buy | sell |
|---|---|---|---|---|
| 0 | `ANTI_SNIPER_NONE` | 0 s | - | - |
| 1 | `ANTI_SNIPER_60S` | 60 s | yes | - |
| 2 | `ANTI_SNIPER_98M` | 5880 s | yes | - |
| 3 | `ANTI_SNIPER_98M_SELL` | 5880 s | - | yes |
| 4 | `ANTI_SNIPER_98M_BOTH` | 5880 s | yes | yes |
| 5 | `ANTI_SNIPER_10M` | 600 s | yes | - |

`tax = floor(99 * (duration - elapsed) / duration)`, integer division, plus the
flat 1 percent `FFactoryV2` tax, clamped so the pair can never exceed 99 percent.
The module estimates from `launchInfo.antiSniperTaxType` and `launchedAt`, labels
every answer an ESTIMATE, and returns `applicable: false` with the reason for a
graduated agent, an unknown type or a missing clock - never "0 percent, safe to
buy". The trade lane re-reads the pair on chain before signing; that read, not
this one, is the money authority.

## Contracts (for the lanes that trade and launch)

| what | Base 8453 | Robinhood 4663 |
|---|---|---|
| BondingV5 | `0x1a540088...` | `0xd4cCBFA37e2f35611b3042e4096Ad7a3459Bd007` |
| FRouterV3 | `0x02fe8ec3...` | `0xCa6395246B4382Ba70F886526dD9a9De984F6081` |
| FFactoryV2 | `0x488Db0978b34C6Fd901760b9024B565C1117c7c8` (buyTax 1, sellTax 1) | `0xFC2E4Da3EdB2E18100473339c763705d263D20A9` |
| VIRTUAL | `0x0b3e3284...` | `0xc6911796...D9c31` |
| AgentTaxV2 (`FFactoryV2.taxVault()`) | `0x617Fd668c5b0d1906C0B3E7E3E49d1409Df0a528` | `0x6D80B81d9Fc56A7A839b1Af9006Eb49151961ce7` |
| AgentTaxV2 implementation | `0xF6dEd65faaB429b2d5E13552D618a2E231f3D129` | `0x4D4e8F06FE9a3dB2FA7AD4D17893128600Ec01bB` |

Curve params 8500 / 42000 VIRTUAL on both chains; launch fee 0, or 10 VIRTUAL
with ACF. Full provenance in
`agents-colab/agents_dm/launchpads-plan-2026-09-04.md` section 14.

## Creator fees - AgentTaxV2, and why the claim is `unsupported`

`virtuals__creator_fees_get` answers what an agent's creator has earned from the
bonding-curve trading tax. Everything below was READ FROM THE CHAIN on
2026-09-04 (Base at block 50881423 / 50882184, Robinhood at 54534905 / 54550068),
not taken from a document.

### Where the money sits, and what it is denominated in

`FFactoryV2.taxVault()` IS the AgentTaxV2 proxy, so the tool reads the vault
address from the factory at call time rather than trusting a constant. The
contract collects in one asset and pays in another, and they are not the same:

| chain | taxToken (collected) | assetToken (paid to the creator) | feeRate | minSwapThreshold | maxSwapThreshold |
|---|---|---|---|---|---|
| Base 8453 | VIRTUAL `0x0b3e3284...`, 18 dec | USDC `0x833589fC...`, 6 dec | 3000 / 10000 = 30% | 10 VIRTUAL | 1000 VIRTUAL |
| Robinhood 4663 | VIRTUAL `0xc6911796...`, 18 dec | USDG `0x5fc5360D...`, 6 dec | 3000 / 10000 = 30% | 1 VIRTUAL | 1000 VIRTUAL |

Treasury on both chains: `0xb51C52d9E5E41937B0100840b6C3CBA6f7A57A0C`. A raw
number carried without its asset here is out by 10^12, so every amount the tool
returns ships with its address, symbol, decimals, raw integer and human string.

### The getters, what each one denominates, and where it comes from

| getter | returns | denomination | note |
|---|---|---|---|
| `getTokenTaxAmounts(token)` | `amountCollected`, `amountSwapped` | taxToken raw (VIRTUAL, 18) | cumulative; `pending` is DERIVED as the difference, the contract stores no third number |
| `getTokenRecipient(token)` | `tba`, `creator` | addresses | an unregistered token answers `(0x0, 0x0)` and does NOT revert (measured against `0x...dEaD`) |
| `getTokenPartnerConfig(token)` | `partnerId`, `partnerFeeRate` | parts in 10000 | zero for every Base agent scanned; 2000 (20%) for five Robinhood agents sharing partner id `0x576cb4e2...` |
| `partnerRecipients(partnerId)` | address | address | zero here REVERTS the distribution ("Partner recipient not set") |
| `feeRate()` | protocol fee | parts in 10000, applied to the SWAP OUTPUT | 3000 on both chains |
| `min/maxSwapThreshold()` | swap bounds | taxToken raw | below min the swap returns early; above max one swap moves at most the cap |
| `treasury()` | address | address | where the protocol fee goes |
| `hasRole(SWAP_ROLE, account)` | bool | - | the measurement behind the refusal |
| `balanceOf(taxVault)` on taxToken | vault balance | taxToken raw | shared across every token; NOT one agent's share |

The split `_swapAndDistribute` performs, in order: protocol fee, then partner
fee, then the creator takes the remainder, each fee clamped so it cannot exceed
what is left. With no partner that is 30 / 0 / 70; with the measured Robinhood
partner it is 30 / 20 / 50.

### The claim is refused, and the refusal is measured

AgentTaxV2 pays a creator ONLY inside `_swapAndDistribute`
(`contracts/tax/AgentTaxV2.sol:300`), which is reachable only through
`swapForTokenAddress` (`:211`) and `batchSwapForTokenAddress` (`:227`), both
`onlyRole(SWAP_ROLE)`. Virtuals' backend holds that role. Measured on both
chains: `hasRole(SWAP_ROLE, creator)` and `hasRole(SWAP_ROLE, tba)` are BOTH
false for CULTOS (Base) and BLOOPA (Robinhood). There is therefore no
transaction Vex could sign that collects this, and none is offered.

There is also nothing left to claim afterwards: when the backend swaps, the
creator's share is TRANSFERRED to the creator address. The tool says so, names
the venue that triggers the swap (the Virtuals app), and never returns a zero or
an error in place of the explanation.

Three states the tool keeps apart by name: a chain with no AgentTaxV2 (solana,
ethereum) answers `supported: false` with that reason; a token with no
registered recipient answers `registered: false` with the contract's own
`"Token not registered"`; a chain that will not answer is a failure that
explicitly denies saying anything about earnings.

### Genesis participation is `unsupported`, for a different measured reason

`Genesis.participate(pointAmt, virtualsAmt)`
(`contracts/genesis/Genesis.sol:243`) transfers the caller's VIRTUAL
immediately and does nothing with `pointAmt` except emit it - no validation, no
signature, no derived allocation. The allocation is computed off chain by
Virtuals' backend and written later by `onGenesisSuccessSalt`, which is
`onlyRole(FACTORY_ROLE)` and carries the winners as calldata arrays (`:274`,
`:390`). Refunds run through the same privileged path. A self-custodial call
would spend real funds against points Vex cannot obtain or prove, so the
refusal ships in the calendar read's own `participation` block rather than as a
tool that exists only to say no. The calendar itself (`virtuals__genesis_launches_list`)
is the supported half.

### `api2.virtuals.io` revenue-connect: read, labelled, and not believed

`GET /api/revenue-connect-metrics/virtuals/{id}?metric=summary` answers
`{totalRevenue, totalTokenAccumulated, totalTokenAccumulatedUsd}`. Measured
2026-09-04 it returned ALL ZEROS for every agent probed - 135655 CULTOS, 133649
BLOOPA, 96200 VEX, and 18820 TIBBIR, 130418 HALO, 1199 AIXBT (the three largest
on Base by market cap) - while those agents held thousands of VIRTUAL of accrued
tax on chain at the same moment. `metric=bogusMetricXyz` answered HTTP 200 with
`{"data": []}`, the same silent-ignore behaviour the main API has for an unknown
filter key. It is therefore carried as a labelled provider claim about a
DIFFERENT revenue stream, tolerant and nullable, never as the answer, and never
subtracted from the on-chain numbers.

## Known gaps, stated rather than hidden

1. **Ordered multi-sort** is reachable upstream and not exposed (reason above).
2. **`second` candles** are legal upstream and not exposed (reason above).
3. **`noCache`** is accepted upstream and not exposed (no observable effect).
4. **ETH coverage of the market-history tools** was never probed against a real
   ETH agent - the chain holds two - so those cells are reported as unsupported
   rather than claimed.
5. **Robinhood bonding candles** no longer depend on that inference: the chain
   is served by the on-chain source, proven live on FIDUCIA (agent 139254, pair
   `0x0f3Ff518...C2D`, 128 `Swap` logs) whose tape is empty at every chainID.
10. **A `token` or `chain` subject** for the candle read is NOT exposed; the
   numeric agent id is the only subject, because it already determines the
   chain, the bonding token and the pair, and the provider's own row is the
   authority for all three. Named here rather than left as an undeclared gap.
11. **Solana bonding depth** is bounded by whichever source answers: the indexed
   pool has GeckoTerminal's own history, and the tape stops at its 1000-trade
   ceiling. There is no third source on that chain, so the oldest bucket the
   tool can offer there is the oldest one of those two carry.
12. **The on-chain source's work budget** (40 log windows, 600 block-header
   reads per call) is a bound on WORK, not on the answer: when it stops, the
   coverage block names the bound and hands back the cursor that resumes exactly
   there.
6. **`filters[status]=5`** filters 236 rows on BASE and we do not know what it
   means, so it is not exposed.
7. **`api2.virtuals.io`** mirrors `api.virtuals.io` (identical totals) and
   carries endpoints this module mostly does not use
   (`/api/tokens/{addr}/holders`, `/api/dex/token-reserves/{pair}`,
   `/api/project-update/{id}/tweets`). Each is a candidate for a later read.
   `/api/revenue-connect-metrics/{id}?metric=summary` IS wired now, by the
   creator-fee read, as a labelled provider claim (section above); its other
   metrics (`tradingFeeRevenue` and whatever else the app requests) are not,
   because an unknown metric name is indistinguishable from a real empty series.
8. **The revenue-connect summary was all zeros for every agent probed**, so the
   tool carries that measurement beside the number rather than pretending the
   zero is informative. If a non-zero is ever observed, the label should be
   revisited with that evidence.
9. **A partner fee split** was found on five Robinhood agents and on no Base
   agent among the 110 scanned. What the partner id `0x576cb4e2...` names is not
   known, so the tool reports the id, the rate and the recipient without
   interpreting them.
