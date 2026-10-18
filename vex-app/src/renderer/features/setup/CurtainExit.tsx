/**
 * THE HANDOFF: the unlock hands off to the shell with a 240ms crossfade
 * (`docs/design/R3-MINIMAL.md section 10.2`). It plays after a successful unlock; it is
 * presentational, so the caller owns the view flip. (The file keeps its curtain name: App and
 * the unlock store call it that.)
 *
 * The stage's plate (`StagePlate`, mounted once by `App`) stays up while the shell mounts
 * beneath it:
 *   1. `onCovered()` fires on mount: the caller flips the view machine. The plate holds the
 *      window, so the shell is not seen yet.
 *   2. One frame later the reveal starts: the plate lifts away over 240ms (the stage to shell
 *      crossfade; a fixed 240ms linear under reduced motion), and the type of the unlock fades
 *      with it.
 *   3. `onDone()` fires when the plate has gone: the caller unmounts the turn.
 * Unlocking back into the wizard, the view flips to the wizard and its screens stand on the same
 * print, so nothing lifts away.
 *
 * This component paints nothing but a transparent shield that takes no click for the 240ms
 * (`.vex-turn`); the plate's own fade is `[data-vex-stage-exit]` in chronos-gate.css.
 *
 * No cancel path - mount it only after the triggering IPC has succeeded. Timers drive it (no
 * animation callback is a contract). Layering: `z-50` like the gate, below the floating update card (z 60).
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { stageVexExit } from "../../components/onboarding/stage-vex.js";
import { DURATION_SLOW_MS } from "../../lib/motion/index.js";

export type PageTurnTarget = "appShell" | "wizard";

type Phase = "cover" | "reveal";

export function CurtainExit({
  onCovered,
  onDone,
  target = "appShell",
}: {
  /** Fired once, on mount: flip the view here. */
  readonly onCovered: () => void;
  /** Fired once the plate has lifted away: unmount it here. */
  readonly onDone: () => void;
  /** Where the unlock returns: the shell (the plate lifts away) or the wizard. */
  readonly target?: PageTurnTarget;
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>("cover");
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

  // Flip the view once, then start the reveal a frame later so the target view paints beneath
  // the plate first. Effect replay (StrictMode) may cancel the first frame, so it schedules
  // another without repeating the view flip.
  useEffect(() => {
    if (!coveredRef.current) {
      coveredRef.current = true;
      onCoveredRef.current();
    }
    frameRef.current = requestAnimationFrame(() => setPhase("reveal"));
    return () => cancelAnimationFrame(frameRef.current);
  }, []);

  // The reveal lifts the plate away over 240ms (a literal under reduced motion too, where it is
  // the whole crossfade), then unmounts the turn.
  useEffect(() => {
    if (phase !== "reveal") return;
    if (target === "appShell") stageVexExit();
    const timer = window.setTimeout(() => onDoneRef.current(), DURATION_SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [phase, target]);

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
    />
  );
}
