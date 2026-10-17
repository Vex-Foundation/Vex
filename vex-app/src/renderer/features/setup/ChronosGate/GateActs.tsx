/**
 * The Chronos Gate's content: the wake screen's right side
 * (`docs/design/R3-MINIMAL.md section 10.2`). The plate with Vex at the left belongs to the stage
 * (`StagePlate`, mounted once by `App`), so only the type lives here and lifts away when the gate
 * does: "Waking the desk", the lead, one progress line and the five real stage lines, with a
 * small version stamp at the bottom right.
 *
 * The progress line and the stage lines are bound to the REAL launch pipeline: the line fills as
 * far as the pipeline has come, the current stage shows its live detail, finished stages are
 * solid, upcoming ones are outlines. Nothing here waits for Vex's wake. All paint is in
 * `global-css/chronos-gate.css`.
 */

import type { CSSProperties, JSX } from "react";
import { StageHead, VersionStamp } from "../../../components/onboarding/PreShellStage.js";
import { Swatch } from "../../../components/ui/swatch.js";
import type { SetupStatusLine } from "../useSetupOrchestrator.js";
import { GATE_STEPS, STAGE_PROGRESS } from "./gate-timeline.js";

export function GateActs({
  status,
}: {
  readonly status: SetupStatusLine;
}): JSX.Element {
  const current = GATE_STEPS.findIndex((step) => step.key === status.key);
  const progress = STAGE_PROGRESS[status.key];
  return (
    <div className="vex-gate-stage">
      <StageHead />
      <div className="vex-stage-side vex-stage-side--gate">
        <h1 className="vex-stage-title">Waking the desk</h1>
        <p className="vex-stage-lead">
          Vex is starting the local services on this machine.
        </p>
        <div
          role="progressbar"
          aria-label="Waking the desk"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          className="vex-gate-track"
        >
          <span
            aria-hidden
            className="vex-gate-progress__fill"
            // Single custom-property write via CSSOM (CSP-safe); the CSS
            // transition rides the resulting scaleX change.
            style={{ "--chronos-progress": progress } as CSSProperties}
          />
        </div>
        <ol className="vex-gate-steps">
          {GATE_STEPS.map((step, index) => (
            <li
              key={step.key}
              data-vex-gate-step={step.key}
              aria-current={index === current ? "step" : undefined}
            >
              <Swatch state={index > current ? "idle" : "done"} size={10} />
              <span>{index === current ? status.label : step.name}</span>
            </li>
          ))}
        </ol>
        <p role="status" aria-live="polite" className="sr-only">
          {status.label}
        </p>
      </div>
      <VersionStamp />
    </div>
  );
}
