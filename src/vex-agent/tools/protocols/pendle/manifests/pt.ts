import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_PT_DISCOVERY } from "../../embeddings/pendle/pt.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const SWAP_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc')." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS (ERC-20; use WETH for ETH). Buy: the payment token. Sell: the PT address." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS. Buy: the PT address. Sell: the payment token." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount of tokenIn in human-readable units." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
  // NO `recipient` param (Codex cleanup): the receiver is ALWAYS the session
  // wallet — the calldata intent binding asserts it, and the quote could never
  // bind a divergent recipient anyway.
  { key: "dryRun", type: "boolean" as const, description: "Preview without executing." },
];

export const PENDLE_PT_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.pt.quote",
    publicName: "pendle__pt_quote",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle PT trade - quote buying a PT with a payment token, selling a PT early, or redeeming a matured PT. Call this before every pendle__pt_buy, pendle__pt_sell and pendle__pt_redeem, and whenever the user asks what locking a fixed rate to this market's expiry would cost or return. RETURNS `action` (swap or redeem), `direction` (buy, sell or redeem), `chainId`, `tokenIn` and `tokenOut`, the resolved `pt`, `yt` and `market`, `receiver` (always the session wallet), `expiry`, `liquidityUsd`, `priceImpact`, `feeUsdEstimate` (Pendle's own estimated route fee in USD), `amountIn`, `amountOut`, `aggregator` and `slippageBps`. Quotes route through Pendle's AMM only - limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT - it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc')." },
      { key: "tokenIn", type: "string", required: true, description: "Input token address (payment token for a buy; PT address for a sell/redeem)." },
      { key: "tokenOut", type: "string", required: true, description: "Output token address (PT for a buy; payment/underlying for a sell/redeem)." },
      { key: "amountIn", type: "string", required: true, description: "Amount of tokenIn in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenOut: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb", amountIn: "100" },
    discovery: PENDLE_PT_DISCOVERY["pendle.pt.quote"],
  },
  {
    toolId: "pendle.pt.buy",
    publicName: "pendle__pt_buy",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Buy a Pendle principal token (PT) FOR REAL with a payment token: signs and broadcasts a trade that LOCKS A FIXED YIELD UNTIL THE MARKET EXPIRES. Use this once the user has agreed to lock a rate you already quoted. Funds are committed until maturity; there is no early unlock, only an early exit at the market price with pendle__pt_sell." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__pt_quote must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `side`, `market`, `aggregator`, `priceImpact` and `feeUsdEstimate`. A real run RETURNS `txHash`, `side`, `market`, `tokenIn`, `tokenOut`, `amountIn`, `executedAmountIn`, `executedAmountOut` and `quotedAmountOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_PARAMS,
    exampleParams: { chain: "ethereum", tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenOut: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb", amountIn: "100", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_PT_DISCOVERY["pendle.pt.buy"],
  },
  {
    toolId: "pendle.pt.sell",
    publicName: "pendle__pt_sell",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Sell a Pendle principal token (PT) FOR REAL back to a payment token before expiry: signs and broadcasts an EARLY EXIT priced at the current market, which can be WORSE than the locked rate the PT was bought at. Use this when the user wants out of a fixed-rate position before its maturity date; a MATURED PT redeems at face value with pendle__pt_redeem instead and should not be sold here." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__pt_quote must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `side`, `market`, `aggregator`, `priceImpact` and `feeUsdEstimate`. A real run RETURNS `txHash`, `side`, `market`, `tokenIn`, `tokenOut`, `amountIn`, `executedAmountIn`, `executedAmountOut` and `quotedAmountOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_PARAMS,
    exampleParams: { chain: "ethereum", tokenIn: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb", tokenOut: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountIn: "50", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_PT_DISCOVERY["pendle.pt.sell"],
  },
  {
    toolId: "pendle.pt.redeem",
    publicName: "pendle__pt_redeem",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Redeem a MATURED Pendle principal token (PT) FOR REAL after its expiry: signs and broadcasts the redemption of the PT for its accounting asset at roughly 1:1, which is the fixed rate paying out. SPENDS REAL FUNDS AND IS IRREVERSIBLE. Use this when the user holds a PT whose market has EXPIRED; before expiry there is nothing to redeem and an exit is a market-priced pendle__pt_sell instead. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees it first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__pt_quote must already exist, and `dryRun: true` HERE IS ONLY A THIN PREVIEW that does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. THE PAYOUT ASSET CAN CHANGE: if Pendle's pricing service is unavailable Vex falls back to a direct on-chain redeem that delivers SY, the wrapped yield-bearing token, NOT the market's underlying asset. The result always names what actually arrived in `deliveredAsset`, `deliveredAssetKind` (sy or underlying) and `deliveredPath` (convert or router_fallback_redeemPyToSy), so read those before telling the user the exit is finished; an SY payout still needs pendle__sy_redeem to unwrap. The `dryRun` preview RETURNS `dryRun`, `action`, `pt`, `yt` and `outputToken`. A real run RETURNS `txHash`, `action`, `pt`, `fallback`, `amountIn`, `executedAmountOut`, `deliveredAsset`, `deliveredAssetKind`, `deliveredPath`, an optional `note`, and `quotedAmountOut` on the priced path only. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc')." },
      { key: "tokenIn", type: "string", required: true, description: "The matured PT CONTRACT ADDRESS to redeem." },
      { key: "amountIn", type: "string", required: true, description: "Amount of PT to redeem in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
      // NO `recipient` param (Codex cleanup): the redeemed asset always lands on
      // the session wallet — asserted by the calldata intent binding.
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "0x1a69154f6f6247e4457332860fb173251a36e03f", amountIn: "100" },
    discovery: PENDLE_PT_DISCOVERY["pendle.pt.redeem"],
  },
];
