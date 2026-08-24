import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_MY_LAUNCHES_DISCOVERY } from "../../embeddings/pools/my-launches.js";
import { POOLS_DISCOVER_LIMIT_CAP, POOLS_PLATFORMS } from "@tools/pools-fun/constants.js";

// The session wallet's OWN pools.fun launches - READ-ONLY. There is deliberately
// no wallet parameter: the address is resolved server-side from the session's
// selection, so the model cannot widen the read to somebody else's history.

export const POOLS_MY_LAUNCHES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.my_launches",
    publicName: "pools__my_launches_list",
    namespace: "pools",
    lifecycle: "active",
    description:
      "List the pools.fun tokens deployed by the user's own wallet on Robinhood Chain (4663). Use when the user asks what they have launched here, or needs the address of a token they created. Returns the wallet the answer is about, a count, and the same rows pools__tokens_discover returns - address, name, symbol, pool, paired asset, display-grade price and market cap, volumes, launch time and links - each marked as an own launch. The launchpad's own deployer index is the source, and it credits the LAUNCHING WALLET even when the launch was routed through the pools.fun gateway contract (on-chain the gateway is the creator, but the launchpad resolves the real launcher), so a gateway launch does appear here. An empty list means the launchpad has nothing indexed against this wallet, which is still not proof that nothing was launched: a token created outside pools.fun, or one not yet indexed, would also be absent. Page through longer histories with `nextCursor`: every reply carries it, and it is the whole continuation contract - send it back as `cursor` for the following page, and `nextCursor: null` means there is no next page. There is no hasMore field here, null IS the end-of-list signal, and the token is opaque: pass it back verbatim, never construct or parse one. The wallet is the session's selected wallet and cannot be overridden by a parameter. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "platform",
        type: "string",
        enum: [...POOLS_PLATFORMS],
        description:
          "Which launcher to look under: all (default), poolsfun, or sushi. The default covers both so a launch is not missed because it went through the other launcher.",
      },
      {
        key: "limit",
        type: "number",
        description:
          `Maximum launches returned, 1-${POOLS_DISCOVER_LIMIT_CAP}. Defaults to 25, newest first.`,
      },
      {
        key: "cursor",
        type: "string",
        description:
          "Opaque pagination token: pass back the nextCursor from a previous reply to fetch the following page. Keep the other arguments identical between pages, or the cursor walks a different result set.",
      },
      {
        key: "includeClaimable",
        type: "boolean",
        description:
          "true also SIMULATES a fee claim for the first few rows and reports what it would pay, in two separate "
          + "assets with their decimals. Costs a couple of chain reads per row, so it is off by default; a row "
          + "that was not simulated reports claimable: null, which means NOT MEASURED rather than nothing to claim.",
      },
    ],
    exampleParams: { limit: 25 },
    discovery: POOLS_MY_LAUNCHES_DISCOVERY["pools.my_launches"],
  },
];
