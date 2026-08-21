import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_YT_DISCOVERY } from "../../embeddings/pendle/yt.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const YT_SWAP_PARAMS = [
  { key: "chain", type: "string" as const, required: true, description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc')." },
  { key: "tokenIn", type: "string" as const, required: true, description: "Input token CONTRACT ADDRESS (ERC-20; use WETH for ETH). Buy: the payment token. Sell: the YT address." },
  { key: "tokenOut", type: "string" as const, required: true, description: "Output token CONTRACT ADDRESS. Buy: the YT address. Sell: the payment token." },
  { key: "amountIn", type: "string" as const, required: true, description: "Amount of tokenIn in human-readable units." },
  { key: "slippageBps", type: "number" as const, unit: "bps" as const, description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
  { key: "dryRun", type: "boolean" as const, description: "Preview without executing." },
];

export const PENDLE_YT_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.yt.quote",
    publicName: "pendle__yt_quote",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle YT trade — quote buying a yield token (YT) with a payment token or selling a YT back, with the output, price impact, feeUsdEstimate (Pendle's own estimated route fee in USD), aggregator, liquidity, and expiry. A YT is VARIABLE yield that DECAYS to zero at expiry (not fixed yield). Quotes route through Pendle's AMM only — limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT — it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc')." },
      { key: "tokenIn", type: "string", required: true, description: "Input token address (payment token for a buy; YT address for a sell)." },
      { key: "tokenOut", type: "string", required: true, description: "Output token address (YT for a buy; payment token for a sell)." },
      { key: "amountIn", type: "string", required: true, description: "Amount of tokenIn in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
    ],
    exampleParams: { chain: "ethereum", tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenOut: "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2", amountIn: "100" },
    discovery: PENDLE_YT_DISCOVERY["pendle.yt.quote"],
  },
  {
    toolId: "pendle.yt.buy",
    publicName: "pendle__yt_buy",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Buy a Pendle yield token (YT) with a payment token — leveraged, VARIABLE yield exposure on the underlying until expiry. A YT DECAYS TO ZERO at expiry and is worth nothing after it; this is NOT fixed yield and can lose money if realized yield underperforms. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.yt.quote first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: YT_SWAP_PARAMS,
    exampleParams: { chain: "ethereum", tokenIn: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenOut: "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2", amountIn: "100", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_YT_DISCOVERY["pendle.yt.buy"],
  },
  {
    toolId: "pendle.yt.sell",
    publicName: "pendle__yt_sell",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Sell a Pendle yield token (YT) back to a payment token before expiry — an early exit priced at the current market. A YT decays toward zero as expiry nears, so exiting sooner preserves more of its remaining value. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.yt.quote first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: YT_SWAP_PARAMS,
    exampleParams: { chain: "ethereum", tokenIn: "0x45a699a11a4a17fe0931ef3cea4bfc3235e659f2", tokenOut: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amountIn: "50", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_YT_DISCOVERY["pendle.yt.sell"],
  },
  {
    toolId: "pendle.claim",
    publicName: "pendle__rewards_claim",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Claim accrued interest and rewards from your Pendle positions on one chain in a single sweep — collects yield earned by held YTs and rewards from liquidity positions, sent to your wallet. Moves ONLY accrued income, never principal (converting interest may grant the Router an exact allowance on the market's own SY). Approval-gated; pins the canonical Pendle Router. An unscoped claim sweeps up to 10 held markets per transaction (a gas bound) and ALWAYS reports eligibleMarkets plus the exact skippedMarkets it left out; selection order is stable, so repeating the call reaches the same markets again — claim a skipped one by passing its address as market, which is not capped.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      { key: "chain", type: "string", required: true, description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc')." },
      { key: "market", type: "string", description: "Optional MARKET CONTRACT ADDRESS to scope the claim to one market — the way to reach a market the unscoped sweep reported in skippedMarkets (no cap applies to a scoped claim). Omit to sweep up to 10 held markets on the chain." },
      { key: "dryRun", type: "boolean", description: "Preview the positions that would be claimed — including eligibleMarkets and skippedMarkets — without executing." },
    ],
    exampleParams: { chain: "ethereum" },
    discovery: PENDLE_YT_DISCOVERY["pendle.claim"],
  },
];
