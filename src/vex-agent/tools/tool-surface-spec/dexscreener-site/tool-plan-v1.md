# DexScreener tool surface v2 - plan (no implementation)

Status: v1.3, after Codex review turn 3 (convergence turn), 2026-08-24.
Author: Claude Code (coordinator).

## Revision log

**v1.3 (2026-08-24, evening), after Codex review turn 3.** Turn 3 returned
BLOCKED with a deterministic clearance list and no remaining disagreement: all
18 tool identities approved, the six-screener granularity approved (the owner's
MCP search-gateway decision met Codex's stated mind-changer). The convergence
cap (3 turns) is reached; the coordinator accepts every correction because each
is evidence-backed, applies them here, and proceeds. Applied:

1. Tool 17's 100-input ceiling removed (a live 300-input probe completed; the
   cap violated D-DS5). Inputs are chunked internally and the chunking is
   reported. `unsupported` accounting renamed: `invalid_format` for
   syntactically bad inputs and `provider_omitted` for valid identities the
   provider left out with the cause unproven.
2. Candle anchoring is declared approximate: the nearest prior trade anchors
   `endAtMs` (measured 393 s early on a 90-day target), and the response
   carries `anchorResolvedAtMs`, `anchorDistanceMs`, `rangeFullyCovered`, and
   a fallback rule for empty or too-distant anchors. Walk bounds are now a
   frozen parameter table (14.5).
3. Top traders: public sorts renamed to `boughtUsd | soldUsd | netCashFlowUsd |
   currentHoldingValueUsd` (mapping internally to provider bought/sold/pnl/
   unrealized); `offset` removed, the tool is `bounded_non_pageable` (one
   leaderboard of up to 100, wallets beyond it unreachable and said so);
   every profit/exit/smart-money implication removed from its texts.
4. All 18 embedding passages now pass the word and anchor gates mechanically
   (verified by script); the five semantic rewrites Codex named are applied in
   `tool-descriptions-v1.md`.
5. The per-tool default floor matrix is frozen in 14.5, h24-anchored exactly
   as the site does it, with explicit override-and-echo semantics.
6. The stale v1.1 body is corrected in place: 18 tools everywhere, "every
   pair of that token" removed (bounded at 30), SSR prose removed from the
   architecture, verification, alternatives and risk sections.
7. Sanitization ruling taken by the coordinator at the cap (named to the
   owner, veto open): invisible, BiDi and tag characters are stripped from
   issuer-authored text and reported via `sanitizedFields`. This passes the
   no-silent-cutting decree's own test: the reader is told exactly what was
   removed and nothing readable is shortened.

**v1.2 (2026-08-24, afternoon).** Three inputs folded in: the owner's decisions
from this session, the coordinator's second live measurement pass
(`evidence/report-retest-2026-08-24.md`), and Codex plan-review turn 2 (live,
network-enabled, three subagent lenses, archive of 430 hashed artifacts under
`<scratchpad>/live-turn2/`). Full delta in section 14; headlines:

- **D-DS4 (owner): the full intent-shaped set ships.** The Studio MCP surface
  exports only internal tools plus the Vex tool-search tool; DexScreener tools
  are discovered THROUGH that search tool, so the static-export cost argument
  behind the two-tool consolidation no longer applies. Codex's own stated
  mind-changer ("Studio stops statically exporting all schemas") is met, and
  contested item 13.1 is closed. The screening family stays at six tools.
- **Two NEW tools from the channels Codex verified live**: tool 17
  `dexscreener__pairs_batch_get` (v8 pairs-search: up to 100 explicit pair or
  token ids in one frame, measured 140-in-one-call) and tool 18
  `dexscreener__tokens_screen` (v2 tokens: one row per base token, up to 100
  per page, rank keys honoured but opaque). The set is now 18 tools.
- **D-DS5 (owner): no artificial Vex-side caps.** Provider realities are
  reported; everything beyond them is reachable by explicit paging or walking.
  Parameter descriptions emphasise capability. Concretely: candle `limit` rises
  to 999 (the provider page), screening `offset` pages to the provider's live
  end (measured page 525 of 525), trades cursor pages without a synthetic
  depth cap, and walk bounds (`maxPages`, deadline) have generous defaults the
  agent can raise explicitly.
- **D-DS6 (owner): cross-tool handoffs are part of the surface.** Profile
  socials hand off to `TwitterAccount` and `WebResearch`; narrative ids hand
  off into `metaIds`; `chains_list` is the vocabulary source everywhere.
- **D-DS7 (owner): the coordinator authors all retrieval text personally.**
  Done: `tool-descriptions-v1.md` in this folder carries embeddingText,
  canonicalSummary, aliases, exampleIntents and the model-visible description
  draft for every tool; builders consume them verbatim.
- **Candle time-range strategy corrected (both reviewers measured the same):**
  `endAtMs -> GetTransactions(timestampEnd) -> bbn` returns an arbitrary
  historical window in two requests (coordinator: 17-month-old window, 533 ms,
  7 KB; Codex: 90-day target, 980 ms/33 KB vs 1,582 ms/436 KB naive walk).
  `abn` does not anchor forward (both measured) and is removed.
- **SSR is deleted entirely** (Codex blocker, accepted): ~900 KB per page, one
  QuickIntel snapshot 14h19m staler than pair-details, nothing exclusive.
  `codec/server-data.ts` and the SSR fallback path leave the plan.
- **Protobuf runtime decided:** pinned direct `@bufbuild/protobuf`,
  `createFileRegistry()` over the checked-in `FileDescriptorSet`, allowlisted
  message descriptors, byte cap before decode, bigint preserved, Zod on the
  projection. No transitive `protobufjs`, no generated codecs in v1.
- **Money-grade unit fix (Codex):** GoPlus holder/owner/creator percentages are
  FRACTIONS (0.091217 = 9.1217 percent) while Solana holder percentages are
  already percentages (13.91 = 13.91 percent). Every holder-derived metric
  normalizes per source with the raw value retained, or is wrong by 100x.
- Other accepted corrections in section 14: exact-address search is bounded at
  30 (**"every pair of that token" is false** and removed everywhere), token
  resolution basis is "deepest among the returned bounded window" and is
  echoed, wrong quote returns a silently inverted candle series so quote
  identity is validated locally, `lastBarPartial` is mandatory (998/998
  completed bars matched across transports, only the forming bar differed),
  5s candles are WS-only and sparse (median 50 s gap, max 1,600 s), the first
  screener WS frame is `latestBlock` in 72 of 74 sessions so dispatch is by
  oneof + correlation id, trade cursors must carry
  `(block, transactionIndex, eventIndex)` (block-only skipped a real same-block
  BUY), `lpId` on top traders is ignored and removed, pair-details can return
  HTTP 200 with every block null (renders `unavailable`, never clean),
  route-keyed caches diverge (pair-id vs token-id route: 8,483 vs 351 holders
  for six minutes) so the subject block names the route used, and the provider
  DOES publish nullable token decimals (100/100 solana, 100/100 bsc, 48/100
  base v7 rows) which reopens `volumeBase`/`volumeQuote` once fixed-point scale
  and orientation are proven.
- Screener page ceiling now measured to the live end (page 525 of 525, 80 rows
  on the boundary, empty past it). New pairs appear 17-39 s after
  `pairCreatedAt` (median 35.5 s). Bundle build 3338/e615f63f7 re-extracted:
  zero descriptor drift against the checked-in evidence.

**v1.1 (2026-08-24), after Codex review turn 1.** Codex returned BLOCKED. His
sandbox had no network (DNS resolution failed), so he could not re-probe the
provider; his findings come from decoding the captured artifacts and reading the
repo, and he says so himself. I verified every load-bearing claim against the
captures before accepting it. Accepted and fixed here:

1. **`balancePercentage` is not supply ownership.** Verified on 99 of 100 rows of
   `connect-gettx.json`: it equals `balanceAmount / volumeBuy * 100`, i.e. the
   share of everything the wallet ever BOUGHT that it still holds. v1 derived
   `traderHoldsPct` and `topHoldersSupplyPct` from it as percent of token supply.
   Both were financially false and are removed. Rule 90 class defect.
2. **The other trader semantics were wrong too.** `volumeUsdSell - volumeUsdBuy`
   is net cash flow, not realized PnL. The provider's "unrealized" sort is current
   holding value, not unrealized profit. `lastSwap - firstSwap` is an active
   trading span, not holding duration. `isNew` means new on THIS pair, not a
   globally fresh wallet. Holding versus exited cannot be inferred at all, because
   transfers and other venues are invisible. All renamed or removed.
3. **`makerConcentrationRatio` renamed to `transactionsPerMaker`** and the
   "5,000 transactions and 12 makers is wash trading" sentence deleted. It was a
   verdict, which violates this plan's own section 4.0 rule 4.
4. **Electron bridge must not use a `data:` document.** `.agents/skills/vex-electron-security/SKILL.md:28`:
   "App may load only `app://vex/` in production." Corrected in 3.1.
5. **`ProtocolParamDef.type` has no array member** (`types.ts:94`: string, number,
   boolean, object). Lists are `type: "string"` with `acceptsStringArray: true`.
   And `fields` is documented in `conventions.ts:126` as comma-separated row field
   GROUPS, not arbitrary field names. All param tables corrected.
6. **The EVM coverage claim was wrong.** GoPlus does return holders on EVM:
   `pair-details-ethereum.json` carries `gp.holders` 10 rows, `gp.lpHolders` 10
   rows and `gp.holderCount` 580,992, while the top-level `holders` key is null.
   Measured audit coverage across the catalog: 74 chains, 56 EVM, GoPlus enabled
   on 21, QuickIntel on 24, both on 13, neither on 24.
7. **`k=1` (KOL filter) returned zero rows**, so top traders is "up to 100", not
   "exactly 100".
8. **`pairsCount` is unstable**, measured moving 2,767 to 2,585 to 2,599 inside 30
   seconds. It becomes `totalMatchedApprox` with an unstable-ranking warning on
   deep offset paging.
9. **Trade paging by block alone can skip trades in the boundary block.** Exact
   `(blockNumber, transactionIndex, eventIndex)` exists only on the WebSocket
   command, so the cursor is built there.
10. **Token volume fields are raw fixed-point** with no decimals from this
    provider, so `volumeBase`, `volumeQuote` and the VWAP idea are withdrawn until
    decimals are resolved from another source.
11. **The resolution enum has 18 members, not 17** (S5 was missed).
12. **Search is `bounded_non_pageable`.** Client-side `offset` over a fixed 30-row
    window was fake pagination. Multi-chain search issues one bounded request per
    chain instead of filtering one global window.
