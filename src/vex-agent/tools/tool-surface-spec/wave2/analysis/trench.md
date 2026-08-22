# Trench namespace analysis

## Packet sufficiency and evidence boundary

The packet is sufficient. Capability and limit claims below come from the Trench manifests and frozen Trench embedding passages. Chain coverage comes only from `TRENCH_CHAIN_ID` in `src/tools/trench-express/constants.ts`, where the value is `4663`. The routing exception comes from the permitted Trench sentences in `Swap Venue Routing`. No retrieval chain-name list or remembered protocol fact is used.

## Protocol and outcomes

Trench Express is a Robinhood Chain launchpad whose tokens begin on an ETH bonding curve and may later graduate to a WETH-paired pool. Its own registry is the freshest discovery surface for its launches.

- **Read:** browse and search Trench launches, distinguish curve from graduated tokens, inspect a token's recent trade tape, inspect the user's locally recorded launches, and list pre-staged image metadata. Registry browsing covers only Trench launches, uses an about two-second server cache, and exposes display-grade rather than USD prices. Rug flags were null in the measured sample, so presence is not a safety endorsement. The trade tape uses an undocumented endpoint; an empty result cannot distinguish a new token from a wrong address. Curve-progress reads are point-in-time and can be stale by action time.
- **Quote:** preview an ETH-curve buy or sell with fee-inclusive output, price impact, and curve progress. Preview a launch with creation fee, optional prebuy, separate Vex fee, gas, predicted address, and balance verdict. A launch preview without a wallet degrades to validation. Without a valid staged image it uses an empty-image fallback whose gas estimate is not fit to authorize a real launch.
- **Act:** buy a curve token with ETH or sell it back for ETH from a fresh matching quote. Launch execution writes the staged image on-chain and can include a same-transaction prebuy. The human launch-form path only drafts and parks the turn; it signs, spends, and creates nothing. Real trades and launches spend funds and are approval or authority gated. A pending or identity-unproven broadcast must not be retried.

## Model-visible retrieval terms

Each intended term occurs verbatim in at least one frozen `embeddingText` after case folding and whitespace collapsing only.

| Retrieval term | Frozen embedding source |
| --- | --- |
| `Trench Express launchpad` | `launch-preview.ts`, `launch.ts`, `my-launches.ts`, `search.ts`, `tokens.ts` |
| `Robinhood Chain` | all eight Trench embedding files |
| `bonding curve` | `tokens.ts`, `trades.ts` |
| `new launches on trench` | `tokens.ts` |
| `trade tape` | `trades.ts` |
| `price impact` | `trade.ts` |
| `Trench image locker` | `images.ts` |
| `Trench Photos` | `images.ts`, `launch.ts` |
| `estimated total cost` | `launch-preview.ts` |
| `launch a token for me` | `launch.ts` |
| `open the launch form` | `launch.ts` |
| `deploy the token` | `launch.ts` |
| `my trench launches` | `my-launches.ts` |
| `buy this trench token` | `trade.ts` |
| `sell my trench launchpad tokens` | `trade.ts` |

## Characteristics, limits, and chain coverage

- **Coverage:** Trench's registry contains only tokens launched there, never arbitrary Robinhood Chain pools. Search is a direct Trench lookup, not a multi-venue screener. The user's launch history is Vex-local and excludes launches created outside the app.
- **Freshness:** registry cache is about two seconds. Curve progress is sampled at one pinned block and is display or hunting grade. Launch pricing must be refreshed in the same turn as execution.
- **Costs:** curve trades include Trench's 1% fee and Vex's separate 25 bps fee on the ETH leg. Launches include creation fee, optional prebuy, gas, and the separately transferred 25 bps Vex fee after confirmation.
- **Provider and paging limits:** registry pages are provider-capped at 30. Trade-tape pages require a zero-based page and have no `hasMore`. The locker returns at most 50 metadata rows. No rate-limit contract or service guarantee is stated in this packet.
- **Cannot do:** it cannot research non-Trench pools, provide USD curve pricing, use holder or volume filters whose telemetry is unpopulated, create or upload an image, launch without a staged image on the agent path, or route a still-on-curve token through a standard AMM. It cannot prove safety from a rug flag or infer nonexistence from an empty local history or tape.
- **Chain projection:** `TRENCH_CHAIN_ID = 4663`, so the declaration must render Robinhood Chain 4663 only. Source: `src/tools/trench-express/constants.ts`.

