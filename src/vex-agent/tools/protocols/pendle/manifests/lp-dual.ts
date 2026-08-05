/**
 * Pendle DUAL-LP manifests (R5d card E3) — `pendle.lp.removeDual` (LP → token +
 * PT) and `pendle.lp.addKeepYt` (token → LP + kept YT).
 *
 * WHAT MAKES THIS PAIR A PAIR is that each produces TWO instruments where the
 * shipped `pendle.lp.add` / `pendle.lp.remove` produce one. That is the whole
 * reason they are separate tools rather than a flag: a second output leg is a
 * different position, a different durable row, a different prequote kind, and a
 * second minimum-output the price floor has to bind independently.
 *
 * WHAT THE DESCRIPTIONS MUST NOT IMPLY. There is no "add liquidity dual" on
 * Pendle's Convert API — a keep-YT add is still a SINGLE-token deposit that
 * happens to hand you the YT instead of selling it into the pool. Both
 * descriptions say the deposit takes one token, so an agent reading them cannot
 * conclude a two-token deposit exists somewhere it has not looked.
 *
 * Both use the DRY-RUN-IN-TOOL prequote pattern: one toolId both quotes and
 * executes. See `../handlers/lp-dual-prequote.ts`.
 */

import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_LP_DUAL_DISCOVERY } from "../../embeddings/pendle/lp-dual.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

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
  description:
    "The Pendle MARKET (LP) CONTRACT ADDRESS — the market IS its LP token. Find it with pendle.yields or read it from pendle.market.get.",
};

const SLIPPAGE_PARAM = {
  key: "slippageBps",
  type: "number" as const,
  unit: "bps" as const,
  description:
    `Slippage tolerance in whole basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%; maximum 1000 = 10%). A fractional, negative or larger value is REJECTED, never clamped. It bounds BOTH output legs. The dry run and the execute must pass the SAME value (or omit it on both).`,
};

const DRY_RUN_PARAM = {
  key: "dryRun",
  type: "boolean" as const,
  description:
    "true = quote only. Prices both output legs, runs every fund-safety check including a separate price floor per leg, records the authorization this tool needs, and broadcasts NOTHING. Required before the real call.",
};

export const PENDLE_LP_DUAL_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.lp.removeDual",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Remove Pendle liquidity into TWO outputs at once: a plain token AND the market's principal token (PT). Burns the LP token (the market address IS the LP token) and delivers both legs to your own wallet, each protected by its own minimum — use it when you want to take part of an LP position back as an ordinary token while keeping principal exposure, instead of exiting entirely to one token with pendle.lp.remove. Needs: the chain, the market address, and amountIn (the LP amount) in human-readable units (e.g. '1.5', not raw base units); tokenOut is optional and defaults to the market's underlying asset. Works BEFORE and AFTER the market's expiry — removal is legal once a market has matured. Returns the transaction hash plus the RECEIPT-DECODED amounts for BOTH legs beside the quoted ones. Approval-gated; pins the canonical Pendle Router. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: exit to a single token (use pendle.lp.remove), choose which PT you receive (it is always the market's own), convert the LP straight to PT only, guarantee an exact output amount on either leg, deliver native currency, or send the proceeds anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      MARKET_PARAM,
      {
        key: "tokenOut",
        type: "string",
        description:
          "The TOKEN output leg's CONTRACT ADDRESS (ERC-20; pass wrapped native, never native). Defaults to the market's underlying asset. The other leg is always the market's own PT and is not a parameter.",
      },
      { key: "amountIn", type: "string", required: true, description: "Amount of the LP (market) token to burn, in human-readable units." },
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      market: "0x34280882267ffa6383b363e278b027be083bbe3b",
      tokenOut: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      amountIn: "1",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      dryRun: true,
    },
    discovery: PENDLE_LP_DUAL_DISCOVERY["pendle.lp.removeDual"],
  },
  {
    toolId: "pendle.lp.addKeepYt",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Add liquidity to a Pendle market with ONE token and KEEP the yield token (YT) it produces, receiving TWO instruments: the market's LP token and its YT. A plain pendle.lp.add sells that YT into the pool; this variant hands it to you, so use it when the user wants LP exposure without giving up the yield leg. It is still a SINGLE-token deposit — Pendle has no two-token 'dual add'. Needs: the chain, the market address, the payment token address (ERC-20 only; pass wrapped native, never native), and amountIn in human-readable units (e.g. '1.5', not raw base units). The market must NOT have expired: liquidity cannot be added after maturity, and a matured market is refused by name. Returns the transaction hash plus the RECEIPT-DECODED amounts for BOTH legs beside the quoted ones. Approval-gated; pins the canonical Pendle Router. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: deposit two tokens, sell the YT for you (use pendle.lp.add), buy a YT on its own (pendle.yt.buy), add to an expired market, guarantee an exact output amount on either leg, accept native currency, or send the LP or YT anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      MARKET_PARAM,
      {
        key: "tokenIn",
        type: "string",
        required: true,
        description: "The payment token CONTRACT ADDRESS to deposit (ERC-20; pass the chain's wrapped-native token for native exposure).",
      },
      { key: "amountIn", type: "string", required: true, description: "Amount of the payment token to deposit, in human-readable units." },
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      market: "0x34280882267ffa6383b363e278b027be083bbe3b",
      tokenIn: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
      amountIn: "1",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      dryRun: true,
    },
    discovery: PENDLE_LP_DUAL_DISCOVERY["pendle.lp.addKeepYt"],
  },
];
