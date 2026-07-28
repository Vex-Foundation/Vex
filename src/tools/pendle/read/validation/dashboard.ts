/**
 * `GET /v1/dashboard/positions/database/{user}` — the wallet's Pendle positions,
 * read WITHOUT the money path's field losses.
 *
 * The frozen `../../validation.ts:validatePositions` keeps four fields and drops
 * the rest; this validator keeps every family a read tool needs (see
 * `../dashboard-types.ts` for what each one costs when it goes missing).
 *
 * A zero-balance leg is DROPPED here, not carried as an empty position: the
 * provider reports every market the wallet has ever touched with
 * `balance: "0"`, and one probed wallet carried three such rows for every live
 * one. Dropping them is a display decision, not a data loss — a zero balance
 * conveys nothing a consumer can act on, and `totalOpen` is preserved so the
 * provider's own count remains checkable.
 */

import { pendleInvalidResponse } from "../../errors.js";
import type {
  PendleReadDashboardChain,
  PendleReadDashboardClaimable,
  PendleReadDashboardCrossPt,
  PendleReadDashboardLeg,
  PendleReadDashboardMarketPosition,
  PendleReadDashboardPositions,
  PendleReadDashboardSyPosition,
} from "../dashboard-types.js";
import {
  chainIdFromCompositeId,
  isRecord,
  readDisplayNumber,
  readDisplayString,
  requireAddress,
  requireChainId,
  requireDigitString,
} from "./_shared.js";

const ENDPOINT = "dashboard positions";

function normalizeClaimable(raw: unknown): PendleReadDashboardClaimable | null {
  if (!isRecord(raw)) return null;
  const token = requireAddress(raw.token);
  // STRICT: an accrued amount is a raw base-unit u256. A number here has already
  // lost precision and a formatted string is a different unit.
  const amountRaw = requireDigitString(raw.amount);
  if (token === null || amountRaw === null) return null;
  return { token, amountRaw };
}

function normalizeClaimables(raw: unknown): PendleReadDashboardClaimable[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeClaimable).filter((c): c is PendleReadDashboardClaimable => c !== null);
}

/** A leg with a zero or unreadable balance is not a position. */
function normalizeLeg(raw: unknown): PendleReadDashboardLeg | null {
  if (!isRecord(raw)) return null;
  const balanceRaw = requireDigitString(raw.balance);
  if (balanceRaw === null || balanceRaw === "0") return null;
  return {
    balanceRaw,
    valuationUsd: readDisplayNumber(raw.valuation),
    activeBalanceRaw: requireDigitString(raw.activeBalance),
    claimable: normalizeClaimables(raw.claimTokenAmounts),
  };
}

function normalizeCrossPt(raw: unknown): PendleReadDashboardCrossPt | null {
  if (!isRecord(raw)) return null;
  const spokePt = requireAddress(raw.spokePt);
  const balanceRaw = requireDigitString(raw.balance);
  if (spokePt === null || balanceRaw === null || balanceRaw === "0") return null;
  return { spokePt, chainId: chainIdFromCompositeId(raw.spokePt), balanceRaw };
}

/** A market row with no live leg and no cross-PT holding carries nothing. */
function normalizeMarketPosition(raw: unknown): PendleReadDashboardMarketPosition | null {
  if (!isRecord(raw)) return null;
  const market = requireAddress(raw.marketId);
  if (market === null) return null;

  const crossPt = Array.isArray(raw.crossPtPositions)
    ? raw.crossPtPositions.map(normalizeCrossPt).filter((c): c is PendleReadDashboardCrossPt => c !== null)
    : [];
  const position: PendleReadDashboardMarketPosition = {
    market,
    pt: normalizeLeg(raw.pt),
    yt: normalizeLeg(raw.yt),
    lp: normalizeLeg(raw.lp),
    crossPt,
  };
  const empty =
    position.pt === null && position.yt === null && position.lp === null && crossPt.length === 0;
  return empty ? null : position;
}

function normalizeSyPosition(raw: unknown): PendleReadDashboardSyPosition | null {
  if (!isRecord(raw)) return null;
  const sy = requireAddress(raw.syId);
  const balanceRaw = requireDigitString(raw.balance);
  if (sy === null || balanceRaw === null || balanceRaw === "0") return null;
  return { sy, balanceRaw, claimable: normalizeClaimables(raw.claimTokenAmounts) };
}

function normalizeChain(raw: unknown): PendleReadDashboardChain | null {
  if (!isRecord(raw)) return null;
  const chainId = requireChainId(raw.chainId);
  if (chainId === null) return null;

  const openRaw = Array.isArray(raw.openPositions) ? raw.openPositions : [];
  const syRaw = Array.isArray(raw.syPositions) ? raw.syPositions : [];
  return {
    chainId,
    updatedAt: readDisplayString(raw.updatedAt),
    totalOpen: readDisplayNumber(raw.totalOpen),
    totalClosed: readDisplayNumber(raw.totalClosed),
    totalSy: readDisplayNumber(raw.totalSy),
    open: openRaw
      .map(normalizeMarketPosition)
      .filter((p): p is PendleReadDashboardMarketPosition => p !== null),
    sy: syRaw.map(normalizeSyPosition).filter((s): s is PendleReadDashboardSyPosition => s !== null),
  };
}

/**
 * `GET /v1/dashboard/positions/database/{user}` → every chain's positions.
 *
 * RAISES when the root is not the documented `{positions: []}` envelope, or when
 * chain entries arrived and none was readable. A wallet holding nothing returns
 * an empty chain list, which is a determined answer — so "no positions" can
 * never be produced by a parse failure, the exact conflation that let the asset
 * catalogue answer `[]` for months.
 */
export function validatePendleDashboardPositions(raw: unknown): PendleReadDashboardPositions {
  if (!isRecord(raw)) {
    throw pendleInvalidResponse(ENDPOINT, "expected a JSON object at the root");
  }
  const positions = raw.positions;
  if (!Array.isArray(positions)) {
    throw pendleInvalidResponse(ENDPOINT, "the root carried no `positions` array");
  }
  const chains = positions
    .map(normalizeChain)
    .filter((c): c is PendleReadDashboardChain => c !== null);
  if (chains.length === 0 && positions.length > 0) {
    throw pendleInvalidResponse(ENDPOINT, "no chain entry carried a readable chain id");
  }
  return { chains };
}
