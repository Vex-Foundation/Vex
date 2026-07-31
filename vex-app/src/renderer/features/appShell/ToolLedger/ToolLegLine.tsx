/**
 * The leg line on a swap/bridge card: "1.5 SOL → 240.31 USDC" with the app's
 * offline token marks, shown INSTEAD of raw JSON as the primary view.
 *
 * Everything printed here was proven by `toolLegs.ts` (fail-closed parse) and
 * `lib/token-leg-display.ts` (brand gating + the strict decimal amount audit).
 * A leg whose amount could not be proven human-readable prints its token
 * ALONE — an omitted number is honest, an invented one is not.
 *
 * OUTCOME IS VISIBLE (rules/90 money-path honesty). ONLY a proven MUTATING
 * operation that succeeded renders the bare executed summary. Everything else
 * wears a prefix that says what it actually was: "Quote" for a successful
 * read-only preview (a swap_quote that moved nothing must never look like a
 * trade), "Completed" when the call succeeded but its quote-versus-execution
 * identity is unproven, "Requested" for a pending/denied/unpaired/legacy
 * unknown outcome, "Pending" (amber) for a broadcast whose receipt never came
 * back — neither a failure nor a completion, and its figures are the REQUESTED
 * ones read from the args — and "Failed", which additionally prints NO amounts
 * at all, because a number beside a failed call reads as money that moved.
 */

import type { JSX } from "react";
import { TokenIcon } from "../../../components/common/TokenIcon.js";
import type { ToolLeg, ToolLegOutcome, ToolLegPair } from "./toolLegs.js";

/** Prefix text per outcome; `null` ONLY for a proven, successful execution. */
const OUTCOME_LABELS: Readonly<Record<ToolLegOutcome, string | null>> = {
  executed: null,
  quote: "Quote",
  completed: "Completed",
  failed: "Failed",
  pending: "Pending",
  requested: "Requested",
};

/**
 * The ONE outcome that wears a tone rather than the neutral chip: an ambiguous
 * broadcast is unresolved, not benign, so it reads amber (`--color-warning`)
 * like the other pending affordances in the app.
 */
const WARN_OUTCOMES: ReadonlySet<ToolLegOutcome> = new Set(["pending"]);

/** Visibly distinct prefix for anything that is not a proven execution. */
function OutcomeLabel({
  outcome,
}: {
  readonly outcome: ToolLegOutcome;
}): JSX.Element | null {
  const label = OUTCOME_LABELS[outcome];
  if (label === null) return null;
  const warn = WARN_OUTCOMES.has(outcome);
  return (
    <span
      data-vex-tool-leg-outcome={outcome}
      className={
        warn
          ? "shrink-0 rounded-[3px] border border-[color-mix(in_oklab,var(--color-warning)_40%,transparent)] px-1 py-px text-[10px] uppercase tracking-[0.12em] text-[var(--color-warning)]"
          : "shrink-0 rounded-[3px] border border-[var(--vex-line)] px-1 py-px text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-3)]"
      }
    >
      {label}
    </span>
  );
}

function Leg({
  leg,
  showAmount,
}: {
  readonly leg: ToolLeg;
  /** False for a failed act — never print a figure as money that moved. */
  readonly showAmount: boolean;
}): JSX.Element {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <TokenIcon symbol={leg.token.iconSymbol} size={13} />
      {showAmount && leg.amount !== null ? (
        <span className="tabular-nums text-[var(--vex-text-2)]">{leg.amount}</span>
      ) : null}
      <span
        className="truncate text-[var(--vex-text-2)]"
        title={leg.token.full ?? undefined}
      >
        {leg.token.text}
      </span>
    </span>
  );
}

export function ToolLegLine({ legs }: { readonly legs: ToolLegPair }): JSX.Element {
  const showAmount = legs.outcome !== "failed";
  return (
    <span
      data-vex-tool-legs={legs.outcome}
      className="flex min-w-0 items-center gap-1.5 text-[12px]"
    >
      <OutcomeLabel outcome={legs.outcome} />
      <Leg leg={legs.from} showAmount={showAmount} />
      <span aria-hidden className="shrink-0 text-[var(--vex-text-3)]">
        →
      </span>
      <Leg leg={legs.to} showAmount={showAmount} />
    </span>
  );
}
