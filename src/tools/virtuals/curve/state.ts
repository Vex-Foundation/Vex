/**
 * The AUTHORITATIVE curve state, read on chain at ONE pinned block.
 *
 * ## Why one block
 *
 * Every figure the approval shows and every figure a signature is held to comes
 * from this read. Taking them across several blocks would let the tax the user
 * was shown belong to a different block than the quote it was applied to, which
 * is a disclosure nobody can reconcile afterwards. So the block is pinned first
 * and every subsequent call names it.
 *
 * ## What is authority and what is not
 *
 * The API row (`virtuals__agent_get`) is DISCOVERY ONLY. The chain decides:
 * `BondingV5.tokenInfo(token)` says whether the agent still trades on the curve,
 * `FFactoryV2` says what the taxes are, and the PAIR's own `taxStartTime` /
 * `startTime` is the anti-sniper clock - never `launchedAt` from the API, which
 * a scheduled launch can move apart from the contract's clock.
 *
 * ## Tolerance policy
 *
 * A read that fails is UNKNOWN, and unknown fails closed on the money path: an
 * unreadable tax cannot price a floor, so the trade is refused by name rather
 * than quoted at a guessed zero. The one exception is `pair.taxStartTime()`,
 * which old pairs do not implement at all - the contract itself catches that and
 * falls back to `startTime()` (`FRouterV3._getTaxStartTime`), so this module
 * mirrors that fallback rather than treating it as a failure.
 */

import { getAddress, type Address, type PublicClient, type Chain, type Transport } from "viem";

import {
  BONDING_CONFIG_ABI,
  BONDING_V5_ABI,
  BONDING_V5_TOKEN_INFO_ABI,
  CURVE_ERC20_ABI,
  FFACTORY_V2_ABI,
  FPAIR_V2_ABI,
  FROUTER_V3_ABI,
} from "./abi.js";
import type { VirtualsCurveDeployment } from "./deployments.js";
import { rawAntiSniperPctAt } from "./quote-math.js";
import { checkPinnedImplementations, type ProxyIdentity } from "./proxy-identity.js";

const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export type CurveTradeSide = "buy" | "sell";

/** Where a chain read left the lane when it could not answer. */
export interface CurveStateRefusal {
  readonly ok: false;
  /** Bounded, log-safe class. Never provider text. */
  readonly code:
    | "implementation_moved"
    | "not_a_curve_token"
    | "graduated"
    | "not_trading"
    | "tax_unreadable"
    | "anti_sniper_unreadable"
    | "pair_unreadable"
    | "quote_unreadable";
  /** Agent-facing sentence. Says what is unknown, never a guessed value. */
  readonly reason: string;
  /**
   * The AMM the agent moved to, when it graduated. Present only on the
   * `graduated` code, so the caller can hand off by name.
   */
  readonly graduatedPair?: Address;
}

/** The anti-sniper facts as the CONTRACT states them, per side. */
export interface CurveAntiSniperState {
  /** `BondingV5.tokenAntiSniperType(token)`. */
  readonly type: number;
  /** `BondingConfig.getAntiSniperDuration(type)`, seconds. */
  readonly durationSeconds: number;
  readonly appliesOnBuy: boolean;
  readonly appliesOnSell: boolean;
  /** `FFactoryV2.antiSniperBuyTaxStartValue()`, integer percent. */
  readonly startTaxPct: number;
  /** `pair.taxStartTime()` when non-zero, else `pair.startTime()`. Unix seconds. */
  readonly taxStartTimeSeconds: number;
  /** Whether `taxStartTime` was set, or the clock fell back to `startTime`. */
  readonly clockSource: "taxStartTime" | "startTime";
  /** Raw percent right now on each side, before the router's 99 percent clamp. */
  readonly rawBuyPct: number;
  readonly rawSellPct: number;
  /** Seconds left in the window on the side that is taxed, else 0. */
  readonly remainingSeconds: number;
  /** `FRouterV3.hasAntiSniperTax(pair)` - the contract's own either-side flag. */
  readonly activeOnChain: boolean;
}

