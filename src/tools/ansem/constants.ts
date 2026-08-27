/**
 * Ansem Z500 constants — the ranking feed behind the Z500 allocation-sync
 * workflow (indexiy-ansem.md).
 *
 * READ-ONLY BY DESIGN: this provider fetches one JSON document and validates
 * it. It holds no schedule, no retry loop, and no Indexify knowledge — the
 * workflow layer owns all of that.
 *
 * ACCESS POSTURE (spec: "Do not bypass authentication, authorization, rate
 * limits, or other access controls"): the client sends ordinary HTTP headers
 * and an OPTIONAL bearer token from ANSEM_API_KEY. When the origin answers
 * with a bot-management challenge (measured live 2026-08-28: Cloudflare
 * "Just a moment…" HTML on every path, browser headers included), that is an
 * access control and the answer is ANSEM_UNAVAILABLE — never a challenge
 * solver. The partner grants access by allowlisting or issuing a token; both
 * are zero-code here (config URL + env token).
 */

/** ENV var holding an optional feed token. Sent as `Authorization: Bearer`. */
export const ANSEM_API_KEY_ENV = "ANSEM_API_KEY";

/** The machine-readable endpoint the Ansem frontend itself uses. */
export const ANSEM_COINS_PATH = "/api/coins";

/**
 * The universe this workflow is pinned to, per the spec's Target
 * Configuration. Matched case-insensitively against the universe marker(s)
 * a coin row carries.
 */
export const ANSEM_UNIVERSE_CURATED = "Z500 Curated";

/**
 * Maximum age of a snapshot whose feed declares its own timestamp. A feed
 * timestamp older than this makes the snapshot STALE (spec failure branch).
 * One full schedule period plus slack: the workflow runs daily.
 */
export const ANSEM_MAX_SNAPSHOT_AGE_MS = 36 * 60 * 60 * 1000;

/** Solana mint shape — identity is strict everywhere in this workflow. */
export const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
