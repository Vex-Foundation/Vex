/**
 * The three steps of the native runtime's start in the system check's row
 * grammar (docs/design/H3-DESKTOP.md section 4.9, `.vex-fr-probe`): the
 * label, the detail in the figure face, and at the right the state as H3's
 * status (section 2.2), a square and an ink word: an outline while it waits,
 * grey while it runs, green once ready, red when it failed. The model row
 * carries the download as bytes, speed and percent over the progress line.
 * The migration screen and Settings > Local runtime draw their steps with the
 * same rows.
 *
 * `data-step` / `data-status` on each row are the test and e2e contract.
 */

import type { JSX } from "react";

import { StageStatus, type StageSquareKind } from "../../../components/onboarding/StageFrame.js";
import type { StepRow, StepStatus } from "./steps.js";

/** The square each status sets beside its word. */
const STATUS_SQUARE: Record<StepStatus, StageSquareKind> = {
  waiting: "none",
  active: "running",
  ready: "done",
  failed: "failed",
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
          <StageStatus kind={STATUS_SQUARE[row.status]} word={sentenceCase(row.word)} />
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