13. **16,384 bytes is a self-imposed lane budget**, not an engine cap
    (`output-envelope.md:142` says there is no global cap).
14. **Plan contradicted the owner's own decisions** D-DS2 and D-DS3 in sections
    4.6, 8 and 9.2 (alias rows, public-API batch lookup). Removed.

Rejected or still contested, with reasons, in section 13.

Provenance note, corrected. I first recorded that Codex had not really spawned the
three subagents he named, because the run's `events.jsonl` contains zero
`collab_agent_spawn_begin` events. That conclusion was wrong and is retracted. The
authoritative record is Codex's own rollout JSONL, which contains three
`spawn_agent` calls in the `collaboration` namespace (`momentum_launch`,
`risk_audit`, `chart_flow`) and six `SubAgentActivity` items, three `started` and
three `interacted`, each with its own child thread id. The fan-out happened exactly
as reported.

The cause of my error is worth recording because it will recur: codex-cli 0.149.0
carries BOTH event vocabularies (`collab_agent_spawn_begin` and
`sub_agent_activity` are both present in the binary), and the thin `events.jsonl`
the driver captures emits the latter, while the harness skill documents a grep for
the former. **Verify a fan-out against the rollout JSONL
(`~/.codex/sessions/<date>/rollout-*.jsonl`), not against the driver's
`events.jsonl`.** The harness skill's instruction needs updating.

---

Owner instruction (2026-08-23/24): the current 12 DexScreener tools are retired in
full and replaced by a production surface built on the website's own API, reached
"as a browser user". Nothing is deferred as beta. CoinGecko lands next to it later
as a keyed alternative (tool stays visible without a key and answers with a setup
instruction). This document is the plan only.

Evidence base: `recon.md` in this folder plus `evidence/` (two live-probe reports,
the Electron spike, 25 extracted protobuf schemas, chain and narrative catalogs).
Every capability claim below cites a measurement, not documentation.

Reference patterns studied: `agents-colab/github-mcp-server` (first-party MCP
server; `pkg/inventory/`, `pkg/github/*.go`, `pkg/errors/`, `pkg/sanitize/`,
`__toolsnaps__/`) and this repo's own `morpho`, `pendle`, `kyberswap` namespaces.

---

## 0. What changes, in one paragraph

Today the namespace asks a provider that reads exactly one query parameter (`q`),
returns at most 30 rows chosen by an undisclosed cross-chain relevance function,
and has no per-chain trending, no gainers, no new-pairs feed, no candles, no
trades, no audits. The website's own API has all of it, server-side: a screener
with 19 rank keys and about 30 filters over 236,798 pairs across 74 chains,
1-second-to-monthly OHLCV with unlimited backward paging, trade history with a
per-trade counterparty profile, ranked top traders with PnL, GoPlus and QuickIntel
audits, holder distribution, LP locks, and narrative aggregates. The new surface
is 18 tools over that API, with the transport injected by the Electron host so
`src/` stays free of Electron and Studio MCP projects get the same tools for free.

---

## 1. Task and constraints in force

1. Replace all 12 current DexScreener tools. No half-integration, no "beta later".
2. Tools serve both the in-app agent and Vex Studio projects (same manifest
   registry, same executor; Studio plan v2 sections 2.2-2.3 and decision O20).
3. Candles are a first-class capability: the agent chooses resolution, count, and
   time range, wherever the provider allows it.
4. Search and per-chain filtered token/pool lists must reach what the website
   itself shows.
5. Both Claude Code and Codex study the github-mcp-server tool patterns first.
6. Owner decrees that bind this lane: full provider depth or a named omission with
   a reason (2026-08-18); no silent content cutting (clarified 2026-08-22); no em
   dashes; no AI attribution; Opus 5 subagents capped at medium effort.

Rules read and applied: `.claude/CLAUDE.md` and all eleven `.claude/rules/*.md`.
The ones that shape concrete decisions here:

- Rule 00 hard stops: provider routing and tool contracts change only on explicit
  owner direction. This plan is that direction being written down, not taken.
- Rule 04: closed unions declared as enums, typed unsupported outcomes, explicit
  pagination and cursor contracts, generated schemas as reviewed artifacts.
- Rule 05: every WebSocket, hidden window and cache has one named lifecycle owner,
  bounded buffers, and reported truncation.
- Rule 07: no new dependency without a bounded adapter; the hidden bridge window
  never loads remote code and never gets Node.
- Rule 09: provider text is untrusted data; tool output must not let issuer-authored
  strings act as instructions; a model-visible input must be reconstructable.
- Rule 90: display-only fields may be tolerant, fields used for financial decisions
  are strict; never present "no audit data" as "clean".

---

## 2. Measured capability inventory (what the tools can be built on)

All measured 2026-08-23/24. Full detail in `recon.md`.

| Surface | Endpoint | Measured |
|---|---|---|
| Screener | `wss://io.dexscreener.com/dex/screener/v7/pairs/{m5\|h1\|h6\|h24}/{page}?{qs}` | 100 rows/page, no page cap (page 531 of 531 returned), first frame 0.6-1.0 s / 42-93 KB, `pairsCount` server-side total, 19 rank keys, about 30 filters |
| Trending top 30 | `GET /dex/trending/dex_trending.PublicService/GetTrendingPairs` (Connect, protobuf) | 30 rows, 9.2 KB, 40 ms, identical order to `rankBy=trendingScore{window}` |
| Search | `GET /dex/search/v12/pairs?q&chainId` (protobuf) | 30-row cap by text, **`chainId` honoured server-side** (not in the site bundle, found by probing), exact token address returns that token's pools, bounded at 30 like text search |
| Spotlight | `GET /dex/search/spotlight/v10` | 30 top boosts, 30 recent boosts, 36 newest profiles, 24 KB |
| Pair snapshot | `wss://.../dex/screener/v7/pair/{chain}/{pair}` | full Pair about 1 KB every 3.2 s |
| Pair details | `GET /dex/pair-details/v4/{chain}/{pair}[?inverted=1]` (JSON) | 6-15 KB, 0.2 s, `cache-control: max-age=60`; GoPlus, QuickIntel, holders, locks, supply, CoinGecko, CMC, CMS |
| OHLCV | feed WS `getHistoricalBars` (protobuf) / `GET /dex/chart/amm/v3/...` (Avro) | **999 bars per call on both**, resolutions 1s..1mo on WS (1s..12h on HTTP), backward paging by `beforeBlockNumber` verified continuous over 3 pages, native + USD, market-cap series without a supply argument, `volumeToken0/1` |
| Trades | `GET /feed/rpc/dex_feed.PublicService/GetTransactions` (Connect, protobuf) | 100 per page, filters on side / maker / USD range / amount range / time window / block range, per-trade `traderScreener` counterparty profile, structured 400 |
| Top traders | `GET /dex/log/amm/v5/{ammId}/top/{chain}/{pair}?q&s&sd[&mda][&k][&lpId]` (Avro) | up to 100 rows (`k=1` returned zero), sort by bought / sold / pnl / unrealized |
| Narratives | `GET /metas/v1/all`, `/metas/v1/trending?chainId=` (Avro) | 18 narratives with market cap, liquidity, volume, token count and change per m5/h1/h6/h24 |
| Catalogs | `GET https://dd.dexscreener.com/ds-data/v2/chains/by-trending`, `/ds-data/dexes` (JSON) | 74 chains with explorer templates and integrations, 602 dexes with swap deeplinks |
| Reactions | `GET /hype/reactions/dexPair/{chain}:{pair}` | 133 bytes, four counters |

Known dead or defective on the provider side, to be handled by refusing rather
than pretending:

- `rankBy=fdv` silently returns the `txns` ordering (100/100 identical addresses).
  Not exposed as a sort. `fdv` remains available as a filter.
- The whole audit filter family on the screener (`isHoneyPot`, `isRenounced`,
  `isOpenSource`, `buyTax`, `sellTax`, `holderCount`, `lpHolderCount`) is accepted
  and ignored. Not exposed. Audits are available per pair through pair-details.
- `categories`, `circulatingSupply`, `pairCreator`, `moonshot*` filters: ignored.
- Live trade push (`subscribeTransactions`) is gated by `isDEXFeedStreamEnabled`,
  which was false on all top-100 volume pairs of solana, ethereum and base. Not
  exposed; trade history is polled.
- Unknown filter names are silently dropped by the provider, so the client
  whitelists names locally and echoes what it sent.

---

## 3. Architecture

### 3.1 Transport seam (the one new architectural piece)

Cloudflare blocks by TLS and HTTP/2 fingerprint. Node `fetch`, `undici` and any
Node WebSocket get 403. Chromium's network stack passes. Measured in the real app
(Electron 42, `evidence/report-electron-spike.md`):

- `net.fetch` from the main process reaches `io.dexscreener.com` with a Chrome UA
  plus `Origin` and `Referer`, and reaches the SSR HTML host with the full Chrome
  navigation header set.
- WebSockets need Chromium's WS stack. The spike proved this with a hidden
  `BrowserWindow` in an isolated `session.fromPartition`, sandboxed,
  context-isolated, no Node, loading a local document, with
  `Origin: https://dexscreener.com` injected by `webRequest.onBeforeSendHeaders`
  for that partition only: the screener channel opened and delivered a 106 KB
  frame in 648 ms with no remote code loaded.

  **Corrected in v1.1:** the spike used a `data:` URL, which the project's own
  Electron security rule forbids in production
  (`.agents/skills/vex-electron-security/SKILL.md:28`, "App may load only
  `app://vex/` in production"). The production bridge therefore loads
  `app://vex/dexscreener-bridge` through the protocol handler registered on its
  own ephemeral session: no preload, no DevTools, no navigation, no window
  opening, no permissions, no remote script, an exact host and path allowlist,
  request-scoped Origin rewriting, bounded frame count, bytes, timeout and
  concurrency, and one named teardown mounted through the existing agent bridge
  lifecycle in `vex-app/src/main/agent/index.ts`. One bounded WebSocket session is
  reused across adaptive paging rather than reopening a window per page.

Therefore:

```
src/tools/dexscreener/transport.ts        contract + registry, no Electron import
   DexScreenerTransport {
     httpGet(url, {timeoutMs, signal, accept}): Promise<TransportResponse>
     wsExchange(url, {send?, expect, timeoutMs, signal}): Promise<Uint8Array[]>
     capabilities: { site: boolean, publicApi: true }
   }
vex-app/src/main/dexscreener-bridge/      the Electron implementation
   http.ts        net.fetch + the measured header set
   ws-bridge.ts   hidden window, single owner, idempotent dispose, single-flight
                  per URL, bounded concurrency, per-request abort
   index.ts       registers the transport into the agent runtime at startup
```

Consequences that make this the right seam:

- `src/` keeps zero Electron imports (verified: today it has none).
- The Studio MCP server runs inside Vex main (Studio plan 2.1), so projects get the
  same transport with no extra work.
- Headless contexts (CLI, unit tests, CI) get the default transport, which serves
  only `api.dexscreener.com`. Tools that can degrade do so and say which transport
  answered; tools that cannot return a typed refusal naming the remedy.

Every envelope carries `sourceObservation.transport: "site_bridge" | "public_api"`
and, when degraded, a `degraded` note naming exactly what is lost. Silent quality
downgrade is the failure mode this prevents.

### 3.2 Client rewrite in `src/tools/dexscreener/`

- `codec/protobuf.ts` - decoders built from the checked-in `FileDescriptorSet`
  (`evidence/dexscreener-descriptors.pb`). 25 schema files, no hand-written parsing.
- `codec/dsavro.ts` - the site's Avro dialect (arrays and maps are a zigzag count
  followed by items with no terminating block; unions are a zigzag branch index;
  what the schema calls a long is written as a double). Verified byte-exact on 9
  responses.
