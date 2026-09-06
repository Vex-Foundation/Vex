/**
 * THE PARAM CONVENTION - one vocabulary for every agent-facing tool surface.
 *
 * This module is the single home for the cross-cutting naming/format rules the
 * tool audit (`agents_dm/tool-audit-2026-08/SPEC.md` §1) settled on: which
 * chain slugs exist, which param keys are canonical, which spellings are banned
 * and what replaces them, and the shared description sentences that must not be
 * retyped per manifest.
 *
 * IT IS LIVE. `CANONICAL_PARAM_KEYS` and `BANNED_PARAM_KEYS` are read by the
 * manifest linter's `param-key` rule (`_manifest-lint/rules.ts::lintParamKey`);
 * `BANNED_PARAM_KEYS` is read again at the untrusted boundary, where a retired
 * spelling is answered with its replacement (`runtime/params.ts`), and by the
 * `param-alias` rule, which admits an input alias only for a key banned here.
 * The canonical sentences below are imported across the manifest tree, and
 * `CHAIN_VALUE_PARAM_KEYS` bounds the two normalizations the boundary performs.
 * An earlier header said "NOTHING consumes it yet": true when the table landed
 * ahead of the migration waves, false from the moment the linter shipped.
 *
 * Deliberate non-goals: no runtime validation lives here (the boundary owner is
 * `runtime/params.ts`), and no provider translation lives here (a provider that
 * needs a numeric id, an UPPERCASE enum, or a slug in a URL path converts inside
 * its own adapter - the manifest always advertises the canonical spelling).
 */

import { getKyberChains } from "@tools/kyberswap/chains.js";
import type { KyberChainSlug } from "@tools/kyberswap/types.js";
import { VEX_MAX_SLIPPAGE_BPS, VEX_DEFAULT_SLIPPAGE_BPS } from "./slippage-policy.js";

// ── Chains ───────────────────────────────────────────────────────

/**
 * The Solana family discriminator. Solana has no EVM chain id and is not in any
 * EVM registry, but `chain: "solana"` is how every router in the tree selects
 * the Solana lane, so it is a canonical chain VALUE even though it is not an
 * EVM chain.
 */
const SOLANA_FAMILY_SLUG = "solana";

/**
 * Canonical agent-facing chain value.
 *
 * Derived, never hand-listed: the KyberSwap registry (`src/tools/kyberswap/chains.ts`)
 * is the broadest slug table in the tree and already carries every chain the
 * local registry covers (Robinhood 4663). A chain that exists ONLY in
 * `src/tools/evm-chains/registry.ts` would therefore be missing here - the
 * manifest-lint suite asserts that coverage so the gap fails a test instead of
 * silently narrowing what an agent may say.
 */
export type CanonicalChainSlug = KyberChainSlug | typeof SOLANA_FAMILY_SLUG;

/** Runtime membership test for {@link CanonicalChainSlug}. */
export const CANONICAL_CHAIN_SLUGS: ReadonlySet<string> = new Set<string>([
  ...getKyberChains().map((chain) => chain.slug),
  SOLANA_FAMILY_SLUG,
]);

// ── Param keys ───────────────────────────────────────────────────

/**
 * Every param key the convention permits, with the reason it exists. Adding a
 * key is a deliberate edit HERE, not an accident in a manifest - the linter
 * reports any other key against the tool that introduced it.
 */
