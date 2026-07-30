/**
 * "Empty means absent" — the model-boundary contract for `twitter_account`.
 *
 * WHY THIS EXISTS. A live session (2026-07-30) failed `tweet_search` five times
 * out of five in the same way: the model filled EVERY field the schema
 * advertises, using an empty value wherever it had nothing to say
 * (`query: ""`, `cursor: ""`, `fromUsers: []`, …) and putting its ONE real
 * criterion in `cashtags`. That is a standard LLM habit, not a malformed call —
 * and an empty value carries no information, so rejecting it taught the model
 * nothing and lost the criterion it did supply.
 *
 * WHAT IS NORMALIZED, and what deliberately is not:
 *  - `""` (or a whitespace-only string), `[]`, and a plain object that reduced
 *    to `{}` are dropped, recursively;
 *  - the `action` discriminator is NEVER dropped: it selects the contract, so
 *    an empty one must fail as an unrecognised action, not as a missing key;
 *  - nothing is invented. A dropped key was blank, so the schema then applies
 *    exactly the rule it applies to an omitted key: optional fields disappear,
 *    REQUIRED fields still fail (as missing, with the expectation stated at the
 *    handler boundary).
 *
 * Pure, and never mutates its input.
 */

/** The key whose value chooses the schema branch — normalization must not touch it. */
const DISCRIMINATOR_KEY = "action";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyModelValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Drop every empty OPTIONAL-shaped value from a model-supplied params object.
 * Applied as the pre-validation step of `TwitterAccountParamsSchema`; a
 * non-object input is returned untouched so Zod reports the real type error.
 */
export function dropEmptyModelValues(input: unknown): unknown {
  if (!isPlainObject(input)) return input;

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === DISCRIMINATOR_KEY) {
      normalized[key] = value;
      continue;
    }
    const normalizedValue = isPlainObject(value) ? dropEmptyModelValues(value) : value;
    if (isEmptyModelValue(normalizedValue)) continue;
    normalized[key] = normalizedValue;
  }
  return normalized;
}

/**
 * How the value at `path` ARRIVED, described by shape rather than echoed — the
 * handler uses it to turn a bare Zod path into a message that says what the
 * model actually did. Values are never printed: a search query is user content.
 */
export function describeReceivedValue(
  params: unknown,
  path: readonly PropertyKey[],
): string | null {
  let current: unknown = params;
  for (const segment of path) {
    if (!isPlainObject(current)) return null;
    current = current[String(segment)];
  }
  if (current === undefined) return null;
  if (current === null) return "null";
  if (typeof current === "string") return current.trim() === "" ? "an empty string" : "a string";
  if (Array.isArray(current)) return current.length === 0 ? "an empty list" : "a list";
  if (isPlainObject(current)) {
    return Object.keys(current).length === 0 ? "an empty object" : "an object";
  }
  return `a ${typeof current}`;
}
