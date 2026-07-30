/**
 * Approval intents — shared scalar normalisation.
 *
 * `pg` parses `TIMESTAMPTZ` into `Date` objects driver-side, but every repo
 * interface in this codebase exposes timestamps as ISO-8601 strings so the
 * boundary (IPC DTO, JSONB equality, snapshot comparison) stays scalar.
 *
 * Lives in its own module because BOTH the decision repo (`../approval-intents.ts`)
 * and the lifecycle repo (`./lifecycle.ts`) map rows; importing it from either
 * of those would create a cycle.
 */

export function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function toIsoOrNull(
  value: string | Date | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value);
}
