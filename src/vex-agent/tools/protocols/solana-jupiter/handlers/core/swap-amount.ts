/**
 * `amountIn` (HUMAN decimals, string) → the mint's atomic units, exactly.
 *
 * WHY THIS EXISTS (W5a). Both swap handlers used to take `amount` as a
 * `type: "number"` param and convert it with
 * `uiToTokenAmount` = `BigInt(Math.round(uiAmount * 10 ** decimals))`. On a
 * 9-decimal mint that float multiply is already lossy well below the amounts
 * this repository trades, and the loss lands on the value that is signed and
 * broadcast. It also violated the invariant
 * `runtime/numeric-string-coercion.ts` states verbatim — that a param declared
 * `type: "number"` is structurally non-monetary.
 *
 * The conversion here is integer-only: split on the decimal point, right-pad
 * the fraction to the mint's decimals, concatenate, `BigInt`. No `Number`, no
 * rounding.
 *
 * EXCESS PRECISION IS REJECTED, NOT ROUNDED. `"1.0000001"` on a 6-decimal mint
 * is not a spelling of `"1.000000"`: it is a request Vex cannot execute
 * faithfully, and silently dropping the tail is a (small) loss the agent never
 * asked for. The rejection names the mint's decimals so the retry is one call.
 */

/** Exact-conversion outcome — a domain result, never an exception on a money path. */
export type HumanAmountConversion =
  | { readonly ok: true; readonly amountRaw: string }
  | { readonly ok: false; readonly reason: string };

const HUMAN_DECIMAL = /^\d+(?:\.\d+)?$/;

export function humanAmountToAtomic(
  paramKey: string,
  value: string,
  decimals: number,
  tokenSymbol: string,
): HumanAmountConversion {
  const trimmed = value.trim();
  if (!HUMAN_DECIMAL.test(trimmed)) {
    return {
      ok: false,
      reason:
        `${paramKey} must be a positive decimal amount in HUMAN units, as a plain string `
        + `(e.g. "1.5") — no sign, exponent, thousands separator, or unit suffix.`,
    };
  }
  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    return {
      ok: false,
      reason:
        `${paramKey} has ${fraction.length} decimal places but ${tokenSymbol} has only ${decimals} — `
        + `Vex will not silently round a trade amount. Re-send it with at most ${decimals} decimal places.`,
    };
  }
  const atomic = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  if (atomic <= 0n) {
    return { ok: false, reason: `${paramKey} must be greater than zero.` };
  }
  return { ok: true, amountRaw: atomic.toString() };
}
