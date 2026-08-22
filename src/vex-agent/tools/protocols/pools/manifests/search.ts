import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_SEARCH_DISCOVERY } from "../../embeddings/pools/search.js";
import { POOLS_PLATFORMS, POOLS_DISCOVER_LIMIT_CAP } from "@tools/pools-fun/constants.js";
import { POOLS_UNSUPPORTED_PARAMS } from "./tokens-params.js";

// Name/symbol lookup on pools.fun - READ-ONLY. Defaults to searching BOTH
// launchers, because a user naming a token has no idea which one launched it.

export const POOLS_SEARCH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.search",
    publicName: "pools__tokens_search",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Find a pools.fun token on Robinhood Chain (4663) by name or symbol. Use this when the user names a token and you need its contract address before pulling candles, deep detail, or a trading quote. Returns the same rows as pools__tokens_discover: address, name, symbol, pool address, paired asset, display-grade price and market cap, volumes, price changes, launch time, deployer and fee recipient, links, and isOwnLaunch when it can be determined (an ABSENT field means undetermined, never not-yours). More than one match also carries a note saying the symbol is ambiguous. NAMES AND SYMBOLS ARE NOT UNIQUE on this launchpad - three live tokens shared the symbol SUSHICAT when this was measured - so always confirm which one the user meant by its ADDRESS, and say so when several match. Searches both launchers by default, and returns a nextCursor when more matches exist - pass it back as cursor to page through them. Read-only.",
    mutating: false,
    actionKind: "read",
    rejectedParams: POOLS_UNSUPPORTED_PARAMS,
    params: [
      {
        key: "query",
        type: "string",
        required: true,
        description:
          "The name or symbol fragment to look for, 1 to 64 characters. Matching is done by the launchpad across both token names and symbols.",
      },
      {
        key: "platform",
        type: "string",
        enum: [...POOLS_PLATFORMS],
        description:
          "Which launcher to search: all (default here, so a name lookup cannot miss the other launcher), poolsfun, or sushi. Narrow it only when the user has already said which launcher they mean.",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Maximum matches returned, 1-${POOLS_DISCOVER_LIMIT_CAP}. Defaults to 10, which is enough to expose copycat symbols sharing the name.`,
      },
      {
        key: "cursor",
        type: "string",
        description:
          "Opaque pagination token: pass back the nextCursor from a previous reply to fetch the following page. Keep the other arguments identical between pages, or the cursor walks a different result set.",
      },
    ],
    exampleParams: { query: "sushicat" },
    discovery: POOLS_SEARCH_DISCOVERY["pools.search"],
  },
];