export const CANONICAL_PARAM_KEYS: ReadonlyMap<string, string> = new Map([
  ["chain", "the single-chain selector; slug or decimal chain-id string"],
  ["fromChain", "bridge source chain; pairs with fromToken"],
  ["toChain", "bridge destination chain; pairs with toToken"],
  ["chainIds", "a LIST of chains (comma-separated string, or string[] where declared)"],
  ["walletFamily", "wallet FAMILY (eip155|solana|all) - never a chain"],
  ["tokenIn", "swap input token: EVM contract address or ETH/native; Solana symbol or mint"],
  ["tokenOut", "swap output token, same grammar as tokenIn"],
  ["fromToken", "bridge source token; pairs with fromChain"],
  ["toToken", "bridge destination token; pairs with toChain"],
  ["token", "the one token a single-token tool acts on"],
  ["tokenAddress", "a token CONTRACT address on a read tool"],
  ["pairs", "a LIST of chain-qualified POOL identities (chain:pairAddress) on a batch read tool; plural because the caller supplies the membership, unlike pairAddress which names one"],
  ["tokens", "a LIST of chain-qualified TOKEN identities (chain:tokenAddress) on a batch read tool; the token-side sibling of `pairs`"],
  ["include", "a LIST of OPTIONAL SIDE READS to perform, each costing an extra request; distinct from `fields`, which shapes rows already fetched"],
  ["tokenAddresses", "a list of token contract addresses"],
  ["walletAddress", "an ACCOUNT address (the thing that holds funds)"],
  ["amountIn", "input amount in HUMAN decimal units, as a string"],
  ["amountOut", "output amount in HUMAN decimal units, as a string"],
  ["amountRaw", "amount in RAW base units; description must name the decimals source"],
  ["depositAmountRaw", "multi-leg lend deposit, raw base units"],
  ["withdrawAmountRaw", "multi-leg lend withdrawal, raw base units"],
  ["supplyAmountRaw", "lend supply into one Blue market (the lender's side), raw base units"],
  ["borrowAmountRaw", "multi-leg lend borrow, raw base units"],
  ["repayAmountRaw", "multi-leg lend repayment, raw base units"],
  // A Blue market pairs two tokens at two scales, so the collateral legs cannot
  // share the loan legs' keys: one `amountRaw` across four operations would let
  // a collateral-scaled number fund a borrow.
  ["supplyCollateralAmountRaw", "Blue market collateral supply, raw base units of the COLLATERAL token"],
  ["withdrawCollateralAmountRaw", "Blue market collateral withdrawal, raw base units of the COLLATERAL token"],
  // Not an amount: it routes a repayment to the SHARES path, the only
  // denomination that can close an accruing debt at zero.
  ["repayFullDebt", "Blue market repayment: close the debt completely by burning its exact borrow shares"],
  ["slippageBps", "price protection in basis points; type number, unit bps"],
  [
    "minSellPriceSlippageBps",
    "solana__predict_close_all's distinct tolerance - a separate knob by necessity, documented in slippage-policy.ts",
  ],
  ["limit", "result cap; description states the default and the maximum"],
  ["page", "1-based FIRST provider page of a windowed read; the reply names the next page to continue from"],
  ["pageSize", "rows fetched per provider page; distinct from `limit`, which caps what is RETURNED after filtering"],
  ["environment", "explicit public service environment selector, such as Lighter core vs rhc"],
  ["marketId", "protocol-native market identifier returned by a market catalog read"],
  ["marketSymbol", "protocol-native market symbol used to resolve a market id"],
  ["marketType", "exact exchange product selector used to disambiguate perpetual and spot markets"],
  ["accountIndex", "protocol-native L2 account index (a public integer identity, not an address)"],
  ["apiKeyIndex", "protocol-native API-key slot index on an exchange account; public metadata, never key material"],
  ["orderId", "protocol-native order identifier returned by an authenticated exchange order read"],
  ["activeOnly", "boolean account-lookup flag: return only active sub-accounts"],
  ["side", "orderbook order side, buy or sell, declared with an enum"],
  ["price", "human-decimal order price string; market orders read it as the worst acceptable price"],
  ["triggerPrice", "human-decimal trigger for one native conditional order; distinct from its execution bound or activated limit price"],
  ["stopLossTriggerPrice", "human-decimal trigger for the stop-loss child of one native protective order group"],
  ["stopLossPrice", "human-decimal execution bound for the stop-loss child of one native protective order group"],
  ["takeProfitTriggerPrice", "human-decimal trigger for the take-profit child of one native protective order group"],
  ["takeProfitPrice", "human-decimal execution bound for the take-profit child of one native protective order group"],
  ["baseAmountIn", "orderbook order size in the BASE asset, human decimal string"],
  ["totalBaseAmountIn", "replacement total order size in the BASE asset, human decimal string"],
  ["orderType", "orderbook order type declared with an enum, such as limit or market"],
  ["timeInForce", "orderbook time-in-force declared with an enum"],
  ["reduceOnly", "perp order flag: execute only if it reduces the current position"],
  ["orderExpiry", "absolute order expiry in epoch milliseconds; the relative twin is orderExpiryOffsetMinutes"],
  ["previewId", "persisted preview identifier returned by a preview tool; binds a prepare call to that exact preview"],
  ["intentId", "prepared execution-intent identifier returned by its prepare tool; binds the approved execute call"],
  ["claimId", "prepared settlement-claim identifier; distinct from its parent withdrawal intent and separately approval-bound"],
  ["filter", "closed provider-side category/status filter declared with an enum"],
  ["resolution", "candle or chart bucket size declared with an enum"],
  ["startTimestamp", "epoch-millisecond start bound for time-series reads"],
  ["endTimestamp", "epoch-millisecond end bound for time-series reads"],
  ["countBack", "provider row cap for time-series reads"],
  ["setTimestampToEnd", "candle timestamp placement flag for time-series providers that expose it"],
  ["orderExpiryOffsetMinutes", "relative order expiry in whole minutes from preview time"],
  ["dryRun", "preview switch, reserved by runtime/params.ts"],
  [
    "includeClaimable",
    "opt-in per-row claim SIMULATION on a launch list; off by default because it costs chain reads per row, and an unsimulated row reports null (NOT MEASURED) rather than zero",
  ],
  [
    "imageId",
    "opaque id of an image already in the user's locker; the agent can never create one, only name one a read tool listed",
  ],

  // -- Screening vocabulary ---------------------------------------
  //
  // The shape every filtered read tool in the tree already has, spelled once
  // here instead of accumulating per-tool allowlist debt. These are GENERIC:
  // any screening tool that pages, ranks or projects rows uses these exact
  // four keys, and a model that learned them on one tool composes them
  // correctly on the next.
  // `search` used to sit here. Owner decision D1 made `query` the canonical
  // free-text key (the fleet already spelled it that way seven times to
  // `search`'s two), so `search` moved to BANNED_PARAM_KEYS naming `query`.
  ["sort", "ranking key; the accepted set is declared as an `enum`, never left in prose"],
  ["order", "ranking direction, `asc` or `desc`; declared as an `enum`"],
  ["offset", "row offset for paging; pairs with the reply's `nextOffset`"],
  ["fields", "comma-separated row field GROUPS to keep, to bound a large result"],
  ["topTokens", "how many CHILD rows to embed inside each parent row on a grouped read (a narrative's leading pairs); distinct from `limit`, which bounds the parent rows, and from `include`, which names side reads rather than a depth"],
  ["listedOnly", "keep only rows the protocol itself lists/curates; excludes permissionless dust"],

  // -- Virtuals agent screening (PR-C1) ----------------------------
  //
  // Every key below is one MEASURED server-side filter of the Virtuals agent
  // endpoint. They are named rather than folded into an opaque `filters` bag
  // for the reason the morpho block gives, and with one extra reason specific
  // to this provider: it SILENTLY IGNORES an unknown `filters[...]` key and
  // answers with the whole population, so an undeclared screen is not an error
  // there - it is a wrong answer that looks right.
  ["searchScope", "what `query` matches on a Virtuals read: text (name/symbol), address (token or curve token), or any"],
  ["creatorWallet", "the wallet that LAUNCHED an agent; distinct from `walletAddress`, which is the account a tool acts for"],
  ["factory", "which launch-contract family produced a token; declared as an `enum`"],
  ["role", "an agent's declared role (ENTERTAINMENT, ON_CHAIN, ...); declared as an `enum`"],
  ["vibesStatus", "the vibes/ICO lane state of an agent; declared as an `enum`"],
  ["isVerified", "keep only rows carrying the provider's anti-impersonation badge"],
  ["hasGraduated", "keep only agents that have left the bonding curve for an AMM pool"],
  ["hasGenesis", "keep only agents that came through a genesis points sale"],
  ["hasStaking", "keep only agents with a staking contract"],
  ["hasMarginTrading", "keep only agents the venue lists for margin trading"],
  ["hasFounderVideo", "keep only agents whose founder published a video pitch"],
  ["hasRevenueConnect", "keep only agents with a revenue-connect wallet configured"],
  ["isDevCommitted", "keep only agents whose developer made the on-platform commitment"],
  ["hasAntiSniperTax", "keep only launches that CONFIGURED a non-zero anti-sniper tax type"],
  ["hasAirdrop", "keep only launches that reserved a non-zero airdrop percentage"],
  ["needAcf", "keep only launches that used Automated Capital Formation"],
  ["isProject60days", "keep only launches in the 60-day project programme"],
  ["launchRadarEnabled", "keep only launches that opted into Launch Radar"],
  ["isRobotics", "keep only robotics agents; the working screen, since the ROBOTIC_* factory values match nothing"],
  ["includeLaunchX", "keep ONLY the X_LAUNCH / ACP_LAUNCH tagged agents"],
  ["excludeLaunchX", "drop the X_LAUNCH / ACP_LAUNCH tagged agents, as the provider's own UI does"],
  ["minMcapInVirtual", "floor on market cap, denominated in the VIRTUAL token and NOT in USD"],
  ["maxMcapInVirtual", "ceiling on market cap, denominated in the VIRTUAL token and NOT in USD"],
  ["minHolderCount", "floor on the holder count"],
  ["maxHolderCount", "ceiling on the holder count"],
  ["minVolume24h", "floor on 24-hour volume, in USD"],
  ["maxVolume24h", "ceiling on 24-hour volume, in USD"],
  ["minPriceChangePercent24h", "floor on the 24-hour price change, as a SIGNED PERCENT"],
  ["maxPriceChangePercent24h", "ceiling on the 24-hour price change, as a SIGNED PERCENT"],
  ["minTop10HolderPercentage", "floor on top-10 holder concentration, as a PERCENT"],
  ["maxTop10HolderPercentage", "ceiling on top-10 holder concentration, as a PERCENT"],
  ["createdAfter", "keep only rows created at or after this date"],
  ["launchedAfter", "keep only rows whose token started trading at or after this date"],
  ["genesisStartsAfter", "keep only rows whose linked genesis sale starts at or after this date"],
  ["genesisStartsBefore", "keep only rows whose linked genesis sale starts at or before this date"],
  ["includePriceSeries", "attach the provider's own 24-hour price samples to each row; off by default because it widens every row"],
  ["beforeTimestampSeconds", "walk a candle history BACKWARDS: return buckets strictly before this unix-seconds mark"],
  ["currency", "which side a candle series is denominated in; declared as an `enum`"],

  // -- Lending-market reads (morpho, batch 1) ----------------------
  //
  // Domain range predicates. They are named rather than folded into a generic
  // `filters` object on purpose: a declared key is type-checked, echoed in
  // `filtersApplied` and rejected by name, which an opaque bag cannot be.
  // `*Percent` and `*Usd` suffixes carry the UNIT in the key, per the rule that
  // prose alone has already failed to prevent a unit hazard.
  ["marketId", "a lending market's own 32-byte id; NOT a contract address"],
  ["loanTokenAddress", "the borrowable asset's contract address on a lending-market read"],
  ["collateralTokenAddress", "the collateral asset's contract address on a lending-market read"],
  ["minSupplyUsd", "floor on total supplied value, in USD"],
  ["maxSupplyUsd", "ceiling on total supplied value, in USD"],
  ["minBorrowUsd", "floor on total borrowed value, in USD"],
  ["maxBorrowUsd", "ceiling on total borrowed value, in USD"],
  ["minUtilizationPercent", "floor on borrowed/supplied, as a PERCENT"],
  ["maxUtilizationPercent", "ceiling on borrowed/supplied, as a PERCENT"],
  ["minNetSupplyApyPercent", "floor on net (rewards-inclusive) supply APY, as a PERCENT"],
  ["maxNetBorrowApyPercent", "ceiling on net (rewards-inclusive) borrow APY, as a PERCENT"],
  ["minLltvPercent", "floor on the liquidation loan-to-value threshold, as a PERCENT"],
  ["maxLltvPercent", "ceiling on the liquidation loan-to-value threshold, as a PERCENT"],
  ["includeHistory", "add the averaged historical window to a detail read"],
  ["lookback", "which averaging window `includeHistory` returns; declared as an `enum`"],
  ["includeSupplyingVaults", "add the curated vaults that supply this market to a detail read"],

  // -- Curated-vault reads (morpho, batch 2) -----------------------
  //
  // A vault is a MANAGED deposit: a curator spreads one asset across many
  // markets and takes a fee. The keys below name that domain rather than the
  // lending-market one, so the two lanes stay distinguishable to a model that
  // learned either first.
  ["vaultAddress", "a curated vault's contract address; NOT a market id"],
  ["version", "which generation of a protocol's contracts to read; declared as an `enum`"],
  ["assetTokenAddress", "contract address of the asset a vault holds and pays out in"],
  ["assetSymbol", "symbol of the asset a vault holds; the address form is preferred where both exist"],
  ["curatorAddress", "address of the party that decides where a curated vault's money goes"],
  ["minTvlUsd", "floor on total deposits held, in USD"],
  ["maxTvlUsd", "ceiling on total deposits held, in USD"],
  ["minNetApyPercent", "floor on APY NET of the curator fee, as a PERCENT"],
  ["maxCuratorCutPercent", "ceiling on the curator's cut of the yield, as a PERCENT"],
  ["includeAllocations", "add the per-market allocation table to a vault detail read"],

  // -- Position and activity reads (morpho, batch 3) ---------------
  //
  // The portfolio vocabulary: what an account already HOLDS, and what already
  // HAPPENED. Distinct from the screening keys above, which describe a venue a
  // user has not entered yet.
  ["scope", "which halves of a compound read to cover; declared as an `enum`"],
  ["maxHealthFactor", "ceiling on a lending position's collateral-to-liquidation-threshold RATIO, not a percent"],
  ["includeVaultV2", "sweep for VaultV2 positions, which no per-user list query serves"],
  ["marketIds", "a LIST of lending-market ids; the singular form is `marketId`"],
  ["types", "a LIST of event kinds to keep on a history read; the accepted set is declared as an `enum`"],
  ["since", "window start as a unix timestamp in SECONDS"],
  ["until", "window end as a unix timestamp in SECONDS"],

  // -- Reward and wallet reads (morpho, batch 4) -------------------
  //
  // One key, added deliberately. `morphoOnly` narrows a REWARD read to the
  // campaigns proven to belong to Morpho. It is not a generic `filter` or an
  // `onlyX` pattern invited for reuse: the distributor behind that read serves
  // many protocols, a single claim takes a whole reward token row whatever
  // produced it, and this key is the caller's explicit statement that it wants
  // the narrower view and accepts the incompleteness. Naming the protocol in
  // the key is what stops it being read as a generic switch.
  ["morphoOnly", "narrow a multi-protocol reward read to campaigns attributed to Morpho alone"],

  // -- Which way an operation moves (morpho vault quote, E3b-1) ----
  //
  // `direction` was never a convention DEFECT; it was simply never ratified,
  // so the two pendle manifests that already ship it carried allowlist debt
  // instead. Ratifying it here is what removes those two entries.
  //
  // It earns a key rather than being inferred from which amount param arrived,
  // even though the amount key alone would determine it. On a money path the
  // caller's STATED intent and the amount it sent are two independent facts,
  // and a call that says withdraw while sending a deposit amount is a caller
  // that has confused itself. Deriving the direction silently would resolve
  // that confusion in the caller's favour and act on the amount; requiring both
  // lets the mismatch be refused by name, which is rules/90's rule for a
  // money-path parameter disagreement.
  //
  // The accepted set is ALWAYS declared as an `enum`, never left in prose.
  ["direction", "which way an operation moves value; the accepted set is declared as an `enum`"],

  // -- Which SHAPE of option a screening read compares (morpho vaults) ---
  //
  // `route` selects which option sets a screening tool returns when the same
  // goal can be reached through structurally different products - a curated
  // vault versus supplying a market directly. It is not `direction` (that is
  // which way value moves) and not `scope` (that is which halves of one
  // compound read to cover). The accepted set is ALWAYS declared as an `enum`.
  ["route", "which option SETS a screening read compares when one goal has structurally different products"],

  // Launchpad screening vocabulary (pools.fun). These are NEW deliberate keys,
  // not pre-convention debt: each names a filter the provider serves server-side
  // and has no canonical spelling to be renamed to. The screening family's older
  // spellings (`sortBy`, `cursor`, `query`, `minMarketCapUsd`, `maxMarketCapUsd`)
  // were withheld here for one wave, because a dozen tools carried allowlist debt
  // against them and canonicalizing one would have decided a fleet-wide rename
  // this task had no mandate for. Owner decision D15 gave that mandate: they are
  // RATIFIED in the block at the end of this table, and `search` (not `query`) is
  // the spelling that was retired. `order` is NOT in this list: the screening
  // block above ratified it, so the pools manifests use the canonical key with no
  // waiver.
  ["platform", "which launcher a multi-launchpad provider should answer for; never a chain"],
  ["live", "restrict a list to the provider's live/recently-active feed"],
  ["maxAgeHours", "keep only rows younger than N hours; the fresh-launch filter"],
  ["minTxCount24h", "minimum trades in the last 24 hours"],
  ["minVolUsd", "minimum traded volume in USD; pairs with volTimeframe, which names the window"],
  ["volTimeframe", "the window a volume floor is measured over (1m/5m/1h/6h/24h)"],
  ["deployerAddress", "the ACCOUNT that deployed a token; distinct from feeRecipientAddress"],
  ["feeRecipientAddress", "the ACCOUNT a token's fee stream pays; on some launchpads it differs from the deployer"],
  ["timeframe", "the base unit of one price candle (minute/hour/day)"],
  ["aggregate", "how many timeframe units make one candle; the span is aggregate x timeframe"],

  // -- Screening DEPTH (morpho, coverage audit 2026-08-18) ---------
  //
  // Ratified together, because they were found together: an external audit
  // measured the Morpho discover tools sending 15 of 43 market filters and 6 of
  // 23 usable sort keys, and the owner's Provider Integration Depth decree makes
  // an undeclared depth gap a defect rather than a backlog item. Each key below
  // is a REAL server-side predicate confirmed against live introspection AND a
  // live result count on that date.
  //
  // Two shapes worth naming, because both generalise past Morpho. An `*Tags`
  // key filters on a provider's OWN classification vocabulary rather than on an
  // identifier we control, so its accepted set is a captured measurement and an
  // unknown member is refused by name - the provider would otherwise treat it as
  // a predicate matching nothing, and an empty page reads as "none exist". A
  // `min*Raw` key is a size floor in RAW base units as a quoted string, carrying
  // its scale in the name for the same reason every `*Percent` and `*Usd` key
  // above does.
  ["oracleAddress", "contract address of the price oracle a lending market prices collateral with"],
  ["irmAddress", "contract address of the interest rate model a lending market's rate follows"],
  ["isIdle", "keep or exclude IDLE markets, which have no collateral asset and cannot be borrowed from"],
  ["loanAssetTags", "a LIST of the provider's own classification tags the BORROWABLE asset must carry"],
  ["collateralAssetTags", "a LIST of the provider's own classification tags the COLLATERAL asset must carry"],
  ["assetTags", "a LIST of the provider's own classification tags the asset a vault holds must carry"],
  ["suppliesMarketIds", "keep only vaults that supply at least one named lending market; the exposure question"],
  ["txHash", "one transaction hash to look a history row up by; the singular form, as no list predicate exists"],
  ["liquidatorAddress", "address of the party that PERFORMED a liquidation; the counterpart of `walletAddress`"],
  ["minBadDebtAssetsRaw", "floor on bad debt left by a liquidation, in RAW base units of the LOAN asset"],
  ["minSeizedAssetsRaw", "floor on collateral taken by a liquidation, in RAW base units of the COLLATERAL asset"],

  // -- The two merge keys (Batch 2, owner decision D7) --------------
  //
  // Both exist because a near-duplicate tool was retired into a parameter, and
  // both are deliberately GENERIC: a provider that publishes the same rows over
  // several endpoints, or a registry that can be enriched by a live status
  // read, is a shape this catalog already has more than one of.
  //
  // `feed` selects WHICH provider endpoint fills the same row shape. It is not
  // `sort` (that orders rows we already have) and not `route` (that compares
  // structurally different products): the rows come from different URLs whose
  // freshness, ordering and populated fields differ, and the description says
  // which. The accepted set is ALWAYS declared as an `enum`.
  //
  // `liveStatus` opts a local-registry read into a live provider status join.
  // Off by default because it turns a read that cannot fail into one that can;
  // and when it does fail the registry rows still return, with the state field
  // null and a stated reason, never a failed call.
  ["feed", "which provider FEED fills a shared row shape; the accepted set is declared as an `enum`"],
  ["liveStatus", "join a live provider status onto a local registry read; degrades to a null state with a stated reason"],

  // -- Free text and opaque continuation (owner decision D1) ---------
  //
  // `query` is the free-text key the fleet already spells on seven tools, and
  // D1 makes it THE canonical one: `search` moves to BANNED_PARAM_KEYS naming
  // it, so the two Morpho discover tools that spelled it the other way are
  // renamed rather than left as a second vocabulary. `cursor` is ratified as
  // the cursor-class continuation key: the value is the PROVIDER's, opaque to
  // the agent and to Vex, and the only legal thing to do with it is send back
  // exactly what the previous reply returned.
  ["query", "free-text substring match over a row's name/symbol identifiers; a FILTER, not a ranker - `sort` decides the order"],
  ["cursor", "opaque provider continuation; pass back exactly what the reply returned, never a value you computed"],

  // -- The ranking spellings that ship beside `sort` / `order` --------
  //
  // Ratified, not renamed: twenty-two tools carry these and a fleet-wide fold
  // into `sort`/`order` is a migration with its own mandate. They mean exactly
  // what the canonical pair means; the accepted set is still declared as an
  // `enum` on every one of them.
  ["sortBy", "ranking key on the tools that spell it this way; same contract as `sort`, declared as an `enum`"],
  ["sortDir", "ranking direction on the tools that spell it this way; same contract as `order`, declared as an `enum`"],
  ["sortDirection", "the third live spelling of ranking direction (solana predict); same contract as `order`"],

  // -- Pair and token screening (dexscreener) -------------------------
  //
  // One provider's screening surface, named key by key because a declared key
  // is type-checked, echoed back and rejected by name, which an opaque filter
  // bag cannot be. Every `*Usd`, `*Pct`, `*Seconds` and `*Ratio` suffix carries
  // the UNIT in the key for the reason the `*Percent` block above gives.
  ["window", "which stats window a screen measures over (5m/1h/6h/24h); the row's numbers follow it"],
  ["includeAllWindows", "return every stats window per row instead of only the one `window` selects"],
  ["omitFields", "row field GROUPS to drop from a large result; the inverse of `fields`"],
  ["explainDrops", "return why each row was dropped by the filters, so an empty page is diagnosable"],
  ["slug", "the provider's own identifier for one curated meta list"],
  ["pairAddress", "one DEX PAIR contract address; not a token address and not a wallet"],
  ["labels", "a LIST of provider pool labels to keep (v3, stable, ...)"],
  ["dexIds", "a LIST of DEX identifiers to keep"],
  ["excludeDexIds", "a LIST of DEX identifiers to drop; the complement of `dexIds`"],
  ["quoteSymbols", "a LIST of quote-asset symbols the pair must trade against"],
  ["onlyBoosted", "keep only pairs carrying a paid boost"],
  ["ctoOnly", "keep only community-takeover profiles"],
  ["requirePriceUsd", "drop rows the provider prices at null, rather than ranking an unpriced row"],
  ["requireLiquidityUsd", "drop rows with null liquidity, which bonding-curve pairs report"],
  ["requireSocials", "keep only rows carrying at least one social link"],
  ["requireWebsite", "keep only rows carrying a website"],
  ["minBoostCountTotal", "floor on the total boosts a token has ever received"],
  ["minTokenCount", "floor on how many tokens a trending group must contain"],
  ["placedWithinSeconds", "keep only ads placed within the last N seconds"],
  ["claimedWithinSeconds", "keep only takeovers claimed within the last N seconds"],
  ["updatedWithinSeconds", "keep only profiles updated within the last N seconds"],
  ["minPairAgeSeconds", "floor on pair age in SECONDS; the fresh-pair filter"],
  ["maxPairAgeSeconds", "ceiling on pair age in SECONDS"],
  ["minLiquidityUsd", "floor on pool liquidity, in USD"],
  ["maxLiquidityUsd", "ceiling on pool liquidity, in USD"],
  ["minMarketCapUsd", "floor on market capitalisation, in USD"],
  ["maxMarketCapUsd", "ceiling on market capitalisation, in USD"],
  ["minFdvUsd", "floor on fully diluted valuation, in USD"],
  ["maxFdvUsd", "ceiling on fully diluted valuation, in USD"],
  ["minVolumeUsd", "floor on traded volume over `window`, in USD"],
  ["maxVolumeUsd", "ceiling on traded volume over `window`, in USD"],
  ["minTxnCount", "floor on trades over `window`"],
  ["minPriceChangePct", "floor on price change over `window`, as a PERCENT"],
  ["maxPriceChangePct", "ceiling on price change over `window`, as a PERCENT"],
  ["minTurnoverRatio", "floor on volume divided by liquidity; a RATIO, not a percent"],
  ["maxTurnoverRatio", "ceiling on volume divided by liquidity; a RATIO, not a percent"],
  ["minBuySellRatio", "floor on buys divided by sells; a RATIO, not a percent"],
  ["maxBuySellRatio", "ceiling on buys divided by sells; a RATIO, not a percent"],
  ["minQuoteDepthTokens", "floor on quote-side depth counted in TOKENS, not USD"],

  // -- The site screening channel (dexscreener v2 surface) -----------
  //
  // The keys the website's own screener sends that the public API never had.
  // Each is a SERVER-side filter: it changes which rows the provider ranks,
  // not which rows survive locally, so a missing key here silently widens a
  // screen instead of narrowing it. Named individually for the same reason the
  // block above is: the provider FAILS OPEN on a filter name it does not know.
  ["thresholdWindow", "which window the volume/transaction/price-change thresholds measure over; defaults to `window`"],
  ["includeInactive", "lift the provider's gate that hides pairs with no activity in `window`"],
  ["includeLaunchpadPairs", "lift the provider's hidden exclusion of bonding-curve pairs; widens the set"],
  ["metaIds", "a LIST of narrative IDs (not slugs) to keep; a slug matches nothing"],
  ["launchpadIds", "a LIST of launchpad identifiers to keep (pumpfun, launchlab, ...)"],
  ["baseTokenSuffixes", "a LIST of base-token mint-address suffixes to keep (for example `pump`)"],
  ["maxTxnCount", "ceiling on trades over the threshold window"],
  ["minBuyCount", "floor on BUY trades over the threshold window; a count, not a volume"],
  ["maxBuyCount", "ceiling on BUY trades over the threshold window"],
  ["minSellCount", "floor on SELL trades over the threshold window; a count, not a volume"],
  ["maxSellCount", "ceiling on SELL trades over the threshold window"],
  ["minBoostCount", "floor on how many paid boosts are ACTIVE on the pair; a count, not a spend"],
  ["minLaunchpadProgressPct", "floor on bonding-curve completion, as a PERCENT of the curve"],
  ["maxLaunchpadProgressPct", "ceiling on bonding-curve completion, as a PERCENT of the curve"],
  ["requireProfile", "keep only pairs whose base token has a DexScreener profile"],
  ["onlyAds", "keep only pairs with a CURRENTLY running paid ad placement"],
  ["onlyRecentAds", "keep only pairs that bought an ad slot recently, running or not"],
  ["stage", "which side of a launchpad graduation to list (still bonding, or migrated)"],

  // -- Bridge routing and order lookup (khalani, relay) ---------------
  //
  // The cross-chain vocabulary. `recipient` and `fromAddress` are deliberately
  // distinct from `walletAddress`: they name the two ENDS of a transfer, and a
  // single account key would let one be silently used as the other on a money
  // path.
  ["recipient", "the ACCOUNT that receives the destination-side funds; distinct from the source wallet"],
  ["fromAddress", "the ACCOUNT the source-side funds leave; distinct from `recipient`"],
  ["tradeType", "whether the amount given is the INPUT or the OUTPUT side; declared as an `enum`"],
  ["filler", "restrict quotes to one named filler of the provider's solver set"],
  ["depositMethod", "how the origin-chain deposit is made; declared as an `enum`"],
  ["routeId", "the id of a route a quote already returned; never synthesised by the caller"],
  ["orderId", "one bridge order's own id; the singular form, for the by-id read"],
  ["orderIds", "a LIST of bridge order ids to filter a list read by"],
  ["txHashSearch", "look a bridge order up by the transaction hash the user remembers"],
  ["keyword", "the partial phrase an autocomplete read parses; not a filter over rows"],
  ["refresh", "bypass the local cache and re-read the provider registry"],

  // -- Fixed-rate yield instruments (pendle) --------------------------
  //
  // Pendle splits one asset into three tradable legs at a maturity date, so it
  // needs keys for the legs (`pt`, `yt`, `sy`) and for the market that pairs
  // them. They are NOT `token`: which leg a call names decides what is bought,
  // and folding them into one key would make a PT purchase and a YT purchase
  // the same call.
  ["market", "a Pendle (or Solana lend) MARKET address or id; the venue, not a token"],
  ["pt", "the PRINCIPAL token leg: the discounted claim on the underlying at maturity"],
  ["yt", "the YIELD token leg: the claim on yield accrued until maturity"],
  ["sy", "the STANDARDIZED-YIELD wrapper leg both other legs are minted from"],
  ["fromMarket", "source market of a liquidity transfer; pairs with `toMarket`"],
  ["toMarket", "destination market of a liquidity transfer; pairs with `fromMarket`"],
  ["fromPt", "the maturing PT a rollover leaves; pairs with `toPt`"],
  ["toPt", "the PT a rollover moves into; pairs with `fromPt`"],
  ["asset", "the underlying asset a price or candle series is quoted for"],
  ["from", "series window start, in the unit the tool's description names"],
  ["to", "series window end, in the unit the tool's description names"],
  ["timeFrame", "the base unit of one candle in a Pendle series; distinct from `timeframe`, which is the pools.fun spelling"],
  ["precision", "how many price levels of an orderbook to return"],
  ["ids", "a LIST of provider asset ids to price"],
  ["type", "which class of asset a price read covers; declared as an `enum`"],
  ["categories", "a LIST of yield categories to keep"],
  ["excludeCategories", "a LIST of yield categories to drop; the complement of `categories`"],
  ["expiryAfter", "keep only markets maturing after this date"],
  ["expiryBefore", "keep only markets maturing before this date"],
  ["minDaysToExpiry", "floor on days remaining to maturity"],
  ["maxDaysToExpiry", "ceiling on days remaining to maturity"],
  ["minImpliedApyPercent", "floor on the market-implied fixed rate, as a PERCENT"],
  ["maxImpliedApyPercent", "ceiling on the market-implied fixed rate, as a PERCENT"],
  ["includeMatured", "also return markets whose maturity has already passed"],
  ["isNew", "keep only markets the provider flags as newly listed"],
  ["isPrime", "keep only markets on the provider's curated prime list"],
  ["underlyingSymbol", "symbol of the asset a yield market is built on"],
  ["kinds", "a LIST of position leg kinds to value; declared as an `enum`"],
  ["includeAccrued", "add accrued-but-unclaimed yield to a position valuation"],
  ["minValueUsd", "floor on a position's value, in USD; drops dust rows"],
  ["redeemableOnly", "keep only positions that can be redeemed right now"],

  // -- Solana swap execution knobs (jupiter) --------------------------
  //
  // Transaction-shaping parameters, not filters. Each one changes how the
  // transaction is BUILT, so each is named rather than hidden behind a single
  // opaque options object a model could not be rejected by name against.
  ["dexes", "a LIST of DEXes the route may use"],
  ["excludeDexes", "a LIST of DEXes the route may NOT use; the complement of `dexes`"],
  ["computeUnitPricePercentile", "which percentile of recent priority fees to pay, as the fee's own scale"],
  ["forJitoBundle", "build the transaction for a Jito bundle rather than a plain send"],
  ["maxAccounts", "ceiling on accounts the route may touch, to keep the transaction under the size limit"],
  ["tipLamports", "the validator tip, in LAMPORTS; raw base units, as the key says"],
  ["wrapAndUnwrapSol", "wrap and unwrap native SOL around the swap instead of requiring wSOL"],

  // -- Solana token screening and pricing (jupiter) -------------------
  ["minLiquidity", "floor on pool liquidity in the provider's own unit; NOT the USD-suffixed dexscreener key"],
  ["minOrganicScore", "floor on the provider's own organic-activity score"],
  ["statsInterval", "which stats window the row's numbers are measured over"],
  ["verifiedOnly", "keep only tokens the provider has verified"],
  ["category", "which provider-curated list a trending or event read answers for"],
  ["interval", "the bucket size of a time series"],
  ["mints", "a LIST of Solana mint addresses to price"],
  ["queries", "a LIST of free-text price queries; the plural of `query` on a batch read"],

  // -- Prediction markets (solana predict) ----------------------------
  //
  // `*Pubkey` keys are Solana account addresses of a SPECIFIC record - a
  // position, an order, a market. They keep the `Pubkey` suffix rather than
  // folding into `walletAddress` or `tokenAddress` because they identify a
  // program-owned account, not an account that holds funds and not a token.
  ["includeMarkets", "expand each event's markets inline instead of returning the event alone"],
  ["provider", "which prediction-market venue to answer for; declared as an `enum`"],
  ["positionPubkey", "the Solana account address of ONE position record"],
  ["orderPubkey", "the Solana account address of ONE order record"],
  ["marketPubkey", "the Solana account address of ONE market record"],
  ["eventId", "the provider's own id for one event"],
  ["filter", "the provider's own named row filter for an event list; declared as an `enum`"],
  ["subcategory", "narrower band inside `category`"],
  ["tags", "a LIST of the provider's own classification tags an event must carry"],
  ["isYes", "which side of a binary market to keep"],
  ["side", "buy or sell side of a prediction order; declared as an `enum`"],
  ["amountUsdc", "order size in USDC, carrying its asset in the key because this venue quotes in nothing else"],
  ["metric", "which leaderboard measure to rank by; declared as an `enum`"],
  ["period", "the leaderboard window"],
  ["count", "how many buckets a PnL history returns; distinct from `limit`, which caps rows"],
  ["id", "the provider's own id for one record on a by-id read"],

  // -- Solana lending (jupiter lend) ----------------------------------
  ["vaultId", "the lending vault ONE operation acts on"],
  ["vaultIds", "a LIST of lending vault ids to read; the plural of `vaultId`"],
  ["positionId", "the borrow position ONE operation acts on"],
  ["withdrawAll", "withdraw the whole balance; the shares path, so an accruing balance closes at zero"],
  ["repayAll", "repay the whole debt; the shares path, for the same reason as `withdrawAll`"],
  ["assets", "a LIST of assets a rates read covers"],
  ["minSupplyRate", "floor on the supply rate a rates read returns"],
  ["minTotalRate", "floor on the total (rewards-inclusive) rate a rates read returns"],

  // -- Launchpad creation and screening (trench, pools.fun) -----------
  //
  // The token a launch CREATES does not exist yet, so these are not `token`
  // keys: they are the metadata the launch is minted with. `prebuy` is the
  // creator's own first buy in the same transaction.
  ["name", "the display NAME the launch mints the token with"],
  ["symbol", "the SYMBOL the launch mints the token with"],
  ["description", "the launch's own description text, minted into the token metadata"],
  ["links", "the social and website links minted into the token metadata"],
  ["prebuy", "the creator's own first buy, executed in the launch transaction"],
  ["pairedAsset", "which asset the new token is paired against in its pool"],
  ["imageByteLength", "size of the image a launch preview will upload, in BYTES"],
  ["creator", "the ACCOUNT that launched a token; the launchpad's deployer filter"],
  ["status", "which lifecycle state a listing must be in; declared as an `enum`"],
  ["excludeRuggedFlagged", "drop rows the launchpad has flagged as rugged"],
  ["includeCurveProgress", "add each row's bonding-curve progress, which costs a per-row read"],
  ["minCurveProgressPct", "floor on bonding-curve completion, as a PERCENT"],
  ["maxCurveProgressPct", "ceiling on bonding-curve completion, as a PERCENT"],

  // -- pools.fun launch badges and the factory's pricing axis (PR4) ---
  //
  // Three keys, each the PROVIDER's own spelling rather than a Vex invention.
  // `vexAttested` and `holderRewards` are the launchpad's two opt-in discover
  // switches: measured at `src/tools/pools-fun/PoolsFun.md` lines 61-62, the
  // endpoint accepts the literal `true` only and answers HTTP 400 on `false`,
  // so the complement genuinely cannot be requested and a generic boolean
  // spelling would promise a filter the provider does not serve. `pricingMode`
  // is the launch factory's own enum over the paired asset (CORE_CHAINLINK,
  // CHAINLINK_STOCK, SIGNED_STOCK - 35 and 159 of 194 assets when measured,
  // PoolsFun.md lines 233-242), and it decides whether a launch needs a
  // time-boxed signed price attestation, so it is an axis a caller screens on.
  ["vexAttested", "pools.fun opt-in switch keeping only launches carrying a Vex attestation; the provider accepts the literal true only"],
  ["holderRewards", "pools.fun opt-in switch keeping only tokens that stream their fees to holders; same true-only contract as vexAttested"],
  ["pricingMode", "the pools.fun launch factory's own pricing enum for a paired asset; decides whether a launch needs a signed price attestation"],

  // -- Time-series and deep-read shaping (DexScreener deep dive, S4) ---
  //
  // These describe reading ONE pool's history rather than screening a
  // population, which is why none of the screening keys fit them.
  ["resolution", "bar size of a time series, as a duration token (1s..1mo); the series' own granularity, not a limit"],
  ["series", "WHICH series a time-series tool returns (price or market cap); orthogonal to resolution and to priceBasis"],
  ["priceBasis", "the denomination of a price column (usd, native, or both); a price needs a currency and the key says which"],
  ["inverted", "report on the OTHER side of a pair (quote per base, or the quote token) - orientation, never a filter"],
  ["startAtMs", "inclusive lower bound of a time window, in epoch MILLISECONDS; the unit is in the key because a seconds value lands in 1970"],
  ["endAtMs", "inclusive upper bound of a time window, in epoch MILLISECONDS; pairs with startAtMs"],
  ["maxPages", "ceiling on PROVIDER pages an internal walk may fetch; the bound is reported when hit, with a cursor for the rest"],
  ["deadlineMs", "wall-clock budget for an internal walk, in MILLISECONDS; the sibling bound of maxPages and reported the same way"],
  ["beforeBlock", "EXCLUSIVE upper block bound for a continuation; takes back the `nextBeforeBlock` a truncated walk returned, so withheld rows stay reachable"],
  ["afterBlock", "EXCLUSIVE lower block bound: return only rows after this block. The forward twin of `beforeBlock`, and the provider's own spelling of forward paging on the trade read"],
  ["maxChains", "ceiling on chains one fan-out may span; a raisable DEFAULT, since each chain costs one provider request and the deadline is the real bound"],
  ["maxBoostCount", "upper bound on a row's count of ACTIVE paid boosts; it bounds WITHIN the boosted population and never excludes advertised rows, because a maximum matches only rows that carry the field"],
  ["maxEnrichedNarratives", "ceiling on how many rows a per-row enrichment pass may cover; a raisable DEFAULT, since each row costs one extra provider exchange"],
  ["disableQualityFloor", "drop EVERY default quality floor a screen applies, in one boolean; the schema-representable form of floor removal, so no threshold needs a null"],
  ["mode", "which SHAPE of one answer to return (rows, an aggregate, or both) when all shapes come from one fetch; distinct from `action`, which selects a different operation"],
  ["eventType", "which KIND of on-chain event to return (buy, sell, liquidity add or remove); a superset of a buy/sell side and named so it cannot be read as one"],
  ["maker", "one WALLET whose activity to return, scoped to the resource being read; distinct from walletAddress, which names the user's own account"],
  ["traderProfile", "how much of the per-row counterparty profile to carry (compact, full, none); a depth selector for one embedded block"],
  ["lookbackDays", "how many days back a provider-side ranking window reaches; a window length, not a filter on a timestamp"],
  ["onlyKol", "restrict a leaderboard to wallets the PROVIDER labels as key opinion leaders; provider classification, named after it so it cannot read as a Vex judgement"],
  ["minBaseAmountIn", "lower bound on a trade's BASE-token amount, human decimals as a string"],
  ["maxBaseAmountIn", "upper bound on a trade's BASE-token amount, human decimals as a string"],
  ["minQuoteAmountIn", "lower bound on a trade's QUOTE-token amount, human decimals as a string"],
  ["maxQuoteAmountIn", "upper bound on a trade's QUOTE-token amount, human decimals as a string"],

  // -- Wallet and response shaping (internal tools) -------------------
  //
  // `response_format` is the shared verbosity contract
  // (`tool-surface-spec/output-envelope.md`); it is ratified here because the
  // linter reads the same table for the JSON-schema lane as for manifests.
  ["action", "which sub-operation of a multi-mode tool to run; declared as an `enum`"],
  ["intentId", "the id of a prepared intent this call confirms; never synthesised by the caller"],
  ["response_format", "reply verbosity; the shared four-state contract, defaulting per tool and stated in its description"],

  // -- Generic transaction signing (stage A4b) ------------------------
  //
  // The proposal itself and the MANDATORY fee caps. Two rules shape these
  // spellings. First, every raw value names its UNIT in the key, because rule
  // 90 says a raw amount travels with the unit needed to read it and these are
  // the fields a user authorizes: `valueWei`, `maxFeePerGasWei`,
  // `computeUnitPriceMicroLamports`. Second, none of them is a Vex invention:
  // they are the field names of the transaction objects the chains and their
  // SDKs already use, so an agent that knows how to build an EVM transaction
  // or a Solana message does not have to learn a second vocabulary to hand one
  // to Vex. `amountIn`/`amountRaw` deliberately do NOT appear here: a generic
  // transaction has no single amount, and the amounts it does move are read
  // out of the calldata by the decoder rather than declared by the caller.
  ["data", "EVM calldata as 0x hex; `0x` means a plain native transfer and is accepted only when the target has no code"],
  ["valueWei", "native coin sent with an EVM call, in RAW wei as a decimal integer string"],
  ["gasLimit", "REQUIRED cap on gas UNITS; a caller input, never derived from an estimate"],
  ["maxFeePerGasWei", "REQUIRED EIP-1559 cap on total price per gas unit, in RAW wei"],
  ["maxPriorityFeePerGasWei", "REQUIRED EIP-1559 cap on the validator tip per gas unit, in RAW wei"],
  ["gasPriceWei", "REQUIRED legacy cap on price per gas unit, in RAW wei; mutually exclusive with the 1559 pair"],
  ["transactionBase64", "an UNSIGNED Solana transaction or message, base64; a signed one is refused"],
  ["computeUnitLimit", "REQUIRED cap on requested Solana compute units; priority fee is charged on the REQUEST, not on usage"],
  ["computeUnitPriceMicroLamports", "REQUIRED cap on Solana priority price per compute unit, in RAW micro-lamports"],
]);

