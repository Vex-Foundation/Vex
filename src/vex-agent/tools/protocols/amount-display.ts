/**
 * Raw base-unit → human amount, for DISPLAY surfaces only.
 *
 * `rules/90-vex-project.md`: "Raw amounts must travel with the decimals needed
 * to read them" - `"1047061"` is 1.05 at 6 decimals and 0.00105 at 9. Four
 * copies of this conversion had grown across the protocol handlers and the
 * transactions repo; this is their single owner, so a correction lands once.
 *
 * It NEVER throws and NEVER guesses: a missing raw amount, missing decimals or
 * a malformed value yields `null`, because on a display path a missing amount
 * is safer than a wrong one. Callers that prefer a different degradation (the
 * raw passthrough, `undefined`, `0`) apply it at their own call site - the
 * per-protocol degradation is the caller's contract, not this owner's.
 *
 * DISPLAY ONLY. The machine fields (`amountRaw`, `routeSummary.amountOut`,
 * `input_amount`, …) keep their raw values verbatim; a humanized figure travels
 * ALONGSIDE them in the human layer, never in place of them.
 */

import { formatUnits } from "viem";

export function formatRawAmount(
  raw: string | bigint | null | undefined,
  decimals: number | null | undefined,
): string | null {
  if (raw === null || raw === undefined || decimals === null || decimals === undefined) return null;
  try {
    return formatUnits(BigInt(raw), decimals);
  } catch {
    return null;
  }
}

/** Both native display units below are 9 decimals from their base unit. */
const NATIVE_SUBUNIT_DECIMALS = 9;

/**
 * Wei as GWEI, for gas PRICES only.
 *
 * A gas price is the one launch figure whose bare integer reads as a plausible
 * gwei number: `22518000` wei is 0.0225 gwei, and an agent that reads it as
 * 22.5 is off by a thousand on the number it prices a transaction from. Gas
 * UNITS (`gasEstimate`, `gasLimitWithHeadroom`) are unitless counts and must
 * never be passed here.
 */
export function formatWeiAsGwei(wei: string | bigint | null | undefined): string | null {
  return formatRawAmount(wei, NATIVE_SUBUNIT_DECIMALS);
}

/** Lamports as SOL. Same reason: a bare lamport figure is unreadable as a price. */
export function formatLamportsAsSol(lamports: string | bigint | number | null | undefined): string | null {
  if (typeof lamports === "number") {
    return Number.isSafeInteger(lamports) ? formatRawAmount(BigInt(lamports), NATIVE_SUBUNIT_DECIMALS) : null;
  }
  return formatRawAmount(lamports, NATIVE_SUBUNIT_DECIMALS);
}
