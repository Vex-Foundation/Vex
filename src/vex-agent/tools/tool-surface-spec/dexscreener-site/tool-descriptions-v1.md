# DexScreener v2: retrieval text and model-visible descriptions (authored by the coordinator)

Status: v1, 2026-08-24. Owner decisions governing this file (recorded in
tool-plan-v1.md revision v1.2):

- The FULL intent-shaped set ships. The Studio MCP surface exports only internal
  tools plus the Vex tool-search tool; DexScreener tools are discovered and
  unlocked through that search tool, so the static-export cost argument against
  many tools does not apply (owner, 2026-08-24).
- No artificial Vex-side caps. Provider realities (999 bars per call, 30-row
  search window, 100 rows per page) are reported honestly in the envelope;
  everything above them is reachable through explicit paging or walking, and
  parameter descriptions emphasise what the agent CAN do, not what it may not.
- Cross-tool handoffs are part of the surface: token profile links hand off to
  `TwitterAccount` (verify the project's X account) and `WebResearch` (check the
  website); narrative IDs hand off to the screening tools; `chains_list` is the
  vocabulary source for every chain and dex value.
- The coordinator authors every passage below personally; builders consume them
  verbatim (spelling fixes only through the coordinator).

Authoring rules applied (from the measured retrieval pipeline): only
`discovery.embeddingText` is embedded, as `title: <toolId> | text: <passage>`;
passages are English-only, 60-110 words, carry `Use this when` and
`Example queries:` anchors, front-load the distinguishing noun, name chains in
prose, and share NO sentence with any sibling passage. Polish user vocabulary
goes into `aliases` and `exampleIntents` (lexical fallback lane; the only
surface where Polish is legal). `description` is a separate string for the
model at call time: technical, with unit anchors, "Returns ...", if-omitted
semantics, and honest caps. Full parameter tables live in tool-plan-v1.md
section 4; builders take schemas from there and text from here.

---

## 1. dexscreener__pairs_trending_list (`dexscreener.pairs.trending`)

canonicalSummary: Rank the hottest trading pairs on a chain by DexScreener's
trending score for a 5m, 1h, 6h, or 24h window.

embeddingText:
Trending pairs and hot tokens ranked by DexScreener's trending score for a
selected window: 5 minutes, 1 hour, 6 hours, or 24 hours, on Solana, Base,
Ethereum, BSC, or any of 74 chains. Returns the same ordering as the
DexScreener homepage, each row with price change, volume, liquidity, market
cap, buyers versus sellers, and its share of the whole chain's volume. Use this
when the user asks what is hot, moving, or gaining attention right now; for
strict metric leaders call dexscreener__pairs_top_list instead. Example
queries: what is trending on solana, hottest memecoins right now, top trending
pairs last hour, what is moving on base today, show me hyped tokens.

aliases: trending pairs, hot tokens, co pompuje, na topie teraz, gorace tokeny
exampleIntents: "co jest teraz na topie na solanie", "pokaz trendy ostatniej
godziny", "hottest pairs on base right now"

description (model-visible draft):
List pairs ranked by DexScreener's trending score for the selected `window`
(m5, h1, h6, h24) on the selected chains. Use this when the question is about
attention and momentum rather than a strict metric sort. Returns up to 100 rows
per page with price, priceChange, volume, liquidity, marketCap, buys/sells,
buyers/sellers/makers, derived flow ratios, and the volume share: `chainVolumeSharePct` only when the
query is one chain with no other row-excluding filter, otherwise
`filteredSetVolumeSharePct` (the denominator is the filtered set, and the
field name says which); the
envelope carries the provider's total match estimate and `marketStats` for the
whole filtered set. All screening filters (liquidity, volume, age, dex,
narrative, launchpad) apply. Trending order mixes organic activity with paid
boosts; boost counts are shown per row so the agent can judge.

## 2. dexscreener__pairs_top_list (`dexscreener.pairs.top`)

canonicalSummary: Rank pairs on a chain by a hard metric: volume, transactions,
buys, sells, liquidity, or market cap, for a chosen window.

