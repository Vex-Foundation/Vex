import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_MARKET_READ_DISCOVERY } from "../../embeddings/pendle/market-reads.js";
import { PENDLE_READ_ASSET_PRICE_TYPES } from "@tools/pendle/read/types.js";
import {
  PENDLE_PRICES_DEFAULT_LIMIT,
  PENDLE_PRICES_MAX_IDS,
  PENDLE_PRICES_MAX_LIMIT,
} from "../market-read-params.js";

/**
 * `pendle.prices.assets` — USD marks for Pendle assets on one chain.
 *
 * The description separates a MARK from a QUOTE explicitly. Pendle's own docs
 * warn against using its quote endpoint as a price oracle; the mirror-image
 * mistake — treating a display snapshot as a tradable price — is the one this
 * tool could invite, so it is refused in words.
 *
 * Contract only; registration, passage and facet live where `market-get.ts` names them.
 */
export const PENDLE_PRICES_ASSETS_TOOL: ProtocolToolManifest = {
  toolId: "pendle.prices.assets",
  publicName: "pendle__asset_prices_get",
  namespace: "pendle",
  lifecycle: "active",
  description:
    "USD price marks for Pendle assets on ONE chain — principal tokens (PT), yield tokens (YT), LP tokens and " +
    "standardised-yield (SY) tokens — including assets the wallet does not hold. Name specific assets with `ids`, or " +
    "omit them to page through the chain's assets. Prices come back as exact decimal strings and are Pendle's own " +
    "snapshot, refreshed roughly every 15-60 seconds: they are display and portfolio figures, NOT executable quotes " +
    "and not a pre-trade rate — use pendle.market.get for a market's tradable rate and implied APY. A requested id " +
    "Pendle does not price is reported in missingIds rather than dropped, so an unpriced asset never reads as a " +
    "worthless one. Read-only.",
  mutating: false,
  actionKind: "read",
  params: [
    {
      key: "chain",
      type: "string",
      required: true,
      description:
        "Chain slug or numeric id (e.g. 'ethereum', 'arbitrum', 42161). One call reads ONE chain; an unsupported chain is rejected by name.",
    },
    {
      key: "ids",
      type: "string",
      description:
        `Comma-separated asset ids to price — bare 0x addresses or 'chainId-0xaddress' composites, at most ` +
        `${PENDLE_PRICES_MAX_IDS} per call. An id belonging to a different chain than \`chain\` is rejected by name. ` +
        "Omit to page through the chain's assets instead.",
    },
    {
      key: "type",
      type: "string",
      description:
        `Optional asset-class filter: ${PENDLE_READ_ASSET_PRICE_TYPES.join(", ")} (comma-separated for several). ` +
        "Anything else is rejected by name. Most useful when paging without `ids`.",
    },
    {
      key: "limit",
      type: "number",
      description:
        `Rows per page when no ids are given: whole number 1-${PENDLE_PRICES_MAX_LIMIT} (default ` +
        `${PENDLE_PRICES_DEFAULT_LIMIT}). The response reports total, hasMore and nextOffset.`,
    },
    {
      key: "offset",
      type: "number",
      description: "Row offset for paging, whole number ≥ 0 (default 0). Pair it with the returned nextOffset.",
    },
  ],
  exampleParams: {
    chain: "ethereum",
    ids: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c,0x34280882267ffa6383b363e278b027be083bbe3b",
  },
  discovery: PENDLE_MARKET_READ_DISCOVERY["pendle.prices.assets"],
};