- `endpoints/*.ts` - one module per family with a typed validator each.
- `throttle.ts` - keep the existing token bucket, per-URL TTL cache and in-flight
  dedupe; retune per endpoint from the measured headers (pair-details 60 s,
  metas 30 s, trending about 30 s at the edge, screener no cache).
- `errors.ts` - extend `ErrorCodes.DEXSCREENER_*`; add a distinct code for
  "site transport unavailable" so it never reads as a provider outage.
- `sanitize.ts` - strip zero-width, BiDi and Unicode tag characters from
  issuer-authored strings (token name, symbol, description, link labels) and set
  `sanitizedFields` on the row. This is the github-mcp `pkg/sanitize` pattern. It
  is not truncation: nothing is shortened, only invisible control characters that
  cannot be displayed are removed, and the fact is reported. Open item 10.4.

### 3.3 Where the agent surface lives

`src/vex-agent/tools/protocols/dexscreener/` is rebuilt around four shared param
modules and one envelope module, following the existing `pair-list-params/` shape
(declare a key once, spread it into every manifest, so a key cannot mean two
things in two tools):

```
manifests/screen-params.ts        scope, window, thresholds, quality, shaping
manifests/pair-identity-params.ts chain + pairAddress/tokenAddress + inverted
manifests/series-params.ts        resolution, time range, series, priceBasis
manifests/trade-params.ts         side, amount and USD ranges, maker, time, cursor
chain-param.ts                    one chain param and resolver for the namespace
screen-core/                      request builder (qs bracket form), row projection,
                                  envelope, catalog-backed value validation
```

---

## 4. The tool set: 18 tools (16 here, tools 17-18 specified in section 14)

Grammar: `dexscreener__<resource>_<action>`, lowercase, exactly one double
underscore. `toolId` is immutable audit identity and is preserved where the
question a tool answers is preserved. All 16 are `mutating: false`,
`actionKind: "read"`, no `requiresEnv`.

Legend for "gains": what the agent can now answer that it provably could not
before.

### 4.0 Enrichment doctrine (owner instruction, 2026-08-24)

The owner's instruction is that every tool must be as deep as `candles_list`,
because these data give an LLM agent something no other provider gives it. That
sets a uniform bar, and `candles_list` is the worked example of it:

1. **Every axis the provider has is an agent-facing parameter.** If the endpoint
   accepts it and it works, the agent can set it. Omissions are named with a
   reason, never silent.
2. **One arithmetic layer on top of the raw fields.** The provider ships counts
   and sums; the ratios that turn them into a decision are computed once, in the
   projection, so every agent gets the same number instead of doing float
   arithmetic on token amounts in prose. Derived values carry `Ratio`, `Pct`,
   `Share` or `Usd` in the key so their unit is unambiguous.
3. **Raw fields stay reachable.** A derived value never replaces its inputs; it is
   added. `fields` decides what ships, the default is the decision-relevant subset,
   and the heaviest optional fields are named in the param description.
4. **Numbers, never verdicts.** No tool emits "safe", "smart money", "rug" or a
   score that hides its inputs. Rule 90 and rule 09: the model may reason from
   measurements, and a projection that renders a judgement as a fact is a defect.
5. **A summary block per response.** What the window covered, what the totals were,
   and what was not proven. This is the `summary` sentence the output envelope
   already requires, made quantitative.
6. **Honest depth.** Where the provider bounds the answer, the envelope says so
   with the cap and the narrowing action; where a page walk was needed, it reports
   how many pages it walked.

Section 4.8 applies this to every tool with the concrete fields and formulas.

### 4.1 Screening family (6 tools, one channel, one param module)

These six share `screen-params.ts` in full. They differ in the sort key they pin,
the defaults they apply, and the intent they are retrieved by. Alternative
considered and rejected in section 9.1.

| # | publicName | toolId | Pinned behaviour |
|---|---|---|---|
| 1 | `dexscreener__pairs_trending_list` | `dexscreener.pairs.trending` | `sortBy` fixed to the trending score of the selected window |
| 2 | `dexscreener__pairs_top_list` | `dexscreener.pairs.top` | `sortBy` in volume, txns, buys, sells, liquidity, marketCap |
| 3 | `dexscreener__gainers_list` | `dexscreener.gainers` | price change of the window, descending, quality floor by default |
| 4 | `dexscreener__losers_list` | `dexscreener.losers` | same universe, ascending |
| 5 | `dexscreener__pairs_new_list` | `dexscreener.pairs.new` | pair age ascending, age and liquidity floor by default |
| 6 | `dexscreener__launchpad_pairs_list` | `dexscreener.launchpad.pairs` | `stage` (bonding, graduated), handles the exclusion trap internally |

**Shared parameters (`screen-params.ts`)**

Scope:

| Param | Type | Notes |
|---|---|---|
| `chainIds` | string, `acceptsStringArray` | DexScreener chain slugs. `ProtocolParamDef` has no array type (`types.ts:94`), so every list param below is declared `type: "string"` with `acceptsStringArray: true`, which compiles to `anyOf`. Validated against the cached catalog; an unknown slug is refused by name with candidates, never silently returns zero rows |
| `dexIds` | string, `acceptsStringArray` | OR within the list |
| `excludeDexIds` | string, `acceptsStringArray` | DANGEROUS by construction and documented as such: sending this key at all replaces the provider's hidden default exclusion. Measured: excluding only PumpSwap moved the Solana population from about 53,094 to 84,058, i.e. narrowing the list made it bigger. `includeLaunchpadPairs` is the safe knob for the common case |
| `labels` | string, `acceptsStringArray` | `v2 v3 v4 CLMM DLMM CPMM ...`, case-insensitive |
| `metaIds` | string, `acceptsStringArray` | Narrative IDs from `dexscreener__narratives_list`. The description says IDs, not slugs, because a slug returns zero rows |
| `launchpadIds` | string, `acceptsStringArray` | `pumpfun`, `launchlab`, `meteoradbc`, `bags`, `fourmeme`, ... |
| `baseTokenSuffixes` | string, `acceptsStringArray` | Mint-address suffix, for example `pump` (20,852 pairs) or `bonk` (1,595) |
| `includeLaunchpadPairs` | boolean | Default false. True lifts the provider's hidden bonding-curve exclusion (solana 53,094 rows becomes 102,676). Named for the effect, not the mechanism |

Window:

| Param | Type | Notes |
|---|---|---|
| `window` | enum `m5 h1 h6 h24` | Default `h24`. Dual role stated in the description: it selects the metric for volume/txns/buys/sells ranking AND excludes pairs inactive in that window |
| `includeInactive` | boolean | Default false. True lifts the activity gate (m5 on solana: 2,513 rows becomes 53,088) |
| `thresholdWindow` | enum `m5 h1 h6 h24` | Defaults to `window`. Which window the volume/txn/change thresholds apply to |

Thresholds (all optional, unit in the key):

`minLiquidityUsd` `maxLiquidityUsd` `minMarketCapUsd` `maxMarketCapUsd`
`minFdvUsd` `maxFdvUsd` `minVolumeUsd` `maxVolumeUsd` `minTxnCount` `maxTxnCount`
`minBuyCount` `maxBuyCount` `minSellCount` `maxSellCount` `minPriceChangePct`
`maxPriceChangePct` `minPairAgeSeconds` `maxPairAgeSeconds` `minBoostCount`
`minLaunchpadProgressPct` `maxLaunchpadProgressPct`

Quality and attention:

| Param | Type | Notes |
|---|---|---|
| `requireProfile` | boolean | Token has a DexScreener profile (28,080 of 53,094 on solana) |
| `onlyBoosted` | boolean | Paid boost active. Labelled in the description as an advertising signal, not a quality signal |
| `onlyAds` | boolean | Currently running ad placement |

Shaping:

| Param | Type | Notes |
|---|---|---|
| `limit` | 1..100, default 20 | Byte budget binds before the provider's 100-row page |
| `offset` | integer | Mapped onto provider pages of 100 |
| `fields` | string, comma-separated | Row field GROUPS, the repo convention (`conventions.ts:126`), not arbitrary field names. Groups for this family: `core`, `flow`, `allWindows`, `profile`, `launchpad`, `identity` |

**Rows returned (default projection)**: chain, dex, labels, pair address, base
symbol and address, quote symbol, price USD, price change in the window, volume in
the window, liquidity USD, market cap USD, pair age, buys and sells in the window,
active boosts. Optional through `fields`: makers/buyers/sellers per window, buy
and sell volume split, FDV, native price, quote address, AMM id, launchpad
progress, issuer profile text and links, and all four windows of every metric.
The two heaviest are named in the param description: `profile` and `allWindows`.

**Envelope**: `totalMatchedApprox` is the provider's server-side `pairsCount`. It is an
estimate, not a total: measured moving 2,767 to 2,585 to 2,599 inside 30 seconds,
about 6.6 percent. Deep offset paging over a live ranking can duplicate or omit
rows, and the envelope carries that warning rather than implying a stable set;
`returned`/`offset`/`hasMore`/`nextOffset`; `filtersApplied` echoes every filter
actually sent, which is the defence against the provider silently dropping an
unknown key; `providerWindow` names the endpoint, rows per page, and that filters
and sort ran server-side; `externalContentWarning` plus `externalContentFields`
label issuer-authored text; `sourceObservation` carries transport, fetch time and
cache state.

