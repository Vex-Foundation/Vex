/**
 * THE STAGE: the picture every pre-shell screen stands on, and the furniture
 * the screens share (docs/design/V10-SPREAD.md sections 2, 3, 8 and 10).
 *
 * The plateau print at window size with the Desktop eagle gliding in its
 * band. The print never moves: the app mounts ONE `StagePrint` behind the
 * whole pre-shell (App.tsx) so a screen change swaps only the type over it,
 * and the gate and the page turn lay an identical copy over it, so their
 * arrival and departure read as type fading on a still picture.
 *
 *   StagePrint    the print and the eagle (decorative, `aria-hidden`)
 *   StageHead     the 44px head row: the title bar's drag region and the mark
 *   StageCounter  the giant italic counter on the sky
 *   StageGround   the hairline and the mono caption row on the dark ground
 *
 * Layout and paint live in `styles/global-css/chronos-gate.css`.
 */

import type { JSX, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
import { VexMark } from "../common/VexMark.js";
import { PrintPlate } from "../pixel/PrintPlate.js";
import type { StagePose } from "../pixel/flock-engine.js";

/**
 * The release the giant counter shows: `0.3.1` of `0.3.1`, and of a
 * pre-release such as `0.4.0-beta.2` the `0.4.0` with the rest returned as
 * the suffix, so a test build never prints a counter wider than its sky.
 */
export function releaseOf(version: string): {
  readonly core: string;
  readonly suffix: string | null;
} {
  const match = /^(\d+\.\d+\.\d+)(.*)$/.exec(version);
  if (match === null) return { core: version, suffix: null };
  const rest = match[2] ?? "";
  return { core: match[1] ?? version, suffix: rest === "" ? null : rest };
}

/** The print and the eagle at window size, the agent at rest (idle glide). */
export function StagePrint({
  className,
  pose,
}: {
  readonly className?: string;
  /** Where the eagle sits; the stage pose by default. */
  readonly pose?: StagePose;
}): JSX.Element {
  return (
    <PrintPlate
      state="idle"
      layout="stage"
      stagePose={pose}
      className={cn("pointer-events-none", className)}
    />
  );
}

/** The head row: drag region with the vx mark at the traffic lights' inset. */
export function StageHead({ className }: { readonly className?: string }): JSX.Element {
  return (
    <div className={cn("vex-stage__tb vex-drag vex-lights-start", className)}>
      <VexMark size={24} />
    </div>
  );
}

/**
 * The giant counter: `(0.3.1)`, `(02)`. Decorative to assistive tech; pass
 * `label` when the number carries information no visible text repeats.
 */
export function StageCounter({
  children,
  label,
  className,
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <>
      <span aria-hidden="true" className={cn("vex-stage-counter", className)}>
        ({children})
      </span>
      {label !== undefined ? <span className="sr-only">{label}</span> : null}
    </>
  );
}

/** The release counter, from the app version. */
export function ReleaseCounter({ className }: { readonly className?: string }): JSX.Element {
  return (
    <StageCounter label={`v${__VEX_APP_VERSION__}`} className={className}>
      {releaseOf(__VEX_APP_VERSION__).core}
    </StageCounter>
  );
}

/**
 * The ground: a white hairline over one mono caption row. `rule` replaces
 * the plain hairline (the gate draws its progress there).
 */
export function StageGround({
  start,
  end,
  rule,
  className,
}: {
  readonly start?: ReactNode;
  readonly end?: ReactNode;
  readonly rule?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn("vex-stage-ground", className)}>
      {rule ?? <div aria-hidden="true" className="vex-stage-ground__rule" />}
      <div className="vex-stage-ground__row">
        {start ?? <span />}
        {end ?? <span />}
      </div>
    </div>
  );
}