embeddingText:
Top pairs by a hard metric: highest volume, most transactions, most buys or
sells, deepest liquidity, or largest market cap, per 5-minute, 1-hour, 6-hour,
or 24-hour window, on Solana, Ethereum, Base, BSC, and 70 more chains. Answers
league-table questions with exact numbers per row and the chain's own totals
for scale. Use this when the user wants leaders by a measurable metric; for
attention-based ranking use dexscreener__pairs_trending_list. Example queries:
top volume pairs on solana today, most traded tokens last hour, biggest
liquidity pools on base, highest market cap memecoins, most active pairs by
transactions.

aliases: top volume, most traded, najwiekszy wolumen, najczesciej handlowane,
lista topowych par
exampleIntents: "najwiekszy wolumen 24h na solanie", "most traded pairs on bsc
right now", "pokaz najplynniejsze pule"

description (model-visible draft):
List pairs ordered by a chosen `sortBy` metric (volume, txns, buys, sells,
liquidity, marketCap, boosts) within the selected `window`; `minBoostCount`
and `maxBoostCount` bound the paid-boost axis; every maximum threshold here
matches only rows that CARRY the field, so `maxBoostCount` bounds within the
boosted population and excluding ads entirely is a client-side filter. Use this for league-table
questions with measurable answers. Returns metric-complete rows plus derived
ratios (turnover, net flow, transactions per maker) and the filtered set's
aggregate stats. `fdv` sorting is not offered because the provider returns a
wrong ordering for it (measured defect); filter by `minFdvUsd`/`maxFdvUsd` and
sort by marketCap instead.

## 3. dexscreener__gainers_list (`dexscreener.gainers`)

canonicalSummary: Biggest price gainers on a chain for a window, with a real
quality floor against manipulated illiquid pairs.

embeddingText:
Biggest gainers: pairs with the largest price increase over 5 minutes, 1 hour,
6 hours, or 24 hours on any chain DexScreener indexes. Applies the site's own
quality floor by default (minimum transactions, sellers, volume, and liquidity)
because an unfloored price-change sort returns broken billion-percent rows;
every floor value is echoed and each can be loosened or removed by the agent.
Use this when the user asks what pumped, mooned, or gained the most; for
declines call dexscreener__losers_list. Example queries: biggest gainers today
on solana, what pumped last hour, top price increases 24h, best performing
memecoins this week, largest green candles on base.

aliases: gainers, biggest pumps, najwieksze wzrosty, co urosło dzisiaj, zyski 24h
exampleIntents: "co najbardziej urosło dzisiaj", "najwieksze pumpy ostatniej
godziny na solanie", "top gainers on base"

description (model-visible draft):
List pairs by price change descending for the selected `window`, with the
site's default quality floor applied and echoed in `filtersApplied`. Override
any threshold with a number, or set `disableQualityFloor: true` to drop every
default floor at once; `qualityFloorApplied` reflects what was actually sent. Use this when the question is about
the strongest risers. Returns price change for all four windows, volume,
liquidity, flow ratios, and pair age, so a fresh low-liquidity spike is
distinguishable from a sustained move. Without the floor the provider's top
rows are arithmetic artifacts; removing it is explicit, never silent.

## 4. dexscreener__losers_list (`dexscreener.losers`)

canonicalSummary: Biggest price losers on a chain for a window, same quality
floor as gainers, ascending order.

embeddingText:
Biggest losers: pairs with the deepest price drop over 5 minutes, 1 hour, 6
hours, or 24 hours on any indexed chain, quality-floored the same way the
DexScreener losers page is so dead pairs do not drown the answer. Shows how
hard each token is dumping, who is selling into it, and whether liquidity is
leaving. Use this when the user asks what is crashing, dumping, or bleeding;
rising pairs live in dexscreener__gainers_list. Example queries: biggest losers
today, what is dumping on solana right now, worst performing tokens 24h,
largest price drops this hour, what crashed on base.

aliases: losers, biggest dumps, najwieksze spadki, co spada, czerwone tokeny
exampleIntents: "co najbardziej spada dzisiaj", "najwieksze dumpy na solanie",
"worst performers last 24h"

