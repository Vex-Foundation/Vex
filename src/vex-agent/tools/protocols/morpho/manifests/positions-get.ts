import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_POSITION_READ_DISCOVERY } from "../../embeddings/morpho/position-reads.js";
import { MORPHO_MAX_PAGE_LIMIT, MORPHO_POSITION_SCOPES } from "@tools/morpho/request.js";

/**
 * `morpho.positions.get` - what one wallet already holds on Morpho.
 *
 * The description is long on purpose (owner decree), and every concrete claim in
 * it comes from the 2026-08-14 live capture rather than from documentation: the
 * 0.3053 health factor on an unlisted market, the 2,002 phantom rows, the
 * supply-only null, and the three-read union are all measured behaviours.
 *
 * The health-factor prose is the most important text in this namespace, which is
 * why it is stated at length rather than left to the doctrine alone: an agent
 * that reads a health factor as a percentage, or reads its absence as safety,
 * gives advice that costs the user the whole position.
 */
export const MORPHO_POSITIONS_GET_TOOL: ProtocolToolManifest = {
  toolId: "morpho.positions.get",
  publicName: "morpho__positions_get",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Read ONE wallet's Morpho footprint: its lending-market positions (collateral, assets lent, debt owed, health "
    + "factor) and its curated-vault deposits, across the EVM chains Vex reads Morpho on. Use this when the user "
    + "asks what they ALREADY hold, what they owe, or how safe their loan is; use morpho__markets_discover or "
    + "morpho__vaults_discover to find somewhere to go, and morpho__markets_activity_list for what happened in a market. "
    + "ONE WALLET PER CALL: Morpho accepts a list of addresses and this tool refuses to send one, because a "
    + "position read maps an account to its debts. A second address is rejected by name. "
    + "HEALTH FACTOR IS A RATIO, NOT A PERCENT, returned as a decimal string. Below 1 the position is liquidatable "
    + "RIGHT NOW. Morpho Blue has NO CLOSE FACTOR: one liquidation can repay the ENTIRE debt and seize collateral "
    + "worth up to the liquidation incentive on top, so a whole position can go in a single block and there is no "
    + "partial-liquidation cushion. Treat anything under about 1.25 as an emergency, not a warning. Each row also "
    + "carries `healthFactorBand` (no_debt, liquidatable_now, critical, tight, moderate, comfortable) and "
    + "`priceDropToLiquidationPercent`, which is NEGATIVE for a distance still to go: -40 means the collateral "
    + "price must FALL 40% to be liquidated, never that it already did, and each row names that direction in words "
    + "too. A NULL HEALTH FACTOR MEANS NO DEBT, NOT SAFETY: a supply-only position has "
    + "nothing to liquidate. Never read that absence as a checked, healthy position. A row that carries debt but no "
    + "health factor is dropped and counted instead of shown. "
    + "WHAT COUNTS AS A POSITION: Morpho keeps a row for every market an address ever touched (a live read of the "
    + "burn address returned 2,002), so this tool merges three server-side reads (rows with collateral, with assets "
    + "lent, with debt) and returns their union ordered by health factor ascending, riskiest first. Their totals in "
    + "`matchedByFilter` OVERLAP and must not be added. A union pages exactly only inside one window, so offset plus "
    + `limit above ${MORPHO_MAX_PAGE_LIMIT} is rejected by name; \`maxHealthFactor\` switches to a single `
    + "server-paged read that has no such bound. "
    + "UNLISTED MARKETS AND VAULTS ARE INCLUDED, unlike every screening tool here: the live capture behind this tool "
    + "found a wallet at health factor 0.3053 on an UNLISTED market flagged for unrealized bad debt, and hiding a "
    + "wallet's own money from its owner is never the safer default. "
    + "RETURNS per market position: the market (marketId, chain, asset pair, LLTV percent, listed, Morpho's "
    + "warnings), collateral, supplied and borrowed each as {raw, decimals, symbol, human, usd}, health factor and "
    + "band, price move to liquidation, margin and borrow PnL as SIGNED amounts, borrow return percent. Per vault "
    + "position: the vault (address, v1 or v2, name, chain, listed), asset, deposit as {raw, decimals, symbol, "
    + "human, usd}, PnL, roe and the vault APY. Every SHARE count arrives as {raw, decimals, human, scale} with "
    + "scale UNKNOWN and a null decimals, because Morpho serves no scale for a share unit: shares are an accounting "
    + "unit and must never be reported as money. Plus USD portfolio totals and a riskFlags "
    + "count of positions liquidatable now. A vault APY is NET of the curator's fee and EXCLUDES nothing else, "
    + "while a market supply APY is GROSS and INCLUDES no fee deduction: never rank the two against each other. "
    + "V2 VAULT COVERAGE IS COMPOSED AND ITS LIMITS ARE REPORTED. Morpho serves no per-user list of V2 vault "
    + "positions, so this tool finds candidates from the wallet's own V2 transaction history and reads each; when "
    + "`vaultV2Coverage.complete` is false a V2 position may exist that is not listed. "
    + "LIMITS: USD figures are Morpho's oracle marks, not traded prices, so totals are estimates and a market with "
    + "an oracle warning contributes an unreliable one. Health factors move every block. No SLA. Read-only - it "
    + "signs nothing, spends nothing, and cannot repay or add collateral to rescue a position.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "walletAddress",
      required: true,
      type: "string",
      description:
        "The ONE account address whose Morpho positions to read, 0x-prefixed and 40 hex. A list or a second "
        + "comma-separated address is rejected by name; call the tool once per wallet.",
    },
    {
      key: "chainIds",
      type: "string",
      acceptsStringArray: true,
      description:
        "Comma-separated chains, an array of the same, or 'all'. Slugs or numeric chain ids; discovery ships the "
        + "supported slugs on this tool's `chains` metadata and an unsupported entry is rejected with the full set. "
        + "Omit for every chain, which is the right default when the user asks what they hold.",
    },
    {
      key: "scope",
      type: "string",
      enum: MORPHO_POSITION_SCOPES,
      description:
        "Which half to read, one of: all (default), markets, vaults. Lending positions can be liquidated; curated "
        + "vault deposits cannot. Anything else is rejected by name.",
    },
    {
      key: "maxHealthFactor",
      type: "number",
      description:
        "Keep only lending positions at or below this health factor, as a plain RATIO and not a percent: 1 is "
        + "already liquidatable, 1.25 is close. The risk screen. It also pages server-side over all matches, so it "
        + "has no merged-window bound, and it excludes supply-only positions entirely, because those have no health "
        + "factor at all rather than a high one. Combining it with `scope: vaults` is rejected by name.",
    },
    {
      key: "includeVaultV2",
      type: "boolean",
      description:
        "Sweep for VaultV2 positions as well as V1 (default true). Morpho publishes no per-user V2 list, so this "
        + "costs one read to find candidate vaults from the wallet's V2 transaction history plus one per vault, and "
        + "its coverage is reported in `vaultV2Coverage`. Set false to skip it; the reply then claims nothing "
        + "about V2.",
    },
    {
      key: "offset",
      type: "number",
      description:
        "Row offset for paging (default 0). Pair it with the reply's `nextOffset`. Without `maxHealthFactor`, "
        + `offset + limit must stay within ${MORPHO_MAX_PAGE_LIMIT} rows: the market half is a merge of three reads `
        + "and that merge is only provably complete inside one window.",
    },
    {
      key: "limit",
      type: "number",
      description:
        `Max positions per section (default 20, maximum ${MORPHO_MAX_PAGE_LIMIT}). A larger value is REJECTED by `
        + "name rather than clamped. Market and vault positions page independently, each with its own `hasMore`. In "
        + "the vault section it bounds the V1 page only: the V2 sweep adds its rows on top, so `returned` there can "
        + "exceed it and `v1Returned` and `v2Returned` say which part came from where.",
    },
  ],
  exampleParams: { walletAddress: "0x2a315c59a6a95aeeec085c73badac801c2f4209f", scope: "all", limit: 20 },
  discovery: MORPHO_POSITION_READ_DISCOVERY["morpho.positions.get"],
};
