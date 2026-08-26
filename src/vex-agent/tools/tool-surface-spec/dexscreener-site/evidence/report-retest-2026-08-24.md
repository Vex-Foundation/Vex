# Live re-test of the 16 planned tools, 2026-08-24 (second measurement pass)

Every planned tool was simulated end to end against the live provider, one
scripted call per tool family, from the same runtime as the first pass
(`curl_cffi impersonate=chrome`). Scripts and raw JSON archives:
`<scratchpad>/claude-retest/sim_{screen,search,details,candles,trades,rest}.py`
and the matching `*.out.json`. This pass ran while Codex's independent turn-2
probe matrix was in flight; the two are separate measurements.

## Screening family (tools 1-6), one WS call each, solana

| Tool sim | rows | pairsCount | bytes | latency | derived metrics complete |
|---|---|---|---|---|---|
| trending (trendingScoreH1) | 100 | 11,017 | 92 KB | 861 ms | 100/100 |
| top volume + site floor | 100 | 1,336 | 87 KB | 726 ms | 88/100 |
| gainers + site floor | 100 | 159 | 92 KB | 746 ms | 80/100 |
| losers + site floor | 100 | 159 | 92 KB | 759 ms | 74/100 |
| new pairs (age<=24h, liq>=1000) | 100 | 246 | 81 KB | 755 ms | 55/100 |
| launchpad bonding (pumpfun, prog<=99.99) | 100 | 3,021 | 71 KB | 765 ms | 0/100 (see below) |

- All derived metrics from plan 4.8 (`netFlowUsd`, `buySellRatio`,
  `transactionsPerMaker`, `turnoverRatio`, `volumeAccelerationRatio`,
  `chainVolumeSharePct`) computed live from single frames. Example: SOL/USDC on
  orca = 17.16 percent of all solana h24 volume; gainers top row +1,701 percent
  WITH the quality floor (real move, not the +7.2e12 garbage of the unfloored sort).
- **New fact: bonding-curve rows carry NO `liquidity` field (0 of 100) and no
  `labels`/`boosts`/`cmsProfile`.** They do carry marketCap, fdv, volume,
  volumeBuy/Sell (80/100), buyers/sellers/makers, txns, priceChange, launchpad
  progress/creator. `launchpad_pairs_list` must project marketCap as the size
  column and declare liquidity `not_applicable` for the bonding stage, and
  `turnoverRatio` is not computable there (input missing, null + missingInputs).

## Resolve family (tools 7-9)

- Search `q=PEPE` global: 30 rows, 6 chains. `chainId=solana|base|bsc` scoped
  server-side: 30 rows single-chain, ~200 ms. Confirms the undocumented param.
- **New fact: an exact token address is ALSO capped at 30 rows.** PEPE
  (ethereum) returned exactly 30 pairs for a token that trades in more venues
  (GoPlus lists 26 ethereum venues alone; pulsechain fork pairs join the same
  window because the forked chain carries the same address). `token_pairs_list`
  therefore inherits `bounded_non_pageable` with `providerCapped: true` at 30,
  and the first pass's "every pair of that token" claim holds only under the cap.
  Derived shares still work: deepest PEPE pool = 91.54 percent of returned liquidity.
- Pair WS first frame (pair_get): 960 B, 443 ms, carries buyers/sellers/makers
  and the buy/sell volume split for all four windows. Reactions endpoint: 142 B.

## Deep dive (tools 10-13)

Pair details, three chain classes, one call each:

| Target | bytes | ms | blocks present |
|---|---|---|---|
| ethereum PEPE | 12,008 | 82 | cg, gp(38 fields), cms, qi, su |
| solana trending pair | 4,821 | 19 | cms, ll(100 pct locked), holders(40 rows), ta |
| solana bonding pair | 3,918 | 45 | holders(38 rows), ta |

- **New fact: the solana `holders` block returned 40 rows** (first pass assumed
  a top-10-style list). Concentration derived live: trending pair top10 = 25.46
  percent of rows covered; bonding pair top10 = 99.09 percent, a ready red flag.