**Gains**: per-chain trending for 5m/1h/6h/24h at any depth, top-by-volume or
txns per window, gainers and losers with a real quality floor, brand-new pairs
filtered by age and liquidity, launchpad boards before and after graduation,
dex-scoped and narrative-scoped and label-scoped lists, and a total count that
tells the agent how big the answer set actually is. None of this exists today.

### 4.2 Resolve and lookup (3 tools)

**7. `dexscreener__pairs_search`** (`dexscreener.search`, toolId preserved)

| Param | Notes |
|---|---|
| `query` | Symbol, name, token address or pair address, minimum 2 characters |
| `chain` or `chainIds` | One chain is scoped server-side. Several chains issue ONE bounded server request PER chain and merge, with a strict chain-count bound. v1's plan of filtering a single global 30-row window client-side is withdrawn: it cannot find rows the provider never sent |
| `limit` `fields` `sortBy` `sortDir` | Client-side over the provider window. There is NO `offset`: this tool is `bounded_non_pageable`, the provider caps at 30 rows with no continuation, and the envelope says `truncated` with the narrowing action instead of offering a page that cannot exist |
| `minLiquidityUsd` and the threshold family | Client-side, with `droppedByFilter` accounting |

Envelope keeps the honest `providerRelevanceNote` and `droppedByFilter`, plus the
new fact that a chain-scoped text query is served by the provider. An exact token address returns that token's pools
within the same 30-row provider window.

**Gains**: the text search a user actually types, scoped to one chain, which the
public API cannot do at all.

**8. `dexscreener__token_pairs_list`** (`dexscreener.tokenPairs`, toolId preserved)

`chain` plus `tokenAddress`, then the full threshold and shaping vocabulary.
Answers "every pool this token trades in, deepest first", which is the input to
choosing where to route a swap.

**9. `dexscreener__pair_get`** (`dexscreener.pair.get`)

`chain` plus one of `pairAddress` or `tokenAddress` (`atLeastOneOf`). With a token
address it resolves to the deepest-liquidity pair and echoes `resolvedFrom`.
Optional `fields` adds `reactions` (crowd sentiment counters) and `insight`
(a provider-generated narrative paragraph, labelled as provider-generated text and
never as fact, rule 09). Backed by the pair WebSocket first frame, about 1 KB.

**Gains**: one call gives the full live picture of a pair including buyers,
sellers and makers per window and the buy/sell volume split, which the public API
does not carry.

### 4.3 Deep dive (4 tools)

**10. `dexscreener__pair_details_get`** (`dexscreener.pair.details`)

| Param | Notes |
|---|---|
| `chain`, `pairAddress` or `tokenAddress` | |
| `inverted` | Report on the quote token instead of the base token |
| `fields` | `security`, `holders`, `liquidityLocks`, `supply`, `profile`, `listings` |

Returns, per availability: GoPlus (honeypot, buy and sell tax, mintable, proxy,
open source, blacklist, transfer pausable, hidden owner, owner and creator
balance and percent, holder count, top holders, LP holder count and top LP
holders, per-venue liquidity), QuickIntel (contract verified, renounced, can mint,
can burn, can blacklist, can pause trading, can update fees, suspicious and
external functions with their actual source), holder distribution, LP lock
percentage and lock rows, Solana mint and freeze authority, circulating and total
supply, CoinGecko and CoinMarketCap identity, DexScreener profile.

Coverage is stated honestly and enforced in the output: EVM chains carry audits
but no holder list, Solana carries holders and mint authority but no audits. A
missing block is reported as `unavailable` with the reason, never as a pass.
Rule 90 makes this mandatory: "no audit data" must never render as "clean".

**Gains**: a real pre-trade safety read. Today the agent has no honeypot, tax,
mint-authority, holder-concentration or LP-lock signal from this namespace at all.

**11. `dexscreener__candles_list`** (`dexscreener.candles`)

| Param | Type | Notes |
|---|---|---|
| `chain` | string, required | |
| `pairAddress` or `tokenAddress` | string | `atLeastOneOf`; a token resolves to its deepest pool and the choice is echoed |
| `resolution` | enum | 18 members: `1s 5s 15s 30s 1m 3m 5m 15m 30m 1h 2h 4h 8h 12h 1d 3d 1w 1mo`. HTTP answered 400 for `5s`, so the WebSocket transport is probed for it and the value is omitted by name if it fails there too |
| `limit` | 1..500, default 100 | Rows RETURNED to the model, bounded by the lane byte budget. The provider serves up to 999 bars per call, so a `limit` under 500 is one provider call; a wide `startAtMs` range is what triggers the internal page walk, and the walk is reported with its bound. The two numbers measure different things and the description says so |
| `endAtMs` | epoch ms | Newest candle to return; the backward paging key |
| `startAtMs` | epoch ms | Walk back until this time is covered, bounded and reported |
| `series` | enum `price marketCap` | Market-cap candles need no supply argument on this transport |
| `priceBasis` | enum `usd native both` | Default `usd` |
| `inverted` | boolean | Quote per base instead of base per quote |
| `fields` | string, comma-separated | Field groups: `ohlc` (default), `volume`, `blockRange`. `volumeBase` and `volumeQuote` are withdrawn in v1.1, see below |

Output is column-oriented to fit the lane's self-imposed 16,384-byte budget (there is no engine-level output cap; `output-envelope.md` section 4 says so explicitly): `columns: ["t","o","h","l","c","v"]`
and `rows: [[...], ...]`, which costs about 40 percent of the bytes an array of
objects costs, plus a `summary` (first and last timestamp, count, change percent,
period high and low) and `hasMore` with `nextEndAtMs`. Measured constraint that
forces this: 999 hourly bars decode to 271 KB raw, so projection and a real limit
are not optional.

Resolutions of 1 day and above exist only on the WebSocket transport; the HTTP
chart endpoint answers 400 for them. The tool hides that split and names it in the
description as a transport fact, not as a missing capability.

**Gains**: OHLCV from one second to one month, on any chain DexScreener indexes,
in USD or native units, as price or market cap, to any depth through paging.
Today the namespace has no candle capability whatsoever, and the public API has
no candle endpoint at all.

**12. `dexscreener__trades_list`** (`dexscreener.trades`)

| Param | Notes |
|---|---|
| `chain`, `pairAddress` | Required; the AMM id and quote token are resolved internally |
| `side` | enum `buy sell any add remove` |
| `minVolumeUsd` `maxVolumeUsd` | |
| `minAmountBase` `maxAmountBase` `minAmountQuote` `maxAmountQuote` | Human amounts as decimal strings, as the provider returns them |
| `maker` | Wallet address; returns that wallet's history on this pair |
| `startAtMs` `endAtMs` | |
| `limit` | 1..100, default 25 |
| `cursor` | Opaque; Vex encodes the provider's block, transaction and event index so the agent never parses provider internals |
| `fields` | `traderProfile` compact by default, full on request |

Every row carries the counterparty profile: lifetime buys and sells on this pair,
USD in and out, current balance and percent of supply, whether the wallet is new,
and its first trade time.

**Gains**: whale and insider detection, "has this wallet been accumulating",
"who is selling into this pump", trade-size distribution, and time-windowed flow.
None of it exists today.

**13. `dexscreener__top_traders_list`** (`dexscreener.top.traders`)

`chain`, `pairAddress`, `sortBy` in `boughtUsd soldUsd netCashFlowUsd
currentHoldingValueUsd` (mapped internally to the provider's bought, sold, pnl
and unrealized ranks), `sortDir`, `lookbackDays`, `onlyKol`, `limit`. This
surface is `bounded_non_pageable`: one leaderboard of up to 100 wallets, no
continuation, wallets beyond it unreachable and stated so. `onlyKol` measured
zero rows;
each carries buys, sells, USD bought and sold, current balance and percent, first
and last trade.

**Gains**: the leaderboard behind a pump, and whether the top holders are still
holding or already out.

### 4.4 Market context (2 tools)

**14. `dexscreener__narratives_list`** (`dexscreener.trending`, both identities preserved)

`chain` (optional; narratives exist on solana, bsc, base and ethereum only, and
the tool refuses other chains by name rather than returning empty), `window`,
`sortBy` in `marketCapUsd volumeUsd liquidityUsd tokenCount marketCapChangePct`,
`sortDir`, `limit`, `fields`. Rows carry the narrative ID, which is the value
`metaIds` on the screening tools needs, and this cross-reference is stated in both
descriptions.

**Gains**: narrative aggregates per chain with change and delta per window,
instead of the current global-only list, plus a working handoff into the screener.

**15. `dexscreener__spotlight_get`** (`dexscreener.spotlight`)

`feed` in `topBoosts recentBoosts latestProfiles all`, `chainIds`, `limit`,
`fields`. Replaces four current feed tools (`boosts`, `profiles`, `attention`,
`ads`) with the endpoint the website itself uses.

**Gains**: who is paying for attention right now and which tokens just published
a profile, in one 24 KB call instead of four thin ones.

### 4.5 Reference (1 tool)

**16. `dexscreener__chains_list`** (`dexscreener.chains`)

Optional `chain` narrows to one chain and adds its full dex list. Rows carry
slug, name, native chain id, architecture, dex count and slugs, block explorer URL
templates, which audit integrations exist for that chain, and whether narratives
are enabled. Backed by the catalog host, cached daily.

**Gains**: the agent can discover valid `chainIds`, `dexIds` and `labels` values
instead of guessing, and can build correct explorer links. It is also the source
the other tools validate against so an unknown slug is refused with candidates
rather than answered with zero rows.

### 4.6 Coverage of the retired 12 (owner decision D-DS2 and D-DS3: total removal, no aliases)

| Retired | Successor | Note |
|---|---|---|
| `dexscreener.search` | tool 7, same toolId | Now chain-scoped |
| `dexscreener.pairs` | tool 9 | Batch lookup is dropped entirely (owner decision D-DS3). Note for the record: the provider's real per-request limit is 30 addresses and the current tool performs two provider batches to reach 60 |
| `dexscreener.tokens` | tool 8 and tool 9 | |
| `dexscreener.tokenPairs` | tool 8, same toolId | |
| `dexscreener.orders` | none | Paid promotional orders per token. Superseded in practice by boosts in tools 1-6 and 15; the loss is orders paid but not yet active. Named omission (D-DS3) |
| `dexscreener.ads` | tool 1-6 `onlyAds` and tool 15 | |
| `dexscreener.profiles` | tool 15 | |
| `dexscreener.boosts` | tool 15 and `onlyBoosted` | |
| `dexscreener.communityTakeovers` | none | The public API CTO feed has no site equivalent and is dropped rather than kept alive on the public API. Named omission (D-DS3) |
| `dexscreener.attention` | tool 15 | It was a synthetic merge; the site has a real spotlight |
| `dexscreener.trending` | tool 14, both identities preserved | Now chain-scoped |
| `dexscreener.meta` | tool 14 plus `metaIds` on tools 1-6 | The drill-down becomes a real screener query |