## Facet coverage map

| Navigation facet label | Declaration prose representing it |
| --- | --- |
| `Trench curve trading (buy/sell)` | Paragraph 2: preview the price and price impact, then buy this Trench token with ETH or sell my Trench launchpad tokens back for ETH from the same fresh quote. |
| `Trench launchpad token browsing and search` | Paragraph 1: browse new launches on Trench, search by name or symbol, and distinguish bonding curve from graduated tokens. |
| `Trench trade tape and launch preview` | Paragraph 3: read the recent trade tape and preview a launch's estimated total cost without signing or spending. |
| `Launching a token on Trench` | Paragraph 4: inspect the Trench image locker, use a staged Trench Photos image, open the launch form for human decision, or deploy the token under the preserved authority rules. |

## Doctrine judgment

Source em dashes are represented as `&#8212;` so this artifact contains no em-dash character. A `DUPLICATED` row may be deleted only because the named description carries the quoted fact. A `JUDGMENT` row survives at the stated destination.

### Rendered capsule

| ID | Source sentence | Verdict | Carrying description or destination |
| --- | --- | --- | --- |
| C-S1 | "Trench Express, the BONDING-CURVE launchpad on Robinhood Chain (4663): its own registry of curve and graduated tokens, the ETH-curve trade path that is the ONLY way to trade a token still on its curve, and the launch path itself." | DUPLICATED | Token browser: "launchpad's own registry - ONLY tokens launched on Trench Express appear here"; trade execution: "Buy or sell a Trench Express bonding-curve token"; launch execution: "Create a token on Trench Express". |
| C-S2 | "Because it is the launchpad's own registry with an about 2-second cache, it sees a token from its FIRST BLOCK - which is exactly why it is reached for ahead of an indexer, and why a token missing from `dexscreener` is still here." | DUPLICATED | Token browser: "Server cache is about 2s, so this is the fastest fresh-launch surface on the chain" and "never other Robinhood pools (research those with dexscreener once indexed)". |
| C-W1 | "Use when the user names Trench, asks what just launched on Robinhood Chain, or wants to buy, sell or launch a curve token: quote then trade against the curve, screen or search the registry, read a token's trade tape, price a launch, launch one, or review their own launches." | DUPLICATED | Frozen and manifest descriptions individually carry each outcome, including "Use this when the user wants what is launching or moving on Trench", "Read the recent trade tape", "Dry-run a Trench Express token launch", and "List the tokens the user has launched". |
| C-W2 | "Trades and launches spend real ETH, are approval-gated, and a launch requires an image the user pre-staged in the app." | DUPLICATED | Trade execution: "Spends real funds and is approval-gated"; launch execution: "SPENDS REAL FUNDS AND IS IRREVERSIBLE" and "An image is REQUIRED and must already be in the locker." The exact irreversible launch sentence and authority matrix also survive in the launches task shape under L1 and L11-L15. |
| C-P1 | "Use `kyberswap` to trade tokens that already trade in a standard AMM pool, and `dexscreener` for broader pair research." | JUDGMENT | `swap` task shape for venue routing and `research` task shape for broader indexed-pair research. |
| C-P2 | "A graduated Trench token trades in a WETH-paired DEX pool on Robinhood Chain; where that pool is indexed, research it with `dexscreener`." | JUDGMENT | Declaration for the local graduation and WETH-pool fact; `swap` and `research` task shapes for cross-namespace routing. |
| C-P3 | "`virtuals` is a different launchpad (VIRTUAL-paired agent tokens) &#8212; Trench tokens never appear there." | JUDGMENT | Declaration as a local coverage limit; no venue preference is attached. |

