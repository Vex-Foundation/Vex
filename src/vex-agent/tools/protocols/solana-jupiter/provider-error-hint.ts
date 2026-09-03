/**
 * Append a Vex hint to a provider's own error WITHOUT replacing it (W2g).
 *
 * WHAT WAS WRONG. Two Jupiter Prediction mappers REWROTE a provider error
 * into a fixed Vex sentence keyed on nothing but an HTTP status:
 * `predict-region-block.ts` turned EVERY 403 from any of the 18 prediction
 * reads into "you are in the US", and `handlers/predict-social.ts` turned
 * EVERY 404 on `pnl-history` into "the endpoint is down upstream". An
 * entitlement 403, a non-geographic IP ban and a WAF refusal are all real and
 * all read as a geo-block; the module's own doc admitted "No live geo-blocked
 * capture exists". The provider's words - the only evidence that separates
 * those cases - were discarded, and so was `httpStatus`, the one field a
 * caller can branch on.
 *
 * THE RULE THIS ENCODES (rules/04, agent-facing tool errors surface the REAL
 * cause; rules/90, never claim more than the evidence supports): a status is
 * evidence that the provider ANSWERED and evidence of the response CLASS. It
 * is not evidence of the CAUSE. So the provider's sentence stays first and
 * intact, the Vex hint follows as a named possibility, and `httpStatus`,
 * `code` and `externalName` are all carried through so nothing downstream -
 * `classifyError`'s status-first branch, `provider-failure-mapping.ts`, the
 * activity row - loses the fact that a provider refused.
 *
 * The original error is preserved as `cause`, per rules/03.
 */

import { VexError } from "../../../../errors.js";

/**
 * Return a VexError carrying the provider's own message with `hint` appended,
 * or the original error untouched when it is not a `VexError` answering with
 * `status` (nothing to append to, and nothing proven).
 *
 * The hint is an authored literal - never provider bytes - so it is appended
 * after the provider's already-scrubbed text rather than mixed into it.
 */
export function appendProviderHint(err: unknown, status: number, hint: string): unknown {
  if (!(err instanceof VexError) || err.httpStatus !== status) return err;

  const appended = new VexError(err.code, `${err.message} ${hint}`, err.hint);
  appended.httpStatus = err.httpStatus;
  if (err.externalName !== undefined) appended.externalName = err.externalName;
  if (err.retryable !== undefined) appended.retryable = err.retryable;
  appended.cause = err;
  return appended;
}
