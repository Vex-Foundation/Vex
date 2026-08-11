import type { ProtocolToolManifest } from "../../types.js";
import { UNISWAP_SWAP_DISCOVERY } from "../../embeddings/uniswap/swap.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

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
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units. This is the TOTAL debited: the swap executes on this amount minus Vex's 25 bps fee." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It sets the minimum output written into the swap calldata, and is the ONLY price protection on the trade. Must match the uniswap.swap.quote value (or be omitted on both) — a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails, in one of two ways. USUALLY it fails for FREE: the router's "Too little received" / "INSUFFICIENT_OUTPUT_AMOUNT" comes back from the pre-sign gas estimate, so nothing is signed and NO gas is spent — this call returns status "not_attempted" with retryable true, and the activity row records failure code slippage. LESS OFTEN the pool moves after that estimate passes: the router REVERTS once mined, the row records mined_revert, and the gas IS spent. Either is the signal to retry with more tolerance, not to give up on the pair: re-quote with a higher slippageBps and pass the same value here. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping. Raise it in steps, starting tight since the usual failure costs nothing — no tolerance is known to fit a given pair in advance, and every increase widens the worst-case price you accept.` },
];

export const UNISWAP_SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "uniswap.swap.quote",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Get the best Uniswap route across V2 + V3 — output amount, route, price impact, gas, and token-safety signals (factory allowlist, liquidity, fee-on-transfer). A HIDDEN fallback for KyberSwap, available after an eligible KyberSwap swap failure reveals it for this session (a route or token KyberSwap cannot price, an unsafe or pre-sign-refused build, the Kyber swap transaction reverting on-chain, or KyberSwap being unavailable to us at all). Read-only, no execution. Vex charges 25 bps (0.25%) on the input token: the quoted output is for amountIn MINUS that fee (see swapAmountRaw and the vexFee block), while amountIn stays the total debited. The rate and receiver are fixed — passing fee, feeBps, feeReceiver or feeAmount is rejected by name.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug/alias or id (e.g. robinhood, base, 4663)." },
      { key: "tokenIn", type: "string", required: true, description: "Input token CONTRACT ADDRESS or native ETH/native. Uniswap has no symbol search — resolve a symbol to its address first." },
      { key: "tokenOut", type: "string", required: true, description: "Output token CONTRACT ADDRESS or native ETH/native." },
      { key: "amountIn", type: "string", required: true, description: "Amount in human-readable units. This is the TOTAL debited: the route is priced for this amount minus Vex's 25 bps fee." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. It pins the minimum output the resulting swap will enforce, and is the ONLY price protection that trade has. Pass the SAME value to uniswap.swap.execute, or omit it on both — a mismatch blocks the execute. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails at execute time, in one of two ways. USUALLY it fails for FREE: the router's "Too little received" / "INSUFFICIENT_OUTPUT_AMOUNT" comes back from the pre-sign gas estimate, so nothing is signed and NO gas is spent, and the activity row records failure code slippage. LESS OFTEN the pool moves after that estimate passes: the router REVERTS once mined, the row records mined_revert, and the gas IS spent. After either, re-quote with a higher slippageBps rather than abandoning the pair — and since the usual failure costs nothing, a tighter tolerance is the cheap thing to try first. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept.` },
    ],
    exampleParams: { chain: "robinhood", tokenIn: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", tokenOut: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", amountIn: "10" },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.quote"],
  },
  {
    toolId: "uniswap.swap.execute",
    namespace: "uniswap",
    lifecycle: "active",
    description: "Execute a Uniswap swap (best V2/V3 route, exact-input). A HIDDEN fallback for KyberSwap, available after an eligible KyberSwap swap failure reveals it for this session (a route or token KyberSwap cannot price, an unsafe or pre-sign-refused build, the Kyber swap transaction reverting on-chain, or KyberSwap being unavailable to us at all). Pass token ADDRESSES (no symbol search). REQUIRES a fresh matching uniswap.swap.quote first. Execution handles the ERC-20 allowance automatically (exact-amount approve to the allowlisted router, with a reset-to-zero first for tokens that require it; native input needs none) — there is NO separate approve tool and none is needed. Vex charges 25 bps (0.25%) on the input token as a SEPARATE transfer signed only AFTER the swap confirms, so a swap that fails is never charged: the router swaps amountIn MINUS the fee and the wallet is debited amountIn in total (the vexFee block in the result reports what was collected). The rate and receiver are fixed — passing fee, feeBps, feeReceiver or feeAmount is rejected by name.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTION_PARAMS,
    exampleParams: { chain: "robinhood", tokenIn: "0x8Ff92566f2e81BDd68EDfAa8cde73942A723796b", tokenOut: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", amountIn: "100", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: UNISWAP_SWAP_DISCOVERY["uniswap.swap.execute"],
  },
];
