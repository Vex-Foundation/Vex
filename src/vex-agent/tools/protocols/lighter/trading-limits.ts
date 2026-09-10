/**
 * `tradingLimits`: the block that tells the agent the two numbers the USER
 * owns on a Lighter account, and that it cannot change either one.
 *
 * The owner's instruction for this surface is MINIMAL. The agent must know
 * (a) the live numbers, (b) that it cannot change them, (c) where the user
 * changes them. Nothing more: no lecture about leverage, no advice.
 *
 * WHY IT RIDES THE ONBOARDING-STATUS READ AND NOT A PROMPT LAYER. The numbers
 * are per wallet and per account and they change whenever the user touches
 * Settings or Lighter's own UI, so a prompt layer would either go stale or cost
 * every turn. `lighter.account.onboarding.status` (and its two always-loaded
 * shortcuts) is the hot readiness read the agent already makes before trading,
 * it is read-only, and it carries provenance and a timestamp. The STATIC half of
 * the instruction - "call it, and do not try to change these" - is one clause in
 * the navigation `declaration.read`, which reaches both the in-app prompt and
 * the Studio AGENTS block from one owner.
 *
 * BOUNDEDNESS (rule 05). `perMarket` lists ONLY the markets this account has a
 * position row for. Robinhood Chain alone has 57 perpetual markets, and every
 * market without a row uses that market's own default, so listing them all would
 * spend the agent's context restating one fact 57 times. The markets left out
 * are summarised by their default and COUNTED in `omitted`, so the agent can
 * tell that rows exist which it is not seeing and can name the default without
 * another call. Nothing is silently dropped.
 *
 * SCALES. Three representations of one concept exist on the wire: the market's
 * 10000-scale integer, the REST position row's PERCENT STRING ("50.00", measured
 * live on RHC account 24226), and the trade endpoint's 10000-scale integer.
 * `margin-fraction.ts` is the ONLY parser of any of them. This module never
 * parses "50.00" itself.
 */

import {
  readLighterTradingLimits,
  type LighterTradingLimitsRow,
} from "@vex-agent/db/repos/lighter-trading-limits.js";
import type { LighterClient } from "@tools/lighter/client.js";
import logger from "@utils/logger.js";
import {
  initialMarginFractionToLeverageDisplay,
  marginModeFromWire,
  LIGHTER_MARGIN_FRACTION_TICK,
  type LighterMarginMode,
} from "@tools/lighter/margin-fraction.js";
import {
  LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE,
  resolveLighterInitialMarginFraction,
} from "@tools/lighter/capital-share.js";
import type {
  LighterAccount,
  LighterAccountPosition,
  LighterEnvironment,
  LighterMarketDetail,
} from "@tools/lighter/types.js";

/**
 * The ONE sentence appended to the onboarding-status `userGuidance`.
 *
 * The owner's instruction for this surface is minimal: the agent must know the
 * numbers exist, that it cannot change them, and where the user can. Anything
 * longer is a lecture that costs context on every readiness read.
 */
export const LIGHTER_TRADING_LIMITS_GUIDANCE =
  `Leverage per market and the agent's capital share are set by the user in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}; Vex exposes no tool to change them; read tradingLimits for the live values.`;

/**
 * How many markets this block will read detail for in one call.
 *
 * Detail is per market, so this bounds the provider fan-out on a hot readiness
 * read. An account with more position rows than this has the excess counted in
 * `omitted` rather than silently dropped.
 */
export const LIGHTER_TRADING_LIMITS_MARKET_DETAIL_MAX = 12;

/** One market this account actually has a position row for. */
export interface LighterTradingLimitsMarketLeverage {
  readonly marketId: number;
  readonly symbol: string;
  readonly current: {
    readonly initialMarginFraction: number;
    readonly leverageDisplay: string;
    readonly marginMode: LighterMarginMode | null;
    readonly source: "position_row";
  };
  readonly max: {
    readonly initialMarginFraction: number;
    readonly leverageDisplay: string;
  };
  readonly openPosition: { readonly size: string; readonly side: "long" | "short" | "flat" } | null;
  /** Present only when the provider's own row could not be read; the raw string is kept. */
  readonly unparsable?: { readonly rawInitialMarginFraction: string; readonly reason: string };
}

export interface LighterTradingLimitsBlock {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number | null;
  readonly agentCapitalSharePercent: number | null;
  readonly source: "user_settings";
  readonly changeableBy: "user_only";
  readonly howToChange: string;
  readonly capitalShareNote: string;
  readonly leverage: {
    readonly scale: number;
    readonly scaleNote: string;
    readonly perMarket: readonly LighterTradingLimitsMarketLeverage[];
    readonly omitted: { readonly count: number; readonly reason: string };
    readonly note: string;
  };
  readonly unresolvedChangeGuidance: string;
}

