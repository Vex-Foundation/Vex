# pools.fun namespace analysis

## Identity and outcomes

pools.fun is a no-curve token launchpad on Robinhood Chain. A launch creates a fixed-supply token directly in a SushiSwap V3 pool and permanently locks the full-range liquidity position. It is distinct from Trench Express despite sharing the same chain.

- Read: browse and filter launches, resolve a name or symbol to an address, read OHLCV history, join one launchpad record to on-chain pool and fee data, and list launches attributed to the selected wallet.
- Quote: estimate a launch from the current deployment fee and optional ETH prebuy, or simulate a creator-fee claim. The launch estimate cannot predict the eventual token address.
- Act: open the user's launch form, launch under the applicable authority, or claim creator fees. Launching spends real funds and cannot be undone. A real claim spends gas.

The namespace has no trading action. Its tokens enter ordinary SushiSwap V3 pools from their first block. Acquisition is a separate KyberSwap quote and execution stage. Pair-liquidity research is a separate DexScreener stage.

## Retrieval terms

Each intended model-visible term below occurs verbatim in at least one frozen `embeddingText`, after case and whitespace normalization only.

| Intended term | Verified frozen passage |
| --- | --- |
| `pools.fun launchpad` | `embeddings/pools/tokens.ts` |
| `new pools fun launches` | `embeddings/pools/tokens.ts` |
| `price history` | `embeddings/pools/candles.ts` |
| `full detail` | `embeddings/pools/token.ts` |
| `my launches on the robinhood launchpad` | `embeddings/pools/my-launches.ts` |
| `claim my creator fees` | `embeddings/pools/claim.ts` |
| `pools fun launch form` | `embeddings/pools/launch.ts` |
| `launch the coin on pools fun now` | `embeddings/pools/launch.ts` |
| `trading quote` | `embeddings/pools/search.ts` |

Dropped from the draft as explicit retrieval terms: `fee split`, `pool address`, `launch cost/estimate`, and `deploy my coin`. They occur in aliases or example intents, but not as those exact phrases in an `embeddingText`. Their concepts remain in prose without being declared as coupling terms.

## Characteristics and limits

- Coverage is Robinhood Chain only. Runtime source: `src/tools/pools-fun/constants.ts:20`, `POOLS_CHAIN_ID = 4663`. No retrieval chain-name list is used as prompt fact.
- The launchpad registry sees tokens from their first block because there is no bonding curve or graduation stage. Browse results are provider-indexed and use a five-second server cache. An empty result is valid. The selected wallet's launch history can omit an outside launch or a launch not yet indexed.
- Market price, market cap, volume, and price-change figures are display-grade. Symbols are not identities. One-token detail anchors on-chain reads at one reported block and distinguishes registered, unregistered, and unavailable results.
- No holder count or liquidity figure is available. Candles are capped at 1,000 with no time cursor; widen the candle span for longer history. The provider documents no read rate limit. Image upload is limited to roughly one request per minute.
- Every pool charges 1 percent per trade. A normal creator split is 20 percent of those fees, with a different measured split for stock pairs. Claims pay the launched token and paired asset as separate amounts that must not be added.
- Launch cost is dynamic and must be read and verified at launch time. An agent launch supports WETH or USDG pairing, but autonomous prebuy is native WETH only. Tokenised stocks are discoverable from the older launcher but cannot be launched through this path.
- An agent launch requires an already-staged image. The agent cannot create one. There is no Trench-style product byte limit for pools.fun, although the shared locker retains its resource ceiling. A launch without an image is possible only through the user's own form and can leave the token permanently blank.
- The creator-fee recipient is pinned to the session wallet on the agent path. Only the user's form may name another recipient. The preview is advisory and never predicts the final token address.

## Facet coverage map

