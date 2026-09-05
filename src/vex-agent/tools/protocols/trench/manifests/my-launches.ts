import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_MY_LAUNCHES_DISCOVERY } from "../../embeddings/trench/my-launches.js";

// The user's OWN Trench Express launches - READ-ONLY, and read from Vex's local
// `launched_tokens` index rather than the launchpad API. There is deliberately
// no `wallet` parameter: the wallet is resolved server-side from the session's
// selection, so the model cannot widen the read to somebody else's history.

export const TRENCH_MY_LAUNCHES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.my_launches",
    publicName: "trench__my_launches_list",
    namespace: "trench",
    lifecycle: "active",
    description:
      "List the tokens the user has launched on Trench Express (Robinhood Chain 4663) through Vex. Use this when the user asks about a coin they made, how their own launch is doing, or which launches this wallet owns. Returns `launches` alongside wallet, chainId, count and source; each row carries token, name, symbol, createTx, launchedAt, and prebuy - the initial buy made in the SAME transaction, with its own amount, raw value, decimals and token, or null when the launch bought nothing. Read from Vex's durable local launch index rather than the launchpad API, so a token created outside this app has NO entry here and its absence is never evidence it does not exist. The wallet is resolved from the session and there is no wallet parameter, so this can never be widened to somebody else's history. Page with limit (1-100, default 25), most recent first; there is no cursor. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "limit", type: "number", description: "Max launches returned, 1-100 (default 25), most recent first." },
    ],
    exampleParams: { limit: 25 },
    discovery: TRENCH_MY_LAUNCHES_DISCOVERY["trench.my_launches"],
  },
];
