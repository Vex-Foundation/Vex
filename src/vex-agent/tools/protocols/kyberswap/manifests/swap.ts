import type { ProtocolToolManifest } from "../../types.js";
import { KYBERSWAP_SWAP_DISCOVERY } from "../../embeddings/kyberswap/swap.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const SWAP_EXECUTE_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or alias." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are rejected here." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are rejected here." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount in human-readable units." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. Must match the kyberswap__swap_quote value exactly (or be omitted on both) - a mismatch blocks execution. It is the ONLY price protection on the trade. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails, in one of two ways. USUALLY it fails for FREE: the pre-sign gas estimate is refused before anything is signed, NO gas is spent, this call returns status "not_attempted" with retryable true and failureCode slippage, and the message names the price guard. LESS OFTEN the pool moves after that estimate passes: the transaction broadcasts, then REVERTS, this call returns status "reverted", the activity row records mined_revert, and the gas IS spent. Read either as "this pair needs more tolerance", not as "this pair is untradeable": re-quote with a higher slippageBps and pass the same value here. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping. Raise it in steps, starting tight since the usual failure costs nothing - no tolerance is known to fit a given pair in advance, and every increase widens the worst-case price you accept.` },
];

export const SWAP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "kyberswap.swap.quote",
    publicName: "kyberswap__swap_quote",
    namespace: "kyberswap",
    lifecycle: "active",
    description:
      "Price an exact-input EVM swap through the KyberSwap aggregator (400+ DEXs, on the chains "
      + "`kyberswap__chains_list` returns) without signing anything, and seed the prequote "
      + "`kyberswap__swap_execute` is matched against. Use this before every KyberSwap execute, and whenever the user "
      + "asks what a trade would return, what the rate or the price impact is, or which venues a route crosses. "
      + "KyberSwap is the PRIMARY EVM swap route; `SwapQuoteUniswap` is the alternative when KyberSwap has no "
      + "aggregator support for the chain or cannot price the pair. Both token params take a CONTRACT ADDRESS "
      + "(resolve a symbol with TokenFind first) or the native keyword, and `amountIn` is human decimals. Pass the "
      + "SAME `slippageBps` on the execute, or omit it on both: the prequote match requires identical params. "
      + "RETURNS `summary` (a one-line reading whose amounts are HUMAN units), `chain`, `chainId`, `tokenIn` and "
      + "`tokenOut` each with address, symbol and decimals, `routeSummary` (`amountIn`, `amountInUsd`, `amountOut`, "
      + "`amountOutUsd`, `gasUsd`, `l1FeeUsd` which is the separate L1 data fee on an L2 and null when the provider "
      + "quoted none, `extraFee`, `priceImpact` as a fraction where 0.0015 is 0.15%, `routeHops`, `routePaths`), "
      + "`routerAddress`, and `safety`, which carries per leg either a honeypot and fee-on-transfer verdict, a native "
      + "marker, or `checkFailed` with a bounded reason when the audit could not run. Amounts inside `routeSummary` "
      + "are RAW base units; only `summary` is humanized. USD and gas figures are provider ESTIMATES. `safety` is "
      + "informational here and blocks nothing: the execute is where a confirmed honeypot refuses. The result is "
      + "complete and there is no pagination.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or alias." },
      { key: "tokenIn", type: "string", required: true, description: "Input token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are not resolved here." },
      { key: "tokenOut", type: "string", required: true, description: "Output token CONTRACT ADDRESS (resolve a symbol with TokenFind first) or native ETH/native. Symbols are not resolved here." },
      { key: "amountIn", type: "string", required: true, description: "Amount in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (1 bps = 0.01%); default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%, which fits deep, liquid pairs. Pass the SAME value on kyberswap__swap_execute, or omit it on both - a mismatch blocks the execute (the prequote match requires identical params). Not sent to the quote route; it only pins the tolerance this quote authorizes. It is the ONLY price protection the resulting trade has. On a thin or volatile pair (new listings, memecoins, small pools) ${VEX_DEFAULT_SLIPPAGE_BPS} bps often fails at execute time, in one of two ways. USUALLY it fails for FREE: the pre-sign gas estimate is refused before anything is signed, NO gas is spent, and the execute returns status "not_attempted" with failureCode slippage. LESS OFTEN the pool moves after that estimate passes: the transaction REVERTS, the activity row records mined_revert, and the gas IS spent. After either, re-quote with a higher slippageBps rather than abandoning the pair - and since the usual failure costs nothing, a tighter tolerance is the cheap thing to try first. Vex caps it at 1000 (10%) and REJECTS anything above rather than clamping; every increase widens the worst-case price you accept.` },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "ETH", tokenOut: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amountIn: "1.0", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: KYBERSWAP_SWAP_DISCOVERY["kyberswap.swap.quote"],
  },
  {
    toolId: "kyberswap.swap.execute",
    publicName: "kyberswap__swap_execute",
    namespace: "kyberswap",
    lifecycle: "active",
    description:
      "Swap tokens FOR REAL through the KyberSwap aggregator: signs and broadcasts an exact-input trade with the "
      + "session's wallet. SPENDS REAL FUNDS AND IS IRREVERSIBLE. Use this once the user has agreed to a trade you "
      + "already priced; KyberSwap is the PRIMARY EVM swap route and `SwapExecuteUniswap` is the alternative when "
      + "KyberSwap has no aggregator support for the chain or cannot route the pair. APPROVAL: in a RESTRICTED "
      + "session this does not execute, it returns pending approval and a human sees the trade with the matched "
      + "quote's safety verdict before anything is signed; in a FULL-permission session it executes directly. "
      + "PRECONDITIONS, each refused BY NAME rather than worked around: a fresh `kyberswap__swap_quote` with "
      + "IDENTICAL params including `slippageBps` must already exist, and there is no preview here, so a `dryRun` "
      + "call is refused and pointed at the quote; both token params must be CONTRACT ADDRESSES (resolve a symbol "
      + "with TokenFind first) or the native keyword; a leg CONFIRMED as a honeypot aborts before anything is "
      + "signed, while a fee-on-transfer tax only warns; a `slippageBps` above 1000 (10%) is rejected, never "
      + "clamped; and the router this route names is verified against the known aggregator router before signing. "
      + "UNITS: `amountIn` is HUMAN decimals and is converted with the resolved token's own decimals; every amount "
      + "returned as `amountIn`/`amountOut` is HUMAN and is the amount DECODED FROM THE RECEIPT, which can differ "
      + "from what was requested. Vex also takes an integrator fee inside the route itself, disclosed on the quote "
      + "as `routeSummary.extraFee`. RETURNS `summary`, `chain`, `chainId`, `txHash`, `tokenIn`, `tokenOut`, "
      + "`amountIn`, `amountOut`, `status`, `_executionId`, `_explorerRefs`, and, when they apply, "
      + "`additionalCostUsd` with `additionalCostMessage`, `deliveryCheck`, and `safetyCheckUnavailable` naming any "
      + "leg whose honeypot audit could not run. READ `status` BEFORE CONCLUDING ANYTHING: `confirmed` is settled "
      + "and recorded; `confirmed_unrecorded` settled on-chain but Vex's own record did not persist; "
      + "`confirmed_pending_amounts` settled but the executed amounts were not decodable yet and finalize "
      + "automatically; `reverted` mined and failed, and the gas WAS spent; `not_attempted` was refused before "
      + "signing, spent nothing, and carries `retryable` and a `failureCode`; and `pending` means the outcome is "
      + "UNKNOWN and may still settle, so DO NOT retry or re-broadcast, the attempt is recorded and resolves "
      + "automatically, and the reply names the read you can perform yourself to check it.",
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
