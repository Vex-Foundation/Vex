/**
 * Anti-sniper tax window (contract-source-verified, types 0-5).
 *
 * WHAT THIS MODULE USED TO SAY, AND WHY IT WAS WRONG (PR-C1, 2026-09-04).
 * The previous version described the window as a POST-GRADUATION buy tax on the
 * Uniswap V2 pool, anchored on `lpCreatedAt`, applicable only to graduated
 * agents, and knew only types 0/1/2. Every one of those four statements is
 * contradicted by the contracts:
 *
 *   - `FRouterV3` is the BONDING-CURVE router. Its anti-sniper tax is charged
 *     inside `_calculateAntiSniperTaxForSide` on curve buys and sells
 *     (`FRouterV3.sol:294-355`), routed to `factory.antiSniperTaxVault()`
 *     (`:229-234`, `:178-182`). Nothing in it touches the graduated AMM pool.
 *   - The clock starts at the BONDING PAIR's trading start:
 *     `_getTaxStartTime(pair)` = `pair.taxStartTime()` when set, else
 *     `pair.startTime()` (`FRouterV3.sol:361-373`) - i.e. launch, not
 *     graduation. A 60 s or even a 5880 s window has always expired by the
 *     time an agent graduates, so anchoring on `lpCreatedAt` reported an
 *     ACTIVE window exactly when there is none and reported none while the
 *     curve was actually taxing.
 *   - There are SIX types, not three (`BondingConfig.sol:30-35`), and types
 *     3/4/5 exist on live rows.
 *
 * The measured arithmetic, transcribed from the source:
 *
 *   type 0 ANTI_SNIPER_NONE      duration 0 s      neither side
 *   type 1 ANTI_SNIPER_60S       duration 60 s     buy only   (launch default)
 *   type 2 ANTI_SNIPER_98M       duration 5880 s   buy only
 *   type 3 ANTI_SNIPER_98M_SELL  duration 5880 s   sell only
 *   type 4 ANTI_SNIPER_98M_BOTH  duration 5880 s   buy AND sell
 *   type 5 ANTI_SNIPER_10M       duration 600 s    buy only
 *
 * (`BondingConfig.getAntiSniperDuration` :412-429,
 *  `appliesAntiSniperOnBuy` :386-394, `appliesAntiSniperOnSell` :399-405.)
 *
 * Tax on a side that applies, while `elapsed < duration`:
 *
 *   antiSniperTax = floor(startTax * (duration - elapsed) / duration)
 *
 * with `startTax = factory.antiSniperBuyTaxStartValue()` = 99 percent
 * (`FRouterV3.sol:318`, `:352`), integer division, and 0 once
 * `elapsed >= duration` (`:347-349`). The flat protocol tax
 * (`FFactoryV2.buyTax` / `.sellTax`, measured 1 percent on both chains) rides
 * on top, and the router clamps the pair so it can never exceed 99 percent:
 * `if (normalTax + antiSniperTax > 99) antiSniperTax = 99 - normalTax`
 * (`FRouterV3.sol:161-163` sell, `:211-213` buy).
 *
 * TIER A ESTIMATE, NOT AN ORACLE. This module reads the API row only: the
 * type from `launchInfo.antiSniperTaxType` and the clock from `launchedAt`
 * (falling back to `createdAt`). The contract's authority is the PAIR's
 * `taxStartTime`/`startTime`, which only an on-chain read can give, and a
 * scheduled launch can move them apart. Every field below is therefore an
 * ESTIMATE labelled as one; the trade lane (PR-C2) re-reads the pair before
 * signing and that read, never this one, is the money authority.
 */

/** The six contract types, with duration and the sides each one taxes. */
interface AntiSniperTypeSpec {
  readonly durationSeconds: number;
  readonly appliesOnBuy: boolean;
  readonly appliesOnSell: boolean;
  /** The contract's own constant name, echoed so the model can cite it. */
  readonly name: string;
}