Retirement is total and alias-free, per owner decision D-DS2: manifests,
handlers, embeddings, mapping rows, snapshots and their tests are deleted, and no
deprecation alias row is created. A call to a retired public name falls through to
the ordinary unknown-tool path. This is the D5 precedent applied to the whole
namespace at once.

### 4.7 Cross-cutting output rules

- One projection module per row type; the provider object never reaches the model.
- `fields` selects; the two heaviest fields are named in the param description,
  the github-mcp pattern.
- Every list carries `totalMatched` (or the provider count with an approximate
  flag), `returned`, `offset`, `hasMore`, and exactly one of `nextOffset` or
  `nextCursor` when `hasMore` is true.
- Nothing is cut silently. Where a provider window bounds the answer, the envelope
  says `providerCapped: true` with the cap and the narrowing action.
- Issuer-authored text ships whole, labelled through `externalContentWarning` and
  `externalContentFields`, with invisible control characters removed and reported.
- Failure classes stay distinct: unknown chain, unknown pair, provider rate limit
  with a retry window, site transport unavailable, cancelled, and ambiguous. No
  generic error string; the `generic-error-literal` lint enforces it.

---

### 4.8 Per-tool enrichment: axes, derived metrics, optional fields

Every derived value below is computed from fields the provider already returns in
the same response. Nothing here needs an extra call unless the row says so.

#### Tools 1-6, 7 and 9 (every pair row)

The `Pair` message carries, for **each** of m5, h1, h6, h24: `txns{buys,sells}`,
`buyers`, `sellers`, `makers`, `volume`, `volumeBuy`, `volumeSell`, `priceChange`.
Public DexScreener API has never carried `buyers`, `sellers`, `makers` or the
buy/sell volume split, so these are the namespace's new signal.

| Field | Kind | Definition |
|---|---|---|
| `netFlowUsd` | derived | `volumeBuy - volumeSell` in the selected window. Direction of pressure in dollars, not in trade counts |
| `buySellRatio` | derived | `txns.buys / txns.sells`, null when sells is zero |
| `buyerSellerRatio` | derived | `buyers / sellers`. Differs from the above exactly when a few wallets trade many times |
| `transactionsPerMaker` | derived | `(txns.buys + txns.sells) / makers`. A ratio, reported as a ratio. A high value means few wallets are producing many transactions; what that means is the model's call, not the tool's |
| `buysPerBuyer`, `sellsPerSeller` | derived | The same decomposition on each side, so a one-sided pattern is visible |
| `buyVolumeSharePct` | derived | `volumeBuy / volume` in the window |
| `turnoverRatio` | derived | `volume / liquidityUsd` in the window. Already proven useful in the current namespace |
| `volumeAccelerationRatio` | derived | `(volume.m5 * 12) / volume.h1`. Above 1 means the last five minutes are running hotter than the trailing hour. Needs `allWindows` inputs, computed even when they are not shipped |
| `freshPairFlag` | derived | `pairAgeSeconds` below the tool's own newness threshold, stated in the description |
| `chainVolumeSharePct` | derived | row `volume` over the frame's `stats[window].volumeUSD`, i.e. how much of the filtered chain's volume this one pair is |
| `missingInputs` | always | Names the inputs a derived value needed and did not get. Measured on a saved top-volume page: strict volume acceleration was computable for 24 of 100 rows and turnover for 29 of 100, so a missing input must produce `null` plus this list, never a zero |
| `allWindows` | optional field group | Every metric above on all four windows. Heaviest group; named as such in the `fields` description |
| `profile` | optional | Issuer-authored description, links and socials. Labelled untrusted, control characters removed and reported |
| `launchpad` | optional | `progressPct`, `creator`, `migrationDex` when the pair is on a bonding curve |
| `boosts` | default | `active` boost count |
| `ammId` | optional | Needed as an input by candles, trades and top traders, so it is one `fields` flag away |

Envelope addition for the screening family: `marketStats`, the frame's own
`stats` block (transaction count and USD volume per window for the filtered set,
plus `latestBlock`). It costs nothing because the provider sends it in every
frame, and it is what lets the agent say "this token is 4 percent of everything
trading on this chain today" instead of quoting a number with no scale.

#### Tool 8, token pairs

| Field | Kind | Definition |
|---|---|---|
| `liquiditySharePct` | derived | This pool's liquidity over the sum across the token's pools. Shows instantly when 90 percent sits in one pool |
| `volumeSharePct` | derived | Same for volume in the selected window |
| `venueCount`, `totalLiquidityUsd` | summary | Across all returned pools |
| `deepestPair` | summary | The pool the other tools should be pointed at |

#### Tool 10, pair details

| Field | Kind | Source and definition |
|---|---|---|
| `security.byProvider` | default | GoPlus and QuickIntel kept as SEPARATE blocks, never merged into one truth set, each with its own analysis timestamp, age, completeness and problem state |
| `security.conflicts` | default | Where the two providers disagree, stated objectively as both values plus the field. The captured SEMI response is the reason: the two disagree on supply, renunciation context, mint capability and freshness, and QuickIntel reported `problem=true` while its own summary said no issues |
| `security.taxes` | default | Buy, sell and transfer tax with the raw provider string, the normalized decimal value and the unit, because GoPlus and QuickIntel do not use the same unit. No floating point on token amounts |
| `venues` | optional | GoPlus `dex[]`: every venue holding this token with its liquidity. Measured: 26 venues for PEPE. Answers "where else does this trade" without a second call |
| `holders.rows` | optional | Top holders with balance, percent and tag (`exchange`, `contract`, `burn`, `lock`). Available on EVM through `gp.holders` and `gp.lpHolders` (measured: 10 rows each plus `holderCount` 580,992 on the PEPE capture) and on Solana through the top-level `holders` block |
| `holders.top10Pct`, `holders.top1Pct` | derived | Concentration over the rows the provider returned, with `rowsCovered` stated so a top-10 list is never read as the whole distribution |
| `holders.burnedPct`, `holders.contractHeldPct`, `holders.unclassifiedPct` | derived | Tag-weighted sums, null when tagging is incomplete rather than zero, so "90 percent concentrated" is not reported when it is a burn address and a missing tag is not silently counted as a holder |
| `liquidityLocks.rows` | optional | Lock tag, address, amount, percent and the unlock URL the provider gives |
| `liquidityLocks.lockedPct` | derived | Total locked share |
| `supply` | optional | Circulating and total |
| `listings` | optional | CoinGecko and CoinMarketCap identity, categories, official links |
| `suspiciousFunctionSource` | optional | QuickIntel's verbatim Solidity for the functions it flagged. Opt-in because it is large, and it is the difference between "canMint: true" and showing the agent the mint function |
| `subject` | always | Requested identifier, resolved pair, which token the report is about, orientation, and whether that identity was verified |
| `coverage` | always | Which provider answered, which did not, and why, per block. Measured reality, corrected in v1.1: of 74 catalogued chains, 56 are EVM; GoPlus is enabled on 21, QuickIntel on 24, both on 13, and **24 EVM chains have neither**. GoPlus does return holders on EVM. A missing block renders as `unavailable` with the reason and never as a pass |

#### Tool 11, candles (already the model; additions)

| Field | Kind | Definition |
|---|---|---|
| `summary.changePct` | derived | Close over first open across the returned window |
| `summary.high`, `summary.low`, `summary.highAtMs`, `summary.lowAtMs` | derived | Period extremes and when they happened |
| `summary.volumeUsdTotal` | derived | Sum over the window |
| `summary.largestMovePct`, `summary.largestMoveAtMs` | derived | Biggest single-candle move, the "when did it happen" question |
| `summary.gapCount` | derived | Candles the provider did not emit inside the requested range, so a sparse series is visible rather than assumed continuous |
| `summary.requestedRange`, `summary.coveredRange`, `summary.lastBarPartial` | always | What was asked for, what was actually covered, and whether the newest bar is still forming |
| `providerWindow.pagesWalked`, `barsPerCall`, `pageBudgetHit` | always | 999 per call is the measured cap on both transports; the walk, its bound and whether the bound was reached are reported |

Withdrawn in v1.1: `volumeBase`, `volumeQuote` and the volume-weighted average
price. The provider's `volumeToken0` and `volumeToken1` are raw fixed-point
strings (a captured PEPE bar carries a normal 4.58 million USD volume next to a
24-digit token volume) and DexScreener publishes no token decimals anywhere in
this API. Any of the three would be wrong by a power of ten. They return only
after decimals are resolved from another source, which is a separate decision.

Bounds that make the time-range walk production-safe, added in v1.1 after Codex
costed it: 1-minute bars for 30 days is 44 pages and 42 to 83 seconds, and
1-minute bars for a year is 527 pages, 8 to 16 minutes and about 76 MB decoded.
So `maxPages`, a byte ceiling and a deadline are mandatory parameters with
conservative defaults, precedence among `startAtMs`, `endAtMs` and `limit` is
declared explicitly, and an exact block cursor is returned for continuation. The
candidate shortcut worth probing: resolve `startAtMs` to a block through
`GetTransactions(timestampEnd=...)` and anchor the candle request with `abn`
instead of walking.

#### Tool 12, trades

`mode` selects the shape, and both modes come from the same fetch:

| Mode | Content |
|---|---|
| `raw` | Trade rows: event type, price USD and native, volume USD, base and quote amounts, block, timestamp, transaction id, maker, plus `traderProfile` |
| `aggregate` | One block per request: buy and sell counts, `netFlowUsd`, unique buyers and sellers, `newOnPairSharePct` (share of trades whose maker is new on THIS pair), size histogram in USD buckets, the largest trades, and the covered timestamp range with `rangeFullyCovered` |
| `both` | The aggregate block plus the rows |

Paging is by an opaque, versioned cursor bound to pair, orientation, event filter
and direction. It is built on the WebSocket command, not the Connect GET, because
only the WebSocket exposes `(blockNumber, transactionIndex, eventIndex)`; a
block-only cursor can skip trades that share the boundary block.

Per-row derived, with the semantics corrected in v1.1:

| Field | Definition |
|---|---|
| `traderNetCashFlowUsd` | `volumeUSDSell - volumeUSDBuy` from the counterparty profile. Net cash flow, NOT realized profit: cost basis and transfers are invisible here |
| `retainedBoughtPct` | The provider's `balancePercentage`, which is `balanceAmount / volumeBuy * 100`, verified on 99 of 100 captured rows. It is the share of what this wallet BOUGHT that it still holds on this pair. It is not percent of token supply and must never be described as one |
| `newOnPair` | The provider's `isNew`. New activity on THIS pair, not a globally fresh wallet |
| `firstSwapAtMs` | Unchanged provider value |

