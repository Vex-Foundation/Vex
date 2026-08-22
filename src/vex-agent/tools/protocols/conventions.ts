/**
 * THE PARAM CONVENTION — one vocabulary for every agent-facing tool surface.
 *
 * This module is the single home for the cross-cutting naming/format rules the
 * tool audit (`agents_dm/tool-audit-2026-08/SPEC.md` §1) settled on: which
 * chain slugs exist, which param keys are canonical, which spellings are banned
 * and what replaces them, and the shared description sentences that must not be
 * retyped per manifest.
 *
 * NOTHING consumes it yet. It is landed ahead of the migration waves so the
 * manifest linter (`_manifest-lint.ts`) can measure today's distance from the
 * convention, and so each later wave edits ONE table instead of hunting copies.
 *
 * Deliberate non-goals: no runtime validation lives here (the boundary owner is
 * `runtime/params.ts`), and no provider translation lives here (a provider that
 * needs a numeric id, an UPPERCASE enum, or a slug in a URL path converts inside
 * its own adapter — the manifest always advertises the canonical spelling).
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
 * `src/tools/evm-chains/registry.ts` would therefore be missing here — the
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
 * key is a deliberate edit HERE, not an accident in a manifest — the linter
 * reports any other key against the tool that introduced it.
 */
export const CANONICAL_PARAM_KEYS: ReadonlyMap<string, string> = new Map([
  ["chain", "the single-chain selector; slug or decimal chain-id string"],
  ["fromChain", "bridge source chain; pairs with fromToken"],
  ["toChain", "bridge destination chain; pairs with toToken"],
  ["chainIds", "a LIST of chains (comma-separated string, or string[] where declared)"],
  ["walletFamily", "wallet FAMILY (eip155|solana|all) — never a chain"],
  ["tokenIn", "swap input token: EVM contract address or ETH/native; Solana symbol or mint"],
  ["tokenOut", "swap output token, same grammar as tokenIn"],
  ["fromToken", "bridge source token; pairs with fromChain"],
  ["toToken", "bridge destination token; pairs with toChain"],
  ["token", "the one token a single-token tool acts on"],
  ["tokenAddress", "a token CONTRACT address on a read tool"],
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
  ["search", "free-text substring match over a row's name/symbol identifiers"],
  ["sort", "ranking key; the accepted set is declared as an `enum`, never left in prose"],
  ["order", "ranking direction, `asc` or `desc`; declared as an `enum`"],
  ["offset", "row offset for paging; pairs with the reply's `nextOffset`"],
  ["fields", "comma-separated row field GROUPS to keep, to bound a large result"],
  ["listedOnly", "keep only rows the protocol itself lists/curates; excludes permissionless dust"],

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
  // are NOT added here, because a dozen existing tools carry allowlist debt
  // against them and canonicalizing one of them would silently retire a
  // fleet-wide rename this task has no mandate to decide. `order` is NOT in this
  // list: the screening block above ratified it, so the pools manifests use the
  // canonical key with no waiver.
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
]);

/**
 * Spellings that must never appear again, each naming its replacement. The
 * linter puts the replacement IN the failure message: a rejection that does not
 * say what to write instead costs the agent another call.
 */
export const BANNED_PARAM_KEYS: ReadonlyMap<string, string> = new Map([
  ["amount", "use `amountIn` (human decimals) or `amountRaw` (base units) — the bare key meant both, 10^6 apart"],
  ["inputToken", "use `tokenIn`"],
  ["outputToken", "use `tokenOut`"],
  ["chainId", "use `chain` — the key said Id while the value was a slug"],
  ["chains", "use `chainIds`"],
  ["address", "use `tokenAddress` (a contract) or `walletAddress` (an account) — the bare key meant both"],
  ["network", "use `walletFamily` — it selects a wallet family, not a chain"],
  ["wallet", "use `walletFamily`"],
]);

/**
 * Param keys that carry a chain VALUE and therefore need the chain sentence.
 *
 * Also the allowlist for the two normalizations `runtime/params.ts` performs —
 * a JSON number becomes its decimal string, and a declared `enum` matches
 * case-insensitively — because a chain value is the one thing in this
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
  "Raw base units as an integer string (not human decimals) — read the token's decimals from `TokenFind` first.";

/** The one sentence a HUMAN-amount param ends with. */
export const CANONICAL_HUMAN_AMOUNT_SENTENCE =
  "In HUMAN decimal units (e.g. \"1.5\") — not wei, lamports, or any other base unit.";

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
