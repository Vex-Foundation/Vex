/**
 * Chronos Gate acts: the presentational content of the boot cold open,
 * standing on the stage (docs/design/V10-SPREAD.md sections 2 and 10; the
 * d1 composition, so the gate hands off to the unlock with the counter in
 * place). Act I: the print develops out of the plate. Act II: the release
 * counter and the mark arrive on the sky. Act III: the ground fills in: the
 * hairline IS the progress line, filled as far as the REAL launch pipeline
 * has come, with the stage's status line under it. All timing lives in the
 * stylesheet keyframes (global-css/chronos-gate.css); reduced motion lands
 * the Act III resting frame instantly.
 */

import type { CSSProperties, JSX } from "react";
import {
  ReleaseCounter,
  StageGround,
  StageHead,
  StagePrint,
} from "../../../components/onboarding/PreShellStage.js";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";
import { STAGE_PROGRESS } from "./gate-timeline.js";

export function GateActs({
  status,
}: {
  readonly status: SetupStatusLine;
}): JSX.Element {
  return (
    <div className="vex-gate-plate absolute inset-0">
      {/* Act I - the print develops: opacity only, the photo never moves. */}
      <StagePrint className="vex-gate-act-print absolute inset-0" />

      <div className="vex-stage absolute inset-0">
        {/* Act II - the mark and the release counter on the sky. */}
        <StageHead className="vex-gate-act-sky" />
        <div className="vex-unl vex-gate-act-sky">
          <div>
            <ReleaseCounter />
          </div>
        </div>

        {/* Act III - the ground: the progress rule and the status line. */}
        <StageGround
          className="vex-gate-act-ground"
          rule={
            <div aria-hidden className="vex-stage-ground__rule">
              <span
                className="vex-gate-progress__fill"
                // Single custom-property write via CSSOM (CSP-safe); the CSS
                // transition rides the resulting scaleX change.
                style={
                  {
                    "--chronos-progress": STAGE_PROGRESS[status.key],
                  } as CSSProperties
                }
              />
            </div>
          }
          start={
            <p role="status" aria-live="polite">
              {status.label}
            </p>
          }
          end={<span aria-hidden>Chronos Gate</span>}
        />
      </div>
    </div>
  );
}