`traderProfile` ships compact by default (buys, sells, USD in, USD out,
`retainedBoughtPct`, `newOnPair`, `firstSwapAtMs`) and full on request. There is
deliberately no accumulating-versus-distributing label: the provider cannot see
transfers or other venues, so any such label would be a guess.

`eventType` replaces `side` and takes `all | swap | buy | sell | liquidity | add | remove`,
because the provider supports swaps-only and liquidity-only filters that v1 omitted.

Range aggregates page exhaustively within a declared bound; when the bound is hit
the block is named `pageAggregate` and carries the exact covered timestamp range
plus `rangeFullyCovered: false`. A one-page summary presented as a range summary
is the silent-cut failure this avoids.

#### Tool 13, top traders

Axes: `sortBy` over the four renamed sorts, `sortDir`, `lookbackDays` (the
provider's `mda`), `onlyKol` (`k=1`), `limit`. No `offset`: the provider
serves one bounded leaderboard. `lpId` is removed (measured ignored). The set
is **up to** 100 rows: with `k=1` the measured result was zero rows.

| Field | Kind | Definition |
|---|---|---|
| `netCashFlowUsd` | derived | `volumeUsdSell - volumeUsdBuy`. Named cash flow, not PnL |
| `currentHoldingValueUsd` | default | The provider's "unrealized" axis is `priceUsd * balanceAmount`, i.e. what the position is worth now, not profit |
| `retainedBoughtPct` | default | As above: retained share of what the wallet bought, not supply |
| `activeSpanSeconds` | derived | `lastSwap - firstSwap`. The span over which the wallet traded this pair, not a holding period |
| `summary.netCashFlowUsd` | derived | Sum across the returned cohort: how much cash the top cohort has taken out net |
| `summary.buySideCount`, `summary.sellSideCount` | derived | Counts, no inferred status |
| `unknowns` | always | Names what cannot be determined from this endpoint: transfers, other venues, cost basis, current supply share |

#### Tool 14, narratives

Axes: `chain`, `window`, `sortBy`, `sortDir`, `limit`, `fields`.

| Field | Kind | Definition |
|---|---|---|
| `marketCapChangePct`, `marketCapDeltaUsd` | default | Provider gives both per window; percent and dollars answer different questions |
| `tokenCount`, `liquidityUsd`, `volumeUsd` | default | |
| `volumeToMarketCapRatio` | derived | Narrative-level turnover |
| `topTokens` | optional | Drill-in: the narrative's leading pairs in the same call, so the agent does not need a second round trip through `metaIds` |
| `id` | always | The value the screening tools need in `metaIds`, cross-referenced in both descriptions |

#### Tool 15, spotlight

Axes: `feed`, `chainIds`, `limit`, `fields`. Derived: `boostTotalRank` and, on the
recent feed, the just-purchased amount separate from the running total, so "who
just started paying" is distinguishable from "who has paid the most".

#### Tool 16, chains

Rows carry slug, name, native chain id, architecture, dex slugs and count, block
explorer URL templates for account, token, transaction and holders, which audit
integrations exist for that chain (GoPlus, QuickIntel, CoinGecko, CMC and the
rest), and whether narratives are enabled. This is also the validation source: an
unknown `chainIds` or `dexIds` value is refused by name with candidates, the
`StructuredResolutionError` pattern from github-mcp, instead of quietly returning
zero rows.

#### What is deliberately NOT derived

No composite risk score, no "smart money" label, no buy or sell signal, no
liquidity-safety verdict. Every one of those hides its inputs behind a number the
agent cannot audit, and rule 90 forbids converting provider data into product
truth. The tools ship measurements; the model reasons.

## 5. What the agent can do afterwards, end to end

Worked flows, each one impossible or crippled today:

1. "What is moving on Robinhood Chain in the last hour?" -> tool 1 with
   `chainIds=robinhood`, `window=h1`, `minLiquidityUsd=10000`. Returns ranked rows
   with a real total count.
2. "Find new Solana launches under 3 hours old with at least 20k liquidity and 200
   buys" -> tool 5 with `chainIds=solana`, `maxPairAgeSeconds=10800`,
   `minLiquidityUsd=20000`, `minBuyCount=200`, `window=h1`.
3. "Is this token safe to buy?" -> tool 9 for the pair, tool 10 for honeypot, tax,
   mint authority, LP lock and holder concentration, tool 13 to see whether the
   top buyers already sold.
4. "Show me the 5-minute chart for the last 6 hours" -> tool 11 with
   `resolution=5m`, `startAtMs=now-6h`. "Now the daily chart since launch" ->
   `resolution=1d`, `limit=200`.
5. "Who has been buying this in the last hour, and how big?" -> tool 12 with
   `side=buy`, `startAtMs=now-1h`, `minVolumeUsd=500`.
6. "Has wallet X traded this pair?" -> tool 12 with `maker=X`.
7. "Which AI-narrative tokens on Solana are up today?" -> tool 14 for the
   narrative ID, then tool 3 with `metaIds` and `chainIds=solana`.
8. "What is still on the pump.fun bonding curve above 80 percent?" -> tool 6 with
   `stage=bonding`, `launchpadIds=pumpfun`, `minLaunchpadProgressPct=80`.
9. "Which chains and dexes can you even see?" -> tool 16.

---

## 6. Compliance with the provider-depth decree

Exposed in full: all 19 rank keys minus the one that is provably broken, all
working screener filters, all four windows, provider pagination to its real end,
all 17 candle resolutions, both candle series types, both price bases, the whole
trade filter surface, all four top-trader sorts, the whole pair-details payload,
narrative aggregates per chain and window.

Named omissions with reasons, to be written into the lane doc:

1. Per-window independent thresholds. The provider accepts a different window per
   threshold family (volume in h24 while ranking on m5). Vex exposes one
   `thresholdWindow` for all of them, because the full surface is 40 keys and an
   unusable schema is not depth. Revisit if a real query needs it.
2. `rankBy=fdv` is omitted because it is a measured server defect.
3. The audit filter family is omitted because the provider ignores it.
4. `subscribeTransactions` live push is omitted because the provider gates it off.
5. `moonshot*`, `categories`, `pairCreator`, `circulatingSupply` filters are
   omitted because they are measured dead.
6. The token-grouped screener channel (`v2/tokens`) is omitted because its ranking
   did not reproduce and its `pairsCount` is a page size, not a total.

---

## 7. Verification plan

Static and unit, all under `pnpm test`:

- Manifest lints with zero new allowlist rows: param keys canonical, param
  descriptions with unit anchors, tool descriptions with when-to-use and returns
  anchors, enum declaration, exclusivity groups, chain doc parity, no generic
  error literals, no stale output-cap claims.
- Public-name grammar plus `mappings/dexscreener.json` bidirectional parity.
- `__toolsnaps__` contract snapshot per tool plus `_catalog.json`.
- Envelope accounting: for client-side filtered families, kept plus dropped equals
  provider returned.
- Byte budget per tool family, measured on `Buffer.byteLength(result.output)`.
- Param boundary: over-max rejected by name, `limit: 0` rejected, unknown key
  rejected, string-array coercion, numeric-string coercion.
- Candle paging: a request for more than 999 walks pages and reports the walk;
  a bounded walk that hits its cap sets `truncated` with the reason.
- Transport absence: with the default transport, site-only tools return the typed
  refusal naming the remedy, and degradable tools answer with
  `transport: "public_api"` plus the `degraded` note.
- Decoder conformance against checked-in fixtures for protobuf and Avro.

Integration and live, `pnpm test:integration`:

- Live-shape tests per endpoint family against fresh captures.
- Bundle drift test: re-extract the protobuf descriptors from the live bundle and
  diff against `evidence/dexscreener-descriptors.pb`. A schema change fails the
  gate and names the changed message.

Retrieval and docs:

- `pnpm tool-reembed` then `pnpm test:eval:lexical` and `pnpm test:eval:dense`
  baselines updated as a reviewed diff.
- Embedding passage lint (use-when and example-queries anchors, banned phrases).
- `pnpm check:em-dash`.
- A generated `exported-tools` doc diffed in CI, the github-mcp docs-check pattern.

Electron side:

- Bridge lifecycle test: dispose is idempotent, in-flight requests abort, no window
  leaks across repeated open and close.
- Boundary test: `src/` still imports no Electron; the renderer never sees the
  bridge; `check:boundaries` unchanged.

---

## 8. Staging

The owner asked for no partial delivery. Staging here means order of landing, not
scope reduction; every stage ends green and nothing ships half-wired.

1. S1 Transport and codecs: contract, Electron bridge, protobuf and Avro and SSR
   decoders, fixtures, drift gate. No agent-visible change yet.
2. S2 Screening family (tools 1-6) plus `chains_list` (16), shared param module,
   envelope, snapshots, embeddings.
3. S3 Resolve and lookup (7-9) plus narratives (14) and spotlight (15).
4. S4 Deep dive (10-13): details, candles, trades, top traders.
5. S5 Delete the 12 old tools with no alias rows, prompt and navigation copy, lane doc
   with the named omissions, retrieval baselines, generated docs.

The old tools stay live until S5 so the agent is never without market data.

---

## 9. Alternatives considered

### 9.1 One screener tool instead of six

A single `dexscreener__pairs_screen` with a `sortBy` enum would cover tools 1-6.
Rejected as the primary design because Vex retrieval is per-tool: ToolSearch ranks
by embedding over the tool description, so "biggest losers today" and "new pump.fun
launches" retrieve much better against six intent-shaped tools than against one
generic one, and the working-set cost is paid only for the tools a session
actually pulls. The maintenance cost is near zero because all six spread the same
param module. Counter-evidence worth weighing: github-mcp consolidated 25 tools
into 8 with a `method` enum for exactly this context pressure, and is now A/B
testing the reverse behind a feature flag, which means they are not confident
either. This is the first thing Codex should challenge.

### 9.2 Public API only

Rejected: it cannot answer the questions the owner asked for. Kept as a degraded
transport where it genuinely helps (headless contexts, batch pair lookup).

### 9.3 Scraping the SSR HTML at all

Rejected and deleted in v1.2/v1.3 (Codex measured nothing exclusive on it and a
14-hour-stale QuickIntel snapshot). No SSR code ships.

### 9.4 A separate `dexscreener_pair` namespace for tools 9-13

Rejected: one provider, one namespace; the repo's namespace unit is the provider,
and splitting would duplicate the chain param and the identity params.

---

## 10. Owner decisions taken, and what is still open

Taken by the owner on 2026-08-24, in this conversation:

- **D-DS1 Implementation mode: builder subagent.** Claude Code delegates each
  stage to write-capable builders (Opus 5, effort low, medium only where the stage
  is complex, per the standing cap) and inspects every returned diff itself.
- **D-DS2 Retirement is total and alias-free.** All 12 current tools are deleted
  from the surface: manifests, handlers, embeddings, mapping rows, snapshots and
  their tests. No deprecation aliases. The owner's words: they are not needed and
  they only clutter. Consequence to implement: a call to a retired public name
  falls through to the ordinary unknown-tool path; no alias table row is added.
- **D-DS3 No public-API leftovers.** `orders`, `communityTakeovers` and the
  60-address batch pair lookup are dropped with their tools rather than kept alive
  on the public API. Named omissions in the lane doc, per the provider-depth
  decree. The public API remains only as a degraded transport inside a new tool
  when the site path is unavailable, never as a tool of its own.

Still open:

1. Sanitizing invisible and BiDi characters out of issuer-authored text changes
   content. Proposed: strip, and report `sanitizedFields`. Needs an explicit
   owner ruling against the no-silent-cutting decree, since the removal is
   reported and nothing is shortened.
2. Whether `dexscreener__pair_details_get` should be reachable from the existing
   pre-swap safety path (`TokenCheck`, `quote-safety.ts`) or stay independent.
   This touches money-path policy and is a rule 00 hard stop.
3. Studio MCP: all 16 tools are read-only and export by default under O20. Confirm
   no project-scope gating is wanted for market data.
4. Whether to add fields-usage telemetry (the github-mcp `mcp.fields.bytes_full`
   and `bytes_sent` pattern) so the projection's savings are measured rather than
   asserted.

---

## 11. Risks and stop conditions

| Risk | Mitigation | Stop condition |
|---|---|---|
| Undocumented provider contract changes without notice | Descriptors checked in, drift gate re-extracts and diffs; decoders are schema-driven, not hand-parsed | A schema change that removes a field a tool promises: fail the gate, fix the projection, never ship a silently empty column |
| Cloudflare posture hardens | Transport is one seam; the public-API degraded path and the typed refusal already exist | If the site path dies, tools answer with the typed refusal and the named loss, never with wrong data |
| Hidden window leaks or wedges | Single named owner, idempotent dispose, bounded concurrency, single-flight per URL, lifecycle test | A leak that survives dispose blocks the stage |
| Byte blowout in the model context | Projection by default, `fields` selection, column-oriented candles, per-family self-imposed byte budget test | A default call over budget fails the test |
| Legal and ToS exposure of using the site API from a signed app | Owner decision already taken and recorded here; read-only, single-user pace, no credential use, no circumvention of an auth boundary | If the provider states a prohibition or blocks the app specifically, stop and report |
| Agent misreads "no audit data" as safe | Per-chain coverage stated in output and description; `unavailable` with a reason | A projection that emits a pass where data is missing blocks the stage |

---

## 12. Not in this plan

CoinGecko: CANCELLED by the owner (2026-08-24, decision D-DS8), not deferred.
The owner's call after seeing the delivered surface: the site API's depth
(per-trade counterparty profiles, wallet leaderboards, 1s-to-1mo candles with
arbitrary historical windows, launchpad boards, audits and holders) makes a
keyed CoinGecko lane not worth building. Consciously accepted loss, named so
the decision is informed: assets with no DEX pool (pure CEX listings) and
global market aggregates stay uncovered by this namespace; DexScreener's own
`cg`/`cmc` listing blocks in pair details still surface CoinGecko identity
data for tokens that have it. If the need for CEX-only coverage ever
materializes, it is a NEW decision, not a revival of this one.

---

## 13. Contested after Codex review turn 1

Recorded so the disagreement is visible rather than settled by silence. Convergence
cap is three turns per review arc (owner decree 2026-07-29).

### 13.1 Screening tool granularity: six, three, or two

Codex recommends two contracts: one `dexscreener__pairs_screen` covering trending,
top, gainers, losers and new, plus a separate launchpad tool. His strongest
argument, and it is new evidence I had not weighed: **Studio exports every tool
statically through `tools/list` (decision O20)**, so six near-identical schemas are
paid by every MCP client on every session, whether or not retrieval ever selects
them. In-app ToolSearch does not pay that cost; Studio does.

My argument for intent-shaped tools stands on a different measurement: in-app
retrieval is per-tool over the description embedding, and "biggest losers today"
or "new pump.fun launches" match an intent-named tool far better than a generic
screener. There is also a correctness reason that neither of us raised in turn 1:
sorting by price change WITHOUT a quality floor returns measured garbage (top row
plus 7.2e12 percent). If one tool carries `sortBy`, the floor either becomes a
hidden default that changes with the sort, which is exactly the "silently ignores
a floor" failure the repo warns about, or the agent must know to set four
thresholds itself.

**Proposed synthesis for turn 2:** ONE `dexscreener__pairs_screen` with both a
full `sortBy` and an optional `preset` enum (`trending`, `top_volume`, `top_txns`,
`gainers`, `losers`, `new`) that expands to the site's own documented sort plus
quality floor, with the expansion echoed in `filtersApplied` so nothing is hidden;
plus `dexscreener__launchpad_pairs_list` kept separate for the reasons Codex
gives. That is two exported schemas instead of six, keeps every intent word in one
description and one embedding passage, and removes the hidden-default problem by
making the preset an explicit, echoed input. Retrieval quality of the merged tool
is then measurable against the existing lexical and dense baselines before
anything ships.

### 13.2 SSR fallback

Codex wants it removed entirely. I agree it must never be primary and must never
use `eval` or `Function`. It is worth keeping ONLY if a live probe shows it
answers something the WebSocket and HTTP paths cannot, which turn 2 should settle.
Otherwise it goes, and the JS-literal parser goes with it.

### 13.3 Live verification is still owed

Codex could not reach the network. Every measurement in this plan is mine, from
2026-08-23 and 2026-08-24, and a second independent probe run is a real gate, not
a formality. Turn 2 should either give Codex a network-enabled path or the owner
accepts single-source measurement with the archive as the record.

### 13.4 Provider terms

Codex raises DexScreener's API terms and the fact that exposing an undocumented
website API through a commercial MCP export is a different question from an agent
reading it locally. The owner has already directed the browser-user approach; this
note exists so the commercial-export dimension is decided explicitly rather than
inherited. Rule 00 legal hard stop.

### 13.5 Unresolved endpoints that block a completeness claim

`/dex/screener/v8/pairs-search` (subscribe by explicit id list; a candidate for a
bounded batch snapshot tool) and `/dex/screener/v2/tokens/...` (token-grouped
leaderboard, which is closer to the owner's "lists of tokens by chain" than a pool
screen is). Both must be live-probed before this plan can claim the provider
surface is fully covered.

---

## 14. v1.2 addenda: the two new tools and corrected contracts

### 14.1 Tool 17: `dexscreener__pairs_batch_get` (`dexscreener.pairs.batch`)

Backing: `wss://io.dexscreener.com/dex/screener/v8/pairs-search`, subscribe by
explicit `{chainId, id}` list, verified live by Codex turn 2: 3 ids in 593 ms,
140 ids in one 144,557-byte frame, chain and liquidity filters honoured,
ranking honoured (same members, different order), no pagination (pages past 1
empty with `pairsCount` retained).

| Param | Notes |
|---|---|
| `pairs` | string, `acceptsStringArray`, `chain:pairAddress` entries. NO artificial input ceiling (D-DS5; a live 300-input probe completed): large lists are chunked internally and the chunking reported. The measured failure mode is silent: invalid ids disappear and duplicates are preserved, so the response carries per-input accounting |
| `tokens` | string, `acceptsStringArray`, `chain:tokenAddress` entries. A token resolves to ONE provider-canonical pair which is NOT the deepest (measured: WETH resolved a $4.23M pool while a $117.31M pool existed). The description says so and `resolutionBasis: "provider_canonical"` is echoed |
| `sortBy`, `window`, threshold family | Same vocabulary as the screening family; filters apply to the resolved set |
| `fields` | Same row groups as the screening family |

Envelope: `requested`, `resolved`, `invalid_format[]` (syntactically bad,
echoed), `duplicates[]`, `provider_omitted[]` (a syntactically valid identity
the provider left out; the cause is unproven and never invented; measured on
91 active pump.fun and 7 Meteora DBC inputs, reported, never silently lost).
No `offset`/`page`: the channel has no pagination.

Gains: watchlist and portfolio snapshots. The agent refreshes up to 100 known
pairs in ONE round trip instead of 100 `pair_get` calls. This is a site-native
capability, not a resurrection of the retired public batch tool (D-DS3 stands:
the public API is not the backing).

### 14.2 Tool 18: `dexscreener__tokens_screen` (`dexscreener.tokens.screen`)

Backing: `wss://io.dexscreener.com/dex/screener/v2/tokens/{tf}/{page}`,
verified live by Codex turn 2: one row per base token, up to 100 per page,
chain/dex/liquidity/age filters work, rank keys select meaningfully different
sets but the token-level score is opaque (46-51 order violations against any
single representative-pair metric), `pairsCount` is the page length (not a
total), adjacent pages overlap (12-13 tokens re-appear).

| Param | Notes |
|---|---|
| Scope, window, thresholds, quality, shaping | The screening family vocabulary, minus what the channel ignores |
| `sortBy` | Exposed as the provider's rank keys with the honest name `providerRank` semantics: the description states the ordering is provider-opaque and not reproducible from any visible metric |

Envelope: `totalUnavailable: true` (the channel has no total), overlap warning
(`pagesOverlap: true` with the measured behaviour), and no claim of exhaustive
traversal. This satisfies the owner's per-chain TOKEN list requirement
literally, which the pool-level screen cannot (one token with ten pools is ten
pool rows but one token row here).

Gains: "top tokens on this chain" as TOKEN rows: market cap and FDV per token
with its representative pair, deduplicated by the provider.

### 14.3 Corrected contracts (supersede earlier sections where they conflict)

1. **Candles time range** (supersedes 4.8/tool 11 walk notes): `endAtMs`
   resolves to a block via `GetTransactions(timestampEnd=endAtMs)`; candles
   anchor with `bbn=block+1`; windows wider than 999 bars continue backward
   with `bbn`. `startAtMs` bounds the walk. `abn` is removed (measured
   non-functional as a forward anchor by both reviewers). `nextEndAtMs` is
   replaced by an exact block cursor `nextBeforeBlock`. Sparse series are
   normal at second-scale resolutions (5s: median 50 s gap): `summary.gapCount`
   plus `coveredRange` carry that; `lastBarPartial` is mandatory; the quote
   token is validated against the resolved pair locally because a wrong quote
   returns a silently inverted series (measured byte-identical).
2. **Search and token pairs** (supersedes 4.2 phrasing): exact-address search
   is bounded at 30 rows like text search; "every pair of that token" is
   withdrawn. `token_pairs_list` reports `providerCapped` and orders the
   returned window by liquidity; "deepest" always means "deepest among the
   returned bounded window" and `resolutionBasis` is echoed wherever a token
   was resolved to a pair.
3. **Pair details** (supersedes 4.8/tool 10 where units are concerned): every
   percentage family carries `{raw, normalizedPct, unit}` per source; GoPlus
   fractions and Solana percentages never mix silently. The subject block
   names the route used (pair-id vs token-id) because route-keyed caches
   diverge; an all-null HTTP 200 renders `unavailable` with reason
   `not_indexed_yet`, never as a pass. The stale claim that EVM chains carry
   no holder list is corrected: GoPlus returns holders and lpHolders on EVM.
4. **Top traders**: `lpId` removed (measured ignored); `onlyKol` stays with
   the measured zero-rows caveat in the description.
5. **Trades**: the only cursor is the exact `(blockNumber, transactionIndex,
   eventIndex)` triple from the WS command (a block-only cursor measurably
   skipped a same-block trade).
6. **WS dispatch**: every WS consumer dispatches on the protobuf oneof and the
   correlation id; the first binary frame is `latestBlock` in 72 of 74
   measured sessions and MUST NOT be treated as the result frame. Fixtures
   cover latestBlock-first and valid-empty-later orderings.
7. **SSR deleted**: `codec/server-data.ts`, the SSR fallback, its throttle
   entry, fixtures and risk rows leave the design. The degraded transport for
   headless contexts remains the public API only.
8. **Protobuf runtime**: pinned direct `@bufbuild/protobuf` with
   `createFileRegistry()` over `evidence/dexscreener-descriptors.pb`;
   allowlisted message names; byte cap before decode; bigint preserved; Zod
   validation on projections. Generated codecs are a later option, not v1.
9. **Decimals**: the provider publishes nullable token decimals with measured
   coverage (100/100 solana, 100/100 bsc, 48/100 base rows). Pair and token
   outputs expose them nullable; any computation that needs them fails closed
   when null. `volumeBase`/`volumeQuote`/VWAP stay withdrawn until fixed-point
   scale and orientation are proven against an independent source.
10. **Limits philosophy (D-DS5)**: no artificial caps anywhere. Ceilings equal
    provider reality; defaults are modest for context hygiene; every bound the
    agent may want to raise (`limit`, `maxPages`, deadline, aggregate depth)
    is a named parameter with its ceiling stated; every applied bound is
    reported in the envelope with the continuation.

### 14.4 Inventory after v1.2

18 tools: the 16 of section 4 unchanged in identity, plus `pairs_batch_get`
(17) and `tokens_screen` (18). Staging: 17 joins S3 (resolve and lookup), 18
joins S2 (screening). Retrieval texts for 17 and 18 are appended to
`tool-descriptions-v1.md`. Section 6's named omission of the v2 channel is
withdrawn (it is now exposed); the omission list gains `ms=true` on search
(measured: no membership change on three test queries; kept as a named
unverified parameter).

### 14.5 Frozen defaults, walk bounds, and the sanitization ruling (v1.3)

**Per-tool default floor matrix.** Each value is the DEFAULT of the named
threshold parameter; the agent may override any of them explicitly (tighten,
loosen, or disable with 0/null), and every effective filter is echoed in
`filtersApplied` with `qualityFloorApplied: false` whenever a default floor
was removed. The floors are h24-anchored exactly as the site sends them, even
when the ranking window is m5/h1/h6:

| Tool | Frozen defaults |
|---|---|
| trending | none |
| top (sortBy volume) | txns h24 min 50, liquidity min 25,000 USD, requireProfile true |
| top (sortBy txns) | requireProfile true |
| top (other sorts) | none |
| gainers, losers | txns h24 min 300, sells h24 min 30, volume h24 min 100,000 USD, liquidity min 250,000 USD, requireProfile true |
| new | maxPairAgeSeconds 86,400, minLiquidityUsd 1,000 |
| launchpad (bonding) | maxLaunchpadProgressPct 99.99 |
| launchpad (graduated) | minLaunchpadProgressPct 100 |
| batch, tokens_screen, search, token_pairs | none |

**Candle walk and anchor parameters (frozen):**

| Param | Type | Default | Ceiling | Notes |
|---|---|---|---|---|
| `maxPages` | integer | 10 | none (bounded by `deadlineMs`) | provider pages of up to 999 bars; the walk count ships in `providerWindow.pagesWalked` |
| `deadlineMs` | integer | 25,000 | 120,000 | the engine call budget is the outer bound; hitting it sets `truncated` with the exact covered range and `nextBeforeBlock` |
| anchor provenance | output | always | - | `anchorResolvedAtMs`, `anchorDistanceMs`, `rangeFullyCovered`; anchor is the nearest PRIOR trade (measured 393 s early on a 90-day target), approximate by contract. Fallback: no trade found near `endAtMs`, or `anchorDistanceMs` beyond one resolution step times 10, falls back to the backward walk from now, reported as `anchorFallback: true` |

`trades_list` aggregate depth uses the same `maxPages`/`deadlineMs` vocabulary
with the same defaults and reporting.

**Sanitization ruling (coordinator decision at the convergence cap, owner may
veto):** invisible, BiDi and Unicode-tag characters are stripped from
issuer-authored strings and reported per row via `sanitizedFields`. Rationale:
the no-silent-cutting decree's own test is "can the reader tell exactly what
was left out"; a reported removal of unrenderable control characters passes
it, and the github-mcp reference treats exactly this class as an injection
channel. Open question 10.1 is closed by this ruling.

### 14.6 Final-review fix round (v1.4, after Codex final-review turn 1, 2026-08-24)

Codex's final review (four lenses, all 18 tools driven live through the real
handler chain) returned BLOCKED with defects the coordinator accepts in full.
Decisions taken for the fix round:

