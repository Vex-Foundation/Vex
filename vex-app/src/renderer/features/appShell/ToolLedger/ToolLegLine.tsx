/**
 * The leg line on a swap/bridge card: "1.5 SOL → 240.31 USDC" with the app's
 * offline token marks, shown INSTEAD of raw JSON as the primary view.
 *
 * Everything printed here was proven by `toolLegs.ts` (fail-closed parse) and
 * `lib/token-leg-display.ts` (brand gating + the strict decimal amount audit).
 * A leg whose amount could not be proven human-readable prints its token
 * ALONE — an omitted number is honest, an invented one is not.
 *
 * OUTCOME IS VISIBLE (rules/90 money-path honesty). Only a PROVEN-successful
 * act renders the bare executed summary. A `requested` pair (pending, denied,
 * unpaired, or legacy-unknown outcome) wears an explicit "Requested" prefix so
 * it can never be mistaken for a completed trade; a `failed` pair wears
 * "Failed" and prints NO amounts at all, because a number beside a failed call
 * reads as money that moved.
 */

import type { JSX } from "react";
import { TokenIcon } from "../../../components/common/TokenIcon.js";
import type { ToolLeg, ToolLegOutcome, ToolLegPair } from "./toolLegs.js";

/** Visibly distinct prefix for anything that is not a proven execution. */
function OutcomeLabel({
  outcome,
}: {
  readonly outcome: ToolLegOutcome;
}): JSX.Element | null {
  if (outcome === "executed") return null;
  return (
    <span
      data-vex-tool-leg-outcome={outcome}
      className="shrink-0 rounded-[3px] border border-[var(--vex-line)] px-1 py-px text-[10px] uppercase tracking-[0.12em] text-[var(--vex-text-3)]"
    >
      {outcome === "failed" ? "Failed" : "Requested"}
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
