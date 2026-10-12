/**
 * CHRONOS GATE: the boot cold open (docs/design/V10-SPREAD.md sections 2
 * and 10). The stage print covers the window from first paint while
 * `useSetupOrchestrator` runs the real launch pipeline; the three acts (the
 * print develops, the release counter arrives, the ground fills in) play on
 * it, with the ground rule bound to the pipeline's real stages.
 *
 * The reveal: once BOTH the pipeline handoff and the Act III settle time
 * have resolved, the gate applies the handoff to the view machine BENEATH
 * itself, waits one frame for the screen to mount, and lifts away. The
 * screen beneath stands on an identical print in the same place, so only
 * the gate's type fades: the picture never moves. Reduced motion: the
 * static Act III frame, no hold, and the gate leaves at once.
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
import { ACTS_SETTLED_MS } from "./ChronosGate/gate-timeline.js";

export function ChronosGate(): JSX.Element | null {
  const active = useUiStore((s) => s.setupGateActive);
  const dismissSetupGate = useUiStore((s) => s.dismissSetupGate);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const openUnlock = useUiStore((s) => s.openUnlock);
  const reduced = useReducedMotion() === true;

  const { status, handoff } = useSetupOrchestrator();
  const [revealing, setRevealing] = useState(false);
  const [actsSettled, setActsSettled] = useState(reduced);

  // The gate never lifts mid-act: hold until Act III settles. Bounded and
  // input-free, so an unlock or error handoff is never stranded. Reduced
  // motion skips the hold entirely.
  useEffect(() => {
    if (reduced || actsSettled) return;
    const timer = window.setTimeout(
      () => setActsSettled(true),
      ACTS_SETTLED_MS,
    );
    return () => window.clearTimeout(timer);
  }, [reduced, actsSettled]);

  // Apply the handoff to the view machine beneath the gate, give React
  // one frame to mount the target screen, then start the reveal.
  useEffect(() => {
    if (handoff === null || revealing || !actsSettled) return;
    if (handoff.kind === "unlock") {
      openUnlock(handoff.returnView);
    } else {
      setCurrentView(handoff.view);
    }
    const raf = requestAnimationFrame(() => setRevealing(true));
    return () => cancelAnimationFrame(raf);
  }, [handoff, revealing, actsSettled, openUnlock, setCurrentView]);

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
