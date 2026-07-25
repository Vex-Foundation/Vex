/**
 * Vex's product policy for how much slippage an agent may authorise.
 *
 * `runtime/bps-param.ts` owns what a basis-point value is ARITHMETICALLY
 * allowed to be (finite, whole, non-negative) and deliberately applies no
 * ceiling — "a maximum-slippage bound is a product-policy decision with its
 * own owner". This module is that owner.
 *
 * Two rules, both owner-pinned:
 *
 *  - The ceiling is {@link VEX_MAX_SLIPPAGE_BPS}. The EFFECTIVE bound for a
 *    venue is the smaller of that and the venue's own maximum, because a
 *    provider that accepts more than Vex allows must still be held to Vex's
 *    limit, and a provider that accepts less must not be sent a value it will
 *    reject.
 *  - Out of range is REJECTED, never clamped. Silently lowering a
 *    price-protection parameter hides the caller's mistake at exactly the
 *    boundary where it costs money, and silently raising one is unthinkable.
 *    Same doctrine as `bps-param.ts`'s "reject, never coerce".
 *
 * NO OVERRIDE EXISTS. A higher tolerance is permitted only on explicit user
 * instruction, and this repository currently has no channel through which a
 * human can authorise a numeric per-call limit that the model cannot also set
 * for itself: the restricted-mode approval gate is a fixed-payload yes/no that
 * is skipped entirely once a session is `full` permission, operator
 * instructions are unenforced free text, and no env var, app setting, or
 * session-policy row expresses a risk limit. Rather than invent one, the
 * ceiling is absolute — raising it is a deliberate code change with an owner
 * decision behind it.
 */

/**
 * Owner-pinned maximum slippage for any Vex-executed trade: 1000 bps (10%).
 *
 * Well above a normal tolerance (50 bps) and well below the total-loss range
 * providers actually accept — KyberSwap's live builds take 5000 bps (50%) and
 * do not clamp; Jupiter's range check permits 10000 (100%).
 */
export const VEX_MAX_SLIPPAGE_BPS = 1000;

/**
 * The binding bound for a venue: Vex's ceiling or the venue's, whichever is
 * lower. Omit `venueMaxBps` when the venue publishes no maximum below Vex's
 * (Relay documents none and none has been measured) — the ceiling then binds
 * on its own, which is the fail-safe reading.
 */
export function effectiveMaxSlippageBps(venueMaxBps?: number): number {
  return venueMaxBps === undefined ? VEX_MAX_SLIPPAGE_BPS : Math.min(VEX_MAX_SLIPPAGE_BPS, venueMaxBps);
}

/**
 * Check an already-numeric slippage value against the policy.
 *
 * @returns an agent-actionable rejection reason, or `null` when the value is
 * permitted. Mirrors `runtime/bps-param.ts`'s `checkBpsParam` shape (reason
 * string or null) so both layers read the same way at a call site; this one
 * adds the ceiling that layer deliberately omits, and is reached even on the
 * paths that never pass through a manifest `unit: "bps"` declaration.
 *
 * `subject` names the offending parameter for the agent, e.g.
 * `Parameter "slippageBps" for kyberswap.swap.execute`.
 */
export function checkSlippageBps(subject: string, value: number, venueMaxBps?: number): string | null {
  if (!Number.isFinite(value)) {
    return `${subject} must be a finite whole number of basis points (1 bps = 0.01%).`;
  }
  if (value < 0) {
    return `${subject} must not be negative (got ${value}); the smallest valid tolerance is 0.`;
  }
  if (!Number.isInteger(value)) {
    return (
      `${subject} must be a whole number of basis points (got ${value}); 1 bps = 0.01%.`
      + percentReadingHint(value)
    );
  }
  const max = effectiveMaxSlippageBps(venueMaxBps);
  if (value > max) {
    // Written for an agent mid-mission with no user to ask: the number it sent,
    // the number it may send, and the fact that the retry is the SAME call with
    // a smaller tolerance. "Lower the tolerance" alone left the retry implicit.
    return (
      `${subject} must not exceed ${max} basis points (got ${value}); `
      + `Vex caps slippage at ${VEX_MAX_SLIPPAGE_BPS} bps (${VEX_MAX_SLIPPAGE_BPS / 100}%) to bound worst-case loss. `
      + `Retry the same call with slippageBps ${max} or lower; if the route genuinely needs more tolerance `
      + "than that, split the trade into smaller amounts instead."
    );
  }
  return null;
}

/** A slippage value parsed from an untrusted STRING param (Relay types it as a string). */
export type SlippageBpsStringParse =
  | { readonly ok: true; readonly bps: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Parse + policy-check a slippage value supplied as a STRING.
 *
 * Relay's `slippageBps` is a manifest `type: "string"` param, so the numeric
 * `unit: "bps"` gate at the manifest boundary never reaches it — this is the
 * only integrality/range check that path gets. Only a plain non-negative
 * decimal integer literal is accepted: no signs, no decimal point, no
 * exponent, no whitespace. Anything else is rejected rather than coerced,
 * because `"0.5"` is exactly as ambiguous as `0.5`.
 *
 * The caller decides what an ABSENT value means — this function is only for a
 * value that is actually present.
 */
export function parseSlippageBpsString(
  subject: string,
  raw: string,
  venueMaxBps?: number,
): SlippageBpsStringParse {
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      reason:
        `${subject} must be a whole number of basis points written as digits only (got "${raw}"); `
        + "1 bps = 0.01%, so 0.5% is \"50\".",
    };
  }
  const bps = Number(raw);
  const violation = checkSlippageBps(subject, bps, venueMaxBps);
  return violation ? { ok: false, reason: violation } : { ok: true, bps };
}

/**
 * Name the correct form for the value the caller most plausibly meant, WITHOUT
 * choosing it for them — the common mistake is passing a percentage into a bps
 * field. Silent unless the percent reading is itself a whole number of bps.
 * Same rule as `runtime/bps-param.ts`'s hint.
 */
function percentReadingHint(value: number): string {
  const asBps = Math.round(value * 100);
  if (asBps / 100 !== value) return "";
  return ` If you meant ${value}%, pass ${asBps}.`;
}
