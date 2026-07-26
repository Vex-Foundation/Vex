/**
 * Jupiter provider rejection → `agent_activity.failure_code` (Agent Scan
 * Phase 3, W4). The Solana/Jupiter counterpart of
 * `../kyberswap/failure-mapping.ts`, and it follows that module's two
 * doctrines: read the ALREADY-mapped/scrubbed error rather than re-deriving
 * it, and default to `"unknown"` rather than to a specific code.
 *
 * WHAT WAS WRONG. `handlers/lend.ts`, `handlers/lend-borrow.ts` and
 * `predict-execute.ts` each filed EVERY pre-broadcast provider rejection as
 * `route_not_found`. That code is agent-visible — `tools/internal/
 * inspect-views/transactions.ts` renders it back into the activity the agent
 * reads — so on 2026-07-25 the production DB told the agent a routing failure
 * when Jupiter Prediction had actually answered "Minimum order is $5". An
 * autonomous agent reads a routing failure as a liquidity problem and retries
 * a call that can never succeed.
 *
 * WHY THE DEFAULT IS `unknown`, NOT `route_not_found`. The stage/error table
 * in `@vex-agent/db/repos/agent-activity/validation.js` maps "pre-broadcast
 * param/quote validation" to `route_not_found` with the note "matches 044's
 * existing swap-quote-rejected semantics". For a SWAP that is right: a
 * rejected quote genuinely means no route. Lend, Borrow and Prediction have
 * no quote and no route, so the semantics do not transfer, and a specific
 * WRONG code is worse than the enum's honest catch-all. `route_not_found`
 * here is reserved for a refusal that actually names routing or fill.
 *
 * WHY PROSE. Jupiter's machine `code` (e.g. `"create_order_failed"`) is too
 * coarse to classify on — it is the same code for a size refusal and for a
 * closed market — so the provider's own sentence is the only signal that
 * separates them. `httpStatus` is used for what it IS evidence of: whether
 * the provider answered at all.
 *
 * The scenario names below (`insufficient_collateral:`, `market_closed:`,
 * `position_not_found:`) are the ones the mapping table already prescribes as
 * `failure_reason` TEXT under the closest existing code — R1's rule that a
 * domain scenario is a reason, not a new code. This module adds no code to
 * the enum.
 */

import type { AgentActivityFailureCode } from "@vex-agent/db/repos/agent-activity.js";
import { VexError } from "../../../../errors.js";
import { summarizeProtocolError } from "../runtime/errors.js";

export interface JupiterProviderFailure {
  /** A member of the closed `agent_activity.failure_code` enum. */
  readonly failureCode: AgentActivityFailureCode;
  /**
   * The scrubbed, bounded provider reason, prefixed with the named scenario.
   * Safe for both the DB column and agent-facing output: it comes from
   * `summarizeProtocolError`, which redacts secrets, strips URLs/auth/bodies
   * and caps the text, and the repo boundary re-caps it again.
   */
  readonly failureReason: string;
}

/**
 * Ordered most-specific first — the order is load-bearing. "insufficient
 * liquidity" must be tested before "insufficient balance" (both contain
 * "insufficient"), and a routing refusal before any bare "not found".
 *
 * Each entry names the scenario for the reason prefix (or `null` when the
 * failure code already names it) and the closed-enum code it maps to.
 */
const PROVIDER_REJECTION_PATTERNS: ReadonlyArray<{
  readonly match: RegExp;
  readonly scenario: string | null;
  readonly failureCode: AgentActivityFailureCode;
}> = [
  {
    match: /insufficient collateral|not enough collateral|collateral (?:is )?too low|under[- ]?collaterali[sz]ed/i,
    scenario: "insufficient_collateral",
    failureCode: "allowance_or_balance",
  },
  {
    match: /insufficient liquidity|not enough liquidity|no liquidity/i,
    scenario: null,
    failureCode: "insufficient_liquidity",
  },
  {
    match: /insufficient (?:balance|funds)|not enough (?:balance|funds)|exceeds (?:your )?balance|balance too low/i,
    scenario: "insufficient_balance",
    failureCode: "allowance_or_balance",
  },
  {
    match: /market (?:is |has |was )?(?:closed|resolved|settled|expired|ended)|no longer accepting|trading (?:is )?(?:halted|suspended|closed)/i,
    scenario: "market_closed",
    failureCode: "unknown",
  },
  {
    match: /(?:position|order|nft)(?: id)? (?:was )?not found|no (?:open |such )?(?:position|order)|(?:position|order) does not exist/i,
    scenario: "position_not_found",
    failureCode: "unknown",
  },
  {
    match: /minimum (?:order|size|amount|borrow|notional)|below (?:the )?minimum|minimum borrowing|maximum (?:order|size|amount)|(?:exceeds|above) (?:the )?maximum|order (?:is )?too (?:small|large)|amount (?:is )?too (?:small|large)/i,
    scenario: "order_size_rejected",
    failureCode: "unknown",
  },
  {
    match: /slippage|price impact|price (?:has )?moved/i,
    scenario: null,
    failureCode: "slippage",
  },
  {
    match: /\bexpired\b|deadline/i,
    scenario: null,
    failureCode: "deadline_expired",
  },
  {
    match: /no route|route (?:was )?not found|unable to (?:route|fill)|cannot (?:route|fill)|no path/i,
    scenario: null,
    failureCode: "route_not_found",
  },
];

/** How the failure reached us, when the prose said nothing recognizable. Names WHO refused, which decides whether a retry is even sane. */
function classifyUnrecognized(err: unknown, category: string): { scenario: string; failureCode: AgentActivityFailureCode } {
  if (category === "timeout" || category === "network") {
    return { scenario: "transport_failure", failureCode: "unknown" };
  }
  // Our OWN validation refused the parameters — saying "the provider
  // rejected this" would send the agent chasing the wrong cause.
  if (category === "invalid_request") {
    return { scenario: "invalid_request", failureCode: "unknown" };
  }
  const status = err instanceof VexError ? err.httpStatus : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    return { scenario: "provider_rejected", failureCode: "unknown" };
  }
  if (status !== undefined && status >= 500) {
    return { scenario: "provider_unavailable", failureCode: "unknown" };
  }
  return { scenario: "unclassified_failure", failureCode: "unknown" };
}

/**
 * Classify a caught pre-broadcast Jupiter provider error. Never throws — any
 * unrecognized shape lands on `"unknown"` with the provider's own (scrubbed)
 * words preserved, which is the part the agent actually needs.
 */
export function classifyJupiterProviderFailure(err: unknown): JupiterProviderFailure {
  const summary = summarizeProtocolError(err);
  const message = summary.message;

  for (const pattern of PROVIDER_REJECTION_PATTERNS) {
    if (!pattern.match.test(message)) continue;
    return {
      failureCode: pattern.failureCode,
      failureReason: pattern.scenario ? `${pattern.scenario}: ${message}` : message,
    };
  }

  const fallback = classifyUnrecognized(err, summary.category);
  return { failureCode: fallback.failureCode, failureReason: `${fallback.scenario}: ${message}` };
}