### Swap Venue Routing sentences about Trench

| ID | Source sentence | Verdict | Destination |
| --- | --- | --- | --- |
| S1 | "Trench exception, Robinhood Chain (4663): a Trench Express token that is still on its bonding curve trades ONLY against ETH on that curve &#8212; quote with `trench__trade_quote`, then execute with `trench__trade_execute`." | JUDGMENT | Declaration for the ETH-curve local fact; `swap` task shape for the quote-then-execute routing procedure. |
| S2 | "`kyberswap.*` has no route for a curve token, so a failed swap quote there is not evidence the token is untradeable." | JUDGMENT | `swap` task shape. This is the measured exception that prevents discovery from stopping at the wrong venue. |
| S3 | "Once a Trench token GRADUATES it leaves the curve for a WETH-paired pool and the normal venue rules apply again." | JUDGMENT | Declaration for the local stage transition; `swap` task shape for the venue transition. |
| S4 | "pools.fun contrast, same chain: a pools.fun token has NO bonding curve and NO graduation, so it sits in a real SushiSwap V3 pool from its FIRST block and trades through `kyberswap.*` like any other ERC-20 (measured: 13 of 13 sampled tokens routed, including ones launched minutes earlier)." | JUDGMENT | `swap` task shape as cross-launchpad routing. The pools report owns the local pools.fun facts. |
| S5 | "The `pools.*` namespace therefore has NO trade tool by design." | JUDGMENT | `swap` task shape; the pools declaration must state the local capability limit. |
| S6 | "Never route a pools.fun token through `trench__trade_*`, and never route a Trench curve token through `kyberswap.*`." | JUDGMENT | `swap` task shape. |

### Trench Launch

| ID | Source sentence | Verdict | Carrying description or destination |
| --- | --- | --- | --- |
| L1 | "Launching a token on Trench Express (Robinhood Chain, 4663) spends real ETH and cannot be undone." | JUDGMENT | Preserve byte-exact in the `launches` task shape as irreversible-effect prose. |
| L2 | "The path is fixed:" | JUDGMENT | `launches` task shape, attached to the ordered planning, preview, human-form, and execution branches. |
| L3 | "PLANNING starts at `trench__images_list`: a launch REQUIRES an image the user pre-staged in the app and you can never supply one." | DUPLICATED | Image-list description: "A Trench launch REQUIRES an image, and you cannot create or upload one" and "CHECK THIS WHILE PLANNING a launch". |
| L4 | "If the locker is empty, do not improvise around it &#8212; ask the user to upload an image to the Trench Photos card, then continue." | DUPLICATED | Image-list description: "if the locker is empty, stop and tell the user to upload an image on the right side before the mission can proceed." |
| L5 | "`trench__launch_preview` is this path's preview under the `# Safety Contract`'s fresh-quote rule: it dry-runs the launch and reports the predicted token address, the creation fee, the 25 bps Vex fee (a separate transfer that runs only after the launch confirms), and the gas cost." | DUPLICATED | Launch-preview description names `predictedTokenAddress`, `creationFeeWei/Eth`, the `vexFee` block, gas figures, and the fee-inclusive total; launch-execution description says the Vex fee is "a SEPARATE transfer that runs only after the launch confirms". |
| L6 | "Preview in the same turn you intend to execute." | DUPLICATED | Launch-preview description: "Use this while planning a launch, in the same turn you intend to execute it". |
| L7 | "`trench__launch_request_form` is how you hand the launch DECISION to the human: it asks them to fill in the launch form instead of you choosing the token's details." | DUPLICATED | Launch-form description: "Hand the launch DECISION to the user" and "asks them to create the token themselves through the app's launch form". |
| L8 | "It spends nothing and creates nothing &#8212; it drafts the launch and parks the turn." | DUPLICATED | Launch-form description: "DRAFTS AND ASKS ONLY"; "does NOT spend"; "does NOT create anything"; and "Your turn PARKS while the form is open". |
| L9 | "The runtime resumes you with the outcome as this call's result when the user deploys, dismisses the form, or it expires, so do not call it again while the form is open and never assume the launch happened." | DUPLICATED | Launch-form description: "the runtime resumes it with the outcome when the user deploys, dismisses the form, or it expires" and "do not call it again while the form is open, and never assume the launch happened without that resumed outcome." |
| L10 | "Never improvise a launch another way." | DUPLICATED | Launch-form description: "report that and stop, never improvise a launch by another route." |
| L11 | "`trench__launch_execute` signs and broadcasts the launch irreversibly, and only under explicit authority." | JUDGMENT | Preserve byte-exact in the `launches` task shape as the authority-matrix preamble. |
| L12 | "In a FULL-permission chat session that authority is the user's own permission: execute directly, exactly as you would a swap." | JUDGMENT | Preserve byte-exact in the `launches` task shape. |
| L13 | "In a RESTRICTED session it refuses by name &#8212; call `trench__launch_request_form` instead, because the launch form is this tool's consent surface and the user's Deploy click is what launches." | JUDGMENT | Preserve byte-exact in the `launches` task shape. |
| L14 | "In a MISSION run the authority is the contract's host-authored launch ceilings; when the contract carries none the tool refuses by name, so report that refusal and tell the user to set the max launch value and max launch count on the contract card." | JUDGMENT | Preserve byte-exact in the `launches` task shape. |
| L15 | "Never look for another way to launch." | JUDGMENT | Preserve byte-exact in the `launches` task shape with the authority matrix. |

