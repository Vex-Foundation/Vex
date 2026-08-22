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
      "Preview a Pendle YT trade - quote buying a yield token (YT) with a payment token or selling a YT back. Call this before every pendle__yt_buy and pendle__yt_sell, and whenever the user asks what taking or exiting variable yield exposure on this market would cost or return. RETURNS `action` (swap), `direction` (buy or sell), `instrument` (yt), `chainId`, `tokenIn` and `tokenOut`, the resolved `pt`, `yt` and `market`, `receiver` (always the session wallet), `expiry`, `liquidityUsd`, `priceImpact`, `feeUsdEstimate` (Pendle's own estimated route fee in USD), `amountIn`, `amountOut`, `aggregator`, `slippageBps` and a `decayWarning`. A YT is VARIABLE yield that DECAYS to zero at expiry (not fixed yield). Quotes route through Pendle's AMM only - limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT - it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
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
      "Buy a Pendle yield token (YT) FOR REAL with a payment token: signs and broadcasts a trade into leveraged VARIABLE yield exposure on the underlying until expiry. A YT DECAYS TO ZERO at expiry and is worth nothing after it; this is NOT a fixed rate and it loses money whenever realized yield underperforms the implied rate paid for it. Use this when the user explicitly wants variable or leveraged yield exposure rather than a locked rate, which is pendle__pt_buy." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__yt_quote must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `side`, `instrument`, `market`, `expiry`, `aggregator`, `priceImpact`, `feeUsdEstimate` and `decayWarning`. A real run RETURNS `txHash`, `side`, `instrument`, `market`, `tokenIn`, `tokenOut`, `amountIn`, `executedAmountIn`, `executedAmountOut` and `quotedAmountOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
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
      "Sell a Pendle yield token (YT) FOR REAL back to a payment token before expiry: signs and broadcasts an early exit priced at the current market. Use this when the user wants out of variable-yield exposure; a YT decays toward zero as expiry nears and is worth nothing after it, so exiting sooner preserves more of its remaining value and there is nothing to sell once the market has matured." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__yt_quote must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `side`, `instrument`, `market`, `expiry`, `aggregator`, `priceImpact`, `feeUsdEstimate` and `decayWarning`. A real run RETURNS `txHash`, `side`, `instrument`, `market`, `tokenIn`, `tokenOut`, `amountIn`, `executedAmountIn`, `executedAmountOut` and `quotedAmountOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
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
      "Claim accrued Pendle income FOR REAL on one chain in a single sweep: signs and broadcasts a transaction that collects the interest held YTs have earned and the rewards liquidity positions have earned, sent to the session's own wallet. SPENDS REAL FUNDS (gas) AND IS IRREVERSIBLE, and it moves ONLY accrued income, never principal, though converting interest may grant the Router an exact allowance on the market's own SY. Use this when the user wants to harvest or collect what their Pendle positions have earned; the merkle-distributed campaign rewards `pendle__merkle_rewards_list` reports are a DIFFERENT pot that no Vex tool can claim. There is nothing to quote here, because a claim has no price and no size to choose, so this tool has NO prequote requirement. APPROVAL: in a RESTRICTED session it does not execute, it returns pending approval so a human sees it first; in a FULL-permission session it executes directly. PRECONDITIONS: the transaction is pinned to the canonical Pendle Router, and an unscoped sweep covers at most 10 held markets per transaction as a gas bound. Call it with `dryRun: true` first to see exactly which markets would be swept. Selection order is stable, so repeating the call reaches the same markets again; reach a skipped market by passing its address as `market`, which is not capped. The `dryRun` preview RETURNS `dryRun`, `chain`, `yts` and `markets` as COUNTS, `eligibleMarkets`, `selectedMarkets`, `marketCap`, `skippedMarkets` and an optional `skippedNote`. A real run RETURNS `txHash`, `claimed` true, `chain`, `creditToken`, `executedCredit`, `yts` and `markets` as ADDRESS LISTS rather than counts, `eligibleMarkets`, `claimedMarkets`, `marketCap`, `skippedMarkets` and an optional `skippedNote`; each skipped entry names its `market` and a `reason` of market_not_found, no_position, unbindable_yt or market_cap. When there is nothing accrued to take it RETURNS `claimed` false with `chain` and a `reason` and broadcasts nothing. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
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
