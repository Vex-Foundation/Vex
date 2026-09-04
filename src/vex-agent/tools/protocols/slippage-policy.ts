/**
 * Vex's product policy for how much slippage an agent may authorise.
 *
 * `runtime/bps-param.ts` owns what a basis-point value is ARITHMETICALLY
 * allowed to be (finite, whole, non-negative) and deliberately applies no
 * ceiling - "a maximum-slippage bound is a product-policy decision with its
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
 * ceiling is absolute - raising it is a deliberate code change with an owner
 * decision behind it.
 */

/**
 * Owner-pinned maximum slippage for any Vex-executed trade: 1000 bps (10%).
 *
 * Well above a normal tolerance ({@link VEX_DEFAULT_SLIPPAGE_BPS} bps) and well below the total-loss range
 * providers actually accept - KyberSwap's live builds take 5000 bps (50%) and
 * do not clamp; Jupiter's range check permits 10000 (100%).
 */
export const VEX_MAX_SLIPPAGE_BPS = 1000;

/**
 * The ONE default slippage tolerance for a call that declares none: 100 bps (1%).
 *
 * A default folded into a prequote match-hash (`prequote/slippage.ts`
 * `canonSlippageBpsWithDefault`) must have exactly one value across the handler
 * lane and the identity lane, or a quote taken without slippage stops
 * authorizing an execute taken without slippage. This constant is the ONLY
 * module allowed to decide the number - enforced by the `slippage-default-home`
 * source rule (`_manifest-lint/source-rules.ts`), whose allowlist is now empty.
 *
 * Lower layers do not mirror it: functions under `src/tools/**` take an
 * EXPLICIT bps parameter and hold no default of their own (they cannot import
 * `src/vex-agent` anyway), and the vex-agent handler that owns the call
 * resolves the omitted value from here before calling down.
 *
 * VALUE (owner decree 2026-08-03, audit wave W4b): 50 → 100. 50 bps was the
 * inherited aggregator convention and was measurably too tight on the venues
 * Vex actually trades - the tolerance is a WORST-CASE bound, not an expected
 * cost, and a quote that reverts costs gas and a whole mission slice while
 * paying nothing for the unused headroom. 100 is what the trench curve path had
 * already converged on independently. The ceiling
 * ({@link VEX_MAX_SLIPPAGE_BPS}) is unchanged.
 *
 * HASH CONSEQUENCE: the default is hash material, so any prequote recorded at
 * 50 before this change fails its gate CLOSED for the remainder of its window
 * (≤15 minutes) - a re-quote resolves it. That is the safe direction: an
 * execute is refused, never silently admitted under a different tolerance.
 */
export const VEX_DEFAULT_SLIPPAGE_BPS = 100;

/**
 * The binding bound for a venue: Vex's ceiling or the venue's, whichever is
 * lower. Omit `venueMaxBps` when the venue publishes no maximum below Vex's -
 * the ceiling then binds on its own, which is the fail-safe reading.
 *
 * Measured venue maxima (audit 2026-08): Jupiter 0–10000, Relay 0–10000
 * ({@link RELAY_MAX_SLIPPAGE_BPS}). Both are far above Vex's 1000, so Vex's
 * ceiling is what actually binds; they are passed anyway so a later change to
 * either number cannot silently send a venue a value it would reject.
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
 *
 * `retryParamKey` is the param the agent must resend, named INSIDE the retry
 * sentence. It defaults to `slippageBps` because that is what every swap
 * surface calls it, but a tool whose tolerance has another name
 * (`solana.predict.closeAll`'s `minSellPriceSlippageBps`) must pass its own:
 * the protocol boundary rejects an unknown parameter by name
 * (`runtime/params.ts`), so naming the wrong key sends an agent into a second
 * call that cannot be made at all.
 */
export function checkSlippageBps(
  subject: string,
  value: number,
  venueMaxBps?: number,
  retryParamKey = "slippageBps",
): string | null {
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
      + `Retry the same call with ${retryParamKey} ${max} or lower; if the route genuinely needs more tolerance `
      + "than that, split the trade into smaller amounts instead."
    );
  }
  return null;
}

/** Relay's own documented tolerance range is 0–10000 bps; Vex's ceiling binds first. */
export const RELAY_MAX_SLIPPAGE_BPS = 10000;

