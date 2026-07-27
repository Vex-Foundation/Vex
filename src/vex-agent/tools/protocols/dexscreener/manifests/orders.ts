import type { ProtocolToolManifest } from "../../types.js";
import { DEXSCREENER_ORDERS_DISCOVERY } from "../../embeddings/dexscreener/orders.js";

export const ORDERS_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.orders",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Check paid promotional orders for a token — each with type, status, and paymentTimestampMs (Unix epoch MILLISECONDS) — plus the token's boost-payment ledger (individual boost purchases with amounts). Legitimacy verification signal: shows what the project paid DEX Screener for.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chainId", type: "string", required: true, description: "Chain identifier (e.g. solana, ethereum, bsc, base)." },
      { key: "tokenAddress", type: "string", required: true, description: "Token contract address." },
    ],
    exampleParams: { chainId: "solana", tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    discovery: DEXSCREENER_ORDERS_DISCOVERY["dexscreener.orders"],
  },
  {
    toolId: "dexscreener.ads",
    namespace: "dexscreener",
    lifecycle: "active",
    description: "Get latest DexScreener ad placements — type, duration, impressions. Monitor promotional activity across the platform.",
    mutating: false,
    actionKind: "read",
    params: [],
    exampleParams: {},
    discovery: DEXSCREENER_ORDERS_DISCOVERY["dexscreener.ads"],
  },
];
