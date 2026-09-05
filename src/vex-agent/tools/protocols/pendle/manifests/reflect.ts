/**
 * Pendle TERM-MOBILITY manifests (R5d card E4) - the three tools that move a
 * position between maturities or between position TYPES without ever leaving
 * Pendle:
 *
 *   - `pendle.pt.rollover` : PT(market A) → PT(market B), a maturity roll.
 *   - `pendle.lp.transfer` : LP(market A) → LP(market B), liquidity moved.
 *   - `pendle.lp.toPt`     : LP → the SAME market's PT, one shot.
 *
 * All three use the DRY-RUN-IN-TOOL prequote pattern the SY family introduced:
 * ONE toolId both quotes (on `dryRun: true`) and executes, so there is no
 * separate `*.quote` manifest. See `../handlers/reflect-prequote.ts`.
 *
 * NO `keepYt` PARAM on `pendle.lp.transfer`. The R5d card allowed one only if
 * the live captures showed a zero-price-impact keep-YT transfer variant; they do
 * not - `transfer-liquidity` probed as `[LP(mktA)] → [LP(mktB)]`, a single output
 * leg, on both the chain-1 and chain-143 captures - so the param is omitted
 * rather than accepted and ignored. `LpTransferMatchInput` records the same
 * finding on the identity side.
 *
 * MATURITY, stated in every description because a context-free agent cannot
 * infer it: the SOURCE of each action may be matured (you must be able to leave
 * an expired position), the DESTINATION may not (you cannot buy into one).
 */

import type { ProtocolToolManifest } from "../../types.js";
import { PENDLE_REFLECT_DISCOVERY } from "../../embeddings/pendle/reflect.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const CHAIN_PARAM = {
  key: "chain",
  type: "string" as const,
  required: true,
  description: "Chain slug or id - one of Pendle's 11 chains (e.g. 'ethereum', 'arbitrum', 'base', 'bsc'). Both legs are on ONE chain; none of these tools bridges.",
};

const SLIPPAGE_PARAM = {
  key: "slippageBps",
  type: "number" as const,
  unit: "bps" as const,
  description:
    `Slippage tolerance in whole basis points (default ${VEX_DEFAULT_SLIPPAGE_BPS} = ${VEX_DEFAULT_SLIPPAGE_BPS / 100}%; maximum 1000 = 10%). A fractional, negative or larger value is REJECTED, never clamped. The dry run and the execute must pass the SAME value (or omit it on both).`,
};

const DRY_RUN_PARAM = {
  key: "dryRun",
  type: "boolean" as const,
  description:
    "true = quote only. Prices the move, runs every fund-safety check including the per-leg price floor, records the authorization this tool needs, and broadcasts NOTHING. Required before the real call.",
};

const AMOUNT_PARAM = {
  key: "amountIn",
  type: "string" as const,
  required: true,
  description: "Amount of the SOURCE token in human-readable units (e.g. '1.5', not raw base units).",
};

