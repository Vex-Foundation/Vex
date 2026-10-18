/**
 * COMPOSED ANALYSIS / DATA NOTES - where every authored string on a board
 * stays reachable.
 *
 * THE REGRESSION THIS PREVENTS, stated plainly because it is the reason the
 * section exists at all. The v3 surfaces replaced an in-transcript block that
 * rendered a board's captions, notes and annotation legend inline. A card
 * grid that shows only figures would have SILENTLY DELETED the model's own
 * words from every board already persisted in every transcript - not hidden
 * them behind a control, deleted them, with no path back. So the disclosure
 * below carries all of it: per-pool captions, per-pool assessments, board
 * notes, the annotation legend with its unmatched-marker reasons, the
 * provenance of the bytes, and BOTH composition clocks.
 *
 * A DISCLOSURE, not a panel. These are the durable, composed-at-a-moment
 * words; the grid below them is the market now. Mixing the two registers is
 * what made the old block heavy. Collapsed by default, one control (the
 * "Composed analysis · Data notes" link at the right of the Board page's
 * meta line, docs/design/R3-MINIMAL.md section 9.4), and the app's single
 * `ExpandRegion` reveal so the motion and the accessibility contract are the
 * ones every other disclosure already has. The trigger and the region are
 * two exports because the design puts them in two places: the link on the
 * meta line, the words between that line and the grid.
 *
 * TWO CLOCKS, PRINTED SEPARATELY. `analysisCreatedAt` dates the WORDS and is
 * immutable; `marketDataFetchedAt` dates the FIGURES and moves with a
 * refresh. One timestamp for both would either make a fresh price claim the
 * analysis is fresh, or make a refreshed board look stale.
 *
 * Model prose renders as plain React text, never as markup and never handed
 * to a third-party renderer's option bag.
 */

import type { JSX, ReactNode, RefObject } from "react";
import { LineChevronDown } from "../../../components/icons/line/index.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import { cn } from "../../../lib/utils.js";
import { formatBoardUtcClock, formatBoardUtcDate } from "./boardFormat.js";
import type { BoardAuthoredContent } from "./boardModel.js";
import {
  BOARD_SAFETY_CHIP,
  type BoardSafetyState,
  type BoardSafetyVerdict,
} from "./board-surface-contracts.js";

/** The trigger's words, the design's. */
export const BOARD_DATA_NOTES_LABEL = "Composed analysis · Data notes";

export interface BoardDataNotesProps {
  readonly content: BoardAuthoredContent;
  /**
   * The board's verdicts, in pool order, for the "Safety states on this
   * board" group: each state PRESENT on the board, with the label its chip
   * wears and the bucket it counts in. The chip's copy is the classifier's
   * frozen table, and this is where a reader learns what the copy means.
   */
  readonly verdicts?: readonly BoardSafetyVerdict[];
  /** Controlled by the meta line's trigger. */
  readonly open: boolean;
  /** The trigger's `aria-controls` target. */
  readonly id: string;
  /** Focus returns here before the region closes. */
  readonly triggerRef?: RefObject<HTMLElement | null>;
}

/** The distinct states present, in first-appearance order. */
export function safetyStatesPresent(
  verdicts: readonly BoardSafetyVerdict[],
): readonly BoardSafetyState[] {
  return [...new Set(verdicts.map((verdict) => verdict.state))];
}

/** The meta line's link that opens and closes the region. */
export function BoardDataNotesTrigger({
  open,
  controls,
  onToggle,
  triggerRef,
}: {
  readonly open: boolean;
  readonly controls: string;
  readonly onToggle: () => void;
  readonly triggerRef?: RefObject<HTMLButtonElement | null>;
}): JSX.Element {
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      data-vex-area="board-data-notes-trigger"
      onClick={onToggle}
      className="vex-bd-link"
    >
      {BOARD_DATA_NOTES_LABEL}
      <LineChevronDown
        size={14}
        className={cn(
          "shrink-0 transition-transform duration-150 motion-reduce:transition-none",
          open && "rotate-180",
        )}
      />
    </button>
  );
}

