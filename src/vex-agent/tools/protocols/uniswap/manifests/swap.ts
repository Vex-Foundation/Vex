import type { ProtocolToolManifest } from "../../types.js";
import { UNISWAP_SWAP_DISCOVERY } from "../../embeddings/uniswap/swap.js";

// C24 (Codex final-review round 1, finding 8): the five-field contract is
// FINAL — no `dryRun`. A preview is `uniswap.swap.quote`; the execute always
// broadcasts. The handler hard-rejects a caller that still passes `dryRun`
// (the runtime's `RESERVED_RUNTIME_PARAM_KEYS` always accepts that key
// regardless of manifest declaration, so omitting it here is not sufficient
// on its own — mirrors kyberswap.swap.execute).
const SWAP_EXECUTION_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug/alias or id (e.g. robinhood, base, 4663)." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS or native ETH/native." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, description: "Slippage tolerance in basis points (default: 50 = 0.5%)." },
];

export const UNISWAP_SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "uniswap.swap.quote",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Get the best Uniswap route across V2 + V3 — output amount, route, price impact, gas, and token-safety signals (factory allowlist, liquidity, fee-on-transfer). A HIDDEN fallback for KyberSwap, available after an eligible KyberSwap route-not-found failure reveals it for this session. Read-only, no execution.",
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
    toolId: "uniswap.swap.execute",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Execute a Uniswap swap (best V2/V3 route, exact-input). A HIDDEN fallback for KyberSwap, available after an eligible KyberSwap route-not-found failure reveals it for this session. Pass token ADDRESSES (no symbol search). REQUIRES a fresh matching uniswap.swap.quote first. Execution handles the ERC-20 allowance automatically (exact-amount approve to the allowlisted router, with a reset-to-zero first for tokens that require it; native input needs none) — there is NO separate approve tool and none is needed.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", tokenOut: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", amountIn: "100", slippageBps: 50 },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.execute"],
  },
];
