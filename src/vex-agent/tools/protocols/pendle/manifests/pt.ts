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
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle PT trade — quote buying a PT with a payment token, selling a PT early, or redeeming a matured PT (output, price impact, feeUsdEstimate — Pendle's own estimated route fee in USD — aggregator, liquidity). Quotes route through Pendle's AMM only — limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT — it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
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
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Buy a Pendle principal token (PT) with a payment token — locks a fixed yield until expiry. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.pt.quote first. Funds are committed until maturity; early exit is market-priced.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_PARAMS,
    exampleParams: { chain: "ethereum", tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenOut: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb", amountIn: "100", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_PT_DISCOVERY["pendle.pt.buy"],
  },
  {
    toolId: "pendle.pt.sell",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Sell a Pendle principal token (PT) back to a payment token before expiry — an early exit priced at the current market (can be below the locked rate). Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.pt.quote first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: SWAP_PARAMS,
    exampleParams: { chain: "ethereum", tokenIn: "0x5a19fa369f2895dcd8d2cee62e4ceae58ef92bbb", tokenOut: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountIn: "50", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_PT_DISCOVERY["pendle.pt.sell"],
  },
  {
    toolId: "pendle.pt.redeem",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Redeem a MATURED Pendle principal token (PT) for its accounting asset (~1:1) after expiry. Approval-gated; pins the canonical Pendle Router. If Pendle's pricing service is unavailable it falls back to a direct on-chain redeem that delivers SY (the wrapped yield-bearing token), NOT the underlying asset — the result names it as `deliveredAsset`; unwrap it with pendle.sy.redeem to finish the exit. REQUIRES a fresh matching pendle.pt.quote first.",
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