export const PENDLE_REFLECT_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pendle.pt.rollover",
    publicName: "pendle__pt_rollover",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Roll a Pendle PT into a LATER-expiry PT of another market in ONE transaction - sell the PT you hold and buy the destination PT without ever holding the underlying. Needs: the chain, the PT address you hold (fromPt), the PT address you want (toPt), and amountIn in human-readable units. The SOURCE PT MAY BE MATURED (rolling out of an expired position is exactly what this is for); the DESTINATION PT MUST BE ACTIVE - a matured destination is refused by name, with its expiry date. Returns both expiries (fromExpiry / toExpiry) and, when Pendle reports them, impliedApyBeforePercent / impliedApyAfterPercent as PERCENT STRINGS (e.g. '4.21' = 4.21%), so you can see whether the roll improves the rate; amounts come back as raw/decimals/exact triplets. Approval-gated; pins the canonical Pendle Router and holds EVERY internal leg to its own minimum-output floor. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: roll across chains, roll a YT or an LP (pendle__lp_transfer moves LP), sell to a token (pendle__pt_sell), redeem a matured PT for its underlying (pendle__pt_redeem), guarantee an exact output amount, or send the destination PT anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      {
        key: "fromPt",
        type: "string",
        required: true,
        description: "The PT CONTRACT ADDRESS you currently hold (the source maturity). May belong to a MATURED market. Read it from pendle__market_get as the market's `pt` field.",
      },
      {
        key: "toPt",
        type: "string",
        required: true,
        description: "The PT CONTRACT ADDRESS to roll INTO (the destination maturity). Must belong to an ACTIVE market - find one with pendle__markets_discover.",
      },
      AMOUNT_PARAM,
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      fromPt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
      toPt: "0xa3e7ccf0d0fa014892372c0321731a1ed977068c",
      amountIn: "1",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      dryRun: true,
    },
    discovery: PENDLE_REFLECT_DISCOVERY["pendle.pt.rollover"],
  },
  {
    toolId: "pendle.lp.transfer",
    publicName: "pendle__lp_transfer",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Move Pendle liquidity from one market's LP straight into another market's LP in ONE transaction - no manual remove-then-add, no intermediate token in your wallet. Needs: the chain, the market you are leaving (fromMarket), the market you are entering (toMarket), and amountIn (the source LP amount) in human-readable units. A Pendle market address IS its LP token, so these are market addresses. The SOURCE market MAY BE MATURED (leaving an expired pool is legal); the DESTINATION market MUST BE ACTIVE - a matured destination is refused by name, with its expiry date. Returns both expiries and, when Pendle reports them, impliedApyBeforePercent / impliedApyAfterPercent as PERCENT STRINGS; amounts come back as raw/decimals/exact triplets. Approval-gated; pins the canonical Pendle Router and holds EVERY internal leg to its own minimum-output floor. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: transfer across chains, keep the YT (no keepYt variant is served), transfer a PT (pendle__pt_rollover), withdraw to a token (pendle__lp_remove), convert LP into PT (pendle__lp_to_pt), guarantee an exact output amount, or send the destination LP anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      {
        key: "fromMarket",
        type: "string",
        required: true,
        description: "The Pendle MARKET ADDRESS whose LP you hold (the market IS the LP token). May be MATURED.",
      },
      {
        key: "toMarket",
        type: "string",
        required: true,
        description: "The Pendle MARKET ADDRESS to move the liquidity into. Must be ACTIVE - find one with pendle__markets_discover.",
      },
      AMOUNT_PARAM,
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      fromMarket: "0x34280882267ffa6383b363e278b027be083bbe3b",
      toMarket: "0xba1cbaece600beec76dabc0a4ead31e0339cbe37",
      amountIn: "1",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      dryRun: true,
    },
    discovery: PENDLE_REFLECT_DISCOVERY["pendle.lp.transfer"],
  },
  {
    toolId: "pendle.lp.toPt",
    publicName: "pendle__lp_to_pt",
    namespace: "pendle",
    lifecycle: "active",
    description:
      "Convert a Pendle LP position into the SAME market's PT in one transaction - swap variable pool exposure for that market's fixed yield without withdrawing to a token first. Needs: the chain, the market address (the market IS the LP token), and amountIn (the LP amount) in human-readable units. SAME MARKET ONLY: the PT you receive is the market's own PT, so there is no underlying to choose. The optional `pt` param is a CHECK, not a destination - pass it and Vex verifies it is this market's PT, refusing by name (and saying so explicitly when the PT belongs to a different underlying asset) rather than silently converting into something else. The market MUST BE ACTIVE: acquiring a matured market's PT is refused by name, with its expiry date, because a matured LP should be withdrawn with pendle__lp_remove instead. Use this when the user holds an LP in a market and wants that market's fixed rate instead of its trading fees. The dry run RETURNS `dryRun`, `action`, `chainId`, `market`, `pt`, `expiry`, `impliedApyPercent`, `amountIn`, `quotedAmountOut`, `priceImpact`, `feeUsdEstimate`, `aggregator`, `slippageBps` and a `note`; the real run RETURNS `txHash`, `action`, `market`, `pt`, `expiry`, `impliedApyPercent`, `executedAmountIn`, `executedAmountOut` and `quotedAmountOut`. Amounts come back as raw/decimals/exact triplets and the market's implied APY as a PERCENT STRING. Approval-gated; pins the canonical Pendle Router and holds minPtOut to the floor this route's own quote implies. CALL IT TWICE: first with dryRun: true, which quotes and records the authorization; then with the EXACT same params to broadcast. Without that fresh dry run the execute is refused. CANNOT: convert into another market's PT (pendle__pt_rollover rolls PT→PT; pendle__lp_transfer moves LP→LP), convert into YT, withdraw to a token (pendle__lp_remove), guarantee an exact output amount, or send the PT anywhere but your own wallet.",
    mutating: true,
    actionKind: "user_wallet_broadcast",
    params: [
      CHAIN_PARAM,
      {
        key: "market",
        type: "string",
        required: true,
        description: "The Pendle MARKET ADDRESS whose LP you hold and whose PT you want (the market IS the LP token).",
      },
      {
        key: "pt",
        type: "string",
        description: "OPTIONAL check: the PT contract address you expect to receive. Must be this market's own PT - a PT from any other market is refused by name. Omit it and Vex uses the market's PT.",
      },
      AMOUNT_PARAM,
      SLIPPAGE_PARAM,
      DRY_RUN_PARAM,
    ],
    exampleParams: {
      chain: "ethereum",
      market: "0x34280882267ffa6383b363e278b027be083bbe3b",
      amountIn: "1",
      slippageBps: VEX_DEFAULT_SLIPPAGE_BPS,
      dryRun: true,
    },
    discovery: PENDLE_REFLECT_DISCOVERY["pendle.lp.toPt"],
  },
];