/**
 * Spellings that must never appear again, each naming its replacement. The
 * linter puts the replacement IN the failure message: a rejection that does not
 * say what to write instead costs the agent another call.
 */
export const BANNED_PARAM_KEYS: ReadonlyMap<string, string> = new Map([
  ["amount", "use `amountIn` (human decimals) or `amountRaw` (base units) - the bare key meant both, 10^6 apart"],
  ["inputToken", "use `tokenIn`"],
  ["outputToken", "use `tokenOut`"],
  ["chainId", "use `chain` - the key said Id while the value was a slug"],
  ["chains", "use `chainIds`"],
  ["address", "use `tokenAddress` (a contract) or `walletAddress` (an account) - the bare key meant both"],
  ["network", "use `walletFamily` - it selects a wallet family, not a chain"],
  ["wallet", "use `walletFamily`"],
  ["search", "use `query` - one free-text key across the fleet (owner decision D1)"],
]);

/**
 * Param keys that carry a chain VALUE and therefore need the chain sentence.
 *
 * Also the allowlist for the two normalizations `runtime/params.ts` performs -
 * a JSON number becomes its decimal string, and a declared `enum` matches
 * case-insensitively - because a chain value is the one thing in this
 * vocabulary whose spelling carries no meaning of its own.
 */
