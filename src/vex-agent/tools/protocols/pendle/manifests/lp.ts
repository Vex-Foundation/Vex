import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_LP_DISCOVERY } from "../../embeddings/pendle/lp.js";

const CHAIN_PARAM = {
  key: "chain",
  type: "string" as const,
  required: true,
  description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc').",
};

const MARKET_PARAM = {
  key: "market",
  type: "string" as const,
  required: true,
  description: "The Pendle MARKET (LP) CONTRACT ADDRESS — the LP anchor liquidity is added to or removed from.",
};

export const PENDLE_LP_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.lp.quote",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle single-token LP add or remove — add deposits ONE token into a market's LP; remove burns LP back to one token. Shows the output, price impact, feeUsdEstimate (Pendle's own estimated route fee in USD), aggregator, liquidity, and market expiry. LP is NOT a fixed-rate lock: after expiry it stops earning swap fees and rewards. Quotes route through Pendle's AMM only — limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT — it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      CHAIN_PARAM,
      { key: "direction", type: "string", required: true, description: "'add' (token → LP) or 'remove' (LP → token)." },
      MARKET_PARAM,
      { key: "tokenIn", type: "string", description: "ADD only: the payment token CONTRACT ADDRESS to deposit (ERC-20; use WETH for ETH)." },
      { key: "tokenOut", type: "string", description: "REMOVE only: the output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Human-readable amount — add: the payment token amount; remove: the LP token amount to burn." },
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
    ],
    exampleParams: { chain: "ethereum", direction: "add", market: "0x34280882267ffa6383b363e278b027be083bbe3b", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1" },
    discovery: PENDLE_LP_DISCOVERY["pendle.lp.quote"],
  },
  {
    toolId: "pendle.lp.add",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Add single-token liquidity to a Pendle market — deposits ONE token and receives the market's LP token, which earns swap fees and rewards until the market's expiry. LP is NOT a fixed-rate lock; after expiry it stops earning and only the principal side remains removable. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.lp.quote (direction add) first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      MARKET_PARAM,
      { key: "tokenIn", type: "string", required: true, description: "The payment token CONTRACT ADDRESS to deposit (ERC-20; use WETH for ETH)." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the payment token in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", market: "0x34280882267ffa6383b363e278b027be083bbe3b", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1", slippageBps: 50 },
    discovery: PENDLE_LP_DISCOVERY["pendle.lp.add"],
  },
  {
    toolId: "pendle.lp.remove",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Remove single-token liquidity from a Pendle market — burns the market's LP token and returns ONE output token. TODAY THIS WORKS ONLY BEFORE EXPIRY: Pendle itself allows removal from a matured market, but Vex resolves markets from the active list, so a matured market cannot currently be removed here. LP is not a fixed-rate lock and no longer earns swap fees or rewards after expiry. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.lp.quote (direction remove) first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      MARKET_PARAM,
      { key: "tokenOut", type: "string", description: "The output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the LP token to remove in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", market: "0x34280882267ffa6383b363e278b027be083bbe3b", amountIn: "1", slippageBps: 50 },
    discovery: PENDLE_LP_DISCOVERY["pendle.lp.remove"],
  },
];
