import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_SWAP_DISCOVERY } from "../../embeddings/kyberswap/swap.js";

const SWAP_EXECUTE_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or alias." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Symbols are rejected here." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Symbols are rejected here." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: "Slippage tolerance in basis points (default: 50 = 0.5%). Must match the kyberswap.swap.quote value exactly (or be omitted on both) — a mismatch blocks execution." },
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
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default: 50 = 0.5%). Pass the SAME value on kyberswap.swap.execute, or omit it on both — a mismatch blocks the execute (the prequote match requires identical params). Not sent to the quote route; it only pins slippage so the execute matches this quote." },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "ETH", tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amountIn: "1.0", slippageBps: 50 },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.quote"],
  },
  {
    toolId: "kyberswap.swap.execute",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Execute a real on-chain swap via KyberSwap — exact-input: spend amountIn of tokenIn to receive tokenOut, routed through 400+ DEXs on 19 EVM chains. Requires a fresh matching kyberswap.swap.quote first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTE_PARAMS,
    exampleParams: { chain: "base", tokenIn: "ETH", tokenOut: "USDC", amountIn: "0.5", slippageBps: 50 },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.execute"],
  },
];