export const CHAIN_VALUE_PARAM_KEYS: readonly string[] = ["chain", "fromChain", "toChain"];

// ── Shared description text ──────────────────────────────────────

/**
 * The one sentence every chain-valued param ends with. Both spellings are real:
 * `TokenFind` hands the agent a NUMERIC chain id, and every resolver in the
 * tree accepts it alongside the slug.
 */
export const CANONICAL_CHAIN_SENTENCE =
  "Chain slug/alias, or the numeric chain id `TokenFind` returns (e.g. `base` or `8453`).";

/**
 * The one sentence a RAW-amount param ends with. Rule 90: a raw amount must
 * travel with the decimals needed to read it, and the agent must be told where
 * to get them rather than guessing 18.
 */
export const CANONICAL_RAW_AMOUNT_SENTENCE =
  "Raw base units as an integer string (not human decimals) - read the token's decimals from `TokenFind` first.";

/** The one sentence a HUMAN-amount param ends with. */
export const CANONICAL_HUMAN_AMOUNT_SENTENCE =
  "In HUMAN decimal units (e.g. \"1.5\") - not wei, lamports, or any other base unit.";

/**
 * THE APPROVAL SENTENCE every fund-moving tool description carries.
 *
 * Hoisted because the copies that existed described the IN-APP loop ("it comes
 * back asking for approval") while the Studio MCP surface does the opposite:
 * `runStudioCall` enqueues the intent and BLOCKS the call on the approval
 * broker, then hands back the settled result whole
 * (`vex-app/src/main/studio/approval-service.ts`). An agent told the call
 * "comes back" reads a blocked call as a hang and a settled result as a
 * proposal, and the two mistakes it then makes - calling again, and retrying an
 * indeterminate outcome - are the two this sentence exists to prevent.
 *
 * The outcome words are the broker's own, so the vocabulary the agent reads
 * here is the vocabulary the wire uses. "executed" was NOT one of them, which is
 * the drift the pass-2 agent found (`transcripts/p1.txt:23-25`): the broker's
 * settled arms are `completed`, `declined`, `expired`, `refused`,
 * `dispatch_failed`, `indeterminate` and `not_queued` (`mcp/outcome.ts`). The
 * list below is the rewrite that transcript proposed, so this sentence and the
 * instructions block (`studio/instructions/**`) name one vocabulary.
 *
 * `pending` IS ONE OF THOSE STATUS WORDS. The sentence named only `confirmed`
 * and `confirmed_unrecorded`, and a completed call routinely carries neither:
 * both bridges (`relay/handlers/bridge/results.ts`, `khalani/handlers/
 * bridge-execute.ts` and its poll), both EVM swap executes on their broadcast
 * and failure paths, the Jupiter swap, the lend pair, trench and pools all
 * return `status: "pending"` from a call the broker settles as `completed`. An
 * agent told `pending` is not a settled word reads a broadcast transaction as an
 * unfinished call and sends it again - the double-spend this sentence exists to
 * prevent. It now names the word and the one action it licenses: poll it, never
 * re-send. The DEFINITION stays in the outcome vocabulary
 * (`studio/instructions/shared-usage.ts`, `pending` under UNKNOWN), delivered
 * once instead of per tool, because six always-loaded descriptions carry this
 * sentence at 2047 of the 2048-character hot-set bound
 * (`mcp/inventory/types.ts`) and the budget is the consumer's, not this
 * sentence's.
 *
 * THAT 2047 IS BYTES AS WELL AS CHARACTERS, and the two readings have stopped
 * agreeing. The measured cut is by characters, so characters remain the
 * contract; but `SwapExecute` and `SwapQuote` each carry a U+2192 arrow, which
 * puts them at 2045 characters and 2047 UTF-8 bytes - one byte of headroom
 * under the same number. Adding a word to this sentence therefore spends both
 * budgets at once, and `__tests__/vex-agent/mcp/inventory.test.ts` asserts both
 * so a non-ASCII edit cannot cross either unnoticed.
 *
 * The card clause answers the second measured confusion: two sessions read their
 * own harness rule ("confirm before an irreversible action") against a card they
 * had already been told about, and hesitated (pass 2, A-8). The card IS the
 * confirmation, and saying it here says it on every tool that raises one.
 */