/** Everything the quote and the pre-sign revalidation read, at one block. */
export interface CurveState {
  readonly ok: true;
  readonly blockNumber: bigint;
  /** The block's own timestamp - the clock the anti-sniper decay is evaluated at. */
  readonly blockTimestampSeconds: number;
  readonly implementations: ProxyIdentity;
  readonly token: Address;
  readonly tokenSymbol: string;
  readonly tokenDecimals: number;
  /** `tokenInfo(token).data.name` - the agent's display name, not its ticker. */
  readonly tokenName: string;
  readonly pair: Address;
  readonly creator: Address;
  readonly virtualId: string;
  /** Integer percent, from `FFactoryV2`. */
  readonly buyTaxPct: number;
  readonly sellTaxPct: number;
  readonly antiSniper: CurveAntiSniperState;
  /** `allowance(wallet, FRouterV3)` for the token the side spends. */
  readonly allowanceRaw: bigint;
  /** The wallet's balance of the token the side spends. */
  readonly spendBalanceRaw: bigint;
  /** The wallet's native balance, for the gas honesty line. */
  readonly nativeBalanceRaw: bigint;
}

export type CurveStateResult = CurveState | CurveStateRefusal;

export interface CurveStateClient extends PublicClient<Transport, Chain> {}

/**
 * Read the whole authority table for one (chain, token, side, wallet) at one
 * block.
 *
 * `atBlock` lets the EXECUTE re-read at the head while the quote's own block is
 * still recorded, and lets a test pin a block. Omitted, the current head is
 * pinned first and everything else is read at it.
 */
