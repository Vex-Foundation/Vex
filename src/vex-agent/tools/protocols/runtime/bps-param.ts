/**
 * The basis-point parameter contract for manifest-declared params
 * (`ProtocolParamDef.unit === "bps"`).
 *
 * This is a SEPARATE module from `./params.ts` on purpose. `params.ts` owns the
 * generic manifest boundary (unknown keys, required presence, declared type);
 * this owns one domain rule — "what a basis-point value is allowed to be" — and
 * has a different reason to change.
 *
 * WHY THIS EXISTS (measured, not inferred): Jupiter ACCEPTS a non-integer
 * `slippageBps` and answers with `otherAmountThreshold = 0` — a swap that will
 * accept ANY output, including near-zero. Reproduced at `50.5`, `50.9`, and
 * most dangerously `0.5`: a caller that means "0.5%" and passes `0.5` gets
 * TOTAL-LOSS tolerance instead of tight protection, with no error and a
 * normal-looking quote. `z.number()` at the manifest boundary let it through,
 * and the Jupiter-side range check `(0, 10_000)` let it through too.
 *
 * REJECT, NEVER COERCE. `0.5` could mean 0.5 bps or 0.5%; the caller's intent
 * is genuinely ambiguous, and guessing on a price-protection parameter is
 * exactly the wrong move. Rounding, flooring, or clamping a fractional bps is
 * forbidden here.
 *
 * NO CEILING IS APPLIED. A maximum-slippage bound is a product-policy decision
 * with its own owner; this module only enforces what is arithmetically
 * meaningful (finite, whole, non-negative).
 */

/**
 * Validate a basis-point param value.
 *
 * @returns an agent-actionable rejection reason, or `null` when the value is a
 * valid basis-point figure.
 *
 * The returned message ECHOES the offending number. `params.ts` deliberately
 * keeps values out of its messages ("could carry untrusted/secret-adjacent
 * content"), but that invariant is about STRINGS: this function is only ever
 * reached for a value Zod already proved to be a `number`, which cannot carry
 * injected text or secret material. Echoing it is what makes the correction
 * actionable ("you passed 0.5, pass 50").
 */
export function checkBpsParam(
  toolId: string,
  paramKey: string,
  value: number,
): string | null {
  const subject = `Parameter "${paramKey}" for ${toolId}`;

  if (!Number.isFinite(value)) {
    return `${subject} must be a finite whole number of basis points (1 bps = 0.01%).`;
  }

  // Checked BEFORE integrality: a negative tolerance is not a rounding
  // problem, it is a caller error. Never substitute a default for it — a
  // silent fallback hides the bug at a price-protection boundary.
  if (value < 0) {
    return (
      `${subject} must not be negative (got ${value}). Basis points express a `
      + `tolerance, so the smallest valid value is 0 (1 bps = 0.01%).`
    );
  }

  if (!Number.isInteger(value)) {
    return (
      `${subject} must be a whole number of basis points (got ${value}); `
      + `1 bps = 0.01%.${percentReadingHint(value)}`
    );
  }

  return null;
}

/**
 * Name the correct form for the value the caller most plausibly meant, WITHOUT
 * choosing it for them. The common mistake is passing a percentage into a bps
 * field (`0.5` meaning 0.5%), so we spell out that conversion — `0.5% → 50`,
 * `50.5% → 5050`. Emitted only when the percent reading is itself a whole
 * number of bps; otherwise there is no unambiguous suggestion worth making and
 * we stay silent rather than guess.
 */
function percentReadingHint(value: number): string {
  // `value * 100` can land on a float artefact (e.g. 1.1 * 100 = 110.00000000000001),
  // so round first and confirm the rounded figure round-trips to the input.
  const asBps = Math.round(value * 100);
  if (asBps / 100 !== value) return "";
  return ` If you meant ${value}%, pass ${asBps}.`;
}
