import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_SWAP_DISCOVERY } from "../../embeddings/kyberswap/swap.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const SWAP_EXECUTE_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or alias." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are rejected here." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are rejected here." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. Must match the kyberswap.swap.quote value exactly (or be omitted on both) — a mismatch blocks execution. It is the ONLY price protection on the trade. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails, in one of two ways. USUALLY it fails for FREE: the pre-sign gas estimate is refused before anything is signed, NO gas is spent, this call returns status "not_attempted" with retryable true and failureCode slippage, and the message names the price guard. LESS OFTEN the pool moves after that estimate passes: the transaction broadcasts, then REVERTS, this call returns status "reverted", the activity row records mined_revert, and the gas IS spent. Read either as "this pair needs more tolerance", not as "this pair is untradeable": re-quote with a higher slippageBps and pass the same value here. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping. Raise it in steps, starting tight since the usual failure costs nothing — no tolerance is known to fit a given pair in advance, and every increase widens the worst-case price you accept.` },
];

export const SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "kyberswap.swap.quote",
    publicName: "kyberswap__swap_quote",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Get best swap route across 400+ DEXs — price, route, gas estimate, price impact. Read-only, no execution.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or alias." },
      { key: "tokenIn", type: "string", required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are not resolved here." },
      { key: "tokenOut", type: "string", required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are not resolved here." },
      { key: "amountIn", type: "string", required: true, description: "Amount in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. Pass the SAME value on kyberswap.swap.execute, or omit it on both — a mismatch blocks the execute (the prequote match requires identical params). Not sent to the quote route; it only pins the tolerance this quote authorizes. It is the ONLY price protection the resulting trade has. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails at execute time, in one of two ways. USUALLY it fails for FREE: the pre-sign gas estimate is refused before anything is signed, NO gas is spent, and the execute returns status "not_attempted" with failureCode slippage. LESS OFTEN the pool moves after that estimate passes: the transaction REVERTS, the activity row records mined_revert, and the gas IS spent. After either, re-quote with a higher slippageBps rather than abandoning the pair — and since the usual failure costs nothing, a tighter tolerance is the cheap thing to try first. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept.` },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "ETH", tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amountIn: "1.0", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.quote"],
  },
  {
    toolId: "kyberswap.swap.execute",
    publicName: "kyberswap__swap_execute",
    namespace: "kyberswap",
    lifecycle: "active",
    description: "Execute a real on-chain swap via KyberSwap — exact-input: spend amountIn of tokenIn to receive tokenOut, routed through 400+ DEXs on 19 EVM chains. Requires a fresh matching kyberswap.swap.quote first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_EXECUTE_PARAMS,
    // tokenOut is the real Base USDC contract, not the symbol "USDC": this
    // manifest REJECTS symbols on both token params, so a symbol here taught
    // the model the exact call the handler refuses (ergonomics audit J1-4).
    exampleParams: { chain: "base", tokenIn: "ETH", tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "0.5", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.execute"],
  },
];
