/**
 * THE TILE'S STATUS CHIP - a swatch and its word, and the precedence rule
 * behind it.
 *
 * ON THE BOARD TILE it reads as the swatch plus the word in 12.5 muted on a
 * row of its own (the tile passes `vex-bd-tile-check`, which `board-layout.css`
 * paints; the kit's compact chip drops its frame). On the spotlight it keeps
 * the kit's own paint. Status is a fill, never a hue.
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
import { Chip } from "../../../components/ui/chip.js";
import type { SwatchState } from "../../../components/ui/swatch.js";
import { cn } from "../../../lib/utils.js";
import {
  showsNewPairChip,
  type BoardSafetyTone,
  type BoardSafetyVerdict,
} from "./board-surface-contracts.js";

/** The copy of the age chip. Frozen here beside the rule that shows it. */
export const BOARD_NEW_PAIR_LABEL = "New pair";

/**
 * Tone to fill (docs/design/R3-MINIMAL.md section 1.6): status is told by the
 * swatch, never by a hue. Clean = solid, caution = target, danger = ink
 * cross, neutral = empty outline, pending = dot screen. The ONE mapping; no
 * safety state is named here.
 */
const SWATCH_BY_TONE: Readonly<Record<BoardSafetyTone, SwatchState>> = {
  positive: "done",
  caution: "warning",
  danger: "error",
  neutral: "idle",
  pending: "ongoing",
};

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
    <Chip
      state={SWATCH_BY_TONE[tone]}
      // Compact: the widest verdict is 35 characters (about 218px with its
      // swatch in 12.5 sans) and the tile floor is 284px of inner width, so
      // the frame is dropped and the word gets the whole row.
      compact
      // `data-*` rather than a class assertion in the tests: the chip's
      // CONTRACT is which fact it shows and in which tone, not which utility
      // classes today's design happens to compose.
      data-vex-area="board-status-chip"
      data-chip={newPair ? "new-pair" : "safety"}
      data-tone={tone}
      data-safety-state={verdict.state}
      // The whole label, for the pointer.
      title={label}
      className={cn("max-w-full", className)}
    >
      {/* NO ELLIPSIS. A verdict that reads "Checks unavai..." is worse than
        * no chip: a reader cannot tell an unavailable check from an
        * unverified token from a check that describes another token, and
        * those are three different things to do next. The widest label the
        * frozen table can produce is about 218px with its swatch ("Checks
        * unavailable in this response", 202px of 12.5 sans), and the tile's
        * floor (`global-css/board-layout.css`) is 284px of inner width, so
        * the word always has a row of its own to fit whole. */}
      <span className="whitespace-nowrap">{label}</span>
    </Chip>
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
