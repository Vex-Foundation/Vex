import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { CANONICAL_CHAIN_SENTENCE } from "../../conventions.js";
import { VIRTUALS_CHAIN_SLUGS } from "../chain-param.js";
import { VIRTUALS_AGENTS_DISCOVERY } from "../../embeddings/virtuals/agents.js";

// Virtuals Protocol agent-token intelligence — READ-ONLY. Discovery surface for
// agent tokens on Robinhood (chain 4663), Base, Solana, and Ethereum. Trades
// route through the EXISTING venue tools named by each result's `tradingRoute`
// hint (uniswap on Robinhood; kyberswap on Base/ETH; solana on Solana).
//
// Chain is the API's required filter over a CLOSED four-value set. The manifest
// advertises the canonical lowercase slugs like every other namespace and
// declares them as an `enum`; the provider's UPPERCASE spelling (BASE | SOLANA |
// ROBINHOOD | ETH) is translated inside `../chain-param.ts`, per SPEC §1.1
// ("per-provider translation stays in the adapter, never in the manifest").

/**
 * The `chain` param, shared by the two chain-scoped tools so their accepted
 * value set cannot drift apart.
 */
const VIRTUALS_CHAIN_PARAM: ProtocolParamDef = {
  key: "chain",
  type: "string",
  required: true,
  enum: VIRTUALS_CHAIN_SLUGS,
  description:
    "REQUIRED. The one chain to list — Virtuals indexes exactly four: "
    + `${VIRTUALS_CHAIN_SLUGS.join(", ")}. ${CANONICAL_CHAIN_SENTENCE}`,
};

export const VIRTUALS_AGENTS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "virtuals.list",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "List Virtuals Protocol agent tokens on ONE chain (base, solana, robinhood, or ethereum). Concise rows: name, symbol, status (UNDERGRAD bonding-curve vs graduated AVAILABLE, with a warning flag on UNDERGRAD), token/preToken/LP addresses, holderCount, top10HolderPercentage, mcapInVirtual, volume24h, priceChangePercent24h, isVerified (anti-impersonation badge only), the anti-sniper buy-tax window, ageDays, and verified socials. Filter status client-side (undergrad|graduated|all) and order with sortBy: mcap, volume, newest, or recentGraduation (sort is accepted as an alias). Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      VIRTUALS_CHAIN_PARAM,
      { key: "status", type: "string", description: "Client-side status filter: undergrad (bonding curve), graduated (AVAILABLE), or all (default)." },
      { key: "sortBy", type: "string", description: "Sort order: mcap (default), volume, newest, or recentGraduation." },
      { key: "sort", type: "string", description: "Alias of sortBy, accepted for compatibility. Same values; sortBy wins when both are sent." },
      { key: "limit", type: "number", description: "Max agents to return after filtering (default 20, max 50)." },
    ],
    exampleParams: { chain: "robinhood", status: "graduated", sortBy: "mcap", limit: 20 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.list"],
  },
  {
    toolId: "virtuals.get",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "Get ONE Virtuals agent token's full profile by its numeric id. Adds to the list fields: factory, category, fdvInVirtual, liquidityUsd, graduation state, launchInfo, a bounded tokenomics summary, a sanitized short description excerpt, and a tradingRoute hint {venue, namespace, quoteToken} naming the EXACT existing tool that trades it (uniswap/kyberswap/solana, quoted in VIRTUAL). ALWAYS call this before buying a graduated agent to read the anti-sniper window — never buy while windowActive. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "id", type: "number", required: true, description: "Numeric Virtuals agent id, exactly as virtuals.list returns it (e.g. 96200 for VEX). The string spelling \"96200\" is accepted too." },
    ],
    exampleParams: { id: 96200 },
    discovery: VIRTUALS_AGENTS_DISCOVERY["virtuals.get"],
  },
  {
    toolId: "virtuals.graduations",
    namespace: "virtuals",
    lifecycle: "active",
    description:
      "The 'what just graduated' feed: recently graduated (AVAILABLE) Virtuals agent tokens on ONE chain (base, solana, robinhood, or ethereum), newest first by graduation time, each with its live anti-sniper buy-tax window status. Use to catch fresh graduations and check whether the sniper-protection window is still active (a buy would be heavily taxed). Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      VIRTUALS_CHAIN_PARAM,
      { key: "limit", type: "number", description: "Max graduations to return (default 20, max 50)." },
    ],
    exampleParams: { chain: "robinhood", limit: 10 },
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