- Catalog nuance to resolve at implementation: `integrations` key presence in
  the chains catalog (56 chains list goPlus) is broader than working audit
  coverage measured through pair-details (21). Presence of the integration key
  is not proof the block answers; `coverage` must come from the response, never
  the catalog.

Candles (tool 11):

- 999-bar cap re-confirmed; `bbn` backward paging continuous (gap exactly 1.00 h).
- **Headline: any historical window is reachable in TWO calls, no page walk.**
  `GetTransactions(timestampEnd=windowEnd)` resolves a block (271 ms), then
  `bars?bbn=block+1&cb=N` returns exactly the requested window: measured
  2024-03-01 00:00 -> 2024-03-02 23:00 UTC, 17 months back, 48 H1 bars, 533 ms,
  7,153 B. This replaces the plan's bounded backward walk for `startAtMs`/`endAtMs`
  whenever the window is under 999 bars; wider windows continue with `bbn` from
  the returned page. The 44-page/527-page cost projections apply only to the
  degenerate "walk from now" strategy, which is now the fallback, not the plan.
- **Negative measure: `abn` (afterBlockNumber) does NOT anchor a forward read.**
  With `abn=<block at 2024-03-01>` the endpoint returned the newest 48 bars
  (2026-08). Do not expose or rely on `abn`.
- Transport split re-confirmed: HTTP 400 for `D` and for `5S`; the feed WS
  serves S5 (100 five-second bars), D1 (999 rows back to 2023-11-30), W1 (176
  rows to the pair's 2023-04-13 launch), and MARKET_CAP without a supply argument.
  The 18-member resolution enum stands, `5s` included (WS transport).

Trades (tool 12), Connect GetTransactions:

- Default page 100 rows/27 KB/285 ms with the full per-trade counterparty
  profile (verified live: buys=26 sells=34 in=135,844 out=139,496 retained
  0 percent, newOnPair=false, firstSwap echoed).
- `type=buy` exact (100/100 buys), `volumeUSDMin=1000` exact (min seen 1,024),
  one-hour timestamp window exact to the second (34 rows, all inside),
  `maker=<wallet>` returns that wallet's history (100/100 same maker),
  block-cursor paging monotonic. Wrong-case `type='BUY'` answers the structured
  `400 {"code":"invalid_argument"}`.
- Aggregate block computed from one fetch: buys=61 sells=39 netFlow +5,759 USD,
  30 unique buyers, 32 unique sellers, newOnPairShare 11 percent, size histogram,
  largest 20,125 USD.

Top traders (tool 13): all four sorts return 100 rows, 12-14 KB, ~250 ms;
`mda=7` works. pnl-sorted top wallet: in 114,438, out 291,732, net +177,294 USD.

## Context and reference (tools 14-16)

- Narratives `chainId=solana`: 18 rows, 3.2 KB, with marketCap, change/delta per
  window, tokenCount; `volumeToMarketCapRatio` derived live.
- Spotlight: 30 top boosts + 30 recent + 36 latest profiles, 23 KB, one call.
- Chains catalog: 74 chains, 63 KB; solana carries 16 dexes, 8 integration keys,
  4 explorer URL templates.

## Consequences for the plan (to fold into v1.2)

1. `candles_list` time-range strategy switches to the block-anchor: resolve
   `endAtMs` via GetTransactions, one candle call per 999-bar span. `maxPages`
   and the deadline stay as bounds, but the common case is O(2 requests).
2. Drop `abn` from the design entirely (measured dead as an anchor).
3. `token_pairs_list` documents the 30-row provider cap (`providerCapped`) and
   the cross-chain fork-address effect; `chain` param narrows server-side.
4. `launchpad_pairs_list` projects marketCap, not liquidity, for bonding rows;
   missing liquidity is `not_applicable`, not null-as-zero.
5. `pair_details_get` holders depth is chain-dependent (40 rows seen on solana);
   `rowsCovered` stays mandatory next to any concentration percentage.
6. Coverage maps come from responses, not the catalog integrations keys.
