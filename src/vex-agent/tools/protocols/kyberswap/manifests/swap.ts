import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_SWAP_DISCOVERY } from "../../embeddings/kyberswap/swap.js";

const SWAP_EXECUTION_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or alias." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token address or symbol." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token address or symbol." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, description: "Slippage tolerance in basis points (default: 50 = 0.5%)." },
  { key: "recipient", type: "string" as const, description: "Recipient address (default: sender)." },
  { key: "dryRun", type: "boolean" as const, description: "Preview without executing." },
];

export const SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "kyberswap.swap.quote",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Get best swap route across 400+ DEXs — price, route, gas estimate, price impact. Read-only, no execution.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or alias." },
      { key: "tokenIn", type: "string", required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Symbols are not resolved here." },
      { key: "tokenOut", type: "string", required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Symbols are not resolved here." },
      { key: "amountIn", type: "string", required: true, description: "Amount in human-readable units." },
      { key: "slippageBps", type: "number", description: "Slippage tolerance in basis points (default: 50 = 0.5%). Pass the SAME value on the execute (buy/sell) call, or omit it on both — a mismatch blocks the swap. Not sent to the quote route; it only pins slippage so the execute matches this quote." },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "ETH", tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amountIn: "1.0", slippageBps: 50 },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.quote"],
  },
  {
    toolId: "kyberswap.swap.sell",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Sell tokens via KyberSwap — exact-input swap: spend amountIn of tokenIn to receive tokenOut. Use when reducing/exiting a position. Routes through 400+ DEXs on 19 EVM chains. Resolve token addresses via khalani.tokens.search first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "0.5", slippageBps: 50 },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.sell"],
  },
  {
    toolId: "kyberswap.swap.buy",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Buy tokens via KyberSwap — exact-input swap: spend amountIn of tokenIn to acquire tokenOut. Same routing as sell, but marks trade as a buy for portfolio tracking (lot opens on tokenOut side). Resolve token addresses via khalani.tokens.search first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "base", tokenIn: "USDC", tokenOut: "ETH", amountIn: "100", slippageBps: 50 },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.buy"],
  },
];