export interface ResolveLighterTradingLimitsInput {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  /** The COMPLETE account read (`activeOnly: false`), or `null` when none exists yet. */
  readonly account: LighterAccount | null;
  /**
   * Market DETAIL for the markets this account has a position row on, and only
   * those.
   *
   * Margin fractions live ONLY on `orderBookDetails`, which the client reads one
   * market at a time (measured live 2026-09-10: `/orderBooks` returns 84 rows
   * and not one margin field). Fetching detail for every market to describe the
   * ones the account has never traded would cost dozens of provider calls on a
   * hot readiness read to restate each market's own default, so the untouched
   * markets are COUNTED instead and the agent is pointed at the per-market read.
   */
  readonly marketDetails: readonly LighterMarketDetail[];
  /** How many perpetual markets the environment has, for the omitted count. */
  readonly perpMarketCount: number;
  readonly limits: LighterTradingLimitsRow | null;
}

/**
 * Project the user's limits and the account's live leverage into the block the
 * agent reads.
 *
 * NEVER THROWS. This rides a readiness read that must keep working when a market
 * row is malformed or a market has no margin metadata; a projection that threw
 * would take the whole onboarding answer down over one bad row. An unreadable
 * row is reported as unreadable, with its raw value kept, and is counted.
 */
export function resolveLighterTradingLimits(
  input: ResolveLighterTradingLimitsInput,
): LighterTradingLimitsBlock {
  const marketsById = new Map<number, LighterMarketDetail>(
    input.marketDetails
      .filter((market) => market.market_type !== "spot")
      .map((market) => [market.market_id, market]),
  );
  const positions = Array.isArray(input.account?.positions) ? input.account.positions : [];

  const perMarket: LighterTradingLimitsMarketLeverage[] = [];
  for (const position of positions) {
    const market = marketsById.get(position.market_id);
    if (market === undefined) continue;
    const projected = projectPositionLeverage(position, market);
    if (projected !== null) perMarket.push(projected);
  }
  perMarket.sort((left, right) => left.marketId - right.marketId);

  const omittedCount = Math.max(0, input.perpMarketCount - perMarket.length);
  const sharePercent = input.limits?.agentCapitalSharePercent ?? null;

  return {
    environment: input.environment,
    walletAddress: input.walletAddress,
    accountIndex: readAccountIndex(input.account),
    agentCapitalSharePercent: sharePercent,
    source: "user_settings",
    changeableBy: "user_only",
    howToChange: LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE,
    capitalShareNote: sharePercent === null
      ? `The user has not set a capital share for this wallet, so no Vex ceiling limits how much of this account's collateral an approved order may commit. The user sets one in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}.`
      : `Approved Lighter orders on this account may commit at most ${sharePercent}% of its collateral. Vex refuses an order that would exceed it rather than resizing it.`,
    leverage: {
      scale: LIGHTER_MARGIN_FRACTION_TICK,
      scaleNote: `Initial margin fractions are provider integers on a ${LIGHTER_MARGIN_FRACTION_TICK} scale: 5000 is 50 percent, which is 2.00x leverage.`,
      perMarket,
      omitted: {
        count: omittedCount,
        reason: omittedCount === 0
          ? "Every perpetual market on this environment has a position row above."
          : `${omittedCount} perpetual market${omittedCount === 1 ? "" : "s"} on this environment have no position row on this account. Each of those uses its OWN market default, which differs between Core and Robinhood Chain, so read one with lighter__market_get and use margin.defaultLeverage rather than assuming a number.`,
      },
      note:
        "Per-market leverage is an account setting on Lighter. Vex exposes no tool that changes it; the user changes it in "
        + `${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}.`,
    },
    unresolvedChangeGuidance:
      "If a leverage change the user made is not reflected here, tell them to open Settings -> Lighter -> Reconcile; do not retry or re-apply it from a tool.",
  };
}

/**
 * Read the live evidence the block needs and project it.
 *
 * This is the IO half of the module, kept here rather than in
 * `handlers/read.ts` so that file (1564 lines) does not grow and so the reads
 * this block depends on have ONE owner. It NEVER throws and never fails the
 * readiness answer it rides: a `tradingLimits` block that could not be built
 * says so, because "we could not read your limits" is a fact the agent must be
 * able to relay, while a thrown error would take the whole onboarding answer
 * with it.
 *
 * @param accountIndex `null` before the wallet has a Lighter account; the block
 *   still reports the capital share, which the user can set beforehand.
 */