export async function readCurveState(input: {
  readonly client: CurveStateClient;
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly side: CurveTradeSide;
  readonly wallet: Address;
  readonly atBlock?: bigint;
}): Promise<CurveStateResult> {
  const { client, deployment } = input;
  const token = getAddress(input.token);

  const identity = await checkPinnedImplementations(client, deployment);
  if (!identity.ok) {
    return { ok: false, code: "implementation_moved", reason: identity.reason };
  }

  const blockNumber = input.atBlock ?? (await client.getBlockNumber());
  const block = await client.getBlock({ blockNumber });
  const blockTimestampSeconds = Number(block.timestamp);
  const at = { blockNumber } as const;

  const info = await client.readContract({
    address: deployment.bondingV5,
    abi: BONDING_V5_TOKEN_INFO_ABI,
    functionName: "tokenInfo",
    args: [token],
    ...at,
  });
  const creator = getAddress(info[0]);
  const pair = getAddress(info[2]);
  // Index order is the auto-getter's, proven by decoding a live response
  // (`./abi.ts`): 0 creator, 2 pair, 4 data, 11 trading, 12 tradingOnUniswap,
  // 15 virtualId, 16 launchExecuted. `cores` is absent, which is what shifts
  // everything after `data` and is exactly why the shape was measured.
  const trading = info[11];
  const tradingOnUniswap = info[12];
  const virtualId = info[15].toString();
  const launchExecuted = info[16];
  // `data.name` is the agent's DISPLAY name ("Cult OS by Virtuals"), which is
  // what an approval card should show beside the symbol; `data.ticker` duplicates
  // the ERC-20 `symbol()` read below, so binding the name to it would show the
  // symbol twice and never show the name at all. Both members were decoded from
  // a live `tokenInfo` response on Base and Robinhood on 2026-09-04.
  const tokenName = info[4].name;

  // NOT A CURVE TOKEN AT ALL. `tokenInfo` returns a zeroed struct for an address
  // BondingV5 never launched, so the pair is the zero address and there is no
  // curve to trade - a different fact from a graduated one, and named as such.
  if (pair === ZERO_ADDRESS || !launchExecuted) {
    return {
      ok: false,
      code: "not_a_curve_token",
      reason:
        `${token} is not a launched Virtuals bonding-curve token on ${deployment.name}: BondingV5 holds no executed launch for it.`,
    };
  }
  if (tradingOnUniswap) {
    return {
      ok: false,
      code: "graduated",
      graduatedPair: pair,
      reason: `This agent has graduated: its trading moved off the bonding curve to an AMM pool on ${deployment.name}.`,
    };
  }
  if (!trading) {
    return {
      ok: false,
      code: "not_trading",
      reason: `BondingV5 reports trading disabled for ${token} on ${deployment.name}, so the curve would revert this trade.`,
    };
  }

  const taxes = await readTaxes(client, deployment, at);
  if (taxes === null) {
    return {
      ok: false,
      code: "tax_unreadable",
      reason:
        `The curve's protocol tax could not be read from FFactoryV2 on ${deployment.name}. An unknown tax cannot price a floor, so nothing was quoted.`,
    };
  }

  const antiSniper = await readAntiSniper({ client, deployment, token, pair, at, nowSeconds: blockTimestampSeconds });
  if (antiSniper === null) {
    return {
      ok: false,
      code: "anti_sniper_unreadable",
      reason:
        `The anti-sniper window could not be read on ${deployment.name} (type, duration or the pair's tax clock). It is UNKNOWN, not zero, so nothing was quoted.`,
    };
  }

  const spendToken = input.side === "buy" ? deployment.virtual : token;
  const [tokenDecimals, tokenSymbol, allowanceRaw, spendBalanceRaw, nativeBalanceRaw] = await Promise.all([
    client.readContract({ address: token, abi: CURVE_ERC20_ABI, functionName: "decimals", ...at }),
    client.readContract({ address: token, abi: CURVE_ERC20_ABI, functionName: "symbol", ...at }),
    client.readContract({
      address: spendToken, abi: CURVE_ERC20_ABI, functionName: "allowance",
      args: [input.wallet, deployment.frouterV3], ...at,
    }),
    client.readContract({
      address: spendToken, abi: CURVE_ERC20_ABI, functionName: "balanceOf", args: [input.wallet], ...at,
    }),
    client.getBalance({ address: input.wallet, blockNumber }),
  ]);

  return {
    ok: true,
    blockNumber,
    blockTimestampSeconds,
    implementations: identity.observed,
    token,
    tokenSymbol,
    tokenDecimals: Number(tokenDecimals),
    tokenName,
    pair,
    creator,
    virtualId,
    buyTaxPct: taxes.buyTaxPct,
    sellTaxPct: taxes.sellTaxPct,
    antiSniper,
    allowanceRaw,
    spendBalanceRaw,
    nativeBalanceRaw,
  };
}

/** The router's own quote for a side, at the same pinned block. */
export async function readCurveQuote(input: {
  readonly client: CurveStateClient;
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly side: CurveTradeSide;
  /** BUY: the TAXED input. SELL: the agent tokens sold. */
  readonly amountRaw: bigint;
  readonly blockNumber: bigint;
}): Promise<bigint | null> {
  // `getAmountsOut(token, assetToken, amountIn)` prices a BUY (VIRTUAL in) and
  // `getAmountsOut(token, address(0), amountIn)` a SELL - the router branches on
  // the second argument, and the zero address is its sell sentinel.
  const quoteAsset = input.side === "buy" ? input.deployment.virtual : ZERO_ADDRESS;
  try {
    return await input.client.readContract({
      address: input.deployment.frouterV3,
      abi: FROUTER_V3_ABI,
      functionName: "getAmountsOut",
      args: [input.token, quoteAsset, input.amountRaw],
      blockNumber: input.blockNumber,
    });
  } catch {
    return null;
  }
}

async function readTaxes(
  client: CurveStateClient,
  deployment: VirtualsCurveDeployment,
  at: { readonly blockNumber: bigint },
): Promise<{ readonly buyTaxPct: number; readonly sellTaxPct: number } | null> {
  try {
    const [buyTax, sellTax] = await Promise.all([
      client.readContract({ address: deployment.ffactoryV2, abi: FFACTORY_V2_ABI, functionName: "buyTax", ...at }),
      client.readContract({ address: deployment.ffactoryV2, abi: FFACTORY_V2_ABI, functionName: "sellTax", ...at }),
    ]);
    const buyTaxPct = Number(buyTax);
    const sellTaxPct = Number(sellTax);
    if (!Number.isSafeInteger(buyTaxPct) || !Number.isSafeInteger(sellTaxPct)) return null;
    return { buyTaxPct, sellTaxPct };
  } catch {
    return null;
  }
}

