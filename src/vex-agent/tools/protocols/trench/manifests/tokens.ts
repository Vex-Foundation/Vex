import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_TOKENS_DISCOVERY } from "../../embeddings/trench/tokens.js";
import { TRENCH_TOKENS_PARAMS } from "./tokens-params.js";

// Trench Express token browser — READ-ONLY. Lists bonding-curve and graduated
// tokens on Robinhood Chain (4663) from the launchpad REST API. Server-side
// status/sort/limit/page; client-side creator + rug-flag filters. ETH curve
// only — there is no token/VEX pair on-chain today.

export const TRENCH_TOKENS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.tokens",
    namespace: "trench",
    lifecycle: "active",
    description:
      "List Trench Express launchpad tokens on Robinhood Chain (4663). COVERAGE: this is the "
      + "launchpad's own registry - ONLY tokens launched on Trench Express appear here, never other "
      + "Robinhood pools (research those with dexscreener once indexed). Server cache is about 2s, "
      + "so this is the fastest fresh-launch surface on the chain. Each row carries token address, "
      + "name, symbol, creator, curve-vs-graduated status, launchedAtMs (registry creation time, "
      + "ms epoch - compute age against your clock), display-grade price and supply, 0-4 social "
      + "links, an image URL, and the launchpad rug-flag (measured null on 12 of 12 live rows: the "
      + "default-on excludeRuggedFlagged filter cannot fire on a null flag, so a returned row is "
      + "NEVER a safety pass). A row also carries isOwnLaunch when it can be determined: true means YOUR OWN wallet created that token (it is your launch, not a market opportunity), false means a different, known creator; the field is ABSENT when the launchpad reported no creator or your wallet could not be resolved, which means undetermined and never not-yours. A graduated row also carries its graduation DEX pool id and pool currencies (WETH-paired) — the token has left the bonding curve for that pool. Filter by curve stage, creator, and rug flag; the time sort orders by launchedAtMs newest first, price and bump order by price or activity. Opt-in curve-progress filters (minCurveProgressPct/maxCurveProgressPct/includeCurveProgress) find tokens by how close they are to graduating — computed by Vex from on-chain curve reserves via one Multicall3 batch over the page (graduated rows are 100). Prices are display-grade (no USD quote) and ETH curve only. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [...TRENCH_TOKENS_PARAMS],
    exampleParams: { status: "curve", sort: "time", limit: 20 },
    discovery: TRENCH_TOKENS_DISCOVERY["trench.tokens"],
  },
];
