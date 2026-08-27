/**
 * THE CARD'S STATUS CHIP - one capsule, and the precedence rule behind it.
 *
 * TWO INDEPENDENT FACTS, ONE SLOT. A card can be both "a pair that is hours
 * old" and "a pair whose checks came back clean", and the mockup gives them
 * one place to appear. They are not merged into a third state: the age chip
 * takes VISUAL precedence (A11) while the safety verdict is still computed,
 * still counted in the preview card's tally, and still named in the card's
 * accessible name. The reason age wins is a product one - on a pair younger
 * than a day the checks have too little history behind them to be the most
 * useful thing a reader can be told, and a green chip there would be read as
 * reassurance the data cannot support.
 *
 * THE VERDICT'S WORDS AND COLOUR ARE NOT THIS FILE'S. Both come from
 * `BOARD_SAFETY_CHIP`, the frozen table in the shared classifier, so the copy
 * a reader sees for `not-indexed` cannot drift between the card, the grid and
 * the spotlight. This component maps a TONE to a design token and nothing
 * more; there is deliberately no branch here on a safety STATE.
 *
 * `spec.analysis` never reaches this component. Model prose does not colour a
 * chip (A5), and the cleanest way to guarantee that is for the chip to have
 * no access to it.
 */

import type { JSX } from "react";
import {
  IconCircleAlert,
  IconInfo,
  IconShieldCheck,
  IconWarning,
} from "../../../components/icons/index.js";
import { Pill } from "../../../components/ui/pill.js";
import { cn } from "../../../lib/utils.js";
import {
  showsNewPairChip,
  type BoardSafetyTone,
  type BoardSafetyVerdict,
} from "./board-surface-contracts.js";

/** The copy of the age chip. Frozen here beside the rule that shows it. */
export const BOARD_NEW_PAIR_LABEL = "New pair";

type PillVariant = "positive" | "caution" | "danger" | "info";

/** Tone to primitive variant. The ONE mapping; no state is named. */
const VARIANT_BY_TONE: Readonly<Record<BoardSafetyTone, PillVariant>> = {
  positive: "positive",
  caution: "caution",
  danger: "danger",
  neutral: "info",
  pending: "info",
};

function ToneIcon({ tone }: { readonly tone: BoardSafetyTone }): JSX.Element {
  switch (tone) {
    case "positive":
      return <IconShieldCheck size={14} />;
    case "danger":
      return <IconCircleAlert size={14} />;
    case "caution":
      return <IconWarning size={14} />;
    case "neutral":
    case "pending":
      return <IconInfo size={14} />;
    default: {
      const unreachable: never = tone;
      throw new Error(`board safety tone not handled: ${String(unreachable)}`);
    }
  }
}

export interface BoardStatusChipProps {
  readonly verdict: BoardSafetyVerdict;
  readonly pairAgeSeconds: number | null;
  readonly className?: string;
}

export function BoardStatusChip({
  verdict,
  pairAgeSeconds,
  className,
}: BoardStatusChipProps): JSX.Element {
  const newPair = showsNewPairChip(pairAgeSeconds);
  const tone: BoardSafetyTone = newPair ? "caution" : verdict.tone;
  const label = newPair ? BOARD_NEW_PAIR_LABEL : verdict.label;
  return (
    <Pill
      variant={VARIANT_BY_TONE[tone]}
      size="lg"
      // `data-*` rather than a class assertion in the tests: the chip's
      // CONTRACT is which fact it shows and in which tone, not which utility
      // classes today's design happens to compose.
      data-vex-area="board-status-chip"
      data-chip={newPair ? "new-pair" : "safety"}
      data-tone={tone}
      data-safety-state={verdict.state}
      // The whole label on hover, because the visible run is `truncate`d by
      // CSS on a narrow card: the string itself is never cut.
      title={label}
      className={cn("font-medium", className)}
    >
      <ToneIcon tone={tone} />
      <span className="min-w-0 truncate">{label}</span>
    </Pill>
  );
}

/**
 * The chip's contribution to the CARD's accessible name.
 *
 * Both facts, always, and in words. The visual precedence above hides the
 * safety verdict from the eye when a pair is new; a reader on assistive tech
 * has no second glance to give, so they are told both rather than the one
 * that happened to win a layout slot.
 */
export function boardStatusChipLabel(
  verdict: BoardSafetyVerdict,
  pairAgeSeconds: number | null,
): string {
  return showsNewPairChip(pairAgeSeconds)
    ? `${BOARD_NEW_PAIR_LABEL}, ${verdict.label}`
    : verdict.label;
}
