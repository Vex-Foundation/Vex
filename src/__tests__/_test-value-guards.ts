/**
 * Runtime guards that let a test narrow a value without an unsafe type escape.
 *
 * A test that writes `result.vault!.name` asserts nothing: when the vault is
 * absent the test dies on a bare "cannot read properties of null" with no clue
 * which expectation was being made. These guards fail loudly with the caller's
 * own label instead, and narrow the type honestly, so no `!`, `as any`,
 * `as never`, or `as unknown as` is needed at the call site.
 *
 * Every function here narrows through a real runtime check or a type predicate.
 * None of them contains a cast: this module exists to remove escapes from the
 * test tree, so introducing one here would defeat its whole purpose.
 */

/**
 * Returns `value` proven non-nullish, or throws naming what was missing.
 *
 * Use in place of a non-null assertion on anything the production type says may
 * legitimately be `null` or `undefined`: a `.find()` result, an optional field,
 * a nullable provider column.
 */
export function definedValue<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be defined, got ${value === null ? "null" : "undefined"}`);
  }
  return value;
}

/** True when `value` is a non-array object usable as a string-keyed bag. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Views an object fixture as a mutable string-keyed bag so a test can corrupt
 * one field and assert the validator rejects it, without casting the fixture.
 */
export function mutableRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`expected ${label} to be a plain object, got ${value === null ? "null" : typeof value}`);
  }
  return value;
}

/** Same as `mutableRecord`, for an array of object rows. */
export function mutableRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array, got ${value === null ? "null" : typeof value}`);
  }
  return value.map((entry, index) => mutableRecord(entry, `${label}[${index}]`));
}
