/**
 * Pure Docker probe parser (fixture-testable). Operates on the output of
 * `docker compose version` so the test suite never needs Docker installed.
 */

export function parseComposeVersion(stdout: string): string | null {
  // "Docker Compose version v2.32.4" or "Docker Compose version 2.32.4"
  const match = stdout.match(/Docker Compose version\s+(v?[\d][\w.+-]*)/);
  return match?.[1] ?? null;
}
