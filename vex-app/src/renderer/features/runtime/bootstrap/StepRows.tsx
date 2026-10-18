/**
 * The three steps of the native runtime's start in the first run's probe-row
 * grammar (`docs/design/R3-MINIMAL.md` section 10.3, `.vex-fr-probe`): the
 * label, the detail in the figure face, and at the right the state as a fill
 * and a word, never a hue. A step in flight is blue with the ongoing fill; the
 * model row carries the download as bytes, speed and percent over the 2px
 * progress line. The migration screen and Settings > Local runtime draw their
 * steps with the same rows.
 *
 * `data-step` / `data-status` on each row are the test and e2e contract.
 */

import type { JSX } from "react";

import type { SwatchState } from "../../../components/ui/swatch.js";
import { StateWord } from "../../../components/ui/state-word.js";
import type { StepRow, StepStatus } from "./steps.js";

/** The fill each status paints beside its word. */
const STATUS_FILL: Record<StepStatus, SwatchState> = {
  waiting: "idle",
  active: "ongoing",
  ready: "done",
  failed: "error",
};

/** Words arrive as main's lowercase vocabulary; the rows say them in sentence case. */
function sentenceCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * A row as drawn. The runtime screen's `StepRow` is one; the migration screen
 * draws its own steps through the same grammar.
 */
export interface StepRowView extends Omit<StepRow, "step"> {
  readonly step: string;
}

export function StepRows({ rows }: { readonly rows: readonly StepRowView[] }): JSX.Element {
  return (
    <ol className="vex-fr-probes">
      {rows.map((row) => (
        <li
          key={row.step}
          className="vex-fr-probe"
          data-step={row.step}
          data-status={row.status}
          data-live={row.status === "active" ? "" : undefined}
        >
          <span className="vex-fr-probe__l">{row.label}</span>
          <span className="vex-fr-probe__d vex-num">{row.detail}</span>
          <StateWord state={STATUS_FILL[row.status]} word={sentenceCase(row.word)} />
          {row.download !== null ? (
            <span
              className="vex-fr-progress__bar vex-fr-probe__bar"
              role="progressbar"
              aria-label="Embeddings model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={row.download.percent}
            >
              <i className="vex-fr-progress__fill" style={{ width: `${String(row.download.percent)}%` }} />
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