1. **Floor removal becomes schema-representable.** New boolean
   `disableQualityFloor` on the floored screen tools drops every default floor
   at once; individual numeric overrides remain; `null` is not a legal value
   anywhere. `qualityFloorApplied`, summaries and override accounting derive
   from the EFFECTIVE filter set, never from the preset table.
2. **`chainVolumeSharePct` is honest again**: emitted only for single-chain
   queries; multi-chain queries emit `filteredSetVolumeSharePct` (the measured
   combined denominator) instead. No field keeps a name its denominator does
   not satisfy.
3. **Two newly measured provider axes are exposed** (depth decree):
   `sortBy: "boosts"` on `pairs_top_list` (provider rankBy=activeBoosts,
   measured 100/54,051) and `maxBoostCount` (measured working). `onlyRecentAds`
   is hereby recorded as a coordinator decision (it existed in S2b's brief but
   not in this plan; Codex was right to flag the gap).
4. **Artificial caps fall (D-DS5)**: search multi-chain fan-out cap 5 becomes
   a raisable `maxChains` parameter with default 5 and no hard ceiling (the
   deadline bounds it); narratives `topTokens` cap 10 and the 5-narrative
   enrichment bound become raisable parameters with the WS-cost stated;
   `maxPages` upper rejection at 1000 is removed (deadline is the bound); the
   undeclared 3,650-day `lookbackDays` cap is removed.
