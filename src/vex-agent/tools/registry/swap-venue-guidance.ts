/**
 * THE ONE OWNER of what Vex tells the model about choosing between its two EVM
 * swap venues (owner decision, 2026-09-07).
 *
 * Before this module the policy had FIVE writers - the two venues' manifests,
 * the always-loaded alias descriptions, the Tool Map category labels,
 * `engine/prompts/task-shapes.ts`, and `navigation/*.preferInstead` - each with
 * its own wording. Four of them said Uniswap was a fallback; the fifth was not
 * rendered anywhere. A model could read two of those in one context window and
 * get two different rankings.
 *
 * WHAT THE POLICY IS. The two venues have EQUAL STANDING. KyberSwap is usually
 * the better first choice for a reason the model can check (it aggregates
 * routes across many DEXes, so it usually prices better), not because Uniswap
 * is a lesser tool: Uniswap prices V2 and V3 pools on-chain with no aggregator
 * in the path, which is exactly what serves a pair the aggregator does not
 * cover or whose indexed reserves are stale. When neither is obviously right,
 * quote both. Whichever is used, the execute runs against that venue's own
 * quote - the runtime enforces it, and this text only states it.
 *
 * WHAT THIS MODULE DOES NOT OWN. The BRIDGE lane (Khalani and Relay) is
 * untouched by that decision and keeps its own wording, which is a routing
 * fact rather than a preference: `BridgeQuote` picks the venue itself from
 * Khalani's live registry (`src/tools/relay/bridge-venue.ts`).
 *
 * WHY THERE ARE SEVERAL FORMS RATHER THAN ONE STRING. The always-loaded
 * descriptions are bound at `ALWAYS_LOADED_DESCRIPTION_MAX_CHARACTERS` (2048,
 * the measured point a client cuts), and two of them sit within three
 * characters of it. A single long sentence would not fit without deleting a
 * money-path fact from the same description, so the doctrine is composed from
 * ATOMS here and each surface carries the longest form its budget allows. The
 * atoms are the single source: a surface never re-words the policy locally.
 *
 * Consumers: `registry/action-aliases.ts`, `registry/tool-map.ts`,
 * `protocols/{uniswap,kyberswap}/manifests/swap.ts`,
 * `protocols/navigation/entries-market/{uniswap,kyberswap}.ts`,
 * `protocols/kyberswap/handlers/swap/fallback-messaging.ts`,
 * `engine/prompts/{task-shapes,tool-model}.ts`,
 * `studio/instructions/project-brief.ts`. The lint rule
 * `retired-venue-precedence` (`protocols/_manifest-lint/source-rules.ts`) keeps
 * the retired phrasings from coming back anywhere else.
 */

/**
 * The comparison, stated symmetrically: each venue's own capability, and the
 * reason one is usually tried first. Never "primary" and "alternative" - a
 * ranking the model cannot check is a ranking it cannot correct.
 */
export const SWAP_VENUE_STANDING =
  "KyberSwap is usually the better first choice because it aggregates routes across many DEXes; "
  + "Uniswap is an equal-standing venue that prices V2 and V3 pools directly.";

/**
 * The same standing in the fewest words that still say "equal", for the
 * always-loaded descriptions that have no room for {@link SWAP_VENUE_STANDING}.
 * The REASON KyberSwap is usually tried first is dropped here and carried by
 * the Tool Map label and the swap task shape, which are in the same context
 * window and are not budget-bound.
 */
export const SWAP_VENUE_STANDING_COMPACT =
  "KyberSwap and Uniswap are equal-standing swap venues";

/** What resolves the choice when neither venue is obviously the right one. */
export const SWAP_VENUE_QUOTE_BOTH = "Quote both when unsure.";

/**
 * The rule binding an execute to the venue its quote came from. Stated, not
 * enforced here: the prequote registry is what refuses a mismatched pair.
 */
export const SWAP_VENUE_EXECUTE_RULE = "Execute on the venue you quoted.";

