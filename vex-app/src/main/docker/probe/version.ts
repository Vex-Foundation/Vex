/**
 * Compose version floor + tolerant semver parsing/comparison used to gate
 * `compose up` before the inline-`configs.content:` template can fail with
 * an obscure `unknown field: content` error.
 */

/**
 * Minimum Docker Compose version required by vex-app's compose template.
 * The `configs:` block with inline `content:` was introduced in
 * Compose 2.23.1 (docker/compose#10942). Below this floor, `compose up`
 * fails with "unknown field: content" — the System Check screen
 * displays an actionable upgrade hint instead of letting the user hit
 * the cryptic failure.
 */
export const COMPOSE_VERSION_FLOOR = "2.23.1";

export interface ParsedSemver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/**
 * Tolerant semver parser — accepts `v2.23.1`, `2.23.1-desktop.1`,
 * `2.39.2+meta`, `v2.40.0-rc.2`. Returns null for anything that does
 * not start with major.minor.patch numeric triplet. The pre-release /
 * build suffix is ignored on purpose — Compose ships `-desktop.N`
 * variants that are semver-compatible with the base version.
 */
export function parseSemver(version: string | null): ParsedSemver | null {
  if (version === null || version.length === 0) return null;
  const stripped = version.startsWith("v") ? version.slice(1) : version;
  const match = stripped.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const [, majorStr, minorStr, patchStr] = match;
  if (
    majorStr === undefined ||
    minorStr === undefined ||
    patchStr === undefined
  ) {
    return null;
  }
  const major = Number.parseInt(majorStr, 10);
  const minor = Number.parseInt(minorStr, 10);
  const patch = Number.parseInt(patchStr, 10);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return null;
  }
  return { major, minor, patch };
}

/**
 * Returns true iff `actual >= minimum` after ignoring pre-release /
 * build suffixes. Used by the compose pre-flight to short-circuit with
 * a helpful error before attempting a `compose up` that would fail
 * with an obscure `unknown field: content` from the inline configs
 * block.
 */
export function semverGte(
  actual: string | null,
  minimum: string
): boolean {
  const a = parseSemver(actual);
  const b = parseSemver(minimum);
  if (a === null || b === null) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}
