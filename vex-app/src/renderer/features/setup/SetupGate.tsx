/**
 * SETUP GATE — the Chronos Gate cold open (PR1 of the setup rebrand).
 *
 * A full-window ink plate covers the window from the first paint (it was
 * the app icon's solid cobalt at room scale until the INK REDESIGN moved
 * the pre-shell onto deep ink-navy with cobalt as the accent — the sigil
 * and the loader arc now carry the brand color instead of the surface).
 * While it holds, `useSetupOrchestrator`
 * runs the real launch pipeline (probes → compose → migrate → wizard
 * entry) and the particle sigil signs itself inside the VexLoader ring.
 * When the pipeline resolves, the gate applies the handoff to the view
 * machine BENEATH itself, then the plate splits into two curtain panels
 * that slide off the top and bottom edges (`EASE_INOUT`, the landing
 * full-surface reveal curve), unveiling whichever screen the launch
 * landed on — for a healthy returning user that is the shell itself,
 * with zero clicks.
 *
 * Layering: `z-50`, mounted BELOW `UpdateLayer` (`z-[60]`) so a critical
 * update toast stays visible over the boot ritual — parity with the old
 * intro screen which UpdateLayer also covered.
 *
 * Choreography (content and panels are separate layers so the sigil
 * never straddles a moving seam): content fades (0.22s) → panels slide
 * (0.62s, 0.18s delay) → `dismissSetupGate()` unmounts the gate for the
 * rest of the process. Reduced motion: both durations collapse to ~0 —
 * the gate simply disappears once the pipeline resolves.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { motion, useReducedMotion } from "motion/react";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { VexSigil } from "../appShell/VexSigil.js";
import { EASE_INOUT, EASE_STANDARD } from "../../lib/motion.js";
import { useUiStore } from "../../stores/uiStore.js";
import { GATE_SIGIL_PALETTE } from "./gate-sigil-palette.js";
import {
  GatePrologue,
  resolveProloguePlay,
  sanitizeStoredPrologueVersion,
  type ProloguePlay,
} from "./gate-prologue/index.js";
import { useSetupOrchestrator } from "./useSetupOrchestrator.js";

const CURTAIN_MS = 0.62;
const CURTAIN_DELAY_MS = 0.18;

export function SetupGate(): JSX.Element | null {
  const active = useUiStore((s) => s.setupGateActive);
  const dismissSetupGate = useUiStore((s) => s.dismissSetupGate);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const openUnlock = useUiStore((s) => s.openUnlock);
  const prologueReplay = useUiStore((s) => s.prologueReplayNonce);
  const setPrologueVersion = useUiStore((s) => s.setPrologueVersion);
  const reduced = useReducedMotion() === true;

  const { status, handoff } = useSetupOrchestrator();
  const [revealing, setRevealing] = useState(false);

  /**
   * Play variant, decided ONCE per gate mount (lazy initialiser, never
   * re-derived): the policy reads persisted state that this same mount is
   * about to overwrite, so re-running it mid-flight would condense the very
   * prologue it is playing.
   *
   * A replay requested from the dev Setup Tour always forces the full
   * variant and never persists — the tour is the owner's preview hook, so it
   * must be immune to the policy it exists to demonstrate.
   */
  const isTourReplay = prologueReplay > 0;
  const [play] = useState<ProloguePlay>(() => {
    if (reduced) return "none";
    if (isTourReplay) return "full";
    return resolveProloguePlay({
      appVersion: __VEX_APP_VERSION__,
      // Rehydrated store state is user-writable localStorage under the
      // persist whitelist — sanitise before the policy reads it.
      lastPlayedVersion: sanitizeStoredPrologueVersion(
        useUiStore.getState().prologueVersion,
      ),
      reducedMotion: false,
    });
  });
  const [prologueDone, setPrologueDone] = useState(false);

  // `onFinished` fires on completion, on skip, and on every failure path —
  // and twice under StrictMode's double mount. Idempotent by construction.
  const persistedRef = useRef(false);
  const handlePrologueFinished = useCallback(() => {
    setPrologueDone(true);
    if (persistedRef.current || isTourReplay) return;
    persistedRef.current = true;
    setPrologueVersion(__VEX_APP_VERSION__);
  }, [isTourReplay, setPrologueVersion]);

  // Apply the handoff to the view machine beneath the plate, give React
  // one frame to mount the target screen, then start the curtain.
  //
  // The reveal waits for BOTH the boot pipeline AND the prologue: the
  // curtain must never wipe away a cinematic mid-act. The prologue is a
  // bounded floor (≤3.5s full, ≤1.2s condensed, 0 under reduced motion) and
  // any input skips it, so this can never strand an unlock or error handoff.
  useEffect(() => {
    if (handoff === null || revealing || !prologueDone) return;
    if (handoff.kind === "unlock") {
      openUnlock(handoff.returnView);
    } else {
      setCurrentView(handoff.view);
    }
    const raf = requestAnimationFrame(() => setRevealing(true));
    return () => cancelAnimationFrame(raf);
  }, [handoff, revealing, prologueDone, openUnlock, setCurrentView]);

  // Reduced motion: dismiss via effect, not the panel's animation
  // callback — a zero-duration animation's completion is not a contract
  // (same rationale as CurtainExit). One frame so the unveiled view
  // paints beneath the plate first. The callback below stays as a
  // harmless duplicate (dismissSetupGate is idempotent).
  useEffect(() => {
    if (!reduced || !revealing) return;
    const raf = requestAnimationFrame(() => dismissSetupGate());
    return () => cancelAnimationFrame(raf);
  }, [reduced, revealing, dismissSetupGate]);

  if (!active) return null;

  const panelTransition = reduced
    ? { duration: 0 }
    : { duration: CURTAIN_MS, ease: EASE_INOUT, delay: CURTAIN_DELAY_MS };

  return (
    <div
      data-vex-screen="setup-gate"
      data-vex-gate-phase={revealing ? "reveal" : "hold"}
      // The cold open is the first slide of the pre-shell continuum, so it
      // carries the same token scope as every screen the curtain opens onto
      // (`global-css/setup-gate.css`) — otherwise its status line and version
      // stamp would render on the shell's type scale and text tiers while the
      // plate beneath them is the pre-shell's.
      data-vex-gate="true"
      className="fixed inset-0 z-50 overflow-hidden"
    >
      {/* Curtain panels — one solid plate until the reveal splits it. */}
      <motion.div
        aria-hidden
        className="vex-gate-plate absolute inset-x-0 top-0 h-1/2"
        initial={false}
        animate={{ y: revealing ? "-101%" : "0%" }}
        transition={panelTransition}
        onAnimationComplete={() => {
          if (revealing) dismissSetupGate();
        }}
      >
        <div className="vex-gate-vignette absolute inset-0" />
        <div className="vex-noise pointer-events-none absolute inset-0" />
      </motion.div>
      <motion.div
        aria-hidden
        className="vex-gate-plate absolute inset-x-0 bottom-0 h-1/2"
        initial={false}
        animate={{ y: revealing ? "101%" : "0%" }}
        transition={panelTransition}
      >
        <div className="vex-gate-vignette absolute inset-0" />
        <div className="vex-noise pointer-events-none absolute inset-0" />
      </motion.div>

      {/* Content layer — fades out before the panels move. The prologue is
          the STAGE around the hold content, never a sibling that replaces
          it: it keeps these children mounted from the first frame (at
          opacity 0) so VexSigil's own assembly runs underneath the cinematic
          and is already settled when the settle act crossfades it in. */}
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ opacity: revealing ? 0 : 1 }}
        transition={reduced ? { duration: 0 } : { duration: 0.22, ease: EASE_STANDARD }}
      >
        <GatePrologue
          play={play}
          palette={GATE_SIGIL_PALETTE}
          onFinished={handlePrologueFinished}
        >
          <VexLoader
            size={200}
            stroke={2}
            tone="paper"
            label={status.label}
            className="shrink-0"
          >
            <VexSigil className="h-full w-full" palette={GATE_SIGIL_PALETTE} />
          </VexLoader>
          <p
            aria-hidden
            className="mt-8 vex-micro text-[var(--color-text-secondary)]"
          >
            {status.label}
          </p>
          <span className="absolute bottom-7 vex-micro text-[var(--color-text-muted)]">
            v{__VEX_APP_VERSION__}
          </span>
        </GatePrologue>
      </motion.div>
    </div>
  );
}