/**
 * Resolve the EFFECTIVE Relay slippage tolerance from untrusted params.
 *
 * ONE function for both Relay lanes - the bridge handler
 * (`relay/handlers/bridge/legs.ts`) and the prequote identity
 * (`prequote/identity/relay-bridge.ts`) - so the value the gate bound and the
 * value the provider receives can never disagree.
 *
 * Two policy decisions live here (audit waves W3 + W4a):
 *
 *  - The param is a manifest `type: "number"` with `unit: "bps"`, so the
 *    boundary gate (`runtime/bps-param.ts`) already ran on the declared path.
 *    A non-number still reaches this function on the identity lane (which reads
 *    raw params) and is REJECTED by name rather than coerced.
 *  - An OMITTED value resolves to {@link VEX_DEFAULT_SLIPPAGE_BPS} and is sent
 *    EXPLICITLY. Relay auto-computes a tolerance when none is sent, and the
 *    provider must not own Vex's price protection.
 *
 * @returns the effective bps value, or an agent-actionable rejection reason the
 * caller raises in its own error type (both lanes surface it before any quote,
 * recording, or signing).
 */
export function resolveRelaySlippageBps(subject: string, raw: unknown): { ok: true; bps: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, bps: VEX_DEFAULT_SLIPPAGE_BPS };
  }
  if (typeof raw !== "number") {
    return {
      ok: false,
      reason:
        `${subject} must be a NUMBER of basis points (e.g. ${VEX_DEFAULT_SLIPPAGE_BPS}), not a ${typeof raw}; `
        + `1 bps = 0.01%, so ${VEX_DEFAULT_SLIPPAGE_BPS / 100}% is ${VEX_DEFAULT_SLIPPAGE_BPS}.`,
    };
  }
  const violation = checkSlippageBps(subject, raw, RELAY_MAX_SLIPPAGE_BPS);
  return violation ? { ok: false, reason: violation } : { ok: true, bps: raw };
}

/**
 * Resolve the EFFECTIVE Morpho vault slippage tolerance from untrusted params.
 *
 * NO `MORPHO_MAX_SLIPPAGE_BPS` CONSTANT EXISTS, and its absence is the decision
 * rather than an omission. `effectiveMaxSlippageBps` takes a venue maximum only
 * when the venue publishes one below Vex's; the Morpho SDK takes the tolerance
 * as a WAD fraction and documents no ceiling at all, so inventing a number here
 * would be a guess dressed as a policy. Vex's own 1000 bps ceiling binds on its
 * own, which is the fail-safe reading the function's own contract names.
 *
 * An OMITTED value resolves to {@link VEX_DEFAULT_SLIPPAGE_BPS} and is passed
 * down EXPLICITLY. `src/tools/morpho/mutations` holds no default of its own by
 * construction (it cannot import `src/vex-agent`), so a tolerance this function
 * failed to resolve would not be silently replaced downstream; it would be a
 * missing argument on a price guard.
 *
 * WHAT THE TOLERANCE ACTUALLY GUARDS ON A VAULT DEPOSIT, because it is not the
 * swap meaning of the word: it raises the `maxSharePrice` ceiling the deposit
 * adapter enforces on chain, so it bounds how much worse the share price may be
 * than the one this preview read. A withdrawal is a direct vault call with no
 * share-price leg, so the value is accepted, echoed and simply has nothing to
 * bind on there.
 *
 * @returns the effective bps value, or an agent-actionable rejection reason.
 */
export function resolveMorphoSlippageBps(
  subject: string,
  raw: unknown,
): { ok: true; bps: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, bps: VEX_DEFAULT_SLIPPAGE_BPS };
  }
  if (typeof raw !== "number") {
    return {
      ok: false,
      reason:
        `${subject} must be a NUMBER of basis points (e.g. ${VEX_DEFAULT_SLIPPAGE_BPS}), not a ${typeof raw}; `
        + `1 bps = 0.01%, so ${VEX_DEFAULT_SLIPPAGE_BPS / 100}% is ${VEX_DEFAULT_SLIPPAGE_BPS}.`,
    };
  }
  const violation = checkSlippageBps(subject, raw);
  return violation ? { ok: false, reason: violation } : { ok: true, bps: raw };
}

/**
 * Name the correct form for the value the caller most plausibly meant, WITHOUT
 * choosing it for them - the common mistake is passing a percentage into a bps
 * field. Silent unless the percent reading is itself a whole number of bps.
 * Same rule as `runtime/bps-param.ts`'s hint.
 */
function percentReadingHint(value: number): string {
  const asBps = Math.round(value * 100);
  if (asBps / 100 !== value) return "";
  return ` If you meant ${value}%, pass ${asBps}.`;
}
