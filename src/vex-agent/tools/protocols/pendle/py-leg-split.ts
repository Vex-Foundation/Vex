/**
 * PY two-leg apportionment — how ONE `pendle.py.mint` / `pendle.py.redeem`
 * execution divides its SINGLE payment leg across the PT lot and the YT lot.
 *
 * Extracted from `handlers/py.ts` unchanged (move-only, phase-4 card H-4: that
 * file sat at the 550-line ceiling). The apportionment POLICY — the USD split,
 * its documented 50/50 fallback, and the total-conserving raw split — now has
 * one owner and one reason to change, separate from the handlers'
 * quote/approve/sign/broadcast orchestration.
 */

/**
 * PT's share of a two-leg value split. When BOTH legs are priced, split by USD;
 * otherwise a 50/50 fallback (documented — a mint/redeem is roughly balanced, and
 * an unpriced leg gives no better estimate). Always in [0, 1].
 */
export function ptUsdShare(ptUsd: number | null, ytUsd: number | null): number {
  if (ptUsd !== null && ytUsd !== null && ptUsd + ytUsd > 0) {
    const s = ptUsd / (ptUsd + ytUsd);
    return Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5;
  }
  return 0.5;
}

/** Split a raw base-unit total into [pt, yt] by `ptShare`, conserving the total. */
export function splitWei(total: bigint, ptShare: number): [bigint, bigint] {
  const SCALE = 1_000_000n;
  const ptScaled = BigInt(Math.min(1_000_000, Math.max(0, Math.round(ptShare * 1_000_000))));
  const ptPart = (total * ptScaled) / SCALE;
  return [ptPart, total - ptPart];
}
