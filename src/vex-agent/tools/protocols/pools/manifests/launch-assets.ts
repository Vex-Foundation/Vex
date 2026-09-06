import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_LAUNCH_ASSETS_DISCOVERY } from "../../embeddings/pools/launch-assets.js";
import { POOLS_PRICING_MODES } from "@tools/pools-fun/abi.js";
import { POOLS_LAUNCH_ASSETS_PAGE_CAP } from "../handlers/launch-assets.js";

// The launchable tokenised stocks - READ-ONLY. The launchpad's list joined with
// the launch factory's own pricing mode per pair, which is what decides whether
// a launch on that pair needs a signed price quote.

export const POOLS_LAUNCH_ASSETS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.launch_assets",
    publicName: "pools__launch_assets_list",
    namespace: "pools",
    lifecycle: "active",
    description:
      "List the tokenised stocks a pools.fun token can be launched paired against on Robinhood Chain (4663), and how each one is priced. Use it before a stock-paired launch, or to answer which stocks the launchpad supports. Returns one row per stock with its symbol, name and contract address, plus two facts read live from the launch factory at one pinned block that the launchpad's own list does not carry: pricingMode and launchable. "
      + `pricingMode is the factory's own enum: ${POOLS_PRICING_MODES.join(", ")}. CORE_CHAINLINK and CHAINLINK_STOCK pairs are priced from a feed and their launch carries an EMPTY price attestation. SIGNED_STOCK pairs require a backend-signed price quote that the factory accepts only 30 to 120 seconds after the price was observed, so a launch on one of those has to be prepared, verified and broadcast inside that window and re-prepared when it lapses. Most of this list is SIGNED_STOCK (159 of 194 when measured), so assume the time-boxed path unless the row says otherwise. `
      + "launchable is the factory's allowedPairedAsset flag for the pair. A row whose factory read did not answer reports pricingModeUnavailable instead of a mode, which means UNKNOWN and never NONE. "
      + `The launchpad serves this list for Robinhood only and paginates nothing, so the paging here is Vex's: the reply carries totalCount (every stock the launchpad listed), matchedCount (after your filters), the offset it served, hasMore and nextOffset, plus pricingModeCounts over the whole list. Nothing is dropped silently - every row past the page is one request away. Page size is 1 to ${POOLS_LAUNCH_ASSETS_PAGE_CAP}, default 50. `
      + "Rows carry no decimals: read them on-chain when an amount must be rendered. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "query",
        type: "string",
        description:
          "Case-insensitive substring matched against both the stock symbol and its company name, applied by Vex after the launchpad's full list is fetched. At most 64 characters. Use it to check whether one stock is launchable rather than paging the whole list.",
      },
      {
        key: "pricingMode",
        type: "string",
        enum: [...POOLS_PRICING_MODES],
        description:
          "Keep only pairs on this factory pricing mode. SIGNED_STOCK lists the pairs whose launch needs a signed price quote inside the factory's 30-to-120-second window; CHAINLINK_STOCK lists the feed-priced ones whose launch carries an empty attestation. The filter is refused by name when the factory reads did not answer, because filtering on a mode nothing was read for would return a list that looks authoritative and is not.",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Rows returned, 1-${POOLS_LAUNCH_ASSETS_PAGE_CAP}. Defaults to 50. This bound is Vex's, not the launchpad's - the endpoint returns everything in one body - and every row past it is reachable with offset.`,
      },
      {
        key: "offset",
        type: "number",
        description:
          "Zero-based index into the filtered list, for the next page. Pass back the nextOffset from a previous reply and keep query and pricingMode identical, or the offset walks a different list.",
      },
    ],
    exampleParams: { pricingMode: "CHAINLINK_STOCK", limit: 50 },
    discovery: POOLS_LAUNCH_ASSETS_DISCOVERY["pools.launch_assets"],
  },
];