description (model-visible draft):
List pairs by price change ascending for the selected `window`, floored and
echoed exactly like the gainers tool. Use this when the question is about the
deepest declines. Returns the same row shape as gainers including sell-side
flow (sellers, sell volume share, net outflow in USD), which is what
distinguishes a real exodus from a thin-book wick.

## 5. dexscreener__pairs_new_list (`dexscreener.pairs.new`)

canonicalSummary: Newly created pairs on a chain, newest first, with age and
liquidity floors the agent controls.

embeddingText:
New pairs and fresh token listings, newest first, with exact age in seconds,
starting liquidity, first-hours volume, and buyer flow, on Solana, Base, BSC,
Ethereum, and every other indexed chain. Defaults to pairs younger than 24
hours with a small liquidity floor; the agent can widen to any age or drop the
floor entirely. Use this when the user asks what just launched or wants brand
new tokens to inspect; for bonding-curve launchpad listings call
dexscreener__launchpad_pairs_list. Example queries: new pairs on solana last
hour, tokens launched today, fresh listings with liquidity above 50k, newest
memecoins right now, what launched on base.

aliases: new pairs, fresh listings, nowe pary, nowe tokeny, swieze listingi
exampleIntents: "nowe pary z ostatniej godziny", "co dzisiaj wystartowalo na
solanie", "new tokens with 20k liquidity"

description (model-visible draft):
List pairs ordered by creation time, newest first, filtered by `maxPairAgeSeconds`
(default 86400) and `minLiquidityUsd` (default 1000; disable it with
`disableQualityFloor: true`, which also readmits bonding-curve pairs that
carry no liquidity field at all). Use this when recency is the question. Returns exact `pairAgeSeconds`, liquidity, early
volume and buys/sells, `volumeAccelerationRatio` (is the last five minutes
hotter than the trailing hour), and the launchpad origin when the pair
graduated from one. Age filters are hours-precise on the provider; sub-hour
precision comes from the returned timestamps.

## 6. dexscreener__launchpad_pairs_list (`dexscreener.launchpad.pairs`)

canonicalSummary: Launchpad boards: tokens still on a bonding curve or already
graduated, per launchpad and chain, with progress percent.

embeddingText:
Launchpad tokens on bonding curves: pump.fun, LaunchLab, Meteora DBC, Bags on
Solana, Four.meme on BSC, with bonding progress percent, creator wallet, market
cap, and buyer flow, plus graduated boards for tokens that completed the curve
and migrated to a DEX. Handles DexScreener's hidden default that normally
excludes bonding-curve pairs from every list. Use this when the user asks about
pump.fun launches, graduation progress, or pre-graduation snipes; ordinary new
DEX pairs live in dexscreener__pairs_new_list. Example queries: pump fun tokens
near graduation, bonding curve above 80 percent, new launchlab launches,
graduated pumpfun tokens today, four meme board.

aliases: launchpad, pump.fun, bonding curve, pumpfun graduation, tokeny z
launchpada
exampleIntents: "co jest blisko graduacji na pump.fun", "pokaz bonding curve
powyzej 90 procent", "swieze graduaty pumpfun"

description (model-visible draft):
List launchpad pairs by `stage`: `bonding` (still on the curve, ranked by
progress, price change, volume, or age; scope bonding boards by `dexIds`,
because `launchpadIds` matches only graduated rows) or `graduated` (completed
and migrated, ranked by trending, age, or market cap; scope by `launchpadIds`).
Use this for launchpad questions;
the provider hides bonding pairs from normal screens and the tool lifts that
exclusion internally. Returns progress percent, creator address, migration
dex, market cap, and flow. Bonding rows carry NO liquidity field by provider
design (measured): size comparisons use `marketCapUsd`, and liquidity reads
`not_applicable` rather than zero.

## 7. dexscreener__pairs_search (`dexscreener.search`)

canonicalSummary: Find pairs by token name, symbol, or address, optionally
scoped to one chain server-side.

