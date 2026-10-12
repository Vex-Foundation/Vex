/**
 * THE PAGE TURN: the unlock hands off to the spread (docs/design/V10-SPREAD.md
 * section 10, frames t1 to t3). It plays after a successful unlock; it is
 * presentational, so the caller owns the view flip. (The file keeps its
 * curtain name: App and the unlock store call it that.)
 *
 * The print and the eagle stay; paper arrives from the right:
 *   1. COVER - a copy of the stage print fades in over the unlock (240ms),
 *      so on the still picture only the stage type fades; at the same time
 *      the right page arrives from the window edge as one paper leaf and
 *      lands on the left page's edge (480ms, the entrance curve), while the
 *      eagle steps from its stage pose to its page pose on the frame step.
 *   2. `onCovered()` - the leaf has landed: the caller flips the view
 *      machine beneath the turn; one frame later the reveal starts.
 *   3. REVEAL - the turn lifts away (240ms) and the spread's furniture fades
 *      in under it. `onDone()` unmounts the turn.
 * Unlocking back into the wizard, the leaf lands where the wizard's page
 * is and the eagle keeps its stage pose.
 *
 * No cancel path - mount it only after the triggering IPC has succeeded.
 * Reduced motion: nothing slides. `onCovered` fires on mount, the leaf is
 * already in place, and the stage and the spread crossfade over a fixed
 * 240ms linear; timers drive it (no animation callback is a contract).
 * Layering: `z-50` like the gate, below UpdateLayer's `z-[60]`.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { useReducedMotion } from "motion/react";
import { StagePrint } from "../../components/onboarding/PreShellStage.js";
import {
  FRAME_STEP_MS,
  STAGE_POSE,
  type StagePose,
} from "../../components/pixel/flock-engine.js";
import { DURATION_SLOW_MS } from "../../lib/motion/index.js";

/** The leaf's travel (section 10: `--dur-4` 480ms on `--ease-out`). The
 * stylesheet transition in chronos-gate.css carries the same 480ms. */
const LEAF_MS = 480;

export type PageTurnTarget = "appShell" | "wizard";

type Phase = "start" | "cover" | "reveal";

/**
 * The eagle's page pose on the left page (section 10: 150 wide at 99, 596 in
 * a 1440 x 900 window), or on the 56 spine under 1276 (42 wide, cell 2), as
 * fractions of the window the stage plate lays out in. The height fraction
 * holds at every size: the print is laid out in place, horizon included.
 */
function pagePose(width: number): StagePose {
  if (width < 1276) {
    return { x: 28 / width, y: 0.645, frac: 42 / width, cell: 2 };
  }
  return { x: 99 / width, y: 596 / 900, frac: 150 / width, cell: 4 };
}

/** Halfway between two poses, on the coarser of their two cells. */
function midPose(a: StagePose, b: StagePose): StagePose {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    frac: (a.frac + b.frac) / 2,
    cell: Math.min(a.cell, b.cell),
  };
}

export function CurtainExit({
  onCovered,
  onDone,
  target = "appShell",
}: {
  /** Fired once, when the leaf has landed: flip the view here. */
  readonly onCovered: () => void;
  /** Fired once the turn has lifted away: unmount it here. */
  readonly onDone: () => void;
  /** Where the leaf lands: the spread's left page edge, or the wizard's page. */
  readonly target?: PageTurnTarget;
}): JSX.Element {
  const reduced = useReducedMotion() === true;
  const [phase, setPhase] = useState<Phase>(reduced ? "cover" : "start");
  const [pose, setPose] = useState<StagePose>(STAGE_POSE);
  const coveredRef = useRef(false);
  const frameRef = useRef(0);
  const onCoveredRef = useRef(onCovered);
  const onDoneRef = useRef(onDone);

  // Flipping the view rerenders the parent with new callback identities.
  // Updating these refs must not cancel the timer that removes the turn.
  useEffect(() => {
    onCoveredRef.current = onCovered;
    onDoneRef.current = onDone;
  }, [onCovered, onDone]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  /** Flip the view once, then start the reveal a frame later so the target
   * view paints beneath the turn first. */
  const cover = (): void => {
    if (!coveredRef.current) {
      coveredRef.current = true;
      onCoveredRef.current();
    }
    cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => setPhase("reveal"));
  };

  // Reduced motion: flip on mount, crossfade at once. Effect replay may
  // cancel the first frame, so it schedules another without repeating the
  // view flip.
  useEffect(() => {
    if (!reduced) return;
    cover();
    return () => cancelAnimationFrame(frameRef.current);
    // `cover` reads refs only; the effect runs per reduced-motion change.
  }, [reduced]);

  // The turn: commit the resting frame, then let the stylesheet move the
  // leaf and fade the print in; the eagle steps on the frame step; the view
  // flips when the leaf has landed.
  useEffect(() => {
    if (reduced) return;
    if (phase === "start") {
      const outer = requestAnimationFrame(() => {
        frameRef.current = requestAnimationFrame(() => setPhase("cover"));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(frameRef.current);
      };
    }
    if (phase !== "cover") return;
    const timers: number[] = [];
    if (target === "appShell") {
      const end = pagePose(window.innerWidth);
      // The eagle moves after the print copy has faded in over the stage's
      // own eagle, so only one bird is ever seen.
      timers.push(
        window.setTimeout(() => setPose(midPose(STAGE_POSE, end)), DURATION_SLOW_MS),
        window.setTimeout(() => setPose(end), DURATION_SLOW_MS + FRAME_STEP_MS),
      );
    }
    timers.push(window.setTimeout(cover, LEAF_MS));
    return () => timers.forEach((t) => window.clearTimeout(t));
    // `cover` reads refs only.
  }, [phase, reduced, target]);

  // The reveal lifts the turn away over 240ms (a literal under reduced
  // motion too, where it is the whole crossfade), then unmounts it.
  useEffect(() => {
    if (phase !== "reveal") return;
    const timer = window.setTimeout(() => onDoneRef.current(), DURATION_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return (
    <div
      aria-hidden
      data-vex-screen="exit-curtain"
      data-vex-curtain-phase={phase}
      data-vex-turn-target={target}
      // Opacity-only under reduced motion: the documented opt-out from the
      // base.css sweep, with its own reduced rule in chronos-gate.css.
      data-vex-motion-opacity=""
      className="vex-turn"
    >
      <div className="vex-turn__print vex-gate-plate">
        <StagePrint className="absolute inset-0" pose={pose} />
      </div>
      <div className="vex-turn__leaf" />
    </div>
  );
}