## D4 note

Trench is described neutrally. The declaration states only its own curve-trading and launch capabilities and limits. KyberSwap preference, fallback switching, and the standard-pool transition appear only in the `swap` task shape. The Trench curve exception remains there because it is a product fact, not a preference claim.

## Draft declaration

> ### Trench Express
>
> The Trench Express launchpad runs on Robinhood Chain 4663. Its own registry covers Trench launchpad tokens from their earliest blocks, including coins still on the bonding curve and coins that have graduated into a WETH-paired pool. Use it to browse new launches on Trench, search by name or symbol, inspect curve stage and progress, or revisit my Trench launches. The registry is cached for about two seconds and covers only Trench launches. It is not a broad pool screener, its prices are display-grade rather than USD quotes, and a returned rug flag is not a safety endorsement.
>
> For curve trading, preview the price impact and fee-inclusive output before acting. Requests such as buy this Trench token or sell my Trench launchpad tokens use ETH against the curve and require a fresh matching quote. A buy spends ETH for tokens; a sell approves the token and returns ETH. The ETH leg includes Trench's 1 percent curve fee and Vex's separate 25 bps fee. A token still on the curve has no standard AMM route. After graduation it leaves the curve for a WETH-paired pool, where normal venue routing resumes. Curve progress is a point-in-time read and can change before a trade.
>
> For investigation, read the recent trade tape to see buys, sells, makers, fills, price, and volume. The tape comes from an undocumented endpoint and has no explicit end cursor. An empty tape cannot distinguish a new token from a mistyped address, so resolve the token first. For launch planning, preview the fixed creation fee, optional prebuy, estimated total cost, gas, and predicted address without signing or spending. A preview without a selected wallet validates inputs only. An empty-image fallback does not price the real launch image.
>
> A launch requires an image already staged in the Trench image locker through Trench Photos. Vex cannot create or upload it. Check the locker while planning; if it is empty, ask the user to stage an image. Use launch a token for me or open the launch form when the human should decide the details and cost. The form drafts the request and parks the turn; it creates nothing, and the resumed outcome is the only evidence that deployment occurred. Use deploy the token only under the preserved session or mission authority rules. Launching a token on Trench Express (Robinhood Chain, 4663) spends real ETH and cannot be undone. A pending result or a confirmed result without proven token identity must never be retried.
