/**
 * Raw base-unit → human amount, for DISPLAY surfaces only.
 *
 * `rules/90-vex-project.md`: "Raw amounts must travel with the decimals needed
 * to read them" — `"1047061"` is 1.05 at 6 decimals and 0.00105 at 9. Four
 * copies of this conversion had grown across the protocol handlers and the
 * transactions repo; this is their single owner, so a correction lands once.
 *
 * It NEVER throws and NEVER guesses: a missing raw amount, missing decimals or
 * a malformed value yields `null`, because on a display path a missing amount
 * is safer than a wrong one. Callers that prefer a different degradation (the
 * raw passthrough, `undefined`, `0`) apply it at their own call site — the
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
