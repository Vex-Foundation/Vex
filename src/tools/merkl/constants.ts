/**
 * Merkl constants: endpoint, identity, budget shape, and the bounds on how much
 * of one wallet's reward history Vex will read in a single answer.
 *
 * Merkl (`https://api.merkl.xyz`) is the distributor Morpho's reward campaigns
 * settle through. Morpho's own Universal Rewards Distributor is deprecated, so
 * this is where a "what can I claim" question is actually answered.
 *
 * LIVE PROBE 2026-08-14, all figures below observed rather than assumed:
 *
 *   - KEYLESS. No key, no signup, no auth header. `GET /v4/users/{address}
 *     /rewards?chainId=8453` answered HTTP 200 for a plain request carrying only
 *     `User-Agent` and `Accept`.
 *   - RATE LIMIT IS PUBLISHED ON EVERY RESPONSE: `x-ratelimit-limit: 4200,
 *     4200;w=60`, with `x-ratelimit-remaining` and `x-ratelimit-reset` beside
 *     it. That is 70 requests a second, two orders of magnitude above anything
 *     an agent read needs.
 *   - `chainId` IS REQUIRED. Omitting it answers HTTP 400 with a validation
 *     body. Repeating it (`?chainId=8453&chainId=1`) does NOT widen the query:
 *     the live response carried Base alone. One chain per request, always.
 *   - CACHING: `cache-control: public, max-age=60`.
 */

/** Merkl's public API root. Keyless; no configuration knob, no key to leak. */
export const MERKL_API_BASE_URL = "https://api.merkl.xyz";

/**
 * Explicit outbound identity (rules/06 - Outbound Provider Requests). Relying on
 * the runtime's default `user-agent` is relying on an accident that a proxy or
 * an Electron network stack can strip.
 */
export const MERKL_USER_AGENT = "Vex-Agent/1.0 (+https://vexlabs.ai)";

/**
 * Vex's self-imposed ceiling, far under Merkl's published 4,200/minute.
 *
 * The number is NOT a guess at Merkl's tolerance - Merkl told us its tolerance
 * and we are nowhere near it. It is a bound on OUR fan-out: one rewards answer
 * costs one request per chain plus one per distinct reward campaign it has to
 * name, and an agent looping over nine chains must not be able to turn a single
 * user question into an unbounded burst.
 */
export const MERKL_REQUESTS_PER_MINUTE = 120;

/**
 * Cache windows. Merkl serves `max-age=60`; matching it locally cannot show
 * anything staler than the provider would have served from its own edge.
 *
 * Reward roots update on Merkl's distribution cadence (hours), not per block, so
 * a 60-second window cannot mislead. Campaign and opportunity metadata is
 * effectively static for the life of a campaign and is held far longer, because
 * it is the part a multi-chain answer re-reads most.
 */
export const MERKL_TTL = {
  userRewards: 60_000,
  opportunity: 900_000,
} as const;

/**
 * The most distinct reward campaigns Vex will resolve to a named source in one
 * answer.
 *
 * Attribution costs one request per distinct opportunity id, and a long-lived
 * wallet's reward rows can reference many. The cap is disclosed in the result
 * when it binds rather than silently trimming the list: an unattributed reward
 * is still reported, labelled as unresolved, because dropping it would hide
 * money the user can claim.
 */
export const MERKL_MAX_OPPORTUNITY_LOOKUPS = 24;

/**
 * Merkl's protocol id for Morpho, live-verified 2026-08-14 on the opportunity
 * `Supply to the Moonwell Flagship USDC vault on Morpho on Base`, whose
 * `protocol` block reads `{id: "morpho", name: "Morpho", tags: ["LENDING",
 * "drip"]}`. This is the ONLY honest attribution key available: a reward row
 * itself names no protocol, only a campaign and an opportunity id.
 */
export const MERKL_MORPHO_PROTOCOL_ID = "morpho";