export async function readLighterOnboardingTradingLimits(input: {
  readonly client: Pick<LighterClient, "getAccount" | "getMarketDetails" | "getMarkets">;
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly accountIndex: number | null;
}): Promise<LighterTradingLimitsBlock | { readonly unavailable: string }> {
  try {
    const [account, markets, limits] = await Promise.all([
      input.accountIndex === null
        ? Promise.resolve(null)
        : input.client
            .getAccount(input.environment, {
              by: "index",
              value: input.accountIndex,
              // `false`: a market the account has leverage settings for but no
              // OPEN POSITION on is hidden by `activeOnly: true`, and that row
              // is precisely the one this block exists to report.
              activeOnly: false,
            })
            .then((response) => response.accounts[0] ?? null),
      input.client.getMarkets(input.environment, { filter: "all" }),
      readLighterTradingLimits(input.environment, input.walletAddress.toLowerCase()),
    ]);
    const perpMarketCount = markets.order_books.filter(
      (market) => market.market_type !== "spot",
    ).length;
    // ONE detail read per market the account actually holds a row for, capped.
    // Detail is the only endpoint carrying margin fractions and it serves one
    // market per call, so an uncapped fan-out here would put an unbounded number
    // of provider calls on a hot readiness read.
    const positionMarketIds = [
      ...new Set(
        (Array.isArray(account?.positions) ? account.positions : [])
          .map((position) => position.market_id)
          .filter((marketId): marketId is number => typeof marketId === "number"),
      ),
    ].slice(0, LIGHTER_TRADING_LIMITS_MARKET_DETAIL_MAX);
    const details = await Promise.all(
      positionMarketIds.map(async (marketId) => {
        const response = await input.client.getMarketDetails(input.environment, {
          marketId,
          filter: "all",
        });
        return response.order_book_details.find((detail) => detail.market_id === marketId) ?? null;
      }),
    );
    return resolveLighterTradingLimits({
      environment: input.environment,
      walletAddress: input.walletAddress,
      account,
      marketDetails: details.filter((detail): detail is LighterMarketDetail => detail !== null),
      perpMarketCount,
      limits,
    });
  } catch (error) {
    logger.warn("lighter.trading_limits.unavailable", {
      error: error instanceof Error ? error.message : String(error),
      environment: input.environment,
      accountIndex: input.accountIndex,
    });
    return {
      unavailable:
        `Vex could not read this wallet's Lighter trading limits right now. The user sets the agent's capital share and per-market leverage in ${LIGHTER_CAPITAL_SHARE_HOW_TO_CHANGE}; Vex exposes no tool to change them.`,
    };
  }
}

function projectPositionLeverage(
  position: LighterAccountPosition,
  market: LighterMarketDetail,
): LighterTradingLimitsMarketLeverage | null {
  const min = market.min_initial_margin_fraction;
  if (!Number.isInteger(min) || (min as number) <= 0) return null;
  const max = {
    initialMarginFraction: min as number,
    leverageDisplay: safeLeverageDisplay(min as number) ?? "unknown",
  };
  const openPosition = readOpenPosition(position);

  let current: LighterTradingLimitsMarketLeverage["current"];
  try {
    const resolved = resolveLighterInitialMarginFraction({ positionRow: position, market });
    current = {
      initialMarginFraction: resolved.initialMarginFraction,
      leverageDisplay: safeLeverageDisplay(resolved.initialMarginFraction) ?? "unknown",
      marginMode: safeMarginMode(position.margin_mode),
      source: "position_row",
    };
  } catch (error) {
    // The raw provider string is KEPT, never dropped: an agent that can see the
    // value it could not interpret can still show it to the user.
    return {
      marketId: market.market_id,
      symbol: market.symbol,
      current: {
        initialMarginFraction: -1,
        leverageDisplay: "unknown",
        marginMode: safeMarginMode(position.margin_mode),
        source: "position_row",
      },
      max,
      openPosition,
      unparsable: {
        rawInitialMarginFraction: String(position.initial_margin_fraction),
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    marketId: market.market_id,
    symbol: market.symbol,
    current,
    max,
    openPosition,
  };
}

function readOpenPosition(
  position: LighterAccountPosition,
): { readonly size: string; readonly side: "long" | "short" | "flat" } | null {
  const size = typeof position.position === "string" ? position.position : null;
  if (size === null) return null;
  const sign = typeof position.sign === "number" ? position.sign : null;
  const zero = /^-?0*(\.0*)?$/.test(size.trim());
  return {
    size,
    side: zero || sign === 0 ? "flat" : sign === null ? "flat" : sign > 0 ? "long" : "short",
  };
}

/**
 * The converter refuses values it cannot represent. Here that must degrade to
 * "unknown" rather than throw, for the same reason the projection never throws.
 */
function safeLeverageDisplay(initialMarginFraction: number): string | null {
  try {
    return initialMarginFractionToLeverageDisplay(initialMarginFraction);
  } catch {
    return null;
  }
}

function safeMarginMode(value: unknown): LighterMarginMode | null {
  if (typeof value !== "number") return null;
  try {
    return marginModeFromWire(value);
  } catch {
    return null;
  }
}

function readAccountIndex(account: LighterAccount | null): number | null {
  if (account === null) return null;
  const index = account.index ?? account.account_index ?? null;
  return typeof index === "number" ? index : null;
}