export const ANTI_SNIPER_TYPES: Readonly<Record<number, AntiSniperTypeSpec>> = {
  0: { durationSeconds: 0, appliesOnBuy: false, appliesOnSell: false, name: "ANTI_SNIPER_NONE" },
  1: { durationSeconds: 60, appliesOnBuy: true, appliesOnSell: false, name: "ANTI_SNIPER_60S" },
  2: { durationSeconds: 5880, appliesOnBuy: true, appliesOnSell: false, name: "ANTI_SNIPER_98M" },
  3: { durationSeconds: 5880, appliesOnBuy: false, appliesOnSell: true, name: "ANTI_SNIPER_98M_SELL" },
  4: { durationSeconds: 5880, appliesOnBuy: true, appliesOnSell: true, name: "ANTI_SNIPER_98M_BOTH" },
  5: { durationSeconds: 600, appliesOnBuy: true, appliesOnSell: false, name: "ANTI_SNIPER_10M" },
};

/** `factory.antiSniperBuyTaxStartValue()` - 99 percent at the window's start. */
export const ANTI_SNIPER_START_TAX_PCT = 99;

/** `FFactoryV2.buyTax` / `.sellTax`, measured 1 on Base and Robinhood. */
export const FLAT_CURVE_TAX_PCT = 1;

/** The router's clamp: the two taxes together can never exceed 99 percent. */
const MAX_COMBINED_TAX_PCT = 99;

export interface AntiSniperSide {
  /** True when this type taxes this side at all. */
  readonly applies: boolean;
  /** Estimated anti-sniper component right now, integer percent (contract floors). */
  readonly antiSniperTaxPct: number;
  /** Flat protocol tax component, integer percent. */
  readonly flatTaxPct: number;
  /** The two together after the router's 99 percent clamp. */
  readonly totalTaxPct: number;
}

export interface AntiSniperStatus {
  /** The reported `launchInfo.antiSniperTaxType`, or null when absent/unknown. */
  readonly type: number | null;
  /** The contract constant name for `type`, or null when the type is unknown. */
  readonly typeName: string | null;
  /**
   * True when the tax can be computed: a KNOWN type, a usable clock, and the
   * agent still on the bonding curve. Graduated agents trade on the AMM pool,
   * which FRouterV3 does not tax at all.
   */
  readonly applicable: boolean;
  /** True while `elapsed < duration` on a side that this type taxes. */
  readonly windowActive: boolean;
  readonly durationSeconds: number;
  /** Seconds until the window ends; 0 when inactive or not applicable. */
  readonly remainingSeconds: number;
  readonly buy: AntiSniperSide;
  readonly sell: AntiSniperSide;
  /**
   * Why the estimate is not authoritative, or why it could not be produced.
   * Always present so the model never reads a bare number as a fact.
   */
  readonly note: string;
}

const ESTIMATE_NOTE =
  "ESTIMATE from the API row: the type comes from launchInfo.antiSniperTaxType and the clock from "
  + "launchedAt. The contract anchors the window on the bonding pair's taxStartTime/startTime, which "
  + "only an on-chain read gives and which a scheduled launch can move. Re-read on chain before trading.";

const NOT_ON_CURVE_NOTE =
  "Not applicable: the anti-sniper tax is charged by FRouterV3 on BONDING-CURVE trades only. This agent "
  + "has graduated, so its trades go through the AMM pool, which FRouterV3 does not tax.";

const UNKNOWN_TYPE_NOTE =
  "Unknown or absent launchInfo.antiSniperTaxType, so the tax is UNKNOWN - not zero. Treat a curve trade "
  + "as potentially taxed up to 99 percent until an on-chain read says otherwise.";

const NO_CLOCK_NOTE =
  "No usable launch time on the row (launchedAt and createdAt are both absent or unparseable), so the "
  + "window position is UNKNOWN - not expired.";

