/**
 * C6 — the enforceable autonomous-launch spend ceiling.
 *
 * `iteration-budget.ts` says in its own words that it is NOT a spend cap, and
 * no session spend gate exists. With Path 2 able to spend unattended, free text
 * in a mission goal constrains nothing at the signing boundary. So the mission
 * contract carries a hard number, and this module owns the ONLY place it is
 * read and compared.
 *
 * Three rules, all of them rule-90 money-path discipline:
 *
 * 1. **No ceiling ⇒ REFUSE.** `null` is not "unlimited"; a mission that never
 *    had a ceiling authored cannot launch autonomously. Fail closed.
 * 2. **Decimals must be 18.** `maxLaunchValueRaw` is compared against
 *    `msg.value` in WEI on chain 4663 (native ETH). Any other decimals value
 *    is REFUSED BY NAME. We never rescale: a silent 10^n slip is exactly the
 *    thousandfold error the rule exists to prevent.
 * 3. **Exceeding it refuses with BOTH numbers, never clamps.** Silently
 *    lowering the amount would hide from the user that the agent tried to
 *    spend more than they authorized.
 *
 * The ceiling is compared against the FULL `msg.value` — creation fee PLUS
 * prebuy — not the prebuy alone. The fee is a real, irreversible spend.
 */

/** Decimals the ceiling must be authored in to be comparable with wei. */
export const REQUIRED_MAX_LAUNCH_VALUE_DECIMALS = 18;

/** The ceiling as authored on the mission contract. */
export interface MaxLaunchValueContract {
  readonly maxLaunchValueRaw: string | null;
  readonly maxLaunchValueDecimals: number | null;
}

export type LaunchCeilingCheck =
  | { readonly ok: true; readonly ceilingWei: bigint }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve the ceiling to a wei bigint, or refuse by name.
 *
 * Separate from {@link enforceLaunchValueCeiling} so a caller can refuse EARLY
 * — before building calldata or reading a fee — when the mission simply has no
 * usable ceiling.
 */
export function resolveLaunchValueCeilingWei(
  contract: MaxLaunchValueContract,
): LaunchCeilingCheck {
  const raw = contract.maxLaunchValueRaw;
  const decimals = contract.maxLaunchValueDecimals;

  if (raw === null || raw.trim().length === 0 || decimals === null) {
    return {
      ok: false,
      reason:
        "Refusing to launch autonomously: this mission has no maxLaunchValue ceiling set. " +
        "An unattended launch spends real funds, so an absent ceiling is treated as zero authority, not unlimited.",
    };
  }

  if (decimals !== REQUIRED_MAX_LAUNCH_VALUE_DECIMALS) {
    return {
      ok: false,
      reason:
        `Refusing to launch: maxLaunchValueDecimals is ${decimals}, but the launch value is ` +
        `compared in wei and this check requires exactly ${REQUIRED_MAX_LAUNCH_VALUE_DECIMALS}. ` +
        "The ceiling is NOT rescaled — a silent decimals conversion is how a thousandfold spend error happens.",
    };
  }

  if (!/^\d+$/.test(raw.trim())) {
    return {
      ok: false,
      reason:
        `Refusing to launch: maxLaunchValueRaw ("${raw.trim()}") is not a raw non-negative integer amount. ` +
        "It must be the ceiling in wei with no decimal point, sign, or exponent.",
    };
  }

  return { ok: true, ceilingWei: BigInt(raw.trim()) };
}

/**
 * Enforce the ceiling against the exact `msg.value` of a launch.
 *
 * @param msgValueWei creation fee + prebuy, the full native value being sent.
 */
export function enforceLaunchValueCeiling(
  contract: MaxLaunchValueContract,
  msgValueWei: bigint,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const resolved = resolveLaunchValueCeilingWei(contract);
  if (!resolved.ok) return resolved;

  if (msgValueWei > resolved.ceilingWei) {
    return {
      ok: false,
      reason:
        `Refusing to launch: this launch would send ${msgValueWei.toString()} wei ` +
        `(creation fee + prebuy), which exceeds the mission's authorized ceiling of ` +
        `${resolved.ceilingWei.toString()} wei. Lower the prebuy and try again — ` +
        "the amount is NOT clamped for you.",
    };
  }

  return { ok: true };
}
