import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_TRADES_DISCOVERY } from "../../embeddings/trench/trades.js";

// Trench Express per-token trade tape — READ-ONLY. Wraps the undocumented
// `/api/trades` endpoint (page REQUIRED). Tolerant reader; honesty in output
// about the endpoint's undocumented status.

export const TRENCH_TRADES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.trades",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Show the recent trade tape for ONE Trench Express token on Robinhood Chain (4663): each fill carries direction (buy/sell), display-grade in/out amounts, USD volume, price, transaction hash, timestamp (ms epoch, newest first within a page), and maker. TRAP: an empty tape (count: 0) means no fills were recorded for that address - a brand-new token with no trades and a mistyped address are indistinguishable here, so verify the address via trench.search or trench.tokens before reading absence as youth. Sourced from an undocumented launchpad endpoint, so the output flags its provisional nature. ETH curve only. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "token", type: "string", required: true, description: "Token contract address whose tape to read." },
      { key: "page", type: "number", required: true, description: "0-based page index (REQUIRED — the provider returns an error without it)." },
      { key: "limit", type: "number", description: "Max trades per page, 1-30 (provider-capped)." },
    ],
    exampleParams: { token: "0x58659Ef9…B91", page: 0 },
    discovery: TRENCH_TRADES_DISCOVERY["trench.trades"],
  },
];
