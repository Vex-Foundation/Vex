/**
 * SetupFrame: the shared pre-shell scaffold, a screen on the stage
 * (docs/design/V10-SPREAD.md sections 2 and 3; the d1 and d8 references).
 *
 * The print itself is not here: App mounts one `StagePrint` behind every
 * pre-shell screen, so the picture holds still while screens change and
 * this frame paints only what stands on it.
 *
 *   leaf  (default) a paper page laid on the stage from the right, 600 wide
 *         at 1440: the serif title, the lead and the screen's body, which
 *         scrolls inside the page. The sky to its left shows the release as
 *         the giant counter, or what the screen passes as `sky` (the
 *         wizard's step number and index).
 *   open  the body stands on the print itself (the unlock).
 *
 * The 44px head row carries the vx mark and is the hidden title bar's drag
 * region (section 8); the ground row along the bottom edge takes `groundStart`
 * and `groundEnd` (white mono on the dark ground).
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
import { ReleaseCounter, StageGround, StageHead } from "./PreShellStage.js";

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
function useGateDocumentScope(): void {
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
  /** `leaf` (default): a paper page on the stage; `open`: on the print. */
  readonly layout?: "leaf" | "open";
  /** Leaf: the serif page title (sentence case, one per surface). */
  readonly title?: string;
  /** Leaf: the lead under the title. */
  readonly subline?: string;
  /** Leaf: a mono line above the title. */
  readonly eyebrow?: ReactNode;
  /** Leaf: what the sky beside the page shows; the release counter by default. */
  readonly sky?: ReactNode;
  /** The ground caption row, left and right. */
  readonly groundStart?: ReactNode;
  readonly groundEnd?: ReactNode;
  readonly children: ReactNode;
}

export function SetupFrame({
  screen,
  layout = "leaf",
  title,
  subline,
  eyebrow,
  sky,
  groundStart,
  groundEnd,
  children,
}: SetupFrameProps): JSX.Element {
  useGateDocumentScope();
  const hasHead = eyebrow !== undefined || title !== undefined;
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
          {sky ?? (
            <div className="vex-stage-sky">
              <ReleaseCounter />
            </div>
          )}
          {/* THE LEAF: paper laid on the print; its head row is a drag
           * region that keeps clear of the Windows and Linux caption
           * buttons. Only the page body scrolls. */}
          <div className="vex-stage-leaf">
            <div aria-hidden="true" className="vex-drag vex-overlay-end" />
            <div className="vex-stage-leaf__body">
              {hasHead ? (
                <header className="vex-stage-leaf__head vex-rise">
                  {eyebrow !== undefined ? (
                    <p className="vex-stage-leaf__eyebrow">{eyebrow}</p>
                  ) : null}
                  {title !== undefined ? (
                    <h1 className="vex-stage-leaf__title">{title}</h1>
                  ) : null}
                  {subline !== undefined ? (
                    <p className="vex-stage-leaf__lead">{subline}</p>
                  ) : null}
                </header>
              ) : null}
              {children}
            </div>
          </div>
        </>
      )}
      <StageGround start={groundStart} end={groundEnd} />
    </main>
  );
}
