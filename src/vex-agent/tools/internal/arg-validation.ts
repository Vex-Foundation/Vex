/**
 * Shared model-boundary argument hygiene for internal tools.
 *
 * Two responsibilities, both owned here so every internal tool speaks the same
 * dialect to the model:
 *
 *  1. RENDERING a Zod rejection the model can act on. zod 4 NEVER puts the
 *     field name in `issue.message` — `"Too small: expected string to have >=1
 *     characters"` names nothing — so `issue.path` is MANDATORY in every
 *     rendered error. A pathless `issues.map(i => i.message).join("; ")` tells
 *     the model that something was too small and leaves it to guess what.
 *  2. NORMALIZING the model's habit of filling every advertised field with an
 *     empty value. `""` / `[]` / `{}` carry no information, so at this boundary
 *     an empty OPTIONAL value means absent; rejecting it teaches nothing and
 *     loses the criteria the model did supply.
 *
 * Values are NEVER echoed back — only their SHAPE (rule 06). A query, an
 * address, or a note is user content, and an error message is a log line, a
 * transcript entry, and a prompt input all at once.
 *
 * Both helpers are pure and never mutate their input.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyModelValue(value: unknown, preserveNull = false): boolean {
  if (value === null) return !preserveNull;
  if (value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

/** Options for {@link dropEmptyModelValues}. */
export interface DropEmptyModelValuesOptions {
  /**
   * Keys that must survive normalization even when empty, at EVERY depth.
   *
   * A discriminator (`action`, `view`, …) selects the contract: dropping an
   * empty one turns "unrecognised action" — which names the legal actions —
   * into "missing key", which does not. A generic drop must never do that, so
   * the carve-out is per-schema rather than a hardcoded field name.
   */
  readonly preserveKeys?: readonly string[];
  /**
   * Keep an explicit `null` instead of treating it as empty.
   *
   * In most contracts `null` is just another way the model says "nothing". In
   * some it is a distinct INSTRUCTION: `mission_draft_update` uses `null` to
   * CLEAR a draft field, so dropping it would turn a clear into a no-op and the
   * agent would be told the field was updated when it still holds the old
   * value. Off by default — a contract that means it opts in.
   */
  readonly preserveNull?: boolean;
}

/**
 * Drop every empty value from a model-supplied params object, recursively.
 *
 * Applied as a PRE-VALIDATION step. Nothing is invented: a dropped key was
 * blank, so the schema then applies exactly the rule it applies to an omitted
 * key — optional fields disappear, REQUIRED fields still fail (as missing, with
 * the "it arrived empty" note supplied by {@link formatZodIssueForModel}, which
 * reads the ORIGINAL params). A non-object input is returned untouched so Zod
 * reports the real type error.
 */
export function dropEmptyModelValues(
  input: unknown,
  options: DropEmptyModelValuesOptions = {},
): unknown {
  if (!isPlainObject(input)) return input;
  const preserveKeys = options.preserveKeys ?? [];

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (preserveKeys.includes(key)) {
      normalized[key] = value;
      continue;
    }
    const normalizedValue = isPlainObject(value) ? dropEmptyModelValues(value, options) : value;
    if (isEmptyModelValue(normalizedValue, options.preserveNull)) continue;
    normalized[key] = normalizedValue;
  }
  return normalized;
}

/**
 * How the value at `path` ARRIVED, described by shape rather than echoed.
 * `null` when the path holds nothing to describe (absent, or unreachable).
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

/** The shape of a zod issue this module needs — kept structural so any zod version fits. */
export interface ModelFacingZodIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

/**
 * A rejection the model can act on: WHERE (the path), WHAT WAS EXPECTED (the
 * schema's own message — custom refinements carry the good ones), and HOW THE
 * VALUE ARRIVED, by shape.
 *
 * The shape matters because the commonest failing call is a field the model
 * considers blank rather than supplied: naming "an empty string" and the
 * empty-means-absent rule turns a mystery into an instruction.
 *
 * Pass the RAW params — the ones as they arrived, before any normalization —
 * so a field that was dropped for being empty can still say so.
 */
export function formatZodIssueForModel(
  issue: ModelFacingZodIssue | undefined,
  rawParams: unknown,
): string {
  if (!issue) return "invalid arguments";
  const path = issue.path.map(String).join(".");
  // A pathless issue is about the OBJECT AS A WHOLE (a top-level refine, an
  // unrecognised key, a union that matched no branch). "received an object"
  // would restate the obvious, so only a located issue gets a shape note.
  const received = path ? describeReceivedValue(rawParams, issue.path) : null;
  const note = received === null ? "" : shapeNote(received, issue.message);
  return path ? `${path}: ${issue.message}${note}` : `${issue.message}${note}`;
}

/**
 * The shape note, when it ADDS something.
 *
 * An EMPTY value always earns one: it carries the empty-means-absent
 * instruction, which is the single most useful thing this boundary can say.
 * Otherwise the note is suppressed when the schema's own message already names
 * the type that arrived — zod's "expected number, received string" needs no
 * "(received a string)" after it, and "limit must be a positive whole number …
 * (received a number)" reads as a contradiction rather than a diagnosis.
 */
function shapeNote(received: string, message: string): string {
  if (received.startsWith("an empty")) {
    return ` — it arrived as ${received}, and an empty value means ABSENT at this boundary: `
      + "supply a real value or omit the field entirely";
  }
  const typeWord = received.replace(/^an? /, "");
  if (message.toLowerCase().includes(typeWord)) return "";
  return ` (received ${received})`;
}

/**
 * Every issue, each independently located and shaped. Used where the site
 * previously joined raw messages; one call can be wrong in several places and
 * a model that fixes only the first burns a turn per field.
 */
export function formatZodIssuesForModel(
  issues: readonly ModelFacingZodIssue[],
  rawParams: unknown,
): string {
  if (issues.length === 0) return "invalid arguments";
  return issues.map((issue) => formatZodIssueForModel(issue, rawParams)).join("; ");
}