embeddingText:
Search pairs by token name, ticker symbol, or contract address, across all
chains or scoped to one chain like Solana or Base, honoured server-side. An
exact contract address returns that token's pools directly; text returns up to
30 relevance-ranked matches with full metrics per row. Use this when the user
names a token whose address is not yet known; once a result is chosen,
continue with dexscreener__pair_get or dexscreener__token_pairs_list. A ticker
is not identity: same-name copycats are normal, so verify by address,
liquidity, and age. Example queries: find PEPE on solana, search token by
name, contract for WIF, lookup this address, find bonk pairs.

aliases: search token, find pair, znajdz token, wyszukaj po nazwie, szukaj
kontraktu
exampleIntents: "znajdz PEPE na solanie", "jaki jest kontrakt WIF", "search dog
tokens on bsc"

description (model-visible draft):
Search by `query` (name, symbol, or address), optionally scoped by `chain`
(server-side). Use this when identity is not yet established. Returns up to 30
rows per chain queried; the provider window is fixed at 30 with no
continuation, and the envelope sets `providerCapped` with narrowing advice
(scope by chain, or query an exact address). Multiple chains issue one bounded
request per chain and merge, reported per chain. Copycat names are common:
check `liquidityUsd`, `pairAgeSeconds`, and the address before treating a match
as the real token.

## 8. dexscreener__token_pairs_list (`dexscreener.tokenPairs`)

canonicalSummary: The pools a token trades in, deepest of the returned window
first, with each pool's share of the returned liquidity and volume.

embeddingText:
Pools and markets for one token address: the DEX pairs where it trades,
deepest first within the provider's returned window, with each pool's share of
the returned liquidity and volume, labels like CLMM or v3, and the quote
asset. Answers where a token trades, which returned pool is deepest, and
whether liquidity looks concentrated or fragmented, the routing input before
any swap. Use this when identity is known by address; to find the address
first use dexscreener__pairs_search. Example queries: pools for this token,
where does WIF trade, deepest returned pool for this address, liquidity split
across dexes, which pair should I chart.

aliases: token pools, all markets, pule tokena, gdzie handlowac, najglebsza pula
exampleIntents: "pokaz wszystkie pule tego tokena", "gdzie jest najwieksza
plynnosc dla WIF", "which pool is deepest"

description (model-visible draft):
List the indexed pools for `tokenAddress` on `chain`, ordered by liquidity
descending; the provider serves a bounded window of at most 30 pools, so a
high-pool-count token is partially covered and the envelope says so. Use this to pick the canonical venue before charting, trading, or
deep analysis. Returns per-pool `liquiditySharePct` and `volumeSharePct`,
`venueCount`, `totalLiquidityUsd`, and `deepestPair` as an explicit summary.
`deepestPair` means deepest among the returned window, never a global claim;
`resolutionBasis` is echoed. When the token trades in more pools than the
window, `providerCapped` is set with narrowing advice. A
forked chain carrying the same address can appear; rows are chain-tagged and a
`chain` filter narrows server-side.

## 9. dexscreener__pair_get (`dexscreener.pair.get`)

canonicalSummary: Full live snapshot of one pair in one call: price, flow,
makers, and all four time windows.

embeddingText:
Live snapshot of a single pair: current price in USD and native units, price
change, volume, buys and sells, distinct buyers, sellers, and makers for all
four windows (5m, 1h, 6h, 24h), buy versus sell volume split, liquidity, market
cap, FDV, pair age, boosts, and the token's profile links. About one kilobyte,
suitable for polling a position. Use this when one specific pair is already
identified and the question is its current state; for safety audits and holders
call dexscreener__pair_details_get. Example queries: current price of this
pair, live stats for this pool, how is this token doing right now, quick
snapshot of this address, poll this position.

aliases: pair snapshot, live price, cena teraz, stan pary, podglad pozycji
exampleIntents: "jaka jest teraz cena tej pary", "pokaz stan tej puli", "how is
this pair doing"

description (model-visible draft):
Get one pair's full live state by `chain` plus `pairAddress` or `tokenAddress`
(a token resolves to the deepest pool of the provider's bounded search window,
with `resolvedFrom` and `resolutionBasis` echoed). Use this for
current-state questions about a known pair. Returns the complete windowed
metric set including buyers/sellers/makers and the buy/sell volume split
(fields the public API never had), derived flow ratios, and profile links.
Optional `fields: profile` (issuer links and description; not in the default
projection) and `include: reactions,insight` (side reads, each costing one
extra provider request: crowd emoji counters, and a provider-generated text
blurb that exists only for roughly 1,200 Solana tokens and answers absent
elsewhere, labelled as such). Profile links can be verified
onward: X/Twitter via the TwitterAccount tool, the website via WebResearch.

