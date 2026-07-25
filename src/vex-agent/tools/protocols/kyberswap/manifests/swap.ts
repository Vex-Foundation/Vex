import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_SWAP_DISCOVERY } from "../../embeddings/kyberswap/swap.js";

const SWAP_EXECUTE_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or alias." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Symbols are rejected here." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with token_find first) or native ETH/native. Symbols are rejected here." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: "Slippage tolerance in basis points (1 bps = 0.01%); default 50 = 0.5%, which fits deep, liquid pairs. Must match the kyberswap.swap.quote value exactly (or be omitted on both) — a mismatch blocks execution. It is the ONLY price protection on the trade. On a thin or volatile pair (new listings, memecoins, small pools) 50 bps often fails at execution: the transaction broadcasts, then REVERTS, this call returns status \"reverted\", the activity row records mined_revert, and the gas is spent. Read that revert as \"this pair needs more tolerance\", not as \"this pair is untradeable\": re-quote with a higher slippageBps and pass the same value here. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping. Raise it in steps — no tolerance is known to fit a given pair in advance, and every increase widens the worst-case price you accept." },
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
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (1 bps = 0.01%); default 50 = 0.5%, which fits deep, liquid pairs. Pass the SAME value on kyberswap.swap.execute, or omit it on both — a mismatch blocks the execute (the prequote match requires identical params). Not sent to the quote route; it only pins the tolerance this quote authorizes. It is the ONLY price protection the resulting trade has. On a thin or volatile pair (new listings, memecoins, small pools) 50 bps often fails at execute time: the transaction REVERTS, the activity row records mined_revert, and the gas is spent. After such a revert, re-quote with a higher slippageBps rather than abandoning the pair. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept." },
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
