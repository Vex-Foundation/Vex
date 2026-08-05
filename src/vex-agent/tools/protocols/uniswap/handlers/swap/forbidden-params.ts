/**
 * Fee parameters Vex derives itself and MUST NOT accept from a caller or model.
 *
 * The rate and the receiver are product constants (`@tools/uniswap/fee`). A
 * caller-supplied one is rejected BY NAME rather than silently dropped: a
 * silent drop hides an attempted overcharge instead of surfacing it (rule 90).
 * Applied on BOTH `uniswap.swap.quote` and `uniswap.swap.execute`, so a quote
 * can never appear to authorize a fee the execute would refuse.
 */

const FORBIDDEN_FEE_PARAMS = ["fee", "feeBps", "feeReceiver", "feeAmount"] as const;

/**
 * The rejection reason for the first caller-supplied fee param, else null.
 *
 * PRESENCE of the key is the violation, whatever it carries: an empty string,
 * `null`, or an explicit `undefined` is still an attempted override.
 */
export function checkForbiddenFeeParams(params: Readonly<Record<string, unknown>>): string | null {
  for (const key of FORBIDDEN_FEE_PARAMS) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      return `Parameter "${key}" is not accepted — Vex's swap fee rate and receiver are fixed product constants; remove it and retry.`;
    }
  }
  return null;
}
