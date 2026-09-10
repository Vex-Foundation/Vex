/**
 * One owner for EVM venue guidance. KyberSwap is the operational default;
 * direct Uniswap is the fallback and the more stable choice on Robinhood.
 * Consumers import these atoms so descriptions, prompts and Studio agree.
 * Each execute remains bound to its own venue's fresh approved quote.
 */
export const ROBINHOOD_SWAP_VENUE_GUIDANCE =
  "On Robinhood Chain, quote both venues when both price the pair; prefer direct Uniswap when it has a route (V2/V3/v4). "
  + "KyberSwap drops quiet pools; its USD reference lags. Elsewhere, KyberSwap is the usual first choice.";

export const SWAP_VENUE_STANDING =
  "KyberSwap is the default; Uniswap prices V2, V3 and v4 pools on seven chains. "
  + "Other DEX liquidity may be unavailable there. "
  + ROBINHOOD_SWAP_VENUE_GUIDANCE;

/** Compact default policy for bounded always-loaded descriptions. */
export const SWAP_VENUE_STANDING_COMPACT =
  "KyberSwap is default; Uniswap is the direct fallback";

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
  "Use this venue when KyberSwap is unavailable in the user's region; it prices Uniswap V2, V3 "
  + "and v4 pools on seven chains. Liquidity only on other DEXes may be unavailable here.";

/** Appended only to the closed 401/403/451 edge-refusal outcome. */
export const KYBERSWAP_EDGE_BLOCK_REMEDY =
  " KyberSwap is not reachable from this network or region; retry this trade with "
  + "`uniswap__swap_quote` then `uniswap__swap_execute` on the same chain. "
  + "That venue prices Uniswap V2, V3 and v4 pools directly on seven chains; liquidity only on "
  + "other DEXes may be unavailable there. If its quote finds no route, explain the coverage "
  + "limit instead of retrying blocked KyberSwap.";

/** The doctrine as one sentence pair, for a surface with room for it. */
export const SWAP_VENUE_GUIDANCE =
  `${SWAP_VENUE_STANDING} ${SWAP_VENUE_QUOTE_BOTH} ${SWAP_VENUE_EXECUTE_RULE}`;



/** The whole doctrine, for the system prompt, the Tool Map and the Studio brief. */
export const SWAP_VENUE_GUIDANCE_FULL =
  `${SWAP_VENUE_STANDING} Use Uniswap when KyberSwap is region/edge-blocked, `
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
  " Try direct Uniswap for this trade: quote it with SwapQuoteUniswap, "
  + "then execute with SwapExecuteUniswap.";

/**
 * What Uniswap is FOR, in its own right - the positive "best for" clause the
 * venue's own descriptions carry instead of a fallback condition.
 */
export const UNISWAP_BEST_FOR =
  "Best for pricing straight off the pools with no aggregator in the path: a chain or pair "
  + "KyberSwap does not cover, and a thin pair whose indexed reserves an aggregator can read stale.";
