/**
 * The Chronos Gate's content: the wake on H3's stage (docs/design/H3-DESKTOP.md section 4.9; the
 * plate `stage-wake`, approved as drawn). Her column is the stage's own (`StagePlate`, mounted
 * once by `App`), so the gate's frame stands over it with its middle column left open
 * (`StageFrame`'s `over`): she wakes beside the gate and stays when it lifts away.
 *
 *   the left column   the five real launch stages, drawn like the nav: behind you done, the
 *                     current one on the selected fill with the grey square of a step in flight,
 *                     the rest ahead
 *   the title cell    the current stage with its live detail, over "Step N of 5"
 *   the work column   the lead as its first row
 *   the bottom row    the progress as a meter of twenty segments, lit as far as the REAL
 *                     pipeline has come, and its figure
 *
 * Nothing here waits for her. All paint is in `global-css/stage.css`.
 */

import type { JSX } from "react";
import {
  StageActs,
  StageBody,
  StageFrame,
  StageLead,
} from "../../../components/onboarding/StageFrame.js";
import { wakeWhere } from "../../../components/onboarding/wake-steps.js";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";
import { GATE_STEPS, STAGE_PROGRESS } from "./gate-timeline.js";

/** The meter's segments: H3's segmented cell (the one drawn at the Vex column's foot on a page). */
export const WAKE_SEGMENTS = 20;

export function GateActs({
  status,
}: {
  readonly status: SetupStatusLine;
}): JSX.Element {
  const current = GATE_STEPS.findIndex((step) => step.key === status.key);
  const percent = Math.round(STAGE_PROGRESS[status.key] * 100);
  const lit = Math.round((percent / 100) * WAKE_SEGMENTS);
  return (
    <StageFrame
      screen="wake"
      over
      title={status.label}
      sub={`Step ${String(current + 1)} of ${String(GATE_STEPS.length)}`}
      where={wakeWhere(status.key)}
    >
      <StageBody>
        <StageLead>Vex is starting the local services on this machine.</StageLead>
        <p role="status" aria-live="polite" className="sr-only">
          {status.label}
        </p>
      </StageBody>
      <StageActs>
        <div
          role="progressbar"
          aria-label="Waking the desk"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="vex-pre-meter"
        >
          <span aria-hidden="true" className="vex-pre-meter__segments">
            {Array.from({ length: WAKE_SEGMENTS }, (_, index) => (
              <i key={index} data-on={index < lit ? "" : undefined} />
            ))}
          </span>
          <span className="vex-pre-meter__figure vex-num">{`${String(percent)}%`}</span>
        </div>
      </StageActs>
    </StageFrame>
  );
}
