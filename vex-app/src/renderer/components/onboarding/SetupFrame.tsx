/**
 * SetupFrame: the first run's screens on H3's stage (docs/design/H3-DESKTOP.md section 4.9;
 * `StageFrame`): the system check, the local runtime, the move of a previous release's data and
 * the database. Her column is not here: App mounts it once beside every pre-shell screen
 * (`StagePlate`), so she holds still while screens change and this frame paints only the screen's
 * own cells:
 *
 *   the title cell    the screen's title over "First run · Step N of 4"
 *   the left column   the first run's steps, the current one squared by the screen's mood
 *   the work column   the lead as its first row, the screen's rows, and its keys in the bottom
 *                     row (`acts`)
 *   the bottom-left   the logs link beside the version (`foot`)
 *
 * The screen names its `step` and its `mood`: the left column's current square, the Vex key's
 * word and Kimm's mood follow the mood.
 *
 * Contracts:
 *   - `data-vex-screen={screen}` is the stable e2e/test selector.
 *   - `data-vex-onboarding="true"` keeps the shared onboarding accent
 *     scope (scrollbars, `--vex-onboarding-accent`) alive.
 *   - `data-vex-gate="true"` applies the pre-shell token re-projection
 *     from `global-css/chronos-gate.css`. The frame ALSO stamps it on
 *     documentElement for its own lifetime so body-portaled surfaces keep
 *     the projection (`useGateDocumentScope` below).
 */

import { useEffect, type JSX, type ReactNode } from "react";

import {
  firstRunSub,
  firstRunWhere,
  StageFace,
  type FirstRunMood,
  type FirstRunStep,
} from "./FirstRunStage.js";
import { StageBody, StageFrame, StageLead } from "./StageFrame.js";

/**
 * Live SetupFrame count. The pre-shell stage crossfades screens through
 * `AnimatePresence`, so two frames are mounted at once mid-transition;
 * without a count the outgoing frame's cleanup would retract the scope
 * while the incoming one still needs it.
 */
let mountedFrames = 0;

/**
 * Carry the `[data-vex-gate]` token scope on documentElement for as long as
 * ANY pre-shell screen is mounted.
 *
 * Why the root and not only the frame: toasts, hover cards and menus portal
 * to `document.body`, which sits OUTSIDE the frame, so a portaled surface
 * opened from a pre-shell screen silently reverted to shell values. Stamping
 * the root is the smallest seam that reaches every portal target without
 * editing ~30 dual-hosted call sites. The wizard steps that ALSO render
 * inside Settings are unaffected: there they render without SetupFrame, so
 * the scope is never stamped.
 *
 * Cleanup is idempotent and count-guarded; the attribute is removed only
 * once the last frame unmounts.
 */
export function useGateDocumentScope(): void {
  useEffect(() => {
    mountedFrames += 1;
    document.documentElement.dataset["vexGate"] = "true";
    return () => {
      mountedFrames -= 1;
      if (mountedFrames <= 0) {
        mountedFrames = 0;
        delete document.documentElement.dataset["vexGate"];
      }
    };
  }, []);
}

interface SetupFrameProps {
  /** Value for data-vex-screen (stable e2e/test selector). */
  readonly screen: string;
  /** The first run step the left column marks as current. */
  readonly step: FirstRunStep;
  /** What the screen is doing, which says what Vex shows. */
  readonly mood?: FirstRunMood;
  /** The screen's title (sentence case, one per surface). */
  readonly title: string;
  /** The lead, the work column's first row. */
  readonly subline?: string;
  /** The screen's keys, in the bottom row (a `StageActs`). */
  readonly acts?: ReactNode;
  /** The bottom-left cell's link beside the version (the logs folder). */
  readonly foot?: ReactNode;
  readonly children: ReactNode;
}

export function SetupFrame({
  screen,
  step,
  mood,
  title,
  subline,
  acts,
  foot,
  children,
}: SetupFrameProps): JSX.Element {
  useGateDocumentScope();
  return (
    <StageFrame
      screen={screen}
      title={title}
      sub={firstRunSub(step)}
      where={firstRunWhere(step, mood ?? "working")}
      foot={foot}
    >
      {mood !== undefined ? <StageFace mood={mood} /> : null}
      <StageBody>
        {subline !== undefined ? <StageLead>{subline}</StageLead> : null}
        {children}
      </StageBody>
      {acts ?? null}
    </StageFrame>
  );
}
