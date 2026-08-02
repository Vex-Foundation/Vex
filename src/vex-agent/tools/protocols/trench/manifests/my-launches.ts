import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_MY_LAUNCHES_DISCOVERY } from "../../embeddings/trench/my-launches.js";

// The user's OWN Trench Express launches — READ-ONLY, and read from Vex's local
// `launched_tokens` index rather than the launchpad API. There is deliberately
// no `wallet` parameter: the wallet is resolved server-side from the session's
// selection, so the model cannot widen the read to somebody else's history.

export const TRENCH_MY_LAUNCHES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.my_launches",
    namespace: "trench",
    lifecycle: "active",
    description:
      "List the tokens the user has launched on Trench Express (Robinhood Chain 4663) through Vex: token address, name, symbol, the creation transaction hash, when it launched, and the initial buy made in the same transaction (with its own decimals). Read from Vex's durable local launch index, not the launchpad API — a token created outside this app has no entry. The wallet is the session's selected wallet and cannot be overridden. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "limit", type: "number", description: "Max launches returned, 1-100 (default 25), most recent first." },
    ],
    exampleParams: { limit: 25 },
    discovery: TRENCH_MY_LAUNCHES_DISCOVERY["trench.my_launches"],
  },
];
