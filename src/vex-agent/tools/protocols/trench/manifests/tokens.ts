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
      "List Trench Express launchpad tokens on Robinhood Chain (4663): each row carries token address, name, symbol, creator, curve-vs-graduated status, display-grade price and supply, 0-4 social links, an image URL, and the launchpad rug-flag. A row also carries isOwnLaunch when it can be determined: true means YOUR OWN wallet created that token (it is your launch, not a market opportunity), false means a different, known creator; the field is ABSENT when the launchpad reported no creator or your wallet could not be resolved, which means undetermined and never not-yours. A graduated row also carries its graduation DEX pool id and pool currencies (WETH-paired) — the token has left the bonding curve for that pool. Filter by curve stage, creator, and rug flag; sort by newest, price, or activity. Opt-in curve-progress filters (minCurveProgressPct/maxCurveProgressPct/includeCurveProgress) find tokens by how close they are to graduating — computed by Vex from on-chain curve reserves via one Multicall3 batch over the page (graduated rows are 100). Prices are display-grade (no USD quote) and ETH curve only. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [...TRENCH_TOKENS_PARAMS],
    exampleParams: { status: "curve", sort: "time", limit: 20 },
    discovery: TRENCH_TOKENS_DISCOVERY["trench.tokens"],
  },
];
