/**
 * The protocols that can actually appear in the Agent Scan feed.
 *
 * WHY THIS IS NOT DERIVED FROM `lib/protocol-marks.ts`. That map answers a
 * different question — "what does this venue look like?" — and knows every
 * venue we have artwork or a name for, including ones that can never reach
 * this feed. Sourcing the filter from it shipped a real defect the owner
 * caught in the live build: the protocol filter offered **Polymarket**
 * (removed from the product in Phase 1 — nothing writes it any more) and
 * **DexScreener** (a read-only market-data tool that executes nothing).
 * Selecting either could only ever return an empty feed, which on an audit
 * surface reads as "the agent never did this" rather than "this filter is
 * meaningless".
 *
 * THE RULE: a feed's filter options come from the set of things that WRITE
 * that feed. Agent Scan reads `agent_activity`, so the option list is exactly
 * the executors that write rows to it today:
 *
 *   kyberswap · uniswap — EVM swap executors
 *   jupiter             — Solana swaps, Jupiter Lend, Jupiter predictions
 *   trench              — Trench Express launchpad trades (Robinhood Chain)
 *   morpho              — EVM vault supply / redeem (`lend` rows); its handler
 *                         writes `agent_activity` directly, same staged path as
 *                         Jupiter Lend
 *   pools               — pools.fun launches and fee claims (Robinhood Chain)
 *   khalani · relay     — bridge executors
 *
 * `pools` joined the list in Phase 3, WITH the launch and claim executors that
 * write its rows — deliberately not in Phase 2, when the namespace shipped as
 * read-only tools and an option here could only ever have returned an empty
 * feed. That is the same defect described below, and the timing is the fix.
 *
 * DELIBERATELY ABSENT:
 *  - `pendle` — still captured only into the LEGACY `proj_activity` table, so
 *    an Agent Scan filter for it would also always be empty. It joins this
 *    list in Phase 4, when its capture migrates to `agent_activity`.
 *  - `dexscreener` — read-only market data; it never executes anything.
 *  - `polymarket` — deleted from the product; no writer remains.
 *
 * TOLERANT RENDERING IS UNAFFECTED. This list curates the FILTER OPTIONS only.
 * A row whose `protocol` is something else — a new executor, or a value this
 * build predates — still renders normally with its own name and mark
 * (`resolveProtocolMark`). Never gate row rendering on this list.
 *
 * OWNERSHIP NOTE: the natural long-term owner is the shared
 * `@shared/agent-activity-vocabulary.ts` module, beside the kind/role/status
 * vocabularies it already owns — main could then use the same list to validate
 * a filter server-side. That file belongs to the data layer, so this renderer
 * constant is the interim home.
 */

import { resolveProtocolMark } from "../../../../lib/protocol-marks.js";

/**
 * Executors that write `agent_activity` today, in the order the filter shows
 * them: swaps first, then lending, then the bridge providers.
 */
export const KNOWN_FEED_PROTOCOLS = [
  "kyberswap",
  "uniswap",
  "jupiter",
  "trench",
  "morpho",
  "pools",
  "khalani",
  "relay",
] as const;

export interface FeedProtocolOption {
  /** The lower-case venue string the DTO carries and the filter sends. */
  readonly value: string;
  /** Display label, taken from the mark resolver so casing lives in one place. */
  readonly label: string;
}

/** The filter's options, labelled through the same resolver the marks use. */
export const FEED_PROTOCOL_OPTIONS: readonly FeedProtocolOption[] =
  KNOWN_FEED_PROTOCOLS.map((value) => ({
    value,
    label: resolveProtocolMark(value)?.label ?? value,
  }));