export const CANONICAL_MCP_APPROVAL_SENTENCE =
  "APPROVAL: over MCP in a restricted project the call WAITS until the user answers the Vex card, "
  + "which IS the confirmation - do not ask for one again in chat. It returns the settled outcome: "
  + "executed (this tool's own status: confirmed, confirmed_unrecorded or pending - poll it, never "
  + "re-send), declined, expired, refused, dispatch_failed or indeterminate; never call it twice "
  + "while you wait; never retry an indeterminate one. In a full project it executes directly under "
  + "standing permission.";

/**
 * WHO BROADCASTS, on a prepare -> confirm pair. The measured defect I-1.
 *
 * `WalletSendPrepare` over MCP returned "Transfer prepared; Vex will confirm it
 * automatically." and nothing followed: that automatic follow-up is the IN-APP
 * turn loop's trusted handoff (`engine/core/turn-loop-tool-batch/
 * prepared-follow-up.ts`), and the MCP lane has no turn loop to run it. An agent
 * that believes the sentence waits forever; the only path that works is calling
 * the confirm tool itself, which is where the approval card is raised (pass 2,
 * `transcripts/i12.txt`, and the same question asked in `p2.txt:11` and
 * `p3.txt:89`).
 *
 * All four pairs (send, wrap, generic EVM, generic Solana) state the SAME rule,
 * because an agent that learns it on one pair must not have to re-derive it on
 * the next. Only the send pair has an in-app auto-dispatch at all, and its own
 * prepare RESULT says which lane ran it, so no description promises a follow-up
 * the reader cannot observe.
 */
