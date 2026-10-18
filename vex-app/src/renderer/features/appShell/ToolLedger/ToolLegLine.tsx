/**
 * The leg line on a money card: "1.5 SOL → 240.31 USDC" for a two-sided act,
 * or "↑ 0.2 USDC" for a one-sided one, with the app's offline token marks,
 * shown INSTEAD of raw JSON as the primary view.
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
import type {
  ToolLeg,
  ToolLegDirection,
  ToolLegOutcome,
  ToolLegPair,
  ToolSingleLeg,
} from "./toolLegs.js";

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
 * Visibly distinct prefix for anything that is not a proven execution. The
 * ONE outcome that wears the blue rather than the neutral frame is the
 * ambiguous broadcast: it is unresolved, not benign (`.vex-leg-outcome`).
 */
function OutcomeLabel({
  outcome,
}: {
  readonly outcome: ToolLegOutcome;
}): JSX.Element | null {
  const label = OUTCOME_LABELS[outcome];
  if (label === null) return null;
  return (
    <span data-vex-tool-leg-outcome={outcome} className="vex-leg-outcome">
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
        <span className="vex-num font-mono tabular-nums">{leg.amount}</span>
      ) : null}
      <span className="truncate" title={leg.token.full ?? undefined}>
        {leg.token.text}
      </span>
    </span>
  );
}

export function ToolLegLine({ legs }: { readonly legs: ToolLegPair }): JSX.Element {
  const showAmount = legs.outcome !== "failed";
  return (
    <span data-vex-tool-legs={legs.outcome} className="vex-step__legs min-w-0">
      <OutcomeLabel outcome={legs.outcome} />
      <Leg leg={legs.from} showAmount={showAmount} />
      <span aria-hidden className="shrink-0">
        →
      </span>
      <Leg leg={legs.to} showAmount={showAmount} />
    </span>
  );
}

/**
 * The wallet-relative arrow for a ONE-SIDED movement. Deliberately NOT the
 * `→` of the pair line: that glyph reads as "this token became that token", and
 * a Morpho Blue market operation has no second token to become. `↑` is money
 * leaving the wallet, `↓` is money arriving, and the direction is also stated
 * in words for assistive tech rather than left to the glyph alone.
 */
const DIRECTION_GLYPHS: Readonly<Record<ToolLegDirection, string>> = {
  sent: "↑",
  received: "↓",
};

const DIRECTION_LABELS: Readonly<Record<ToolLegDirection, string>> = {
  sent: "Sent from wallet",
  received: "Received into wallet",
};

/**
 * The single-leg line: "↑ 0.2 USDC". Same outcome ladder, same brand-gated
 * token and same audited amount as the pair line, so a preview, a failure or an
 * unproven act is labelled here exactly as it is there.
 */
export function ToolSingleLegLine({
  leg,
}: {
  readonly leg: ToolSingleLeg;
}): JSX.Element {
  const showAmount = leg.outcome !== "failed";
  return (
    <span
      data-vex-tool-legs={leg.outcome}
      data-vex-tool-leg-direction={leg.direction}
      className="vex-step__legs min-w-0"
    >
      <OutcomeLabel outcome={leg.outcome} />
      <span
        role="img"
        aria-label={DIRECTION_LABELS[leg.direction]}
        className="shrink-0"
      >
        {DIRECTION_GLYPHS[leg.direction]}
      </span>
      <Leg leg={leg.leg} showAmount={showAmount} />
    </span>
  );
}
