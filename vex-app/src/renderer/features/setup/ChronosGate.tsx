/**
 * CHRONOS GATE — the boot cold open (design-language §6a). A royal-blue
 * brand plate (drifting dither sky) covers the window from first paint
 * while `useSetupOrchestrator` runs the real launch pipeline; the four
 * acts (gate opens → mark enters → seal stamps → curtain release) play
 * over it, with the progress line bound to the pipeline's real stages.
 *
 * Act IV: once BOTH the pipeline handoff and the Act III settle time have
 * resolved, the gate applies the handoff to the view machine BENEATH
 * itself, the act content fades, and the sky splits into two curtain
 * panels sliding off the top and bottom edges — one continuous motion
 * into the first boot screen. Reduced motion: the static Act III frame,
 * no hold, and a plain fade instead of the curtain.
 *
 * Layering: `z-50`, mounted BELOW `UpdateLayer` (`z-[60]`) so a critical
 * update toast stays visible over the boot ritual.
 */

import { useEffect, useState, type JSX } from "react";
import { motion, useReducedMotion } from "motion/react";
import { EASE_INOUT, EASE_STANDARD } from "../../lib/motion/index.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useSetupOrchestrator } from "./useSetupOrchestrator.js";
import { GateActs } from "./ChronosGate/GateActs.js";
import { GateBackdrop } from "./ChronosGate/GateBackdrop.js";
import { ACTS_SETTLED_MS } from "./ChronosGate/gate-timeline.js";

const CURTAIN_S = 0.62;
const CURTAIN_DELAY_S = 0.18;
const CONTENT_FADE_S = 0.22;

export function ChronosGate(): JSX.Element | null {
  const active = useUiStore((s) => s.setupGateActive);
  const dismissSetupGate = useUiStore((s) => s.dismissSetupGate);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const openUnlock = useUiStore((s) => s.openUnlock);
  const reduced = useReducedMotion() === true;

  const { status, handoff } = useSetupOrchestrator();
  const [revealing, setRevealing] = useState(false);
  const [actsSettled, setActsSettled] = useState(reduced);

  // The curtain never wipes a stamp mid-act: hold until Act III settles.
  // Bounded and input-free, so an unlock or error handoff is never
  // stranded. Reduced motion skips the hold entirely.
  useEffect(() => {
    if (reduced || actsSettled) return;
    const timer = window.setTimeout(
      () => setActsSettled(true),
      ACTS_SETTLED_MS,
    );
    return () => window.clearTimeout(timer);
  }, [reduced, actsSettled]);

  // Apply the handoff to the view machine beneath the plate, give React
  // one frame to mount the target screen, then start the curtain.
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

  // Reduced motion: dismiss via effect, not the panel's animation
  // callback — a zero-duration animation's completion is not a contract
  // (same rationale as CurtainExit). One frame so the unveiled view
  // paints beneath the plate first. The animation callback below stays
  // as a harmless duplicate (dismissSetupGate is idempotent).
  useEffect(() => {
    if (!reduced || !revealing) return;
    const raf = requestAnimationFrame(() => dismissSetupGate());
    return () => cancelAnimationFrame(raf);
  }, [reduced, revealing, dismissSetupGate]);

  if (!active) return null;

  const panelTransition = reduced
    ? { duration: 0 }
    : { duration: CURTAIN_S, ease: EASE_INOUT, delay: CURTAIN_DELAY_S };

  return (
    <div
      data-vex-screen="chronos-gate"
      data-vex-gate-phase={revealing ? "reveal" : "hold"}
      // Carries the pre-shell token scope so `.vex-micro` speaks the
      // gate's label voice at the pre-shell size and weight.
      data-vex-gate="true"
      className="fixed inset-0 z-50 overflow-hidden"
    >
      {/* Curtain panels — one seamless sky until the reveal splits it. */}
      <motion.div
        aria-hidden
        className="absolute inset-x-0 top-0 h-1/2 overflow-hidden"
        initial={false}
        animate={{ y: revealing ? "-101%" : "0%" }}
        transition={panelTransition}
        onAnimationComplete={() => {
          if (revealing) dismissSetupGate();
        }}
      >
        <GateBackdrop edge="top" />
      </motion.div>
      <motion.div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-1/2 overflow-hidden"
        initial={false}
        animate={{ y: revealing ? "101%" : "0%" }}
        transition={panelTransition}
      >
        <GateBackdrop edge="bottom" />
      </motion.div>

      {/* Act content — fades out before the panels move. */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ opacity: revealing ? 0 : 1 }}
        transition={
          reduced
            ? { duration: 0 }
            : { duration: CONTENT_FADE_S, ease: EASE_STANDARD }
        }
      >
        <GateActs status={status} />
        <span className="absolute bottom-7 right-10 vex-micro text-white/60">
          v{__VEX_APP_VERSION__}
        </span>
      </motion.div>
    </div>
  );
}
