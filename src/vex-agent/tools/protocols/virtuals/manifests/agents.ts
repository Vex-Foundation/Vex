import type { ProtocolToolManifest } from "../../types.js";
import { VIRTUALS_AGENTS_DISCOVERY } from "../../embeddings/virtuals/agents.js";

// Virtuals Protocol agent-token intelligence — READ-ONLY. Discovery surface for
// agent tokens on Robinhood (chain 4663), Base, Solana, and Ethereum. Trades
// route through the EXISTING venue tools named by each result's `tradingRoute`
// hint (uniswap on Robinhood; kyberswap on Base/ETH; solana on Solana). Chain is
// the API's required filter and MUST be one of BASE, SOLANA, ROBINHOOD, ETH.

export const VIRTUALS_AGENTS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "List Virtuals Protocol agent tokens on ONE chain (BASE, SOLANA, ROBINHOOD, or ETH). Concise rows: name, symbol, status (UNDERGRAD bonding-curve vs graduated AVAILABLE, with a warning flag on UNDERGRAD), token/preToken/LP addresses, holderCount, top10HolderPercentage, mcapInVirtual, volume24h, priceChangePercent24h, isVerified (anti-impersonation badge only), the anti-sniper buy-tax window, ageDays, and verified socials. Filter status client-side (undergrad|graduated|all) and sort by mcap, volume, newest, or recentGraduation. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain filter (REQUIRED): BASE, SOLANA, ROBINHOOD, or ETH." },
      { key: "status", type: "string", description: "Client-side status filter: undergrad (bonding curve), graduated (AVAILABLE), or all (default)." },
      { key: "sort", type: "string", description: "Sort order: mcap (default), volume, newest, or recentGraduation." },
      { key: "limit", type: "number", description: "Max agents to return after filtering (default 20, max 50)." },
    ],
    exampleParams: { chain: "ROBINHOOD", status: "graduated", sort: "mcap", limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.list"],
  },
  {
    toolId: "virtuals.get",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Get ONE Virtuals agent token's full profile by its numeric id — a protocol tool, called via execute_tool(toolId=\"virtuals.get\", params={id}), not by name. Adds to the list fields: factory, category, fdvInVirtual, liquidityUsd, graduation state, launchInfo, a bounded tokenomics summary, a sanitized short description excerpt, and a tradingRoute hint {venue, namespace, quoteToken} naming the EXACT existing tool that trades it (uniswap/kyberswap/solana, quoted in VIRTUAL). ALWAYS call this before buying a graduated agent to read the anti-sniper window — never buy while windowActive. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "string", required: true, description: "Numeric Virtuals agent id (e.g. 96200 for VEX)." },
    ],
    exampleParams: { id: "96200" },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.get"],
  },
  {
    toolId: "virtuals.graduations",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "The 'what just graduated' feed: recently graduated (AVAILABLE) Virtuals agent tokens on ONE chain (BASE, SOLANA, ROBINHOOD, or ETH), newest first by graduation time, each with its live anti-sniper buy-tax window status. Use to catch fresh graduations and check whether the sniper-protection window is still active (a buy would be heavily taxed). Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain filter (REQUIRED): BASE, SOLANA, ROBINHOOD, or ETH." },
      { key: "limit", type: "number", description: "Max graduations to return (default 20, max 50)." },
    ],
    exampleParams: { chain: "ROBINHOOD", limit: 10 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.graduations"],
  },
  {
    toolId: "virtuals.geneses",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Browse the Virtuals genesis launch calendar — points-sale events that precede agent-token launches (mostly Base), newest first, with start/end windows, participant counts, and the linked agent. Use to track upcoming or past launches. Suspicious far-future dates are spam. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "limit", type: "number", description: "Max geneses to return (default 20, max 50)." },
      { key: "page", type: "number", description: "1-based page for older genesis events (default 1)." },
    ],
    exampleParams: { limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.geneses"],
  },
];