export function BoardDataNotes({
  content,
  verdicts = [],
  open,
  id,
  triggerRef,
}: BoardDataNotesProps): JSX.Element {
  const safetyStates = safetyStatesPresent(verdicts);

  return (
    <section
      data-vex-area="board-data-notes"
      data-open={open ? "true" : "false"}
      aria-label={BOARD_DATA_NOTES_LABEL}
    >
      <ExpandRegion
        id={id}
        open={open}
        triggerRef={triggerRef}
        outerClassName="vex-bd-notes"
        className="vex-bd-notes__body"
      >
        {content.empty ? (
          <p data-vex-area="board-data-notes-empty" className="vex-bd-notes__text">
            No saved analysis. This board was composed with figures only.
          </p>
        ) : null}

        {content.assessments.length > 0 ? (
          <Group title="Vex assessment">
            {content.assessments.map((entry) => (
              <div key={entry.key} data-vex-area="board-note-assessment">
                <p className="vex-bd-notes__text">
                  <b>{entry.heading}</b>
                </p>
                {/* `pre-line`: the assessment field admits newlines and the
                  * paragraphs the model wrote are part of what it wrote.
                  * Collapsing them would edit the text. */}
                <p className="vex-bd-notes__text">{entry.analysis}</p>
              </div>
            ))}
          </Group>
        ) : null}

        {content.captions.length > 0 ? (
          <Group title="Card takeaways">
            {content.captions.map((entry) => (
              <p key={entry.key} data-vex-area="board-note-caption" className="vex-bd-notes__text">
                <b>{entry.heading}</b>
                {": "}
                {entry.caption}
              </p>
            ))}
          </Group>
        ) : null}

        {content.notes.length > 0 ? (
          <Group title="Board notes">
            {content.notes.map((note, index) => (
              <p
                key={`note/${String(index)}`}
                data-vex-area="board-note"
                className="vex-bd-notes__text"
              >
                {note}
              </p>
            ))}
          </Group>
        ) : null}

        {content.annotations.length > 0 ? (
          <Group title="Chart annotations">
            {content.annotations.map((annotation) => (
              <p
                key={annotation.key}
                data-vex-area="board-note-annotation"
                className="vex-bd-notes__text"
              >
                <b>{annotation.label}</b>
                {" - "}
                <span className="vex-num">{annotation.coordinate}</span>
                {/* The unmatched-marker reason. A marker whose instant matched
                  * no candle is left OFF the canvas (the library would snap it
                  * onto a neighbouring bar and make it read as analysis of
                  * that bar), so the reason is the only place the reader
                  * learns the agent's claim exists at all. */}
                {annotation.note === null ? null : (
                  <span data-vex-area="board-note-annotation-reason" className="vex-bd-muted">
                    {" ("}
                    {annotation.note}
                    {")"}
                  </span>
                )}
              </p>
            ))}
          </Group>
        ) : null}

        {safetyStates.length > 0 ? (
          <Group title="Safety states on this board">
            <dl data-vex-area="board-note-safety-states" className="vex-bd-notes__kv">
              {safetyStates.map((state) => (
                <div
                  key={state}
                  data-vex-area="board-note-safety-state"
                  data-safety-state={state}
                  className="contents"
                >
                  <dt>{BOARD_SAFETY_CHIP[state].label}</dt>
                  <dd>counted as {BOARD_SAFETY_CHIP[state].bucket}</dd>
                </div>
              ))}
            </dl>
          </Group>
        ) : null}

        <Group title="Provenance">
          <dl data-vex-area="board-note-provenance" className="vex-bd-notes__kv">
            <Fact label="Transport" value={content.provenance.transport} />
            <Fact label="Source" value={content.provenance.sourceObservation} />
            <Fact label="Analysis composed" value={stamp(content.analysisCreatedAt)} />
            <Fact label="Figures read" value={stamp(content.marketDataFetchedAt)} />
          </dl>
        </Group>
      </ExpandRegion>
    </section>
  );
}

function Group({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <p className="vex-bd-notes__h">{title}</p>
      {children}
    </div>
  );
}

function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): JSX.Element {
  return (
    <div className="contents">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** A composition clock, in UTC for the reason the header's clock is. */
function stamp(epochMs: number): string {
  const date = formatBoardUtcDate(epochMs);
  const clock = formatBoardUtcClock(epochMs);
  if (date === null || clock === null) return "unknown";
  return `${date}, ${clock}`;
}
