/**
 * Dashboard positions → `pendle.position.value` legs, through the trusted-fields
 * boundary.
 *
 * Balances leave as `{raw, decimals, exact}` triplets (`../money-format.ts`): a
 * raw base-unit string alone is the canonical money-format failure, and
 * `Number()` on a u256 silently loses precision above ~9 tokens at 18 decimals —
 * which is what the projector this replaces did on every leg.
 *
 * Two correctness rules worth stating plainly:
 *   - A matured PT is valued at its ACCOUNTING/face value (Pendle `price.acc`),
 *     never at underlying spot.
 *   - Every leg carries ONE `state` from a closed vocabulary. The old
 *     `redeemable` / `matured` boolean pair could express "matured but not
 *     redeemable", which is not a state a PT can be in, and it said nothing at
 *     all about YT or SY.
 */

import type { PendleAsset } from "@tools/pendle/types.js";
import type { PendleReadDashboardClaimable, PendleReadDashboardLeg } from "@tools/pendle/read/dashboard-types.js";
import {
  amountTriplet,
  daysUntil,
  sumUsdStrings,
  usdString,
  type PendleAmount,
} from "../money-format.js";
import { trustedAddress, trustedIsoTimestamp, trustedNumber } from "../trusted-fields.js";
import { projectToken, type ProjectedToken } from "./_shared.js";

/**
 * The single state vocabulary for every position leg.
 *
 * Replaces the old `redeemable` / `matured` boolean pair, which could express
 * combinations no position can be in and covered only PT and LP. One closed
 * vocabulary means the agent reads the same field for every kind of holding.
 */
export type PendlePositionState =
  | "earning"
  | "matured_redeemable"
  | "matured_removable"
  | "expired_worthless";

export interface ProjectedAccruedItem {
  token: ProjectedToken | null;
  amount: PendleAmount;
}

export interface ProjectedAccrued {
  items: ProjectedAccruedItem[];
  /** Null: these amounts have no USD price on this endpoint, and none is invented. */
  totalUsd: null;
  note: string;
}

export interface ProjectedPositionLeg {
  chain: string;
  kind: "pt" | "yt" | "lp" | "sy";
  state: PendlePositionState;
  /**
   * FALSE when the market could not be resolved, so `state` is a conservative
   * DEFAULT rather than a finding. `earning` is the safe default precisely
   * because it is the one that cannot cause an action: mislabelling a live
   * position as redeemable sends the agent to broadcast a redeem that must
   * revert, while mislabelling a matured one as earning only delays a redeem.
   */
  stateDetermined: boolean;
  stateNote?: string;
  market: string | null;
  /** The leg's own token — for a matured PT this is its REAL address (G-18). */
  token: ProjectedToken | null;
  expiry: string | null;
  daysToExpiry: number | null;
  balance: PendleAmount;
  /** LP only: the staked share of `balance`. */
  activeBalance?: PendleAmount;
  activeBalanceNote?: string;
  valueUsd: string | null;
  valuationBasis: "accounting" | "dashboard" | "spot" | "unknown";
  accrued?: ProjectedAccrued;
}

/** Classify a leg from its kind and maturity. One rule, all kinds. */
export function positionState(
  kind: ProjectedPositionLeg["kind"],
  matured: boolean | null,
): PendlePositionState {
  if (matured !== true) return "earning";
  switch (kind) {
    // A matured PT is the redeem product: face value, claimable ~1:1.
    case "pt":
      return "matured_redeemable";
    // A matured LP can still be removed (principal side) but earns nothing more.
    case "lp":
      return "matured_removable";
    // A YT is worth zero after expiry — this is the decay the buy path warns of.
    case "yt":
      return "expired_worthless";
    // SY has no expiry of its own; it tracks its underlying and keeps earning.
    default:
      return "earning";
  }
}

function projectAccrued(
  claimable: readonly PendleReadDashboardClaimable[],
  assetByAddress: Map<string, PendleAsset>,
): ProjectedAccrued | undefined {
  if (claimable.length === 0) return undefined;
  const items: ProjectedAccruedItem[] = [];
  for (const entry of claimable) {
    const token = projectToken(entry.token, assetByAddress);
    items.push({ token, amount: amountTriplet(entry.amountRaw, token?.decimals ?? null) });
  }
  return {
    items,
    totalUsd: null,
    note: "Pendle CACHES claimable amounts for up to 24 hours, so these can lag the chain. They are also unpriced on this endpoint — no USD total is implied.",
  };
}

/**
 * Project one PT / YT / LP leg.
 *
 * `legToken` is the contract the balance is denominated in — the PT address for
 * a PT leg, the YT for a YT leg, the market itself for LP. Resolving it (via the
 * read-lane resolver for matured markets) is what fixes G-18: a matured PT used
 * to project as `pt: null, expiry: null, redeemable: false`, i.e. the exact
 * position the redeem product exists for, reported as not redeemable.
 */
