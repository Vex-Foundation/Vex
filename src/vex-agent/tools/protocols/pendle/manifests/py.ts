import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_PY_DISCOVERY } from "../../embeddings/pendle/py.js";

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
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Preview a Pendle PY mint or pre-expiry redeem — mint splits a payment token into an EQUAL amount of PT and YT; redeem burns an EQUAL PT+YT pair back to a token before expiry. Shows the output, price impact, feeUsdEstimate (Pendle's own estimated route fee in USD), aggregator, liquidity, and expiry, and records the safety preview the mint/redeem tools require before they broadcast. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      CHAIN_PARAM,
      { key: "direction", type: "string", required: true, description: "'mint' (token → PT+YT) or 'redeem' (pre-expiry PT+YT → token)." },
      PT_PARAM,
      { key: "tokenIn", type: "string", description: "MINT only: the payment token CONTRACT ADDRESS to spend (ERC-20; use WETH for ETH)." },
      { key: "tokenOut", type: "string", description: "REDEEM only: the output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Human-readable amount — mint: the payment token amount; redeem: the PT+YT pair amount to burn." },
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
    ],
    exampleParams: { chain: "ethereum", direction: "mint", pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1" },
    discovery: PENDLE_PY_DISCOVERY["pendle.py.quote"],
  },
  {
    toolId: "pendle.py.mint",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Mint a Pendle PT and YT together from one payment token — splits the token into an EQUAL amount of principal token (PT, fixed yield to expiry) and yield token (YT, variable yield that decays to zero at expiry) in a single transaction. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.py.quote (direction mint) first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      PT_PARAM,
      { key: "tokenIn", type: "string", required: true, description: "The payment token CONTRACT ADDRESS to spend (ERC-20; use WETH for ETH)." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the payment token in human-readable units." },
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", amountIn: "1", slippageBps: 50 },
    discovery: PENDLE_PY_DISCOVERY["pendle.py.mint"],
  },
  {
    toolId: "pendle.py.redeem",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Redeem a Pendle PT and YT pair back to a token BEFORE expiry — burns an EQUAL amount of principal token (PT) and yield token (YT) and returns the output token. This needs BOTH legs in equal amount; a MATURED PT with no YT uses pendle.pt.redeem instead. Approval-gated; pins the canonical Pendle Router. REQUIRES a fresh matching pendle.py.quote (direction redeem) first.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      PT_PARAM,
      { key: "tokenOut", type: "string", description: "The output token CONTRACT ADDRESS. Defaults to the market's underlying asset." },
      { key: "amountIn", type: "string", required: true, description: "Amount of the PT+YT pair to burn in human-readable units (equal PT and YT)." },
      { key: "slippageBps", type: "number", unit: "bps", description: "Slippage tolerance in basis points (default 50)." },
      { key: "dryRun", type: "boolean", description: "Preview without executing." },
    ],
    exampleParams: { chain: "ethereum", pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", amountIn: "1", slippageBps: 50 },
    discovery: PENDLE_PY_DISCOVERY["pendle.py.redeem"],
  },
];
