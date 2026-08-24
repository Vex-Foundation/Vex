# DexScreener analysis

## Identity

DexScreener is Vex's read-only research surface for DexScreener-indexed AMM pairs and the provider's profile, narrative, takeover, boost, advertisement, and promotion-order labels. It can resolve a textual candidate to an exact chain and contract address, compare indexed pools, inspect a known pool, batch known token addresses, and inspect provider-selected attention and promotion feeds. It is neither an execution venue nor a contract-safety authority.

No DexScreener-specific sentence exists in `identity.ts`; this conflicts with recon section 8's parenthetical claim that identity positions it. The relevant positioning is in the navigation entry and Token Research Map.

## Outcomes

- **Read:** Search pairs by name, symbol, or address; inspect a known pool; compare indexed pools for one exact token; batch market observations for known token addresses; read profile updates, CTO labels, paid boosts, ad placements, promotion orders, trending narratives, narrative members, and the synthetic profile-plus-boost merge.
- **Quote:** Return observed pool prices, liquidity, volume, transaction, age, FDV, market-cap, and price-sanity data. These are research observations, never an executable quote.
- **Act:** None. Every manifest is `mutating: false` with `actionKind: "read"`. Trading requires a fresh quote from an execution venue.

## Retrieval terms

Each phrase below appears verbatim in at least one namespace `embeddingText` after case and whitespace normalization:

| Term to render | Frozen embedding source |
| --- | --- |
| `name or symbol` | `embeddings/dexscreener/core.ts`, search |
| `exact chain and contract address` | `embeddings/dexscreener/core.ts`, search |
| `pool address` | `embeddings/dexscreener/core.ts`, pairs |
| `multiple exact token addresses` | `embeddings/dexscreener/core.ts`, tokens |
| `fresh executable quote` | `embeddings/dexscreener/core.ts`, token pairs |
| `token profile metadata` | `embeddings/dexscreener/trending.ts`, profiles |
| `paid boosts` | `embeddings/dexscreener/trending.ts`, boosts |
| `community-takeover` | `embeddings/dexscreener/trending.ts`, takeovers |
| `synthetic profile plus boost merge` | `embeddings/dexscreener/trending.ts`, attention |
| `trending narratives` | `embeddings/dexscreener/trending.ts`, trending |
| `paid promotional orders` | `embeddings/dexscreener/orders.ts`, orders |
| `ad placements` | `embeddings/dexscreener/orders.ts`, ads |

Dropped from the declaration: tool-specific parameter spellings, row-field names, feed selector values, and public call names. Those belong to discovery metadata and descriptions.

## Characteristics and limits

- Pair and feed results are provider-chosen windows. Vex can filter, sort, and page only within those windows; an empty or missing row does not prove that no market exists.
- New-pair discovery lags. `research.ts` records roughly 30-second edge caching and measured discovery lag from minutes to hours, including about 16 minutes on Solana and about 7 hours on Robinhood. This is not a fresh-launch feed.
- Search ordering is provider relevance, not a ranking, and a ticker match is not identity. Resolve exact chain and contract address before relying on a candidate.
- Most pair and fixed-feed windows are bounded at about 30 provider rows. Exact-pool and token batch calls accept up to 60 addresses by splitting them into provider-safe groups of 30. The narrative-detail set can exceed 30, while the narrative-list size is provider chosen.
- Trending and narrative surfaces are live but undocumented. Their ordering is influenced by engagement and paid promotion and must not be called organic, genuine, complete, or a safety ranking.
- Attention is a Vex-side synthetic profile-plus-boost merge, not a provider feed. It has no usable timestamp and is not an organic signal.
- Profiles describe metadata updates, not token creation. CTO is a provider label, not proof that control changed. Boosts, ads, and paid orders show purchased visibility, never demand, legitimacy, quality, or safety. Boost units are not currency amounts, and an ad impression field may describe a package tier rather than delivered reach.
- The packet gives no numeric rate-limit contract. Undocumented feeds surface rate-limit, transport, or unreadable-payload failures rather than converting them to empty success.
- All operations are read-only. No provider request-cost schedule is documented in the packet.

## Chain coverage