export function projectPositionLeg(args: {
  chain: string;
  kind: "pt" | "yt" | "lp";
  leg: PendleReadDashboardLeg;
  market: string | null;
  legToken: string | null;
  expiry: string | null;
  matured: boolean | null;
  assetByAddress: Map<string, PendleAsset>;
  includeAccrued: boolean;
  nowMs: number;
}): ProjectedPositionLeg {
  const { chain, kind, leg, market, legToken, expiry, matured, assetByAddress, includeAccrued, nowMs } = args;
  const token = projectToken(legToken, assetByAddress);
  const iso = trustedIsoTimestamp(expiry);

  const projected: ProjectedPositionLeg = {
    chain,
    kind,
    state: positionState(kind, matured),
    stateDetermined: matured !== null,
    market: trustedAddress(market),
    token,
    expiry: iso,
    daysToExpiry: daysUntil(iso, nowMs),
    balance: amountTriplet(leg.balanceRaw, token?.decimals ?? null),
    valueUsd: null,
    valuationBasis: "unknown",
  };

  if (matured === null) {
    projected.stateNote =
      "Pendle's catalogue did not resolve this market, so maturity is UNPROVEN — `state` is a conservative default, not a determination. Re-read before acting on it; do not treat this leg as confirmed live.";
  }

  const valued = valueLeg(kind, leg, token, matured === true, assetByAddress);
  projected.valueUsd = valued.valueUsd;
  projected.valuationBasis = valued.basis;

  if (leg.activeBalanceRaw !== null) {
    projected.activeBalance = amountTriplet(leg.activeBalanceRaw, token?.decimals ?? null);
    if (leg.activeBalanceRaw !== leg.balanceRaw) {
      projected.activeBalanceNote =
        "`activeBalance` is the STAKED share of `balance` that earns boosted rewards — not a second holding, and not a pending amount. The remainder sits unstaked in the wallet.";
    }
  }
  if (includeAccrued) {
    const accrued = projectAccrued(leg.claimable, assetByAddress);
    if (accrued !== undefined) projected.accrued = accrued;
  }
  return projected;
}

/** Project a standalone SY holding. SY has no expiry, so it is always `earning`. */
export function projectSyLeg(args: {
  chain: string;
  sy: string;
  balanceRaw: string;
  claimable: readonly PendleReadDashboardClaimable[];
  assetByAddress: Map<string, PendleAsset>;
  includeAccrued: boolean;
}): ProjectedPositionLeg {
  const { chain, sy, balanceRaw, claimable, assetByAddress, includeAccrued } = args;
  const token = projectToken(sy, assetByAddress);
  const projected: ProjectedPositionLeg = {
    chain,
    kind: "sy",
    // SY has no expiry of its own; "earning" is a determination, not a default.
    state: "earning",
    stateDetermined: true,
    market: null,
    token,
    expiry: null,
    daysToExpiry: null,
    balance: amountTriplet(balanceRaw, token?.decimals ?? null),
    valueUsd: null,
    valuationBasis: "unknown",
  };
  const spot = spotValue(balanceRaw, token, assetByAddress);
  if (spot !== null) {
    projected.valueUsd = spot;
    projected.valuationBasis = "spot";
  }
  if (includeAccrued) {
    const accrued = projectAccrued(claimable, assetByAddress);
    if (accrued !== undefined) projected.accrued = accrued;
  }
  return projected;
}

function valueLeg(
  kind: "pt" | "yt" | "lp",
  leg: PendleReadDashboardLeg,
  token: ProjectedToken | null,
  matured: boolean,
  assetByAddress: Map<string, PendleAsset>,
): { valueUsd: string | null; basis: ProjectedPositionLeg["valuationBasis"] } {
  // A MATURED PT is worth ~face. Value it at the accounting price (`price.acc`),
  // NEVER the underlying spot — the SIERRA evidence behind this rule stands.
  const address = token?.address ?? null;
  if (kind === "pt" && matured && address !== null && token !== null && token.decimals !== null) {
    const acc = trustedNumber(assetByAddress.get(address)?.priceAcc ?? null, 1e9);
    const exact = amountTriplet(leg.balanceRaw, token.decimals).exact;
    if (acc !== null && exact !== null) {
      const value = usdString(Number(exact) * acc);
      if (value !== null) return { valueUsd: value, basis: "accounting" };
    }
  }
  const dashboard = usdString(trustedNumber(leg.valuationUsd));
  if (dashboard !== null) return { valueUsd: dashboard, basis: "dashboard" };
  const spot = spotValue(leg.balanceRaw, token, assetByAddress);
  if (spot !== null) return { valueUsd: spot, basis: "spot" };
  return { valueUsd: null, basis: "unknown" };
}

/**
 * Spot USD for a balance. The multiply is float arithmetic, unavoidably: the
 * provider's price IS a float. That is why this is a DISPLAY figure carrying an
 * explicit `valuationBasis`, while the balance beside it stays an exact triplet
 * — the number an agent would act on is the balance, not the mark.
 */
function spotValue(
  balanceRaw: string,
  token: ProjectedToken | null,
  assetByAddress: Map<string, PendleAsset>,
): string | null {
  const address = token?.address ?? null;
  if (address === null || token === null || token.decimals === null) return null;
  const price = trustedNumber(assetByAddress.get(address)?.priceUsd ?? null, 1e12);
  if (price === null) return null;
  const exact = amountTriplet(balanceRaw, token.decimals).exact;
  if (exact === null) return null;
  return usdString(Number(exact) * price);
}

/**
 * Total the projected legs. Unpriceable legs are COUNTED, not absorbed as zero —
 * a portfolio total that quietly swallowed an unvalued position would understate
 * the wallet and give no hint that it had.
 */
export function totalPositionValue(legs: readonly ProjectedPositionLeg[]): {
  totalUsd: string;
  valuedLegs: number;
  unvaluedLegs: number;
} {
  const { total, counted, skipped } = sumUsdStrings(legs.map((leg) => leg.valueUsd));
  return { totalUsd: total, valuedLegs: counted, unvaluedLegs: skipped };
}