| Navigation facet | Declaration representation |
| --- | --- |
| `pools.fun browsing and search` | Browse and filter launches; resolve repeated names or symbols to an address; registry freshness and display-grade limitations. |
| `pools.fun candles and token detail` | OHLCV history; joined launchpad and pinned-block contract detail; canonical pool, fee recipient and split; 1,000-candle limit. |
| `Own pools.fun launches` | Selected-wallet launch history; simulated or real two-asset creator-fee claim; indexer and gas limits. |
| `Launching a token on pools.fun` | Advisory cost estimate, user form, real launch, dynamic fee, image, pair, prebuy, authority, recipient, and irreversible-effect constraints. |

Every frozen facet label is represented exactly once.

## Doctrine judgment

Source quotations use ASCII hyphens where the source uses a long dash. Carrying phrases are otherwise exact excerpts from the named descriptions.

### Rendered capsule

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| <q>pools.fun, the NO-CURVE launchpad on Robinhood Chain (4663): its own registry of launches, one-token deep reads against the chain, price candles, the creator-fee claim, and the launch path.</q> | DUPLICATED | Browse description: `Browse and screen pools.fun launchpad tokens on Robinhood Chain (4663).`; token-detail description: `Read everything known about ONE pools.fun token on Robinhood Chain (4663), joining the launchpad's market row with on-chain contract state.`; candle description: `Read the price history of ONE pools.fun token on Robinhood Chain (4663) as OHLCV candles.`; claim description: `Claim the creator fees a pools.fun token has earned, on Robinhood Chain (4663).`; preview description: `Price a pools.fun token launch on Robinhood Chain (4663) before committing to it, and record the preview.` |
| <q>A pools.fun token has no bonding curve and no graduation - it opens straight into a real SushiSwap V3 pool with a 1 percent fee, at a fixed one-billion supply - so this registry sees it from its FIRST BLOCK, which is why it is reached for ahead of an indexer.</q> | DUPLICATED | Browse description: `pools.fun has NO bonding curve and NO graduation: a token trades in a real SushiSwap V3 pool from its first block, every pool charges a 1 percent fee, and total supply is always one billion.` |
| <q>Use when the user names pools.fun, asks what just launched on Robinhood Chain, or wants to vet, launch, or collect fees on one: screen or search the launchpad, read one token against the chain, read its candles, review their own launches, claim the creator fees a launch earned, or launch a token.</q> | DUPLICATED | Browse: `finding or ranking tokens on this launchpad`; search: `user names a token`; candles: `Read the price history`; token detail: `Read everything known`; own launches, claim, and launch descriptions each carry their outcome. |
| <q>Only the claim and the launch spend; everything else is read-only.</q> | DUPLICATED | Read manifests end in `Read-only.`; claim says `Without dryRun it SIGNS AND SPENDS GAS`; launch execution says `signs and broadcasts`. |
| <q>Use `kyberswap` to QUOTE AND TRADE these tokens - they trade in ordinary SushiSwap V3 pools on Robinhood Chain that KyberSwap routes, so this namespace deliberately has no swap tool.</q> | JUDGMENT | `task shape: swap`. Preserve the local no-trading limit in the declaration. This is the explicit handoff from discovery to a separate KyberSwap quote and execution stage. |
| <q>Use `dexscreener` for pair-level liquidity research (these pools are indexed there as dexId sushiswap, label v3, chain robinhood).</q> | JUDGMENT | `task shape: research`, because it crosses namespaces after the local declaration states that liquidity is unavailable. |
| <q>`trench` is a DIFFERENT launchpad on the same chain: it has a bonding curve and a graduation step, while pools.fun has neither, so their tokens never overlap.</q> | JUDGMENT | `task shape: launches`, with local no-curve facts in the declaration. |

### Swap Venue Routing, pools.fun contrast

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| <q>pools.fun contrast, same chain: a pools.fun token has NO bonding curve and NO graduation, so it sits in a real SushiSwap V3 pool from its FIRST block and trades through `kyberswap.*` like any other ERC-20 (measured: 13 of 13 sampled tokens routed, including ones launched minutes earlier).</q> | JUDGMENT | `task shape: swap`. The no-curve and first-block local facts also belong in the declaration; the sampled routing result justifies the cross-namespace handoff. |
| <q>The `pools.*` namespace therefore has NO trade tool by design.</q> | JUDGMENT | Declaration, local limit. |
| <q>Never route a pools.fun token through `trench__trade_*`, and never route a Trench curve token through `kyberswap.*`.</q> | JUDGMENT | `task shape: swap`, cross-protocol negative routing rule. |

