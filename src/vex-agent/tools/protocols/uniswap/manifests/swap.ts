import type { ProtocolToolManifest } from "../../types.js";
import { UNISWAP_SWAP_DISCOVERY } from "../../embeddings/uniswap/swap.js";

const SWAP_EXECUTION_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug/alias or id (e.g. robinhood, base, 4663)." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS or native ETH/native." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, description: "Slippage tolerance in basis points (default: 50 = 0.5%)." },
  { key: "recipient", type: "string" as const, description: "Recipient address for the output (default: sender)." },
  { key: "dryRun", type: "boolean" as const, description: "Preview without executing." },
];

export const UNISWAP_SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "uniswap.swap.quote",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Get the best Uniswap route across V2 + V3 — output amount, route, price impact, gas, and token-safety signals (factory allowlist, liquidity, fee-on-transfer). An all-EVM fallback for KyberSwap (which is primary where supported, incl. Robinhood Chain). Read-only, no execution.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug/alias or id (e.g. robinhood, base, 4663)." },
      { key: "tokenIn", type: "string", required: true, description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search — resolve a symbol to its address first." },
      { key: "tokenOut", type: "string", required: true, description: "Output token CONTRACT ADDRESS or native ETH/native." },
      { key: "amountIn", type: "string", required: true, description: "Amount in human-readable units." },
      { key: "slippageBps", type: "number", description: "Slippage tolerance in basis points (default: 50 = 0.5%)." },
    ],
    exampleParams: { chain: "robinhood", tokenIn: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", tokenOut: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", amountIn: "10" },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.quote"],
  },
  {
    toolId: "uniswap.swap.sell",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Sell tokens via Uniswap — exact-input swap (best V2/V3 route). An all-EVM fallback for KyberSwap (primary where supported, incl. Robinhood Chain). Pass token ADDRESSES (no symbol search). REQUIRES a fresh matching uniswap.swap.quote first. Execution handles the ERC-20 allowance automatically (exact-amount approve to the allowlisted router; native input needs none) — there is NO separate approve tool and none is needed.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", tokenOut: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", amountIn: "100", slippageBps: 50 },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.sell"],
  },
  {
    toolId: "uniswap.swap.buy",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Buy tokens via Uniswap — exact-input swap (best V2/V3 route), marked as a buy for portfolio tracking (lot opens on tokenOut). An all-EVM fallback for KyberSwap (primary where supported, incl. Robinhood Chain). Pass token ADDRESSES. REQUIRES a fresh matching uniswap.swap.quote first. Execution handles the ERC-20 allowance automatically (exact-amount approve to the allowlisted router; native input needs none) — there is NO separate approve tool and none is needed.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", tokenOut: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", amountIn: "50", slippageBps: 50 },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.buy"],
  },
];