## 10. dexscreener__pair_details_get (`dexscreener.pair.details`)

canonicalSummary: Safety and ownership report for a pair: audits, taxes,
honeypot flags, holders, LP locks, supply, and listings.

embeddingText:
Token safety report: GoPlus and QuickIntel audits with honeypot flags,
taxes, mint and blacklist capability, contract verification, owner balances,
holder concentration, LP lock percentage, supply, Solana mint and freeze
authority, and CoinGecko or CoinMarketCap listings. Coverage comes from the
response and is reported per source: native and GoPlus holder lists stay
distinct, percentages keep provider units beside normalized values, and a
missing block reads unavailable, never clean. Use this when the user asks
if a token is safe, a honeypot, a rug risk, or who holds it. Example queries:
is this token safe, honeypot check, who holds this token, is liquidity
locked, what are the taxes, can the owner mint.

aliases: safety check, honeypot, audyt tokena, kto trzyma token, czy scam,
liquidity lock
exampleIntents: "czy ten token to scam", "sprawdz honeypot i podatki", "kto ma
najwiecej tego tokena", "czy plynnosc jest zablokowana"

description (model-visible draft):
Get the safety and ownership report for a pair (or token, resolved to its
deepest pool). Use this before any buy decision or when risk is the question.
Returns per-provider audit blocks kept separate with their disagreements
listed, tax values as `{raw, normalizedPct, unit}`, top holders with
`rowsCovered` next to every concentration percentage, LP locks, supply, and
authority flags. Coverage is derived from the response, never the catalog, and reported per
source (native holders versus GoPlus holders stay distinct), and every
percentage carries its provider unit plus `normalizedPct`; an absent block is
`unavailable` with the reason.
No composite score is emitted: the numbers are the report. Project socials in
the profile hand off to TwitterAccount and WebResearch for off-chain
verification.

## 11. dexscreener__candles_list (`dexscreener.candles`)

canonicalSummary: OHLCV candles from 1 second to 1 month for any pair, any
time period, in USD or native, as price or market cap.

embeddingText:
OHLCV candles and price history for any pair on any chain: resolutions
from 1 second through 1m, 5m, 1h, 4h to daily, weekly, monthly, in USD or
native quote, as price or market-cap series, up to 999 bars per call with
continuous paging back to the pair's first block. A start and end time
select any historical window: the nearest prior trade anchors it, with
anchor distance and coverage reported. Use this when the user wants a chart,
price history, volatility, or OHLC data. Example queries: 1 hour candles for
this pair, price chart last week, OHLC data since launch, 5 minute candles
yesterday, market cap history, daily chart.

aliases: candles, OHLC, price chart, swieczki, wykres ceny, historia cen
exampleIntents: "pokaz swieczki 1h z ostatnich 3 dni", "wykres dzienny od
startu", "5 minute candles for yesterday", "godzinowe OHLC z marca"