`catalog.ts` registers all DexScreener manifests under the active `dexscreener` namespace. `manifests/core.ts` states that chain inputs use DexScreener string slugs and gives Ethereum, Base, Solana, BSC, Arbitrum, Polygon, Avalanche, Optimism, and Robinhood as examples followed by "and more". The search manifest likewise gives a non-exhaustive example set and says it searches across every chain exposed by the provider search.

Therefore the declaration may say "DexScreener-indexed pairs across provider-supported chains, including Robinhood". It must not claim a closed chain list. The packet contains no catalog-owned or manifest-owned exhaustive chain projection, so exact complete coverage is insufficiently specified. Retrieval chain-name lists were not used.

## Facet coverage

| Navigation facet | Declaration prose that represents it |
| --- | --- |
| Search and pair analytics | "Resolve a name or symbol to an exact chain and contract address, inspect a known pool address, compare indexed pools for one token, or batch multiple exact token addresses." |
| Trending narratives and profiles | "Read token profile metadata and trending narratives; drill into a selected narrative. Treat ordering as engagement and promotion influenced. Use the synthetic profile plus boost merge only when that combined view is explicitly requested." |
| Community takeovers and promotion checks | "Read community-takeover labels, paid boosts, ad placements, and paid promotional orders without inferring control, demand, legitimacy, or safety." |

All three frozen facet labels are represented exactly once.

## Doctrine judgment

DexScreener has no section in `protocols.ts`. The rendered capsule and relevant Token Research Map prose are classified below. Tool names in quotations are source text only and are not proposed declaration prose.

### Capsule summary

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| "Vex's read-only market-research backbone and source of truth for DexScreener-indexed AMM pairs, including robinhood, and DexScreener's own profile/promotion labels." | JUDGMENT | Declaration, local namespace identity aggregating multiple manifests. |
| "Research flow: discover → resolve the address with `TokenFind` → verify liquidity → quote on a venue." | JUDGMENT | Research task shape; cross-surface procedure. |
| "Characteristic: its pool depth, liquidity and volume observations are real, but indexing LAGS - on some chains a new pair takes hours to appear - so it answers how deep and how real a market is, not what launched in the last hour, and it is not a token-creation or newly-listed-pair feed." | JUDGMENT | Declaration, local limit; freshness measurement is also carried by `research.ts`. |
| "It does not establish contract safety, token identity from a ticker, complete market coverage, or an executable price." | JUDGMENT | Declaration, namespace-wide negative boundary. |

### Capsule whenToUse

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| "Route exactly: token address + chain -> `tokenPairs`; name/symbol -> `search`, select the exact chain + contract address, then `tokenPairs`; pool address + chain -> `pairs`; multiple addresses on one chain -> `tokens`; narrative -> `trending`, then `meta`; promotion -> `boosts`/`ads`, then per-token `orders`." | JUDGMENT | Research task shape for the multi-stage sequence; the declaration keeps only outcome-level local routing without names. |
| "Profiles report metadata updates, not token creation; CTO is a provider label, not proof." | DUPLICATED | Profiles description: "A profile update is metadata, NOT token creation: neither feed says when a token or pair was created, and young pools surface here through marketing activity rather than a launch record." Takeover description: "This provider classification is not proof that ownership, admin keys, or contract control changed." |
| "Trending/meta are live undocumented feeds influenced by engagement and promotion, not organic or genuine rankings." | DUPLICATED | Trending embedding: "This endpoint is live but undocumented, and ordering is influenced by engagement and paid promotion such as boosts, alongside verified information and audits, rather than organic demand." It also says: "Do not call the ordering genuine, organic, complete, or a safety ranking." |

### Capsule preferInstead

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| "Use a dedicated chain safety tool for contract risk." | JUDGMENT | Research task shape; cross-namespace routing. |
| "For execution, always request a fresh quote from `kyberswap`, `solana`, or the chosen venue; never treat a DexScreener price as executable." | JUDGMENT | Research task shape; cross-namespace routing. Local declaration keeps only that observations are not executable quotes. |

