/**
 * Which required parameters are ACTUALLY absent — the one place that decides.
 *
 * THE DEFECT THIS CLOSES, measured in the persona gate
 *
 * `dexscreener.tokens` with a valid `chain` and an empty `tokenAddresses`
 * answered `"Missing required: chain, tokenAddresses"`. The message was a
 * hard-coded list of the tool's required params rather than a list of the gaps,
 * so it accused a parameter the caller had supplied correctly. A context-free
 * agent reads that as "my chain is wrong too" and re-sends both — spending a
 * call to re-learn what it already had right.
 *
 * A shared module rather than a helper inside one handler file: `orders` is
 * deliberately not a pair-list or feed handler and must not reach into
 * `./core.ts` for this, and a second copy of the rule is how the two would drift
 * into two different message shapes.
 *
 * "Absent" is `""` as well as missing, matching the runtime param boundary's own
 * empty-string-as-absent semantics (`runtime/params.ts`) and `str()`, which
 * returns `""` for a param that was never sent.
 */

/**
 * @param supplied every REQUIRED param of the tool, mapped to the value read for
 * it. Order determines the order they are named in.
 * @returns the rejection message, or `null` when nothing is missing.
 */
export function missingRequired(
  toolId: string,
  supplied: Readonly<Record<string, string | null>>,
): string | null {
  const absent = Object.entries(supplied)
    .filter(([, value]) => value === null || value === "")
    .map(([key]) => key);
  if (absent.length === 0) return null;
  return `${toolId}: missing required parameter${absent.length > 1 ? "s" : ""}: ${absent.join(", ")}`;
}
