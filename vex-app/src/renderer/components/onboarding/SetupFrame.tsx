/**
 * SetupFrame: the shared pre-shell scaffold, a screen on the stage.
 *
 * Her column is not here: App mounts it once over every pre-shell screen
 * (`StagePlate`), so she holds still while screens change and this frame
 * paints only the screen's own cells.
 *
 *   stage  the first run (system check, local runtime, the move of a previous
 *          release's data, database) on H3's stage frame
 *          (docs/design/H3-DESKTOP.md section 4.9; `StageFrame`): the title
 *          cell, the first run's steps in the left column, the lead as the
 *          work column's first row, the screen's rows, and its keys in the
 *          bottom row (`acts`), the logs link in the bottom-left cell beside
 *          the version (`foot`). The screen names its `step` and its `mood`:
 *          the left column's current square, the Vex key's word and Kimm's
 *          mood follow the mood.
 *   open   (the unlock, until its own H3 row) the body stands on R3's stage
 *          itself, which draws its own side column.
 *   leaf   (default; no caller since the wizard draws its own frame) R3's
 *          paper page laid on the stage from the right.
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

import { cn } from "../../lib/utils.js";
import {
  firstRunSub,
  firstRunWhere,
  StageFace,
  type FirstRunMood,
  type FirstRunStep,
} from "./FirstRunStage.js";
import { ReleaseCounter, StageGround, StageHead } from "./PreShellStage.js";
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
  /** `stage`: a first run screen on H3's stage; `open`: on R3's stage; `leaf` (default): R3's paper page. */
  readonly layout?: "stage" | "leaf" | "open";
  /** Stage: the first run step the left column marks as current. */
  readonly step?: FirstRunStep;
  /** Stage: what the screen is doing, which says what Vex shows. */
  readonly mood?: FirstRunMood;
  /** Stage and leaf: the screen's title (sentence case, one per surface). */
  readonly title?: string;
  /** Stage and leaf: the lead under the title (the stage's first row). */
  readonly subline?: string;
  /** Stage: the screen's keys, in the bottom row (a `StageActs`). */
  readonly acts?: ReactNode;
  /** Stage: the bottom-left cell's link beside the version (the logs folder). */
  readonly foot?: ReactNode;
  readonly children: ReactNode;
}

export function SetupFrame({
  screen,
  layout = "leaf",
  step,
  mood,
  title,
  subline,
  acts,
  foot,
  children,
}: SetupFrameProps): JSX.Element {
  useGateDocumentScope();
  if (layout === "stage") {
    const at = step ?? "systemCheck";
    const now = mood ?? "working";
    return (
      <StageFrame
        screen={screen}
        title={title ?? ""}
        sub={firstRunSub(at)}
        where={firstRunWhere(at, now)}
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
  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen={screen}
      className={cn("vex-stage", layout === "leaf" && "vex-stage--leaf")}
    >
      <StageHead />
      {layout === "open" ? (
        children
      ) : (
        <>
          <div className="vex-stage-sky">
            <ReleaseCounter />
          </div>
          {/* THE LEAF: paper laid on the print; its head row is a drag
           * region that keeps clear of the Windows and Linux caption
           * buttons. Only the page body scrolls. */}
          <div className="vex-stage-leaf">
            <div aria-hidden="true" className="vex-drag vex-overlay-end" />
            <div className="vex-stage-leaf__body">
              {title !== undefined ? (
                <header className="vex-stage-leaf__head vex-rise">
                  <h1 className="vex-stage-leaf__title">{title}</h1>
                  {subline !== undefined ? (
                    <p className="vex-stage-leaf__lead">{subline}</p>
                  ) : null}
                </header>
              ) : null}
              {children}
            </div>
          </div>
          <StageGround />
        </>
      )}
    </main>
  );
}
