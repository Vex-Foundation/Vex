/**
 * Cross-boundary env-key constants for vex-app onboarding (M9).
 *
 * Re-exports a curated subset of canonical .env key names. Stays lean on
 * purpose so vex-app preload contexts do not load wallet/decrypt modules.
 *
 * vex-app builds its own typed surface (Zod schemas + per-field UI
 * metadata) on top of the bare key names exported here.
 *
 */

/** Canonical .env key for the (required) Jupiter API key. */
export const ENV_JUPITER_API_KEY = "JUPITER_API_KEY";

/** Canonical .env key for the (optional) Tavily web research key. */
export const ENV_TAVILY_API_KEY = "TAVILY_API_KEY";

/** Canonical .env key for the (optional) Rettiwt session key. */
export const ENV_RETTIWT_API_KEY = "RETTIWT_API_KEY";

/**
 * Ordered tuple of API-key env names the M9 wizard manages.
 * Order is canonical and surfaces in `fieldsWritten` IPC outputs so
 * UI rendering / log redaction can iterate deterministically.
 *
 */
export const TRACKED_API_KEYS = [
  ENV_JUPITER_API_KEY,
  ENV_TAVILY_API_KEY,
  ENV_RETTIWT_API_KEY,
] as const;

export type TrackedApiKey = (typeof TRACKED_API_KEYS)[number];
