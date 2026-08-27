/**
 * ANNOTATION LEGEND - the agent's annotations as TEXT.
 *
 * THE SECURITY DECISION THIS FILE EXISTS TO PRESERVE. Every word here is
 * model-authored, and none of it is ever handed to lightweight-charts. Price
 * lines are created with `axisLabelVisible: false` and an empty `title`, and
 * markers carry no text, so nothing the model wrote is painted onto a canvas.
 * Canvas text is unreachable by a screen reader, unselectable, untranslatable
 * and outside every style and layout rule the app enforces. The words live
 * here, as React children, where the DOM is the thing that renders them.
 *
 * PRESENTATION. One chip per annotation: a kind dot, the model's label, the
 * coordinate in tabular numerals, and the reason it is not drawn when there
 * is one. The dot carries the kind so the eye can group without reading, and
 * the kind word stays in the DOM as the dot's accessible text rather than
 * being encoded in color alone.
 *
 * ONE ACCENT FAMILY. The three kinds are distinguished by dot TREATMENT
 * (filled, outlined, rotated) rather than by three unrelated hues, so the
 * legend stays inside the app's single accent family and does not borrow the
 * success and warning colors, which mean something else everywhere else.
 *
 * A board decimal can be forty characters wide, so the list scrolls inside
 * its own container. Nothing is clipped: a long coordinate scrolls, it does
 * not truncate, and it never widens the transcript column.
 */

import type { JSX } from "react";
import type { BoardAnnotationRow } from "./boardModel.js";

/** Dot treatment per kind. One accent, three shapes. */
const KIND_DOT: Readonly<Record<BoardAnnotationRow["kind"], string>> = {
  level: "rounded-full bg-accent-primary",
  zone: "rounded-full border border-accent-primary bg-accent-wash",
  marker: "rotate-45 bg-accent-primary",
};

export interface AnnotationLegendProps {
  readonly rows: readonly BoardAnnotationRow[];
}

export function AnnotationLegend({
  rows,
}: AnnotationLegendProps): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ul
      data-vex-area="board-chart-annotations"
      aria-label="Chart annotations"
      className="flex max-w-full flex-col gap-1 overflow-x-auto"
    >
      {rows.map((row) => (
        <li
          key={row.key}
          data-annotation-kind={row.kind}
          className="flex w-max items-center gap-2 whitespace-nowrap rounded-md border border-line-2 bg-surface-1 px-2 py-1 text-[12px] leading-[16px]"
          title={row.label}
        >
          <span
            aria-hidden
            className={`size-1.5 shrink-0 ${KIND_DOT[row.kind]}`}
          />
          <span className="vex-micro-label uppercase text-ink-secondary">
            {row.kind}
          </span>
          <span className="text-ink-primary">{row.label}</span>
          <span className="tabular-nums text-ink-tertiary">
            {row.coordinate}
          </span>
          {row.note !== null ? (
            <span
              data-vex-area="board-annotation-note"
              className="text-warning-label"
            >
              {row.note}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