description (model-visible draft):
Get OHLCV candles for a pair by `chain` plus `pairAddress` or `tokenAddress`.
Use this for any chart, trend, volatility, or history question. `resolution`
is one of 18 values from `1s` to `1mo`; `limit` up to 999 per call (the
provider's page size); `startAtMs`/`endAtMs` select any historical window,
resolved internally through a block anchor so an arbitrary period costs two
requests, not a page walk; deeper ranges continue with the exact `nextBeforeBlock` cursor. `series`
chooses price or marketCap (no supply argument needed); `priceBasis` usd,
native, or both; `inverted` flips the pair. Returns column-oriented rows plus
a summary block: period change percent, high and low with their timestamps,
total volume, largest single-candle move, gap count, and whether the newest
bar is still forming. The envelope reports pages walked and the exact covered
range against the requested one.

## 12. dexscreener__trades_list (`dexscreener.trades`)

canonicalSummary: Trade-by-trade history for a pair with a counterparty
profile on every row, filters on side, size, time, and wallet.

embeddingText:
Trade history for a pair: each buy and sell with price, USD size,
timestamp, transaction hash, and the counterparty wallet's profile on the
row: lifetime buys and sells here, dollars in and out, retained share of
purchases, newcomer flag. Filters by side, USD size range, time window to
the second, or one wallet address, plus liquidity add and remove events; an
aggregate mode summarises net flow, unique buyers versus sellers, and the
size histogram. Use this when the user asks who is buying or selling, whale
watching, or wallet activity. Example queries: who is buying this token,
recent large sells, trades of this wallet, whale buys last hour, order flow.

aliases: trades, trade history, order flow, whale trades, buys and sells, kto
kupuje, historia transakcji, ruchy wielorybow
exampleIntents: "who is buying this token right now", "show me whale trades on
this pair", "largest sells in the last hour", "kto kupuje ten token", "duze
sprzedaze z ostatniej godziny", "pokaz transakcje tego portfela"

description (model-visible draft):
List trades for a pair, newest first, 100 per page with cursor paging to any
depth. Use this for flow, whale, and wallet questions. Filters: `eventType`
(buy, sell, swap, add, remove, all), `minVolumeUsd`/`maxVolumeUsd`, amount
ranges, `startAtMs`/`endAtMs` (second-precise, measured), and `maker` for one
wallet's history on the pair. Each row carries `traderProfile` with
`retainedBoughtPct` (share of what the wallet bought that it still holds; NOT
percent of supply), `newOnPair`, and first-trade time. `mode: aggregate`
returns net flow in USD, unique buyer and seller counts, new-wallet share,
size histogram, and the largest trades for the covered range, with the range
and its completeness stated.

## 13. dexscreener__top_traders_list (`dexscreener.top.traders`)

canonicalSummary: Ranked wallet leaderboard for a pair: who bought and sold the
most, cash taken out, and current holding value.

embeddingText:
Top traders leaderboard for a pair: a bounded pair-local ranking of up to
100 wallets by bought USD, sold USD, net venue cash flow, or current holding
value, with buys, sells, dollars in and out, retained purchase share, and
first and last trade times, inside the provider's 30-day window. It
cannot establish profit, exit status, global accumulation, or smart-money
quality: cost basis, transfers, and other venues are invisible here. Use
this when the user asks who bought or sold the most on a pair; for
chronological or wallet-filtered flow use dexscreener__trades_list. Example
queries: top traders of this token, biggest buyers of this pair, who sold
the most, wallet leaderboard.

aliases: top traders, top wallets, biggest buyers, wallet leaderboard, whale
wallets, najlepsi traderzy, kto zarobil, ranking portfeli
exampleIntents: "which wallets bought the most of this token", "top traders on
this pair", "kto najwiecej zarobil na tym tokenie", "czy pierwsi kupujacy
dalej trzymaja", "top 10 portfeli tej pary"

description (model-visible draft):
List the pair's top wallets by `sortBy`: `boughtUsd`, `soldUsd`,
`netCashFlowUsd` (maps to the provider's pnl rank), or `currentHoldingValueUsd`
(the provider's unrealized rank), with `lookbackDays` (1 to 30; the provider
serves a 30-day window and refuses more, measured) to narrow it. Use this for
who-bought-and-sold-the-most questions over the last month. This surface is
bounded_non_pageable: one leaderboard of up to 100 wallets, no continuation;
wallets beyond it are unreachable and the envelope says so. Returns
per wallet: buys, sells, USD in and out, `netCashFlowUsd` (cash flow, not
profit: cost basis and transfers are invisible to the venue),
`retainedBoughtPct`, `currentHoldingValueUsd`, and active trading span. The
`unknowns` block names what this endpoint cannot see (other venues, transfers,
supply share) so the agent does not overclaim. `currentHoldingValueUsd`
depends on the provider sending a balance, which it does reliably only on the
`currentHoldingValueUsd` ranking itself; other sorts can return pages with no
balance at all, reported as missing, never zero.

## 14. dexscreener__narratives_list (`dexscreener.trending` toolId preserved)

canonicalSummary: Narrative and meta aggregates per chain: market cap, change,
volume, and token count per theme, with the IDs the screeners accept.

embeddingText:
Narratives and metas: themes like AI, cat and dog coins, or x402, aggregated
per chain with total market cap, 5-minute to 24-hour change in percent and
dollars, liquidity, volume, and token count, for any active chain (the site
surfaces Solana, BSC, Base, and Ethereum). Each row carries the narrative ID the screening tools accept
as a filter, so theme discovery drills into the theme's pairs.
Use this when the user asks which narrative or sector is moving; individual
pairs live in the screening tools. Example queries: which narrative is hot
today, AI tokens market cap, what meta is pumping on solana, sector rotation
in memecoins, cat coins versus dog coins.

aliases: narratives, metas, narracje, jaki sektor rosnie, motywy rynkowe
exampleIntents: "ktora narracja dzisiaj rosnie", "jak radzi sobie meta AI na
solanie", "which meta is moving"

description (model-visible draft):
List the 18 DexScreener narratives with per-`chain` aggregates for the
selected `window`: marketCapUsd, marketCapChangePct and marketCapDeltaUsd,
volumeUsd, liquidityUsd, tokenCount, and derived turnover. Use this as the
first hop for theme questions. Aggregates exist for any chain with narrative
activity (measured live on robinhood, ton, and polygon too); a chain with
none answers quietly as N of 18 active, and the four site-surfaced chains are
a visibility label, never a data gate. Returns each narrative's
`id`, which is the exact value the screening tools' `metaIds` parameter needs;
optional `topTokens` embeds each narrative's leading pairs to skip the second
call.

## 15. dexscreener__spotlight_get (`dexscreener.spotlight`)

canonicalSummary: Paid-attention feeds in one call: top boosted tokens, fresh
boosts, and the newest token profiles.

embeddingText:
Paid attention on DexScreener: the top boosted tokens, the most recent boost
purchases, and the newest token profiles (up to 30, 30, and 36 rows), in a
single call, each with token identity and chain. Distinguishes who has paid the most
overall from who just started paying, which is the earliest promotion signal
DexScreener emits. A boost is bought visibility, and rows say so plainly. Use
this when the user asks who is advertising, boosting, or promoting right now;
organic momentum lives in dexscreener__pairs_trending_list. Example queries:
most boosted tokens right now, who just bought a boost, newest token profiles,
what is being promoted today, fresh marketing pushes.

aliases: boosts, promoted tokens, kto sie promuje, boostowane tokeny, platna
promocja
exampleIntents: "kto sie teraz promuje", "swieze boosty z ostatniej chwili",
"most boosted tokens today"

description (model-visible draft):
Get the spotlight feeds: `feed` selects `topBoosts`, `recentBoosts`,
`latestProfiles`, or `all` (default), optionally filtered by `chainIds`. Use
this for promotion and paid-attention questions. Returns per row the token
address, symbol, chain, boost totals, and for recent boosts the just-purchased
amount separately from the running total, so "who just started paying" is
answerable. Row counts are provider bounds, not promises: a feed can return
fewer. One call, about 23 KB, the same endpoint the website itself uses.

## 16. dexscreener__chains_list (`dexscreener.chains`)

canonicalSummary: The 74 supported chains with their dexes, explorer link
templates, audit integrations, and feature availability.

embeddingText:
Chain and DEX catalog: all 74 chains DexScreener indexes, each with its
slug, display name, native chain ID, architecture, DEX list, block explorer
URL templates, which audit providers cover it, and whether narratives are
enabled there. The vocabulary source for every other DexScreener tool: valid
chain slugs and dex slugs come from here, and unknown values elsewhere are
refused with candidates from this catalog. Use this when the
user asks which chains or dexes are supported, or when a chain slug needs
verifying. Example queries: which chains are supported, list dexes on solana,
is berachain indexed, explorer link for this chain, what chains have audits.

aliases: chains, supported networks, lista sieci, jakie dexy, obslugiwane
lancuchy
exampleIntents: "jakie sieci obslugujesz", "pokaz dexy na solanie", "is monad
supported"

description (model-visible draft):
List the supported chains with their metadata; optional `chain` narrows to one
and expands its full dex list. Use this to discover valid `chainIds` and `dexIds`
values before screening (the `labels` vocabulary is listed in that parameter's
own description), and to build correct explorer links from the returned URL
templates. Returns per chain: slug, name, nativeChainId,
architecture, dex count and slugs, explorer templates, audit integration keys
(presence of an integration is catalog metadata; whether an audit answers for
a given token is decided by dexscreener__pair_details_get's coverage block),
and narrative availability. Cached daily; the catalog host serves it in one
63 KB response.

## 17. dexscreener__pairs_batch_get (`dexscreener.pairs.batch`)

canonicalSummary: Refresh a list of known pairs or tokens in one call: a batch
snapshot for watchlists and portfolios.

embeddingText:
Batch snapshot of many pairs at once: pass known pair or token addresses
across any mix of chains and get current rows back in one frame with price,
volume, liquidity, market cap, and flow for all windows. Built for
watchlists, portfolio refresh, and side-by-side comparison without one call
per pair. Every input is accounted for: resolved, invalid, duplicate, or
omitted by the provider, nothing disappears silently. Use this when a pair set is
already known and the question is its current state; discovery lives in the
screening and search tools. Example queries: refresh my
watchlist, current stats for these pairs, compare these tokens, snapshot my
portfolio, update my tracked pools.

aliases: batch snapshot, watchlist refresh, moja lista, odswiez portfel,
porownaj pary
exampleIntents: "odswiez moja liste obserwowanych", "porownaj te trzy pary",
"current stats for these addresses"

description (model-visible draft):
Get current rows for explicit `pairs` (`chain:pairAddress`) or `tokens`
(`chain:tokenAddress`) in one provider frame; no artificial input ceiling (a
live 300-input probe completed), large lists are chunked internally and the
chunking reported. Use this when the set is known and freshness is the
question. Returns full screening-family rows plus per-input accounting:
`resolved`, `invalid_format`, `duplicates`, and `provider_omitted` (a
syntactically valid identity the provider returned no row for; bonding-curve
launchpad pairs resolve normally since the batch lifts the provider's hidden
launchpad exclusion the way the screeners do). A token input resolves to ONE
provider-canonical pair which is not necessarily the deepest;
`resolutionBasis` says which pair answered. The provider pages this channel
at 500 rows with a true total; large lists chunk to that page size and page
walks are reported.

## 18. dexscreener__tokens_screen (`dexscreener.tokens.screen`)

canonicalSummary: Token leaderboard per chain: one aggregate row per token
summing its pools, ranked by the provider's opaque score.

embeddingText:
Token leaderboard aggregating each token's pools on a chain: volume,
liquidity, and transaction counts are sums across the token's pools, attached
to one representative pool whose price and market cap can mislead by orders
of magnitude and are labelled so. Coverage is the provider's profile-carrying
universe, tokens can repeat across pages, and the ordering is the provider's
opaque score, all reported rather than hidden. Use this when the user wants
token-level aggregates on a chain; exact metric league tables and pool detail
live in dexscreener__pairs_top_list. Example queries: top tokens on solana,
token level volume across pools, token list for bsc, best tokens today, show
me coins not pools.

aliases: token list, top coins, lista tokenow, najwieksze tokeny, ranking
monet
exampleIntents: "pokaz najwieksze tokeny na solanie", "lista coinow na base",
"top tokens by market cap"

description (model-visible draft):
List token aggregate rows for the selected chains and `window`, up to 100
per page with offset paging. Use this when the answer should be token rows
rather than pool rows. Returns per token: volume, liquidity, and transaction
counts SUMMED across the token's pools (the channel's real value), plus the
representative pool the provider chose with its price; that pool's marketCap
and FDV are labelled representative-pool values and can be wrong by orders of
magnitude for multi-pool tokens. Honesty contract, measured: the universe is
the provider's profile-carrying tokens only; the ranking is the provider's
opaque score (`providerRank`); there is no server-side total; the same token
can repeat across pages with disjoint aggregates and repeats are flagged by
token. For metric-exact league tables use the pair screening tools.