export function canonicalPrepareHandoffSentence(confirmToolName: string): string {
  return (
    "WHO BROADCASTS: preparing sends nothing and raises no card. Only "
    + `\`${confirmToolName}\`, run with this intentId, moves funds, and THAT call raises the card. `
    + "Over MCP nothing dispatches it for you: you call it yourself before the intent expires."
  );
}

/** The confirm half of {@link canonicalPrepareHandoffSentence}. */
export const CANONICAL_CONFIRM_HANDOFF_SENTENCE =
  "WHO CALLS THIS: you do, with the intentId prepare returned - over MCP Vex dispatches nothing on "
  + "your behalf.";

/**
 * THE BRIDGE-DESTINATION SENTENCE, shared by all four bridge tools (the Khalani
 * and Relay quote and execute manifests) as the `rejectedParams` answer for
 * `recipient`.
 *
 * A bridge destination is a fund destination in exactly the sense the refund
 * destination is (`@tools/khalani/request.js`), and rule 90 is explicit: a
 * value that can redirect funds never originates from model input. Both wallet
 * references agree - MetaMask's bridge controller quotes for the SELECTED
 * account (`bridge-controller.ts`, `#getMultichainSelectedAccount`) and Rabby's
 * bridge flow has no recipient input at all (`Bridge/hooks/context.tsx` reads
 * `state.account.currentAccount.address`) - so the capability is REMOVED rather
 * than disclosed.
 *
 * It lives in `rejectedParams`, not in `params`: the untrusted boundary
 * (`runtime/params.ts`) rejects an undeclared key BEFORE the handler and BEFORE
 * the prequote gate, so this is the only place the explanation is read by the
 * agent that tried it. The handlers reject the key again, by name and WITH the
 * resolved destination address, for any path that reaches them.
 *
 * The remedy clause is a separate constant because BOTH texts end with it: the
 * refusal an agent reads must always name the tool that CAN send somewhere
 * else, or the agent's next move is to look for another way to set the
 * destination.
 */