### pools.fun Launchpad

| Sentence | Verdict | Evidence or destination |
| --- | --- | --- |
| <q>`pools.*` is the pools.fun launchpad on Robinhood Chain (4663), and it is a DIFFERENT product from Trench Express on that same chain.</q> | JUDGMENT | Declaration, local identity; the contrast also informs `task shape: launches`. |
| <q>A pools.fun token has NO bonding curve, NO graduation and no curve phase at all: the launch creates and initialises a real SushiSwap V3 pool, mints the whole supply as one full-range position and locks the LP forever, so the token trades on a real DEX from its FIRST block.</q> | DUPLICATED | Browse description: `pools.fun has NO bonding curve and NO graduation: a token trades in a real SushiSwap V3 pool from its first block`; execution: `The token opens immediately into a real SushiSwap V3 pool against ETH or USDG - there is no bonding curve and no graduation.` |
| <q>TRADING IS DELIBERATELY NOT IN THIS NAMESPACE.</q> | JUDGMENT | Declaration, local limit. |
| <q>There is no pools trade tool and there is not meant to be one: quote and execute a pools.fun token with `kyberswap.*` exactly as you would any other ERC-20 on that chain.</q> | JUDGMENT | `task shape: swap`; explicitly a separate quote and execution stage. |
| <q>Not finding a swap tool under `pools` is a fact about this namespace, never evidence that the token is untradeable.</q> | JUDGMENT | Declaration, local negative limit. |
| <q>RESEARCH: `pools__tokens_discover` screens the launchpad with server-side filters and sorts, `pools__tokens_search` resolves a name or symbol to an address, `pools__token_candles_list` reads price history, `pools__token_get` deep-reads ONE token against the chain (canonical pool, creator, fee recipient, fee split, on-chain decimals, and whether the locker has it registered at all), and `pools__my_launches_list` lists what the session's OWN wallet deployed - that wallet is resolved from the session and there is no wallet parameter, so it can never be widened to somebody else's history.</q> | DUPLICATED | Browse: `Browse and screen pools.fun launchpad tokens on Robinhood Chain (4663).`; search: `Find a pools.fun token on Robinhood Chain (4663) by name or symbol.`; candles: `Read the price history of ONE pools.fun token on Robinhood Chain (4663) as OHLCV candles.`; detail: `Read everything known about ONE pools.fun token on Robinhood Chain (4663), joining the launchpad's market row with on-chain contract state.`; own launches: `List the pools.fun tokens deployed by the user's own wallet on Robinhood Chain (4663).` and `The wallet is the session's selected wallet and cannot be overridden by a parameter.` |
| <q>Identity is the token ADDRESS: symbols repeat on this launchpad and copycats are routinely live.</q> | DUPLICATED | Search description: `NAMES AND SYMBOLS ARE NOT UNIQUE on this launchpad - three live tokens shared the symbol SUSHICAT when this was measured - so always confirm which one the user meant by its ADDRESS, and say so when several match.` |
| <q>pools.fun publishes NO holder count and NO liquidity figure ANYWHERE, so neither is available from this namespace and you must never estimate one.</q> | DUPLICATED | Rejected parameter descriptions: `pools.fun exposes no holder count on any endpoint.` and `pools.fun exposes no liquidity figure`. |
| <q>Research pool liquidity with `dexscreener`, where these pools are indexed as sushiswap v3 on chain robinhood.</q> | JUDGMENT | `task shape: research`, cross-namespace handoff. |
| <q>Every price, volume, market cap and price change `pools.*` returns is display-grade with no executable meaning; a KyberSwap quote is the financial truth.</q> | JUDGMENT | Declaration carries the local display-grade limit; `task shape: swap` carries the execution-source judgment. |
| <q>Launching a token on pools.fun spends real ETH and cannot be undone:</q> | DUPLICATED | Execution description: `SPENDS REAL FUNDS AND IS IRREVERSIBLE`. Exact preserved destination: `task shape: launches`, PRESERVE VERBATIM. |
| <q>AN IMAGE IS REQUIRED on the agent path, so PLANNING starts at the image locker: read it with `trench__images_list` (the locker is SHARED by both launchpads) and pass the chosen `imageId`.</q> | DUPLICATED | Execution description: `AN IMAGE IS REQUIRED on this path: pass the imageId of a picture the user staged in the image locker`. |
| <q>`pools__launch_execute` REFUSES without one and launches nothing.</q> | DUPLICATED | Required image parameter: `without it this tool refuses and nothing is launched`. |
| <q>You can never create or supply an image, so if the locker is empty do not improvise around it - ask the user to stage one, then continue.</q> | DUPLICATED | Image parameter: `The agent can never create one, only name one the locker already holds`. Destination for the procedure is `task shape: launches`. |
| <q>(A token launched with no image renders blank on pools.fun forever, which cannot be undone.</q> | DUPLICATED | Required image parameter: `A token launched with no image renders blank on pools.fun forever and that cannot be undone.` Exact preserved destination: declaration limit and `task shape: launches`. |
| <q>Only the user's own launch form may choose to launch without one; that is their decision to make and never yours.)</q> | JUDGMENT | `task shape: launches`, preserve the human-only exception. |
| <q>Unlike Trench there is NO byte limit here, because pools.fun hosts the image off-chain at its original quality: an image too large for Trench's on-chain budget, which the app badges as pools only, still launches fine on this launchpad.</q> | JUDGMENT | Declaration, local limit. `PoolsFun.md` proves off-chain original-quality hosting and distinguishes the 25 MiB resource ceiling from a product byte limit. |
| <q>`pools__launch_preview` is ADVISORY and says so.</q> | DUPLICATED | Preview description: `ADVISORY, and it says so`. |
| <q>It reads the gateway's CURRENT deployment fee, prices an optional prebuy and returns every leg as raw amounts with their decimals - but it CANNOT tell you the token's ADDRESS, because the image determines the metadata link, which determines the salt, which determines the address, and that is settled only when the launch is actually prepared.</q> | DUPLICATED | Preview description: `reads the gateway's CURRENT deployment fee` and `the final token ADDRESS cannot be known here, because the image determines the metadata link, which determines the salt, which determines the address - the address is settled only when the launch is actually prepared.` |
| <q>Never promise a predicted address from a preview.</q> | JUDGMENT | Declaration, local negative limit; exact preserved destination: `task shape: launches`. |
| <q>THE DEPLOYMENT FEE IS DYNAMIC.</q> | DUPLICATED | Execution description: `CURRENT deployment fee (read on-chain at signing time, and it moves - it changed fourfold inside one day)`. |
| <q>It is read live and it moves - measured moving about fourfold inside 24 hours - so it is re-read and re-verified at launch time.</q> | DUPLICATED | Execution description: `CURRENT deployment fee (read on-chain at signing time, and it moves - it changed fourfold inside one day)` plus `Before signing, Vex DECODES the launchpad's transaction and proves 13 things about it against the chain - the gateway's identity and version, its live fee and bounds`. |
| <q>A fee from an earlier turn is stale: never present a preview's figure as what the launch will cost.</q> | JUDGMENT | `task shape: launches`, money-path procedure, PRESERVE VERBATIM. |
| <q>The Vex fee is 25 bps of the NATIVE value the launch sends (the deployment fee plus any ETH prebuy), taken as a SEPARATE transfer that runs only after the launch confirms.</q> | DUPLICATED | Preview carries `Vex's 25 bps fee on the native launch value`; execution carries `25 bps of the ETH the launch sends (deployment fee + any ETH prebuy) as a SEPARATE transfer that runs only after the launch confirms`. Exact preserved destination: existing Vex Fee section for the global fee contract, with pools-specific basis in the declaration. |
| <q>A USDG prebuy is an ERC-20 leg and is NOT in that basis.</q> | JUDGMENT | Exact preserved destination: declaration money-path limit and existing Vex Fee section. The prebuy parameter proves that USDG prebuy needs an approval leg and is manual-form only, but does not itself state the fee-basis exclusion. |
| <q>THE CREATOR FEE RECIPIENT IS PINNED to the session wallet on every agent launch, and the agent-facing tools have NO recipient parameter at all.</q> | DUPLICATED | Execution description: `The creator fee stream always goes to the user's own session wallet on this path; there is no recipient parameter.` Exact preserved destination: declaration limit and `task shape: launches`. |
| <q>Only the user's own launch form can name somebody else, so never offer to point the fee stream anywhere.</q> | JUDGMENT | Form description carries `choose where the creator fee stream goes`; launch-params comment says only the manual form may choose a different recipient. The negative instruction remains in `task shape: launches`. |
| <q>The paired asset is `weth` or `usdg` ONLY; a tokenised stock is refused BY NAME (the stock-paired rows the browsing tools return belong to the older sushi launcher, not to anything Vex can launch).</q> | DUPLICATED | Paired-asset parameter: `weth (default) or usdg. These are the only two the factory allows today - tokenised stocks exist in the provider's vocabulary but the on-chain allowlist refuses them`. |
| <q>An autonomous prebuy is WETH-NATIVE ONLY, because the gateway itself refuses a native dev buy against any other pair; a USDG prebuy exists only on the manual form path.</q> | DUPLICATED | Prebuy parameter: `Autonomous launches support an ETH prebuy only; a USDG prebuy needs an approval leg and is available through the desktop form instead`. Exact preserved destination: declaration limit and `task shape: launches`. |
| <q>`pools__launch_request_form` is how you hand the launch DECISION to the human: it drafts the launch, parks the turn and spends nothing.</q> | DUPLICATED | Form description: `Use this when a launch should happen but the agent may not authorize spending by itself: it opens the two-stage form pre-filled with the proposed name, symbol, pair and prebuy, and parks the turn until the user submits or cancels.` and `It spends nothing on its own.` |
| <q>The FORM is the consent surface and the user's Deploy click is what launches.</q> | DUPLICATED | Form description: `THE FORM ITSELF IS THE APPROVAL: submitting it is what authorizes the launch`. Exact preserved destination: `task shape: launches`, PRESERVE VERBATIM. |
| <q>The runtime resumes you with the outcome as this call's result when the user deploys, dismisses the form, or it expires, so do not call it again while the form is open and never assume the launch happened.</q> | JUDGMENT | `task shape: launches`, procedural state-machine rule. |
| <q>`pools__launch_execute` signs and broadcasts the launch irreversibly, and only under explicit authority.</q> | DUPLICATED | Execution description: `signs and broadcasts the on-chain launch` and `It runs ONLY under explicit authority`. Exact preserved destination: `task shape: launches`, PRESERVE VERBATIM. |
| <q>In a FULL-permission chat session that authority is the user's own permission: execute directly, exactly as you would a swap.</q> | DUPLICATED | Execution description carries `in a FULL-permission chat session the user's permission is the authority and this executes directly`. Exact preserved destination: `task shape: launches`, PRESERVE VERBATIM. |
| <q>In a RESTRICTED session it refuses BY NAME - call `pools__launch_request_form` instead.</q> | DUPLICATED | Execution description carries `in a RESTRICTED session it refuses BY NAME and you must call pools__launch_request_form instead`. Exact preserved destination: `task shape: launches`, PRESERVE VERBATIM. |
| <q>In a MISSION run the authority is the contract's HOST-authored launch ceilings, which you cannot write; while a contract carries none the tool refuses BY NAME, so report that refusal and tell the user to set the max launch value and max launch count on the contract card.</q> | JUDGMENT | Execution description carries the mission clause through `REFUSES BY NAME`, but not the instruction to set both ceilings. Exact preserved destination: `task shape: launches`, PRESERVE VERBATIM in full. |
| <q>Every one of those refusals is safe.</q> | JUDGMENT | `task shape: launches`, preserve as the outcome of the authority matrix. |
| <q>Never improvise a launch by another route.</q> | JUDGMENT | `task shape: launches`, negative procedure. |
| <q>`pools__fees_claim` claims the creator fee stream a launch has earned, because the session wallet is the on-chain fee recipient of its own launches.</q> | DUPLICATED | Claim description: `Claim the creator fees a pools.fun token has earned` and `Only the wallet the fee stream points at can claim it`; execution carries the session-wallet recipient. |
| <q>Call it with `dryRun: true` FIRST: that is a FREE `eth_call` simulation and the only honest preview, and it reports BOTH legs - the launched token and the paired asset - as raw amounts with their own decimals, which must never be added together.</q> | DUPLICATED | Claim description: `Use dryRun: true first - it SIMULATES` and `both legs are reported separately with their raw amounts, their decimals and their asset addresses; never add them together`. |
| <q>The locker's already-collected figures are fees the locker ALREADY holds and are NOT the claimable total; the simulation is.</q> | DUPLICATED | Claim description: `the locker's claimable mappings show fees ALREADY collected and not yet paid out, and they read zero while real fees are still waiting in the pool`. |
| <q>A real claim is an ordinary approval-gated on-chain transaction that costs gas, so say so before claiming a dust balance.</q> | JUDGMENT | Exact preserved destination: declaration cost limit plus `task shape: positions and risk` if the global approval prose needs a task-local reminder. The description carries `SIGNS AND SPENDS GAS behind the normal approval gate`; the dust-value communication judgment does not. |

## D4 note

The declaration must remain venue-neutral. It may state the local fact that pools.fun has no trading action and that acquisition is a separate swap stage. The swap task shape owns the D4 preference for KyberSwap and the measured fallback policy. DexScreener belongs only to the research handoff. No preference sentence belongs in this declaration.

## Draft declaration

### pools.fun

pools.fun is a no-curve token launchpad on Robinhood Chain. New tokens open directly in ordinary SushiSwap V3 pools from their first block, with a fixed one-billion supply and permanently locked full-range liquidity. Use this declaration for a `pools.fun launchpad` request, `new pools fun launches`, or when the user needs `price history`, `full detail`, or `my launches on the robinhood launchpad`.

Read outcomes cover launch browsing and server-side screening, name or symbol resolution, OHLCV candles, one-token detail joined to on-chain state at a reported block, and launch history for the selected wallet. Names and symbols can repeat, so use the token address as identity. Provider prices, volumes, market caps, and price changes are display-grade. Holder count and liquidity are unavailable here and must not be estimated. Candles are limited to 1,000 without a time cursor. Registry results may lag, although the browse endpoint has a five-second server cache.

This namespace has no trading action. Discovery does not acquire the token. After resolving the address, continue to a separate `trading quote` and swap stage. Researching pair liquidity is also a separate stage. Do not interpret the absent trading action as evidence that a token is untradeable.

Quote outcomes include a launch-cost estimate and a simulated creator-fee claim. A launch estimate reads the current dynamic deployment fee, but it cannot predict the token address because the image fixes metadata and salt only during preparation. A claim simulation is the honest preview and reports the launched token and paired asset separately. Use `claim my creator fees` for that outcome; never add the two assets.

Act outcomes include a `pools fun launch form`, a real launch, and a creator-fee claim. A real launch spends funds and cannot be undone. The agent path requires an image already staged by the user, supports WETH or USDG pairing, permits only a native WETH prebuy, and pins the creator-fee recipient to the session wallet. The user's form alone may choose another recipient or omit the image. There is no Trench-style product byte limit for a pools.fun image. Use `launch the coin on pools fun now` only when authority is already established. Re-read and verify the dynamic deployment fee at launch time, never reuse an earlier estimate, and never invent a predicted address. A real fee claim spends gas and remains approval-gated.
