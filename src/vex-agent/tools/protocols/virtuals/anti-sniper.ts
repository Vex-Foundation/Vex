/**
 * Anti-sniper buy-tax window computation (contract-source-verified).
 *
 * When a Virtuals agent token graduates to its Uniswap V2 VIRTUAL pool, the
 * FRouterV3 router (NOT the token contract) enforces a decaying buy tax to deter
 * snipers: the buy tax starts near 99% at graduation (`lpCreatedAt`) and decays
 * LINEARLY to ~0 over a duration set by `launchInfo.antiSniperTaxType`:
 *
 *   type 0 → no window          (0 s)
 *   type 1 → 60 s   (DEFAULT ~89% initial effective)
 *   type 2 → 5880 s
 *
 * A flat ~1% token tax rides on top (and sells carry a flat ~1%), so the
 * estimated current buy tax while the window is active is:
 *   estBuyTaxPct = 99 * (remainingSeconds / durationSeconds) + 1
 *
 * PRODUCT RULE (surfaced to the model, enforced in the prompt): the agent must
 * NOT buy a graduated token while `windowActive` - it should wait out
 * `remainingSeconds` or inform the user. This is TIER A detection: purely
 * time-based from `lpCreatedAt` + `antiSniperTaxType` (no on-chain read).
 *
 * The window only applies to GRADUATED tokens (those with `lpCreatedAt`).
 * Pre-graduation UNDERGRAD tokens trade on the bonding curve and have no
 * anti-sniper window → `applicable: false`.
 */

/** Linear decay durations in seconds, keyed by antiSniperTaxType. */
export const ANTI_SNIPER_DURATION_SECONDS: Record<number, number> = {
  0: 0,
  1: 60,
  2: 5880,
};

/** Peak linear buy tax at graduation (before the flat component). */
const PEAK_LINEAR_BUY_TAX_PCT = 99;
/** Flat token tax component that rides on top of the decaying window. */
const FLAT_BUY_TAX_PCT = 1;

export interface AntiSniperStatus {
  /** The antiSniperTaxType (0/1/2) as reported, or null when absent. */
  type: number | null;
  /** True only for graduated tokens (lpCreatedAt present) with a known type. */
  applicable: boolean;
  /** True while the decaying buy-tax window is still in force. */
  windowActive: boolean;
  /** Total window length for this type (seconds). */
  durationSeconds: number;
  /** Seconds until the window ends (0 when inactive / not applicable). */
  remainingSeconds: number;
  /**
   * Estimated CURRENT buy tax percent (linear-decay + flat), rounded to 1dp.
   * Null when not applicable (pre-graduation). ~1 once the window has elapsed.
   */
  estBuyTaxPct: number | null;
}

/**
 * Compute the anti-sniper status for a token.
 *
 * @param antiSniperTaxType  `launchInfo.antiSniperTaxType` (0/1/2) or null.
 * @param lpCreatedAtIso     graduation timestamp (ISO) or null for UNDERGRAD.
 * @param nowMs              current epoch ms (injected for deterministic tests).
 */
export function computeAntiSniper(
  antiSniperTaxType: number | null | undefined,
  lpCreatedAtIso: string | null | undefined,
  nowMs: number = Date.now(),
): AntiSniperStatus {
  // Whitelist the KNOWN enum {0,1,2} (contract-source-verified). Any other
  // finite value is future API drift with UNKNOWN tax semantics - it must
  // degrade to not-applicable/unknown (estBuyTaxPct null), never to
  // "residual flat tax, safe to buy".
  const type = typeof antiSniperTaxType === "number" &&
    (antiSniperTaxType === 0 || antiSniperTaxType === 1 || antiSniperTaxType === 2)
    ? antiSniperTaxType
    : null;

  // Pre-graduation (no LP) or unknown/absent type → the window does not apply
  // and no tax estimate is offered.
  const lpMs = lpCreatedAtIso ? Date.parse(lpCreatedAtIso) : NaN;
  if (!Number.isFinite(lpMs) || type === null) {
    return {
      type,
      applicable: false,
      windowActive: false,
      durationSeconds: type !== null ? (ANTI_SNIPER_DURATION_SECONDS[type] ?? 0) : 0,
      remainingSeconds: 0,
      estBuyTaxPct: null,
    };
  }

  const durationSeconds = ANTI_SNIPER_DURATION_SECONDS[type] ?? 0;
  const elapsedSeconds = Math.max(0, (nowMs - lpMs) / 1000);

  // Type 0 (no window) or already elapsed → residual flat tax only.
  if (durationSeconds <= 0 || elapsedSeconds >= durationSeconds) {
    return {
      type,
      applicable: true,
      windowActive: false,
      durationSeconds,
      remainingSeconds: 0,
      estBuyTaxPct: round1(FLAT_BUY_TAX_PCT),
    };
  }

  const remainingSeconds = durationSeconds - elapsedSeconds;
  const estBuyTaxPct = PEAK_LINEAR_BUY_TAX_PCT * (remainingSeconds / durationSeconds) + FLAT_BUY_TAX_PCT;
  return {
    type,
    applicable: true,
    windowActive: true,
    durationSeconds,
    remainingSeconds: Math.ceil(remainingSeconds),
    estBuyTaxPct: round1(estBuyTaxPct),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