async function readAntiSniper(input: {
  readonly client: CurveStateClient;
  readonly deployment: VirtualsCurveDeployment;
  readonly token: Address;
  readonly pair: Address;
  readonly at: { readonly blockNumber: bigint };
  readonly nowSeconds: number;
}): Promise<CurveAntiSniperState | null> {
  const { client, deployment, at } = input;
  try {
    const type = Number(
      await client.readContract({
        address: deployment.bondingV5, abi: BONDING_V5_ABI,
        functionName: "tokenAntiSniperType", args: [input.token], ...at,
      }),
    );
    const [durationRaw, appliesOnBuy, appliesOnSell, startTaxRaw, startTimeRaw, activeOnChain] = await Promise.all([
      client.readContract({ address: deployment.bondingConfig, abi: BONDING_CONFIG_ABI, functionName: "getAntiSniperDuration", args: [type], ...at }),
      client.readContract({ address: deployment.bondingConfig, abi: BONDING_CONFIG_ABI, functionName: "appliesAntiSniperOnBuy", args: [type], ...at }),
      client.readContract({ address: deployment.bondingConfig, abi: BONDING_CONFIG_ABI, functionName: "appliesAntiSniperOnSell", args: [type], ...at }),
      client.readContract({ address: deployment.ffactoryV2, abi: FFACTORY_V2_ABI, functionName: "antiSniperBuyTaxStartValue", ...at }),
      client.readContract({ address: input.pair, abi: FPAIR_V2_ABI, functionName: "startTime", ...at }),
      client.readContract({ address: deployment.frouterV3, abi: FROUTER_V3_ABI, functionName: "hasAntiSniperTax", args: [input.pair], ...at }),
    ]);

    // The contract's own backward-compatibility path: `taxStartTime` does not
    // exist on old pairs and is zero on pairs that never set it, and both cases
    // fall back to `startTime` (`FRouterV3._getTaxStartTime`).
    let taxStartTimeSeconds = Number(startTimeRaw);
    let clockSource: "taxStartTime" | "startTime" = "startTime";
    try {
      const taxStart = Number(
        await client.readContract({ address: input.pair, abi: FPAIR_V2_ABI, functionName: "taxStartTime", ...at }),
      );
      if (taxStart > 0) {
        taxStartTimeSeconds = taxStart;
        clockSource = "taxStartTime";
      }
    } catch {
      // Old pair contract with no `taxStartTime` - exactly the case the router
      // catches and answers with `startTime`. Not a failure.
    }

    const durationSeconds = Number(durationRaw);
    const startTaxPct = Number(startTaxRaw);
    if (![durationSeconds, startTaxPct, taxStartTimeSeconds, type].every(Number.isSafeInteger)) return null;

    const shared = { durationSeconds, taxStartTimeSeconds, startTaxPct, nowSeconds: input.nowSeconds };
    const rawBuyPct = rawAntiSniperPctAt({ ...shared, appliesOnThisSide: appliesOnBuy });
    const rawSellPct = rawAntiSniperPctAt({ ...shared, appliesOnThisSide: appliesOnSell });
    const elapsed = input.nowSeconds - taxStartTimeSeconds;
    const remainingSeconds = (appliesOnBuy || appliesOnSell) && durationSeconds > 0 && elapsed < durationSeconds
      ? durationSeconds - Math.max(0, elapsed)
      : 0;

    return {
      type, durationSeconds, appliesOnBuy, appliesOnSell, startTaxPct,
      taxStartTimeSeconds, clockSource, rawBuyPct, rawSellPct, remainingSeconds, activeOnChain,
    };
  } catch {
    return null;
  }
}
