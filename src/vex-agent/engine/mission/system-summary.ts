/**
 * System-generated mission summary — the fallback account of a run that
 * ended without the agent ever calling `mission_stop`.
 *
 * WHY THIS EXISTS. A 6-hour live mission hit a provider error, parked, and
 * then timed out. It never called `mission_stop`, so `stop_summary` stayed
 * null and the mission card fell back to a strip of raw metrics — at
 * exactly the moment the operator most needed to be told what had happened
 * to their money. Worse, the run had left a position open with nothing
 * watching it, and nothing on screen said so.
 *
 * WHAT THIS IS NOT. This is not a stand-in for the agent. It is assembled
 * from the run record and says only what that record proves:
 *
 *   1. It is LABELLED. Every summary opens with `SYSTEM_SUMMARY_LABEL` so
 *      the operator can tell at a glance that no agent wrote this.
 *   2. It never speaks AS the agent, and never invents the agent's
 *      reasoning, thesis, or intent. The agent's silence is a fact about
 *      the run, and it is reported as one.
 *   3. Every figure comes from the ledger record passed in — never
 *      computed from prose, never estimated, and omitted entirely when the
 *      record does not carry it.
 *
 * The highest-value line by far is the still-open-position warning: an
 * unmanaged position after a dead run is money at risk right now.
 */

/** Opens every system-generated summary. The operator must never mistake this for the agent's own words. */
export const SYSTEM_SUMMARY_LABEL =
  "Automatic summary — the agent stopped without writing one, so this was assembled from the run record.";

export interface SystemSummaryFacts {
  /** Terminal ledger outcome. */
  readonly outcome: "completed" | "cancelled" | "failed" | "stopped";
  /** Raw engine StopReason, or null when the run died without recording one. */
  readonly stopReason: string | null;
  /** Trades executed during the run, from the ledger row. */
  readonly trades: number;
  /** Ledger PnL in ETH. Null when start/end bankroll could not be read. */
  readonly pnlEth: number | null;
  /** ETH price at close, for the USD conversion. Null when unavailable. */
  readonly ethPriceUsd: number | null;
  /** Symbols still held when the run died. Non-empty means money is unmanaged. */
  readonly openPositionSymbols: readonly string[];
}

/**
 * Plain-language cause of death, keyed on the raw StopReason.
 *
 * Deliberately describes the MECHANISM only. "A connection failed" is a
 * fact from the record; "the agent decided the setup had broken down"
 * would be an invention.
 */
const REASON_PROSE: Readonly<Record<string, string>> = {
  goal_reached: "The run reported that it had reached its goal.",
  deadline_reached: "The run reached its time limit and was stopped.",
  capital_depleted: "The run ran out of funds to keep trading with.",
  max_loss_hit: "The run hit the maximum loss you allowed and was stopped.",
  no_viable_opportunity: "The run did not find anything it was willing to trade.",
  emergency_stop: "The run was halted by an emergency stop.",
  user_stopped: "You stopped this run.",
  provider_error: "The connection to the trading service failed and the run could not continue.",
  system_error: "A system error ended the run.",
  waiting_for_wake: "The run was waiting to resume and never did.",
  compact_unable_at_critical: "The run could not free up enough working memory to continue.",
};

/** Format an ETH PnL as USD, or null when the record cannot support a figure. */
function pnlUsdText(pnlEth: number | null, ethPriceUsd: number | null): string | null {
  if (pnlEth === null || ethPriceUsd === null) return null;
  if (!Number.isFinite(pnlEth) || !Number.isFinite(ethPriceUsd)) return null;
  const usd = pnlEth * ethPriceUsd;
  const sign = usd > 0 ? "+" : usd < 0 ? "-" : "";
  return `${sign}$${Math.abs(usd).toFixed(2)}`;
}

/** Oxford-comma join: `a`, `a and b`, `a, b and c`. */
function joinSymbols(symbols: readonly string[]): string {
  if (symbols.length === 1) return symbols[0]!;
  return `${symbols.slice(0, -1).join(", ")} and ${symbols[symbols.length - 1]!}`;
}

/**
 * Build the fallback summary as `- `-prefixed bullets, matching the shape
 * the card already renders for agent-authored prose.
 *
 * Ordering is by what the operator must act on: the label, why it stopped,
 * then the still-open warning (money at risk), then activity and PnL.
 */
export function buildSystemSummary(facts: SystemSummaryFacts): string {
  const bullets: string[] = [`${SYSTEM_SUMMARY_LABEL}`];

  const reason =
    facts.stopReason === null
      ? null
      : (REASON_PROSE[facts.stopReason] ?? null);
  if (reason !== null) {
    bullets.push(reason);
  } else if (facts.outcome === "failed") {
    bullets.push("The run stopped unexpectedly and did not record why.");
  } else {
    bullets.push("The run ended without recording a reason.");
  }

  // The line that matters most: a position nobody is watching.
  const open = facts.openPositionSymbols;
  if (open.length > 0) {
    const what = joinSymbols(open);
    const isAre = open.length === 1 ? "is" : "are";
    bullets.push(
      `${what} ${isAre} STILL OPEN and no longer being managed — the run ended without selling, so nothing is watching this position or acting on its exit levels. Check it in your wallet.`,
    );
  }

  bullets.push(
    facts.trades === 0
      ? "No trades were made during this run."
      : `${facts.trades} ${facts.trades === 1 ? "trade was" : "trades were"} made during this run.`,
  );

  const usd = pnlUsdText(facts.pnlEth, facts.ethPriceUsd);
  if (usd === null) {
    bullets.push("The profit or loss for this run could not be determined from the record.");
  } else if (open.length > 0) {
    // An open position makes the figure a mark-to-market, not a realised
    // result. Saying so is the difference between honest and merely accurate.
    bullets.push(
      `Value change so far: ${usd}. This is not final — it includes the position still open above, valued at its current price.`,
    );
  } else {
    bullets.push(`Overall result: ${usd}.`);
  }

  return bullets.map((b) => `- ${b}`).join("\n");
}
