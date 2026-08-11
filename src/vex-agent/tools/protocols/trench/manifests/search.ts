import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_SEARCH_DISCOVERY } from "../../embeddings/trench/search.js";

// Trench Express name/symbol search — READ-ONLY. Thin wrapper over the
// launchpad `/api/search` endpoint.

export const TRENCH_SEARCH_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.search",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Search Trench Express launchpad tokens by name or symbol on Robinhood Chain (4663): returns matching rows with token address, name, symbol, creator, curve-vs-graduated status, display-grade price, links, and an image URL. A row also carries isOwnLaunch when it can be determined: true means YOUR OWN wallet created that token, false means a different, known creator; the field is ABSENT when the launchpad reported no creator or your wallet could not be resolved, which means undetermined and never not-yours. Use to resolve a token the user names before browsing its tape. ETH curve only. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "query", type: "string", required: true, description: "Name or symbol fragment to search for." },
      { key: "limit", type: "number", description: "Max results to return, 1-30 (provider-capped). Default leaves it to the provider." },
    ],
    exampleParams: { query: "vex" },
    discovery: TRENCH_SEARCH_DISCOVERY["trench.search"],
  },
];
