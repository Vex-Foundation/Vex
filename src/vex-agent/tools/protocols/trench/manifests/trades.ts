import type { ProtocolToolManifest } from "../../types.js";
import { TRENCH_TRADES_DISCOVERY } from "../../embeddings/trench/trades.js";

// Trench Express per-token trade tape - READ-ONLY. Wraps the undocumented
// `/api/trades` endpoint (page REQUIRED). Tolerant reader; honesty in output
// about the endpoint's undocumented status.

export const TRENCH_TRADES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "trench.trades",
    publicName: "trench__token_trades_list",
    namespace: "trench",
    lifecycle: "active",
    description:
      "Read the recent trade tape for ONE Trench Express token on Robinhood Chain (4663). Use this when the user asks whether a token is actually trading, who is buying it, or how it moved fill by fill. Returns `trades` alongside token, page, count and source; each fill carries side (buy, sell, or unknown), display-grade in and out amounts, volumeUsd, price, tx, time (ms epoch, newest first within a page) and maker. Page with the REQUIRED 0-based page plus limit (1-30, provider-capped); there is no hasMore field, so a short page is the only end-of-tape signal. TRAP: an empty tape (count: 0) means no fills were recorded for that address - a brand-new token with no trades and a mistyped address are indistinguishable here, so verify the address via trench__tokens_search or trench__tokens_discover before reading absence as youth. Sourced from an undocumented launchpad endpoint, so the output flags its provisional nature. ETH curve only. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "token", type: "string", required: true, description: "Token contract address whose tape to read." },
      { key: "page", type: "number", required: true, description: "0-based page index (REQUIRED - the provider returns an error without it)." },
      { key: "limit", type: "number", description: "Max trades per page, 1-30 (provider-capped)." },
    ],
    exampleParams: { token: "0x58659Ef9…B91", page: 0 },
    discovery: TRENCH_TRADES_DISCOVERY["trench.trades"],
  },
];