const BRIDGE_RECIPIENT_REMEDY =
  "To move funds elsewhere, bridge to your wallet and then send with WalletSendPrepare, "
  + "which the user approves.";

export const BRIDGE_DERIVED_RECIPIENT_SENTENCE =
  "A bridge always delivers to the wallet selected for this project on the destination chain, so the "
  + "destination is derived and never taken from tool input. "
  + BRIDGE_RECIPIENT_REMEDY;

/**
 * The bridge handlers' own refusal for a supplied `recipient`, naming the
 * parameter AND the address the bridge will actually deliver to.
 *
 * It carries the SAME remedy clause the manifest sentence ends with, so the
 * boundary answer and the handler answer cannot drift. Only the handler can
 * state the address, because only the handler has resolved it; that is why both
 * texts exist rather than one.
 */
export function bridgeRecipientRefusal(toolId: string, destinationAddress: string): string {
  return `${toolId} failed: recipient is not a parameter: a bridge delivers to the wallet selected for `
    + `this project on the destination chain (${destinationAddress}). ${BRIDGE_RECIPIENT_REMEDY}`;
}

/**
 * The shared slippage paragraph, hoisted from six near-verbatim copies.
 *
 * Both numbers are INTERPOLATED from `slippage-policy.ts` rather than written
 * out, so the prose cannot drift from the enforced policy when the default
 * moves.
 */
export const CANONICAL_SLIPPAGE_PARAGRAPH =
  `Basis points (1 bps = 0.01%). Default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%. `
  + `Vex caps this at ${VEX_MAX_SLIPPAGE_BPS} (${VEX_MAX_SLIPPAGE_BPS / 100}%) and REJECTS a higher value rather than clamping it.`;