function inertSide(): AntiSniperSide {
  return { applies: false, antiSniperTaxPct: 0, flatTaxPct: FLAT_CURVE_TAX_PCT, totalTaxPct: FLAT_CURVE_TAX_PCT };
}

function unknown(type: number | null, typeName: string | null, note: string, durationSeconds = 0): AntiSniperStatus {
  return {
    type,
    typeName,
    applicable: false,
    windowActive: false,
    durationSeconds,
    remainingSeconds: 0,
    buy: inertSide(),
    sell: inertSide(),
    note,
  };
}

/**
 * `floor(startTax * (duration - elapsed) / duration)`, then the router's clamp
 * against the flat tax. Mirrors `FRouterV3._calculateAntiSniperTaxForSide` plus
 * the `normalTax + antiSniperTax > 99` guard at the two call sites.
 */
function sideFor(
  applies: boolean,
  durationSeconds: number,
  elapsedSeconds: number,
): AntiSniperSide {
  if (!applies || durationSeconds <= 0 || elapsedSeconds >= durationSeconds) {
    return inertSide();
  }
  const raw = Math.floor(
    (ANTI_SNIPER_START_TAX_PCT * (durationSeconds - elapsedSeconds)) / durationSeconds,
  );
  const clamped = Math.min(raw, MAX_COMBINED_TAX_PCT - FLAT_CURVE_TAX_PCT);
  return {
    applies: true,
    antiSniperTaxPct: clamped,
    flatTaxPct: FLAT_CURVE_TAX_PCT,
    totalTaxPct: clamped + FLAT_CURVE_TAX_PCT,
  };
}

export interface AntiSniperInput {
  /** `launchInfo.antiSniperTaxType`. */
  readonly antiSniperTaxType: number | null | undefined;
  /** `launchedAt` (preferred) or `createdAt`, ISO. The curve clock. */
  readonly launchedAtIso: string | null | undefined;
  /** True when the agent has left the curve (status AVAILABLE / lpAddress set). */
  readonly graduated: boolean;
  readonly nowMs?: number;
}

/**
 * Estimate the anti-sniper window for one agent, per side.
 *
 * Refuses to guess: an unknown type, a missing clock, or a graduated agent each
 * produce `applicable: false` with the reason in `note`, never a "0 percent,
 * safe to buy" answer.
 */
export function computeAntiSniper(input: AntiSniperInput): AntiSniperStatus {
  const nowMs = input.nowMs ?? Date.now();
  const rawType = input.antiSniperTaxType;
  const spec = typeof rawType === "number" && Number.isInteger(rawType)
    ? ANTI_SNIPER_TYPES[rawType]
    : undefined;
  const type = spec === undefined ? null : rawType as number;
  const typeName = spec?.name ?? null;

  if (spec === undefined) return unknown(type, typeName, UNKNOWN_TYPE_NOTE);
  if (input.graduated) return unknown(type, typeName, NOT_ON_CURVE_NOTE, spec.durationSeconds);

  const startMs = input.launchedAtIso ? Date.parse(input.launchedAtIso) : Number.NaN;
  if (!Number.isFinite(startMs)) {
    return unknown(type, typeName, NO_CLOCK_NOTE, spec.durationSeconds);
  }

  const elapsedSeconds = Math.max(0, (nowMs - startMs) / 1000);
  const buy = sideFor(spec.appliesOnBuy, spec.durationSeconds, elapsedSeconds);
  const sell = sideFor(spec.appliesOnSell, spec.durationSeconds, elapsedSeconds);
  const windowActive = buy.applies || sell.applies;
  return {
    type,
    typeName,
    applicable: true,
    windowActive,
    durationSeconds: spec.durationSeconds,
    remainingSeconds: windowActive ? Math.ceil(spec.durationSeconds - elapsedSeconds) : 0,
    buy,
    sell,
    note: ESTIMATE_NOTE,
  };
}
