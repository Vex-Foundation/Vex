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
 * words; the grid above them is the market now. Mixing the two registers is
 * what made the old block heavy. Collapsed by default, one control, and the
 * app's single `ExpandRegion` reveal so the motion and the accessibility
 * contract are the ones every other disclosure already has.
 *
 * TWO CLOCKS, PRINTED SEPARATELY. `analysisCreatedAt` dates the WORDS and is
 * immutable; `marketDataFetchedAt` dates the FIGURES and moves with a
 * refresh. One timestamp for both would either make a fresh price claim the
 * analysis is fresh, or make a refreshed board look stale.
 *
 * Model prose renders as plain React text, never as markup and never handed
 * to a third-party renderer's option bag.
 */

import { useId, useRef, useState, type JSX, type ReactNode } from "react";
import { IconChevronDown } from "../../../components/icons/index.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import { cn } from "../../../lib/utils.js";
import { formatBoardUtcClock, formatBoardUtcDate } from "./boardFormat.js";
import type { BoardAuthoredContent } from "./boardModel.js";

export interface BoardDataNotesProps {
  readonly content: BoardAuthoredContent;
}

export function BoardDataNotes({ content }: BoardDataNotesProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <section
      data-vex-area="board-data-notes"
      data-open={open ? "true" : "false"}
      className="mt-5 rounded-xl border border-line-2 bg-board-card"
    >
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-controls={regionId}
        data-vex-area="board-data-notes-trigger"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left text-[13px] font-medium text-ink-secondary transition-colors duration-150 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        Composed analysis / Data notes
        <IconChevronDown
          size={16}
          className={cn(
            "shrink-0 transition-transform duration-150 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <ExpandRegion
        id={regionId}
        open={open}
        triggerRef={triggerRef}
        className="flex flex-col gap-4 border-t border-line-2 px-4 py-4"
      >
        {content.empty ? (
          <p
            data-vex-area="board-data-notes-empty"
            className="text-[12.5px] leading-relaxed text-ink-tertiary"
          >
            No saved analysis. This board was composed with figures only.
          </p>
        ) : null}

        {content.assessments.length > 0 ? (
          <Group title="VEX assessment">
            {content.assessments.map((entry) => (
              <div key={entry.key} data-vex-area="board-note-assessment">
                <p className="text-[12px] font-semibold text-ink-secondary">
                  {entry.heading}
                </p>
                {/* `whitespace-pre-line`: the assessment field admits newlines
                  * and the paragraphs the model wrote are part of what it
                  * wrote. Collapsing them would edit the text. */}
                <p className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink-primary">
                  {entry.analysis}
                </p>
              </div>
            ))}
          </Group>
        ) : null}

        {content.captions.length > 0 ? (
          <Group title="Card takeaways">
            {content.captions.map((entry) => (
              <p
                key={entry.key}
                data-vex-area="board-note-caption"
                className="text-[12.5px] leading-relaxed text-ink-secondary"
              >
                <span className="font-semibold text-ink-primary">
                  {entry.heading}
                </span>
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
                className="whitespace-pre-line text-[12.5px] leading-relaxed text-ink-secondary"
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
                className="text-[12.5px] leading-relaxed text-ink-secondary"
              >
                <span className="font-semibold text-ink-primary">
                  {annotation.label}
                </span>
                {" - "}
                <span className="tabular-nums">{annotation.coordinate}</span>
                {/* The unmatched-marker reason. A marker whose instant matched
                  * no candle is left OFF the canvas (the library would snap it
                  * onto a neighbouring bar and make it read as analysis of
                  * that bar), so the reason is the only place the reader
                  * learns the agent's claim exists at all. */}
                {annotation.note === null ? null : (
                  <span
                    data-vex-area="board-note-annotation-reason"
                    className="text-ink-tertiary"
                  >
                    {" ("}
                    {annotation.note}
                    {")"}
                  </span>
                )}
              </p>
            ))}
          </Group>
        ) : null}

        <Group title="Provenance">
          <dl
            data-vex-area="board-note-provenance"
            className="grid grid-cols-1 gap-1 text-[12.5px] leading-relaxed text-ink-secondary"
          >
            <Fact label="Transport" value={content.provenance.transport} />
            <Fact
              label="Source"
              value={content.provenance.sourceObservation}
            />
            <Fact
              label="Analysis composed"
              value={stamp(content.analysisCreatedAt)}
            />
            <Fact
              label="Figures read"
              value={stamp(content.marketDataFetchedAt)}
            />
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
    <div className="flex flex-col gap-1.5">
      <p className="vex-micro-label uppercase text-ink-secondary">{title}</p>
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
    <div className="flex gap-2">
      <dt className="shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
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