5. **Trades cursor comes from the LAST EMITTED row**, never the last fetched
   row; a two-page regression proves no gap and no duplicate at every limit.
6. **Candle continuation becomes callable**: new `beforeBlock` parameter
   accepts the returned `nextBeforeBlock`; `startAtMs` precedence is real;
   whenever requested data is withheld the envelope says `truncated: true`.
7. **`currentHoldingValueUsd` is emitted with its derivation**: exact
   decimal-string multiplication of the provider's `balanceAmount` by the
   pair's current `priceUsd`, both echoed, no binary floating point on the
   token amount lexeme. If the multiply cannot be exact, the field is null
   with `missingInputs`, never approximated silently.
8. **Supply and every decision-bearing amount survive as lexemes**: raw JSON
   number lexemes are captured losslessly (no JSON.parse Number path for
   those fields), with an unsafe-lexeme regression.
9. **Listings parsing is fixed for current provider shapes** (object-form
   CoinGecko websites/socials, object-form CMC tags), every emitted external
   string passes the sanitizer and reports in `sanitizedFields`, populated
   `hpi`/`ti` blocks are projected (schema known from the bundle) or, if their
   live shape resists validation, surfaced as `presentButUnprojected` with
   raw-size counts, never hidden. Coverage distinguishes native holders from
   GoPlus holders.
10. **Batch and token_pairs gain the full client-side threshold family**;
    spotlight gains its planned `fields` axis; missing metrics stay missing
    (`?? 0` removed; a row without the metric is `not_evaluated`, reported).
11. **`fields` is the one selection key everywhere** (pair_get's `include` is
    renamed); `atLeastOneOf` constraints declared on pair_get and batch.
12. **`tokens_screen` emits per-row `providerRank`** (ordinal in provider
    order). `chains_list` stops promising label vocabulary (the `labels`
    param description owns that list).
13. **Envelope truncation key unified with the output-envelope spec**
    (`truncatedByLimit` drift removed).
14. **D-DS7 drift repaired at the source first**: this fix round's description
    corrections are authored in `tool-descriptions-v1.md` (done), embeddings
    regenerate from it, and any extra text not present in the source is
    dropped.
15. **The spec travels with the change set**: the entire
    `tool-surface-spec/dexscreener-site/` directory (plan, retrieval source,
    recon, handoff, evidence) is copied into the implementation worktree so
    the delivered change carries its own authority.

16. **`include` and `fields` split per the repo vocabulary (coordinator ruling
    after S6):** `conventions.ts` deliberately separates `include` (side reads,
    each costing an extra request) from `fields` (shapes rows already fetched).
    pair_get therefore takes `fields: profile` and `include: reactions,insight`;
    the merged-key implementation from the fix round is corrected in the final
    pass. Cross-namespace vocabulary beats local convenience.
17. **`chainVolumeSharePct` under the strict rule:** emitted ONLY when the
    query is a single chain with no other row-excluding filter; any floored or
    otherwise narrowed set emits `filteredSetVolumeSharePct`. The frame's
    stats block reflects every filter in force (S6 builder's observation), so
    the looser single-chain rule still mislabelled floored subsets.