/** Regional refusal remedy shared by both KyberSwap tool descriptions. */
export const KYBERSWAP_EDGE_BLOCK_GUIDANCE =
  "When KyberSwap refuses with a regional or edge block, switch to `uniswap__swap_quote` "
  + "then `uniswap__swap_execute` on the same chain.";

/** The direct venue's regional role and current pool-version limit. */
export const UNISWAP_REGIONAL_GUIDANCE =
  "Use this venue when KyberSwap is unavailable in the user's region; it covers Uniswap V2 "
  + "and V3 pools only, with no v4 support yet.";

/** Appended only to the closed 401/403/451 edge-refusal outcome. */
export const KYBERSWAP_EDGE_BLOCK_REMEDY =
  " KyberSwap is not reachable from this network or region; retry this trade with "
  + "`uniswap__swap_quote` then `uniswap__swap_execute` on the same chain. "
  + "That venue prices Uniswap V2 and V3 pools directly, so a token whose only liquidity is in "
  + "Uniswap v4 pools cannot be traded there yet. Tell the user about that limitation instead "
  + "of retrying KyberSwap.";

/** The doctrine as one sentence pair, for a surface with room for it. */
export const SWAP_VENUE_GUIDANCE =
  `${SWAP_VENUE_STANDING} ${SWAP_VENUE_QUOTE_BOTH} ${SWAP_VENUE_EXECUTE_RULE}`;

export const ROBINHOOD_SWAP_VENUE_GUIDANCE =
  "On Robinhood Chain, quote both venues when both price the pair; prefer direct Uniswap when it has a route "
  + "(V2/V3 only, no v4). KyberSwap drops quiet pools; its USD reference lags. "
  + "Elsewhere, KyberSwap is the usual first choice.";

/** The whole doctrine, for the system prompt, the Tool Map and the Studio brief. */
export const SWAP_VENUE_GUIDANCE_FULL =
  `${ROBINHOOD_SWAP_VENUE_GUIDANCE} Use Uniswap when KyberSwap is region/edge-blocked, `
  + `unavailable, mispriced, or on request. ${SWAP_VENUE_QUOTE_BOTH} ${SWAP_VENUE_EXECUTE_RULE}`;

/** The compact form, for an always-loaded quote description at the 2048 bound. */
export const SWAP_VENUE_GUIDANCE_COMPACT =
  `${SWAP_VENUE_STANDING_COMPACT}; quote both when unsure.`;

/**
 * The compact form PLUS the other venue's callable name, for `SwapQuote` - the
 * KyberSwap-side router, and the one surface where the model would otherwise
 * be told a peer exists without being told what to call. The name is a bare
 * parenthetical rather than a clause because that description sits four
 * characters under the 2048-character client cut (measured 2026-09-07), and
 * the alternative was deleting a money fact from the same string to make room
 * for grammar.
 */
export const SWAP_VENUE_GUIDANCE_COMPACT_ROUTER =
  `${SWAP_VENUE_STANDING_COMPACT} (SwapQuoteUniswap); quote both when unsure.`;

/**
 * The sentence a KyberSwap failure appends when a second venue could actually
 * serve the trade (`kyberswap/handlers/swap/fallback-messaging.ts` decides
 * WHEN; this is WHAT it says). Leading space: it is appended to a message.
 */
export const SWAP_VENUE_PEER_NUDGE_SUFFIX =
  " Uniswap is an equal-standing venue for this trade: quote it with SwapQuoteUniswap, "
  + "then execute with SwapExecuteUniswap.";

/**
 * What Uniswap is FOR, in its own right - the positive "best for" clause the
 * venue's own descriptions carry instead of a fallback condition.
 */
export const UNISWAP_BEST_FOR =
  "Best for pricing straight off the pools with no aggregator in the path: a chain or pair "
  + "KyberSwap does not cover, and a thin pair whose indexed reserves an aggregator can read stale.";
