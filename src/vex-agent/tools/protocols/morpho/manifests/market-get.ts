import type { ProtocolToolManifest } from "../../types.js";
import { MORPHO_MARKET_READ_DISCOVERY } from "../../embeddings/morpho/market-reads.js";
import { MORPHO_LOOKBACK_KEYS } from "@tools/morpho/request.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";

/**
 * `morpho.market.get` - the pre-entry read for one market.
 *
 * BOTH `marketId` and `chain` are required, and that is a real constraint rather
 * than a convenience: Morpho's `marketById` takes `chainId: Int!`, so the same
 * market id on the wrong chain resolves to nothing. The param contract refuses a
 * 40-hex address in `marketId` by name, because `marketById` does not error on
 * one - it simply finds nothing, which would read to an agent as "this market
 * does not exist".
 */
export const MORPHO_MARKET_GET_TOOL: ProtocolToolManifest = {
  toolId: "morpho.market.get",
  publicName: "morpho__market_get",
  namespace: "morpho",
  lifecycle: "active",
  description:
    "Read ONE Morpho Blue lending market in full, by its `marketId` and the `chain` it lives on (both REQUIRED - a "
    + "market id is chain-scoped and the same id on the wrong chain resolves to nothing). Use this AFTER "
    + "`morpho__markets_discover` has narrowed the candidates and before treating a market as an entry, because it "
    + "returns the risk facts the screening call cannot carry. RETURNS everything the discovery row has (both assets "
    + "with decimals, lltvPercent, utilizationPercent, supply/borrow/collateral/liquidity as {raw, decimals, symbol, "
    + "human, usd}, the labelled APY block, oracle, irmAddress, listed flag and warnings) PLUS: outstanding and "
    + "realized badDebt in loan-asset units, the oracle price collateral is valued at with the scale needed to read it, "
    + "apyAtTargetPercent from the adaptive-curve rate model, the protocol fee, total liquidity, and Public Allocator "
    + "liquidity broken down per supplying vault. Set `includeSupplyingVaults` to also list the curated vaults that "
    + "supply this market with their NET APY, BOTH vault generations, each row tagged with its `version` - a vault "
    + "APY is net of the vault's own fee and is NOT the same basis as "
    + "this market's supply APY, so never rank the two against each other. Set `includeHistory` with a `lookback` for "
    + "the AVERAGE rate over a day, week, month, quarter, year or since inception, split on the same base-versus-net "
    + "lines: `supplyApyPercent` and `borrowApyPercent` EXCLUDE incentives, the `net*` figures INCLUDE them, and each "
    + "reward is an APR in its own token. ENTRY DISCIPLINE: `listed:false` means nobody vetted the market, a RED "
    + "warning names a concrete defect (an `oracle_unusable` flag makes every USD figure and every liquidation price "
    + "here unreliable), and non-zero outstanding bad debt means suppliers have already lost principal. LIMITS: state "
    + "is point-in-time, USD values are the market oracle's estimates rather than traded prices, `reallocatable` "
    + "liquidity is not committed and can be gone next block, and Morpho publishes no SLA. Read-only - it signs "
    + "nothing and spends nothing.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "marketId",
      type: "string",
      required: true,
      description:
        "The Morpho Blue market id: a 0x-prefixed 64-hex hash, NOT a 40-hex contract address. Read one from "
        + "`morpho__markets_discover`. An address is rejected by name, because Morpho answers an address-shaped id with "
        + "an empty result rather than an error.",
    },
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        `The chain the market lives on. ${CANONICAL_CHAIN_SENTENCE} Required because a Morpho market id is `
        + "chain-scoped, so the same id on the wrong chain resolves to nothing. Discovery ships the supported slugs "
        + "on this tool's `chains` metadata, and an unsupported chain is rejected with the full set spelled out.",
    },
    {
      key: "includeHistory",
      type: "boolean",
      description:
        "Add the averaged APY window selected by `lookback` (default false). Use it to judge whether today's rate is "
        + "high or low for this market - a rate is never high or low on its own.",
    },
    {
      key: "lookback",
      type: "string",
      enum: MORPHO_LOOKBACK_KEYS,
      description:
        "Which averaging window `includeHistory` returns, one of: one_day, seven_days (default), thirty_days, "
        + "ninety_days, one_year, inception. Ignored unless includeHistory is true. Anything else is rejected by name.",
    },
    {
      key: "includeSupplyingVaults",
      type: "boolean",
      description:
        "Also list the curated Morpho vaults supplying this market, with each vault's NET APY (default false). Covers "
        + "BOTH generations and tags every row with its `version`; a curator commonly runs a v1 and a v2 vault under "
        + "the same name at different addresses, so identify a route by address. A vault "
        + "APY is net of the vault fee and is a different basis from this market's supply APY.",
    },
  ],
  exampleParams: {
    marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    chain: "base",
    includeHistory: true,
    lookback: "thirty_days",
  },
  discovery: MORPHO_MARKET_READ_DISCOVERY["morpho.market.get"],
};
