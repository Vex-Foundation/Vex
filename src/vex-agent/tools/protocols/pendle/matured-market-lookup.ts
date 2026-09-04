/**
 * The MATURED-CAPABLE financial resolver - `market-lookup.ts`'s deliberate,
 * separately-named counterpart (R5b, G-02 / D18).
 *
 * WHO MAY IMPORT THIS. Exactly three actions, because exactly three actions can
 * legitimately act on a market that has already expired:
 *   - `pendle.pt.redeem` (quote, prequote identity, execute) - the core
 *     fixed-yield product case, and the whole reason this module exists: a
 *     matured PT used to resolve to nothing, so the position the redeem tool was
 *     built for was unreachable by that tool;
 *   - `pendle.lp.remove` (quote, identity, execute) - Pendle documents remove as
 *     "callable regardless of the market's expiry";
 *   - `pendle.claim` target selection - accrued income does not stop being the
 *     user's because the market expired.
 *
 * EVERY OTHER ACTION KEEPS `market-lookup.ts`. A buy, a mint, an add, and both
 * sell-shaped exits (`pt.sell`, `py.redeem`) resolve ACTIVE-ONLY; when their
 * lookup comes back empty they name the reason through `matured-refusal.ts`,
 * which reads the READ-ONLY classification lane and returns TEXT. That split is
 * the point: a refusal-only action gets no matured financial resolution at all,
 * so there is no object in scope it could accidentally trade on.
 *
 * WHY A SEPARATE MODULE RATHER THAN A FLAG ON THE FROZEN ONE. `market-lookup.ts`
 * is the single lookup for every mutating handler; teaching it a `includeMatured`
 * parameter would put the safety of ten call sites on remembering to pass
 * `false`. Here the default is the safe one by construction - a handler has to
 * import a module whose name says what it does.
 *
 * THE INACTIVE-ROW RULE. "Inactive" is the provider's bookkeeping label;
 * "matured" is an on-chain fact. An inactive row is believed ONLY when it
 * carries a parseable `expiry` at or before the injected clock. Missing,
 * unparseable, or still-future expiry is REFUSED BY NAME - the future-expiry
 * case is the dangerous one, because trusting the label there would redeem
 * against a market that is still live.
 */

import { getPendleClient } from "@tools/pendle/client.js";
import type { PendleMarket } from "@tools/pendle/types.js";

import { VexError, ErrorCodes } from "../../../../errors.js";
import { classifyPendleExpiry } from "./market-maturity.js";

export type PendleMarketMaturity = "active" | "matured";

export interface PendleExitMarket {
  readonly market: PendleMarket;
  /**
   * Where the row came from, already validated. `matured` means the row was in
   * the inactive catalogue AND its expiry proved it - callers branch on THIS,
   * never on the presence of the row (G-02: "callers branching on `matured`
   * rather than on presence").
   */
  readonly maturity: PendleMarketMaturity;
}

function eq(a: string | null, b: string): boolean {
  return a !== null && a.toLowerCase() === b.toLowerCase();
}

/**
 * Refuse an inactive row whose expiry does not prove maturity.
 *
 * Deliberately a THROW, not a `null`. Absence and untrustworthiness are
 * different answers: `null` lets the caller honestly say "not a Pendle market",
 * while a row that exists but cannot be believed must stop the call outright -
 * collapsing it into `null` would let the caller fall through to some other path
 * as though the market were simply absent.
 */
function refuseUntrustworthyRow(market: PendleMarket, expiry: string | null, reason: string): never {
  throw new VexError(
    ErrorCodes.PENDLE_MARKET_NOT_FOUND,
    `Pendle lists market ${market.address} as inactive, but ${reason} - Vex will not treat it as matured.`,
    "Nothing was quoted or signed. Confirm the market with pendle__market_get, which reads the full catalogue including matured markets, before retrying.",
  );
}

/** Validate an inactive-catalogue hit, or refuse it by name. */
function acceptMaturedRow(market: PendleMarket, now: Date): PendleExitMarket {
  const classified = classifyPendleExpiry(market.expiry, now);
  if (classified.state === "unreadable") {
    return refuseUntrustworthyRow(
      market,
      market.expiry,
      classified.reason === "missing"
        ? "it publishes no expiry, so maturity cannot be proven"
        : `its expiry "${market.expiry}" could not be read, so maturity cannot be proven`,
    );
  }
  if (classified.state === "not_matured") {
    return refuseUntrustworthyRow(
      market,
      market.expiry,
      `it has NOT matured yet (expires ${market.expiry})`,
    );
  }
  return { market, maturity: "matured" };
}

/**
 * Resolve a market by PT, active first and matured second.
 *
 * The active catalogue is consulted first and, when it answers, the inactive one
 * is never fetched: chain 1 carries 61 active rows against 420 matured ones, so
 * scanning both would make every ordinary lookup pay for the rare case.
 *
 * `now` is injectable so the maturity boundary is testable without a clock.
 */
export async function resolveExitMarketByPt(
  chainId: number,
  ptAddress: string,
  now: Date = new Date(),
): Promise<PendleExitMarket | null> {
  const client = getPendleClient();
  const active = (await client.getActiveMarkets(chainId)).find((m) => eq(m.pt, ptAddress));
  if (active) return { market: active, maturity: "active" };

  const matured = (await client.getInactiveMarkets(chainId)).find((m) => eq(m.pt, ptAddress));
  return matured ? acceptMaturedRow(matured, now) : null;
}

/** Resolve a market by its market (LP) address, active first and matured second. */
export async function resolveExitMarketByAddress(
  chainId: number,
  marketAddress: string,
  now: Date = new Date(),
): Promise<PendleExitMarket | null> {
  const client = getPendleClient();
  const active = (await client.getActiveMarkets(chainId)).find((m) => eq(m.address, marketAddress));
  if (active) return { market: active, maturity: "active" };

  const matured = (await client.getInactiveMarkets(chainId)).find((m) => eq(m.address, marketAddress));
  return matured ? acceptMaturedRow(matured, now) : null;
}

/**
 * The canonical YT for a PT, matured included - the `pendle.pt.redeem` prequote
 * identity path.
 *
 * Both the quote recorder and the execute gate call THIS, so their redeem
 * identities keep colliding by construction on a matured PT exactly as they did
 * on an active one. Only WHICH markets can produce an identity changes; the
 * identity material does not.
 */
export async function resolveExitYtForPt(
  chainId: number,
  ptAddress: string,
  now: Date = new Date(),
): Promise<string | null> {
  return (await resolveExitMarketByPt(chainId, ptAddress, now))?.market.yt ?? null;
}
