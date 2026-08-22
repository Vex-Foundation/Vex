import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_PY_DISCOVERY } from "../../embeddings/pendle/py.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const CHAIN_PARAM = {
  key: "chain",
  type: "string" as const,
  required: true,
  description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc').",
};

const PT_PARAM = {
  key: "pt",
  type: "string" as const,
  required: true,
  description: "The market's PT (principal token) CONTRACT ADDRESS — the anchor that resolves the market and its YT.",
};

export const PENDLE_PY_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.py.quote",
    publicName: "pendle__py_quote",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle PY mint or pre-expiry redeem - mint splits a payment token into an EQUAL amount of PT and YT; redeem burns an EQUAL PT+YT pair back to a token before expiry. Call this before every pendle__py_mint and pendle__py_redeem. RETURNS `action` (mint-py or redeem-py), `direction`, `chainId`, `tokenIn` and `tokenOut`, the resolved `pt`, `yt` and `market`, `receiver` (always the session wallet), `expiry`, `liquidityUsd`, `priceImpact`, `feeUsdEstimate` (Pendle's own estimated route fee in USD), `amountIn`, `aggregator`, `slippageBps`, and then `ptOut` with `ytOut` on a mint or `amountOut` on a redeem. Quotes route through Pendle's AMM only - limit-order liquidity is excluded, so a better resting price may exist. Exact-output is impossible: you specify amountIn and receive an estimate, never a guaranteed amountOut. This call has a SIDE EFFECT - it records the prequote authorization the matching broadcast tool requires, so quoting arms that tool for ~15 minutes. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      CHAIN_PARAM,
      { key: "direction", type: "string", required: true, description: "'mint' (token → PT+YT) or 'redeem' (pre-expiry PT+YT → token)." },
      PT_PARAM,
      { key: "tokenIn", type: "string", description: "MINT only: the payment token CONTRACT ADDRESS to spend (ERC-20; use WETH for ETH)." },
      { key: "tokenOut", type: "string", description: "REDEEM only: the output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Human-readable amount — mint: the payment token amount; redeem: the PT+YT pair amount to burn." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
    ],
    exampleParams: { chain: "ethereum", direction: "mint", pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1" },
    discovery: PENDLE_PY_DISCOVERY["pendle.py.quote"],
  },
  {
    toolId: "pendle.py.mint",
    publicName: "pendle__py_mint",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Mint a Pendle PT and YT together FOR REAL from one payment token: signs and broadcasts one transaction that splits the token into an EQUAL amount of principal token (PT, a fixed rate to expiry) and yield token (YT, variable yield that decays to zero at expiry). Use this when the user wants BOTH legs, typically to hold one and sell the other; when they only want one of them, buying it directly with pendle__pt_buy or pendle__yt_buy is the shorter path." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__py_quote with direction mint must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `action`, `pt`, `yt`, `market`, `aggregator`, `priceImpact` and `feeUsdEstimate`. A real run RETURNS `txHash`, `action`, `pt`, `yt`, `market`, `amountIn`, `executedPtOut`, `executedYtOut`, `quotedPtOut` and `quotedYtOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      PT_PARAM,
      { key: "tokenIn", type: "string", required: true, description: "The payment token CONTRACT ADDRESS to spend (ERC-20; use WETH for ETH)." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the payment token in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_PY_DISCOVERY["pendle.py.mint"],
  },
  {
    toolId: "pendle.py.redeem",
    publicName: "pendle__py_redeem",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Redeem a Pendle PT and YT pair back to a token FOR REAL BEFORE expiry: signs and broadcasts one transaction that burns an EQUAL amount of principal token (PT) and yield token (YT) and returns the output token. Use this to unwind a minted pair while the market is still active. It needs BOTH legs in equal amount: a MATURED PT held without its YT redeems with pendle__pt_redeem instead." + " SPENDS REAL FUNDS AND IS IRREVERSIBLE. APPROVAL: in a RESTRICTED session this does not execute, it returns pending approval so a human sees the trade and its term lock first; in a FULL-permission session it executes directly. PRECONDITIONS, refused BY NAME: a fresh matching pendle__py_quote with direction redeem must already exist and `dryRun: true` HERE IS ONLY A THIN PREVIEW, it does NOT record that authorization and does NOT replace the quote; the transaction is pinned to the canonical Pendle Router; and `amountIn` is HUMAN decimals, never raw base units. Pendle is exact-INPUT only, so the output is an estimate bounded by `slippageBps`, never a guarantee. The `dryRun` preview RETURNS `dryRun`, `action`, `pt`, `yt`, `outputToken` and `market`. A real run RETURNS `txHash`, `action`, `pt`, `yt`, `outputToken`, `amountIn`, `executedAmountOut` and `quotedAmountOut`, where the executed amounts are DECODED FROM THE RECEIPT and sit beside the quoted ones so the realized slippage is visible. ANY OTHER OUTCOME COMES BACK AS A FAILURE SENTENCE, NOT JSON, and it is not a licence to retry: a transaction that reverted, could not be proven, or was broadcast before Vex lost the read-back is already recorded and resolves automatically, so surface the transaction hash and check it rather than sending a second one.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      PT_PARAM,
      { key: "tokenOut", type: "string", description: "The output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the PT+YT pair to burn in human-readable units (equal PT and YT)." },
      { key: "slippageBps", type: "number", unit: "bps", description: `Slippage tolerance in basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%).` },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", amountIn: "1", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS },
    discovery: PENDLE_PY_DISCOVERY["pendle.py.redeem"],
  },
];
