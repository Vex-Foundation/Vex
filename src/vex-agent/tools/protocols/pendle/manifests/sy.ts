/**
 * Pendle SY wrap / unwrap manifests (R5d card D3).
 *
 * SY ("Standardised Yield") is Pendle's wrapper around a yield-bearing asset —
 * the token PT and YT are actually minted from, and the token the `pendle.pt.redeem`
 * Router fallback pays out. `pendle.sy.redeem` is therefore THE recovery path for
 * that fallback: the two descriptions name each other on purpose.
 *
 * Both tools take the corpus rank-8 param set (chain, sy, token, amountIn,
 * slippageBps, dryRun) and use the DRY-RUN-IN-TOOL prequote pattern: one toolId
 * both quotes and executes. See `../handlers/sy-prequote.ts`.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_SY_DISCOVERY } from "../../embeddings/pendle/sy.js";

const CHAIN_PARAM = {
  key: "chain",
  type: "string" as const,
  required: true,
  description: "Chain slug or id — one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc').",
};

const SY_PARAM = {
  key: "sy",
  type: "string" as const,
  required: true,
  description:
    "The SY (Standardised Yield) CONTRACT ADDRESS. Read it from pendle.market.get as the market's `sy` field, or from the `deliveredAsset` a pendle.pt.redeem fallback reported.",
};

const SLIPPAGE_PARAM = {
  key: "slippageBps",
  type: "number" as const,
  unit: "bps" as const,
  description:
    "Slippage tolerance in whole basis points (default 50 = 0.50%; maximum 1000 = 10%). A fractional, negative or larger value is REJECTED, never clamped. The dry run and the execute must pass the SAME value (or omit it on both).",
};

const DRY_RUN_PARAM = {
  key: "dryRun",
  type: "boolean" as const,
  description:
    "true = quote only. Prices the wrap, runs every fund-safety check including the price floor, records the authorization this tool needs, and broadcasts NOTHING. Required before the real call.",
};

export const PENDLE_SY_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.sy.mint",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Wrap a plain token into Pendle SY (Standardised Yield) — the wrapper form of a yield-bearing asset that PT and YT are minted from. Needs: the chain, the SY contract address, the payment token address (ERC-20 only; pass wrapped native, never native), and amountIn in human-readable units (e.g. '1.5', not raw base units). Returns the transaction hash plus the RECEIPT-DECODED amounts (executedAmountIn / executedAmountOut) beside the quoted ones, so you can see the slippage you actually got. Approval-gated; pins the canonical Pendle Router. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: mint PT or YT (use pendle.py.mint), buy a PT (pendle.pt.buy), guarantee an exact output amount, accept native currency, or send the SY anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      SY_PARAM,
      {
        key: "token",
        type: "string",
        required: true,
        description: "The payment token CONTRACT ADDRESS to wrap (ERC-20; pass the chain's wrapped-native token for native exposure).",
      },
      { key: "amountIn", type: "string", required: true, description: "Amount of the payment token in human-readable units." },
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
      token: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      amountIn: "1",
      slippageBps: 50,
      dryRun: true,
    },
    discovery: PENDLE_SY_DISCOVERY["pendle.sy.mint"],
  },
  {
    toolId: "pendle.sy.redeem",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Unwrap Pendle SY (Standardised Yield) back into a plain token. THIS IS THE RECOVERY PATH for a pendle.pt.redeem that fell back to the direct Router redeem: that fallback pays SY instead of the market's underlying and reports it as `deliveredAsset` — pass that address here as `sy` to finish the exit. Needs: the chain, the SY contract address, the token address to receive, and amountIn (the SY amount) in human-readable units. Returns the transaction hash plus the RECEIPT-DECODED amounts beside the quoted ones. Approval-gated; pins the canonical Pendle Router. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: redeem a PT (pendle.pt.redeem) or a PT+YT pair (pendle.py.redeem), guarantee an exact output amount, deliver native currency, or send the proceeds anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      SY_PARAM,
      {
        key: "token",
        type: "string",
        required: true,
        description: "The output token CONTRACT ADDRESS to receive (ERC-20; pass the chain's wrapped-native token for native exposure).",
      },
      { key: "amountIn", type: "string", required: true, description: "Amount of SY to unwrap, in human-readable units." },
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
      token: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      amountIn: "1",
      slippageBps: 50,
      dryRun: true,
    },
    discovery: PENDLE_SY_DISCOVERY["pendle.sy.redeem"],
  },
];
