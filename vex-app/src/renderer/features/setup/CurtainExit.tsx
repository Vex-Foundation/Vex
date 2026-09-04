/**
 * CURTAIN EXIT — the gate choreography, reused for leaving a pre-shell
 * screen (Phase 2b, owner decree C.3). Today it plays after a successful
 * unlock; it is deliberately presentational so a future finalize exit can
 * reuse it with different wiring.
 *
 * Sequence (the SetupGate curtain in reverse order of duties):
 *   1. COVER — the full-window ink plate fades in over the current
 *      screen (0.22s). The plate is pixel-identical to the pre-shell
 *      continuum plate beneath, so only the card content visibly melts
 *      away — the plate reads as one continuous surface.
 *   2. `onCovered()` — the caller flips the view machine while the plate
 *      is opaque (nothing beneath is visible); one frame later the reveal
 *      starts.
 *   3. REVEAL — the plate splits into two panels sliding off the top and
 *      bottom edges (`EASE_INOUT` 0.62s, the gate's own curve), unveiling
 *      the new view. `onDone()` unmounts the curtain.
 *
 * No cancel path — mount it only after the triggering IPC has succeeded.
 * Reduced motion: an explicit instant swap (effect-driven, no animation
 * callbacks to rely on) — `onCovered` fires on mount, `onDone` one frame
 * later. Layering: `z-50` like SetupGate, below UpdateLayer's `z-[60]` so
 * an update toast stays visible over the exit ritual.
 */

import { useEffect, useRef, useState, type JSX } from "react";
import { motion, useReducedMotion } from "motion/react";
import { EASE_INOUT, EASE_STANDARD } from "../../lib/motion/index.js";

const COVER_S = 0.22;
const CURTAIN_S = 0.62;
const CURTAIN_DELAY_S = 0.18;

export function CurtainExit({
  onCovered,
  onDone,
}: {
  /** Fired once, while the plate is fully opaque — flip the view here. */
  readonly onCovered: () => void;
  /** Fired once the reveal finishes — unmount the curtain here. */
  readonly onDone: () => void;
}): JSX.Element {
  const reduced = useReducedMotion() === true;
  const [revealing, setRevealing] = useState(false);
  const coveredRef = useRef(false);

  // Reduced motion = instant swap: cover, flip, disappear. Driven by an
  // effect (not animation callbacks — a no-op animation may never fire
  // its completion), with one frame between flip and unmount so the
  // target view paints beneath the plate first.
  useEffect(() => {
    if (!reduced || coveredRef.current) return;
    coveredRef.current = true;
    onCovered();
    const raf = requestAnimationFrame(() => onDone());
    return () => cancelAnimationFrame(raf);
  }, [reduced, onCovered, onDone]);

  const handleCovered = (): void => {
    if (coveredRef.current) return;
    coveredRef.current = true;
    onCovered();
    // One frame for React to mount the target view beneath the plate.
    requestAnimationFrame(() => setRevealing(true));
  };

  if (reduced) {
    return (
      <div
        aria-hidden
        data-vex-screen="exit-curtain"
        data-vex-curtain-phase="cover"
        className="fixed inset-0 z-50 overflow-hidden"
      >
        <div className="vex-gate-plate absolute inset-0">
          <div className="vex-gate-vignette absolute inset-0" />
          <div className="vex-noise pointer-events-none absolute inset-0" />
        </div>
      </div>
    );
  }

  const panelTransition = {
    duration: CURTAIN_S,
    ease: EASE_INOUT,
    delay: CURTAIN_DELAY_S,
  };

  return (
    <div
      aria-hidden
      data-vex-screen="exit-curtain"
      data-vex-curtain-phase={revealing ? "reveal" : "cover"}
      className="fixed inset-0 z-50 overflow-hidden"
      // The reveal must not intercept clicks on the unveiled view while
      // the panels finish their travel.
      style={{ pointerEvents: revealing ? "none" : "auto" }}
    >
      <motion.div
        className="absolute inset-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: COVER_S, ease: EASE_STANDARD }}
        onAnimationComplete={handleCovered}
      >
        <motion.div
          className="vex-gate-plate absolute inset-x-0 top-0 h-1/2"
          initial={false}
          animate={{ y: revealing ? "-101%" : "0%" }}
          transition={panelTransition}
          onAnimationComplete={() => {
            if (revealing) onDone();
          }}
        >
          <div className="vex-gate-vignette absolute inset-0" />
          <div className="vex-noise pointer-events-none absolute inset-0" />
        </motion.div>
        <motion.div
          className="vex-gate-plate absolute inset-x-0 bottom-0 h-1/2"
          initial={false}
          animate={{ y: revealing ? "101%" : "0%" }}
          transition={panelTransition}
        >
          <div className="vex-gate-vignette absolute inset-0" />
          <div className="vex-noise pointer-events-none absolute inset-0" />
        </motion.div>
      </motion.div>
    </div>
  );
}
