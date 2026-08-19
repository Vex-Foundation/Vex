/**
 * The sentences every DexScreener pair param inherits (split out of
 * `../pair-list-params.ts` in 0R.16, refactor-only). They live in one module
 * because a correction to the window truth must land in exactly one place —
 * it cannot be allowed to fix the params and miss the description.
 */

/** Repeated in the params that can silently mislead about coverage. */
export const WINDOW_CLAUSE =
  "Applied by Vex to the at most 30 rows DexScreener returned — it cannot reach rows outside "
  + "that window.";

/**
 * Every param that accepts BOTH spellings says so, in one sentence, once.
 *
 * Shared with the feed vocabulary (`../feed-list-params.ts`) and the identity
 * params in `../core.ts` for the same reason the KEYS are shared: an agent that
 * learned the array form on `search` must not have to re-learn it on `boosts`.
 *
 * The cost of NOT saying it is measured — `call-records.json`, first record:
 * `dexscreener.profiles {chainIds: ["solana"]}` was rejected in 78 bytes while
 * `chainIds: "solana"` answered in 5,215.
 */
export const STRING_OR_ARRAY_CLAUSE =
  'Accepts either a comma-separated string ("a,b") or an array of strings (["a","b"]) — the two '
  + "are equivalent.";

/**
 * The same truth at TOOL level, for the `description` of `search` and `tokens`.
 *
 * It lives beside `WINDOW_CLAUSE` rather than in the manifest so the window fact
 * still has exactly one owner per family: a future correction cannot land on the
 * params and miss the description, or on one tool and miss its sibling. The
 * pair-lookup tools state their own narrower truth inline — `pairs` has no window
 * to disclose and `tokenPairs` is truncated by the provider before we see it.
 */
export const PAIR_DESCRIPTION_WINDOW_CLAUSE =
  "Every filter, sort and window is applied by Vex to at most 30 provider-chosen rows per call. "
  + "DexScreener offers no server-side filter, sort, limit or pagination, and there is no way to "
  + "widen the window.";

/**
 * The freshness envelope every DexScreener handler emits, described once for
 * all 14 tools. An envelope the manifest never names is discoverable only by
 * paying for a call - and the undocumented half of the old block admitted a
 * derivation that read "fresh" when the truth was "unknown".
 */
export const SOURCE_OBSERVATION_CLAUSE =
  "Every response carries sourceObservation: observed (true = the transport was measured; the "
  + "age may STILL be unknown), responseAtMs (when Vex answered; asOfMs echoes it), "
  + "localCacheHit/localCacheAgeMs (Vex's own cache only - 0 beside a null dataAgeMs means the "
  + "local fetch was live, not that the data is), upstreamAgeMs + upstreamAgeKnown (DexScreener's "
  + "CDN age, from its whole-second Age header), providerFetchedAtMs (derived origin time, about "
  + "1 s quantized; null when the upstream age is unknown), and dataAgeMs - the PROVABLE FLOOR of "
  + "data age, never a worst case (null means unknown, never fresh). Batched or merged calls "
  + "report the stalest completed fetch. Nothing here is real-time.";
