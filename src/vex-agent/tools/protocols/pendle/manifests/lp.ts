import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_LP_DISCOVERY } from "../../embeddings/pendle/lp.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const CHAIN_PARAM = {
  key: "chain",
  type: "string" as const,
  required: true,
  description: "Chain slug or id - one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc').",
};

const MARKET_PARAM = {
  key: "market",
  type: "string" as const,
  required: true,
  description: "The Pendle MARKET (LP) CONTRACT ADDRESS - the LP anchor liquidity is added to or removed from.",
};

export const PENDLE_LP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.lp.quote",
    publicName: "pendle__lp_quote",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle single-token LP add or remove - add deposits ONE token into a market's LP; remove burns LP back to one token. Call this before every pendle__lp_add and pendle__lp_remove. RETURNS `action` (add-liquidity or remove-liquidity), `direction`, `chainId`, `tokenIn` and `tokenOut`, the resolved `market`, `receiver` (always the session wallet), `expiry`, `liquidityUsd`, `priceImpact`, `feeUsdEstimate` (Pendle's own estimated route fee in USD), `amountIn`, `amountOut`, `aggregator` and `slippageBps`. LP is NOT a fixed-rate lock: after expiry it stops earning swap fees and rewards. Quotes route through Pendle's AMM only - limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT - it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      CHAIN_PARAM,
      { key: "direction", type: "string", required: true, description: "'add' (token → LP) or 'remove' (LP → token)." },
      MARKET_PARAM,
      { key: "tokenIn", type: "string", description: "ADD only: the payment token CONTRACT ADDRESS to deposit (ERC-20; use WETH for ETH)." },
      { key: "tokenOut", type: "string", description: "REMOVE only: the output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Human-readable amount - add: the payment token amount; remove: the LP token amount to burn." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
    ],
    exampleParams: { chain: "ethereum", direction: "add", market: "0x34280882267ffa6383b363e278b027be083bbe3b", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1" },
    discovery: PENDLE_LP_DISCOVERY["pendle.lp.quote"],
  },
  {
    toolId: "pendle.lp.add",
    publicName: "pendle__lp_add",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Add single-token liquidity to a Pendle market FOR REAL: signs and broadcasts a deposit of ONE token in exchange for the market's LP token, which earns swap fees and rewards until the market expires. Use this when the user wants to earn a market's trading fees rather than lock a rate. LP is NOT a fixed-rate lock: after expiry it stops earning entirely, so an LP position has a date after which holding it gains nothing." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__lp_quote with direction add must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `action`, `market`, `tokenIn`, `aggregator`, `priceImpact` and `feeUsdEstimate`. A real run RETURNS `txHash`, `action`, `market`, `tokenIn`, `amountIn`, `executedLpOut` and `quotedLpOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      MARKET_PARAM,
      { key: "tokenIn", type: "string", required: true, description: "The payment token CONTRACT ADDRESS to deposit (ERC-20; use WETH for ETH)." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the payment token in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", market: "0x34280882267ffa6383b363e278b027be083bbe3b", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_LP_DISCOVERY["pendle.lp.add"],
  },
  {
    toolId: "pendle.lp.remove",
    publicName: "pendle__lp_remove",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Remove single-token liquidity from a Pendle market FOR REAL: signs and broadcasts a burn of the market's LP token in exchange for ONE output token. Works BEFORE AND AFTER expiry, so a matured market can still be exited here, and a matured LP no longer earns anything and has no reason to be held. Use pendle__lp_remove_dual instead when the user wants to keep principal exposure by taking part of the position back as the market's PT." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__lp_quote with direction remove must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `action`, `market` and `tokenOut`. A real run RETURNS `txHash`, `action`, `market`, `tokenOut`, `amountIn`, `executedAmountOut`, `quotedAmountOut` and `fullExit`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      MARKET_PARAM,
      { key: "tokenOut", type: "string", description: "The output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the LP token to remove in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", market: "0x34280882267ffa6383b363e278b027be083bbe3b", amountIn: "1", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_LP_DISCOVERY["pendle.lp.remove"],
  },
];