### Relevant identity and research prose

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| `identity.ts` DexScreener positioning | N/A | No DexScreener-specific sentence exists in the file. |
| "`dexscreener.*` &#8212; source of truth for AMM pairs DexScreener indexes and for DexScreener's own profile, CTO, boost, ad and order labels." | JUDGMENT | Declaration, local identity. |
| "It is NOT contract-safety evidence, canonical token identity from a name/ticker, proof of complete market coverage, or an executable quote." | JUDGMENT | Declaration, local negative boundary. |
| "A missing row means DexScreener did not return an indexed row in that provider window, not that no market exists." | DUPLICATED | Search filter description: "an EMPTY RESULT DOES NOT MEAN THERE IS NO POOL THERE." Token batch embedding: "Do not use it to resolve names or symbols, and do not treat missing rows as proof that a market does not exist." |
| "Route by the identity you already have: exact token address + chain -> `dexscreener__token_pairs_list`; name/symbol -> `dexscreener__pairs_search`, select an exact chain + contract address from the result, then `dexscreener__token_pairs_list`; exact pool address + chain -> `dexscreener__pairs_get`; multiple token addresses on one chain -> `dexscreener__tokens_get`." | JUDGMENT | Research task shape; multi-stage selection procedure. |
| "Never identify a token from ticker text alone." | DUPLICATED | Search description: "A symbol match is never identity: confirm with an exact contract address before quoting a price." |
| "For narratives call `dexscreener__narratives_list`, then `dexscreener__narrative_get` with the selected narrative slug." | JUDGMENT | Research task shape; multi-stage narrative procedure. |
| "Both endpoints are live but undocumented, and their ordering is influenced by engagement and paid promotion; do not call it organic or genuine." | DUPLICATED | Trending and narrative descriptions plus their embedding text carry the same limits. |
| "Profiles are metadata-update feeds, not token-creation feeds." | DUPLICATED | Profiles description carries this exact distinction. |
| "A CTO row is only DexScreener's provider label, not proof that control changed." | DUPLICATED | Takeover description carries the provider-classification and no-proof-of-control language. |
| "For promotion use `dexscreener__boosts_list` (feed: latest for the newest boost purchases, feed: top for the largest cumulative boosts), `dexscreener__ads_list`, then `dexscreener__token_orders_list` for one exact token." | JUDGMENT | Research task shape; multi-stage promotion procedure. |
| "Promotion is never demand, legitimacy, or safety." | DUPLICATED | Ads description: "An ad is bought visibility, never demand, legitimacy, or safety." Boost embedding: "A boost is promotion, never organic demand, legitimacy, or contract safety." |
| "Before any trade, use the chain's dedicated contract-safety surface when available, then request a fresh executable quote from the venue that would execute." | JUDGMENT | Research task shape; cross-namespace routing. |
| "DexScreener market data can shortlist a pool; it must never be reused as the execution price." | JUDGMENT | Declaration keeps the local non-executable limit; research task shape owns the handoff to execution. |
| "FRESHNESS LAG (measured 2026-08-17): DexScreener reads are edge-cached about 30s and are never real-time; its DISCOVERY lag for brand-new tokens is minutes to hours (youngest reachable pool measured ~16 min on Solana, ~7 h on Robinhood), because launch -> indexing -> profile -> feed window all sit in front of it." | JUDGMENT | Declaration, local freshness limit sourced from the measured research prose. |
| "For fresh-token discovery route by chain instead: fresh Solana -> `solana__tokens_discover` category=recent (measured: tokens 10-175 s old, createdAt on every row proves age); fresh Robinhood -> `trench__tokens_discover` status=curve sort=time (launchpad registry, ~2 s cache, launchedAtMs proves age) - COVERAGE: only tokens launched on Trench Express, never other Robinhood pools." | JUDGMENT | Research task shape; cross-namespace freshness routing. The Solana clause is present only when that namespace is available. |
| "Use DexScreener afterwards, for depth, price sanity and risk once the pool is indexed." | JUDGMENT | Research task shape; cross-namespace sequence. "Risk" must mean market observations, not contract safety. |
| "`solana__tokens_discover` / `solana__tokens_search` &#8212; Solana discovery." | JUDGMENT | Research task shape; supporting fresh-discovery alternative, present only when the Solana namespace is available. |
| "Use `solana__tokens_discover` when you do NOT have a name yet (category=recent for freshly launched, or the top-traded and top-organic feeds); use `solana__tokens_search` once you already have a symbol, name or mint." | JUDGMENT | Research task shape; supporting fresh-discovery procedure. |
| "Jupiter carries signal the free pair feeds do not: organic score, verification, holder counts and safety-audit flags." | JUDGMENT | Research task shape; explains why fresh Solana discovery precedes DexScreener. |
| "Prefer it over a generic feed for fresh Solana launches." | JUDGMENT | Research task shape; cross-namespace freshness routing. |
| "`trench__tokens_discover` / `trench__tokens_search` / `trench__token_trades_list` &#8212; Trench Express launchpad tokens on Robinhood Chain (4663), still on the ETH bonding curve or already graduated: browse and screen what just launched, resolve a token the user names, and read one token's recent fill tape." | JUDGMENT | Research task shape; supporting fresh Robinhood discovery. |
| "A GRADUATED Trench token has left the curve for a WETH-paired DEX pool on that chain, and its pool id and pool currencies are on the row &#8212; where that pool is indexed, research it with `dexscreener.*` as you would any other pair." | JUDGMENT | Research task shape; launchpad-to-indexed-pair sequence. |
| "`virtuals.*` &#8212; Virtuals Protocol agent tokens (quoted in VIRTUAL) on Robinhood Chain, Base, Solana and Ethereum." | JUDGMENT | Research task shape; launchpad-native identity. |
| "This is the LAUNCHPAD-NATIVE view and the only source for it: UNDERGRAD bonding-curve vs graduated status, holder concentration, market cap in VIRTUAL, the anti-sniper buy-tax window, the recent-graduations feed and the genesis launch calendar." | JUDGMENT | Research task shape; launchpad-native state remains outside the DexScreener declaration. |
| "A GRADUATED agent token trades in an ordinary indexed pair, so where that pair is indexed `dexscreener.*` carries its pool-side liquidity, volume and momentum &#8212; read BOTH: `virtuals.*` for launchpad state and the sniper window, `dexscreener.*` for the pair." | JUDGMENT | Research task shape; two-surface research sequence. |

