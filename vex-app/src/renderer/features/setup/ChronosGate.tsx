/**
 * CHRONOS GATE: the boot cold open (`docs/design/R3-MINIMAL.md section 10.2`). The wake screen
 * covers the window from first paint while `useSetupOrchestrator` runs the real launch pipeline:
 * "Waking the desk", one progress line and the five stage lines at the right, and Vex on the
 * stage's plate at the left (the plate belongs to `App`, so she keeps waking across the screens
 * that follow). The gate never holds a stage and never waits for her.
 *
 * The reveal: once BOTH the pipeline handoff and the short minimum hold have resolved, the gate
 * applies the handoff to the view machine BENEATH itself, waits one frame for the screen to
 * mount, and lifts away over 240ms. A handoff to the shell lifts the plate away with it (the
 * stage to shell crossfade); every other handoff stands on the same plate, so only the gate's
 * type fades and the picture never moves. Reduced motion: no hold, and the gate leaves at once.
 *
 * Layering: `z-50`, mounted BELOW `UpdateLayer` (`z-[60]`) so a critical
 * update toast stays visible over the boot ritual.
 */

import { useEffect, useState, type JSX } from "react";
import { motion, useReducedMotion } from "motion/react";
import { DURATION_SLOW_MS, EASE_STANDARD } from "../../lib/motion/index.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useSetupOrchestrator } from "./useSetupOrchestrator.js";
import { GateActs } from "./ChronosGate/GateActs.js";
import { GATE_HOLD_MS } from "./ChronosGate/gate-timeline.js";
import {
  stageVexExit,
  stageVexPipelineReady,
} from "../../components/onboarding/stage-vex.js";

export function ChronosGate(): JSX.Element | null {
  const active = useUiStore((s) => s.setupGateActive);
  const dismissSetupGate = useUiStore((s) => s.dismissSetupGate);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const openUnlock = useUiStore((s) => s.openUnlock);
  const reduced = useReducedMotion() === true;

  const { status, handoff } = useSetupOrchestrator();
  const [revealing, setRevealing] = useState(false);
  const [held, setHeld] = useState(reduced);

  // The gate never flashes: hold for the minimum so its title can be read. Bounded
  // and input-free, so an unlock or error handoff is never stranded. Reduced
  // motion skips the hold entirely.
  useEffect(() => {
    if (reduced || held) return;
    const timer = window.setTimeout(() => setHeld(true), GATE_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [reduced, held]);

  // The pipeline is done: the desk is awake (the plate's word turns to Ready once
  // she has woken too).
  useEffect(() => {
    if (handoff !== null) stageVexPipelineReady();
  }, [handoff]);

  // Apply the handoff to the view machine beneath the gate, give React
  // one frame to mount the target screen, then start the reveal.
  useEffect(() => {
    if (handoff === null || revealing || !held) return;
    if (handoff.kind === "unlock") {
      openUnlock(handoff.returnView);
    } else {
      setCurrentView(handoff.view);
    }
    const raf = requestAnimationFrame(() => setRevealing(true));
    return () => cancelAnimationFrame(raf);
  }, [handoff, revealing, held, openUnlock, setCurrentView]);

  // A handoff to the shell leaves the stage: the plate lifts away with the gate
  // (the 240ms crossfade). Any other screen stands on the same plate.
  useEffect(() => {
    if (!revealing || handoff === null) return;
    if (handoff.kind === "view" && handoff.view === "appShell") stageVexExit();
  }, [revealing, handoff]);

  // Reduced motion: dismiss via effect, not the fade's animation callback -
  // a zero-duration animation's completion is not a contract (same
  // rationale as CurtainExit). One frame so the unveiled view paints beneath
  // the gate first. The animation callback below stays as a harmless
  // duplicate (dismissSetupGate is idempotent).
  useEffect(() => {
    if (!reduced || !revealing) return;
    const raf = requestAnimationFrame(() => dismissSetupGate());
    return () => cancelAnimationFrame(raf);
  }, [reduced, revealing, dismissSetupGate]);

  if (!active) return null;

  return (
    <motion.div
      data-vex-screen="chronos-gate"
      data-vex-gate-phase={revealing ? "reveal" : "hold"}
      // Carries the pre-shell token scope so the gate's type speaks the
      // pre-shell register.
      data-vex-gate="true"
      className="fixed inset-0 z-50 overflow-hidden"
      initial={false}
      animate={{ opacity: revealing ? 0 : 1 }}
      transition={
        reduced
          ? { duration: 0 }
          : { duration: DURATION_SLOW_MS / 1000, ease: EASE_STANDARD }
      }
      onAnimationComplete={() => {
        if (revealing) dismissSetupGate();
      }}
    >
      <GateActs status={status} />
    </motion.div>
  );
}