Assignment count: 35 rows total, comprising 9 capsule sentences, 25 relevant Token Research Map sentences, and 1 explicit `identity.ts` N/A row. No capsule or DexScreener-related research sentence is unassigned. The Trench and Virtuals evidence confirms that launchpad-native discovery precedes DexScreener pair research once a graduated pair is indexed. It remains owned by the research task shape, not duplicated into this declaration.

## D4 note

Not applicable. DexScreener is not one of the four execution venues and the declaration names no venue preference. The research task shape should say only that execution needs the chain's safety surface and a fresh quote from the venue that will execute.

## Draft declaration

> **DexScreener**
>
> DexScreener is read-only market research for AMM pairs that DexScreener indexes across provider-supported chains, including Robinhood. It also exposes the provider's token profile metadata, community-takeover labels, paid boosts, ad placements, paid promotional orders, and trending narratives. It never executes a trade.
>
> **Read:** Resolve a name or symbol to an exact chain and contract address, inspect a known pool address, compare the indexed pools for one exact token, or batch multiple exact token addresses on one chain. Read liquidity, volume, price, transaction, age, FDV, market-cap, and cross-pool price-sanity observations. Browse token profile metadata and trending narratives, then inspect a selected narrative. Check community-takeover labels and purchased promotion. Use the synthetic profile plus boost merge only when that combined view is explicitly requested.
>
> **Quote:** Pool prices are observations, not executable quotes. This namespace provides no fresh executable quote. **Act:** No action is available in this namespace.
>
> **Use when:** You need indexed pair discovery, exact-pool analytics, portfolio address pricing, narrative research, or DexScreener's own promotion labels. A ticker match is not identity, so confirm the chain and contract address. A profile update is not token creation. A community-takeover label does not prove control changed. Paid visibility is never evidence of demand, legitimacy, quality, or safety.
>
> **Characteristics and limits:** Results cover only provider-selected windows and indexed markets. Filters and sorting cannot widen those windows, so a missing row does not prove that no market exists. Reads are edge-cached and new-pair discovery can lag from minutes to hours; this is not a fresh-launch feed. Trending and narrative surfaces are live but undocumented, and their order is influenced by engagement and promotion rather than being organic, genuine, complete, or a safety ranking. The synthetic attention merge is Vex-created, has no usable timestamp, and is not a provider ranking. It does not establish contract safety.

Draft size is approximately 2.3 KB. It contains no public tool name or dotted identifier.
