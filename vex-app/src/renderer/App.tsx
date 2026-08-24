/**
 * Top-level renderer state machine.
 *
 * Boot: the `ChronosGate` overlay covers the window from first paint
 * while its orchestrator runs the launch pipeline, then hands off to a
 * view beneath itself and curtain-reveals it. The view machine itself
 * is unchanged:
 *   splash (void beneath the gate) → systemCheck → dockerBootstrap →
 *   composeBootstrap → migrations → wizard → unlock → appShell —
 * a healthy returning user skips straight from the gate to
 * unlock/appShell; first-run still walks the classic guided chain.
 *
 * Pre-shell STAGE (Phase 2b, decree C.3): the six pre-shell screens all
 * paint the identical cobalt plate, so their swaps ride ONE
 * `AnimatePresence mode="wait"` stage — the outgoing slide lifts away
 * (0.18s), the incoming one settles (0.3s), and the plate never moves:
 * screens read as slides on a continuous surface. The app shell is NEVER
 * inside the stage. Unlock→shell instead plays the `CurtainExit` cobalt
 * curtain (armed by a successful unlock), which flips the view while the
 * plate is opaque and splits open over the shell.
 *
 * The legacy M0 capability/health/security cards are gated behind
 * `import.meta.env.DEV` and are reachable via a dev-only side panel —
 * they are not part of the user-facing flow.
 */

import { useEffect, useState, type JSX } from "react";
import {
  AnimatePresence,
  MotionConfig,
  motion,
  useReducedMotion,
} from "motion/react";
import { ChronosGate } from "./features/setup/ChronosGate.js";
import { SetupTour } from "./features/setup/SetupTour.js";
import { CurtainExit } from "./features/setup/CurtainExit.js";
import { EASE_STANDARD } from "./lib/motion.js";
import { SystemCheck } from "./features/systemCheck/SystemCheck.js";
import { BootstrapPanel } from "./features/docker/BootstrapPanel.js";
import { ComposeBootstrap } from "./features/compose/ComposeBootstrap.js";
import { Migrations } from "./features/database/Migrations.js";
import { WizardShell } from "./features/wizard/WizardShell.js";
import { AppShell } from "./features/appShell/AppShell.js";
import { UnlockScreen } from "./features/secrets/UnlockScreen.js";
import { UpdateLayer } from "./features/updates/UpdateLayer.js";
import { ToastHost } from "./components/ui/toast-host.js";
import { useUiStore, type View } from "./stores/uiStore.js";
import type { Capabilities } from "../shared/schemas/capabilities.js";
import type { HealthReport } from "../shared/schemas/system.js";

/** The stage members — every cobalt-plate slide. Never splash/appShell. */
const PRE_SHELL_VIEWS: ReadonlySet<View> = new Set<View>([
  "systemCheck",
  "dockerBootstrap",
  "composeBootstrap",
  "migrations",
  "wizard",
  "unlock",
]);

export function App(): JSX.Element {
  const currentView = useUiStore((s) => s.currentView);
  const prologueReplayNonce = useUiStore((s) => s.prologueReplayNonce);
  const unlockCurtainActive = useUiStore((s) => s.unlockCurtainActive);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const dismissUnlockCurtain = useUiStore((s) => s.dismissUnlockCurtain);
  const reducedMotion = useReducedMotion() === true;

  // Dispatch map keeps view routing flat: adding a view = one entry,
  // not a new ternary branch. Keep the map inline (no separate registry
  // module) until M7+ wizard step views need real per-step prop wiring
  // or lazy loading (codex turn 4).
  const views: Record<View, () => JSX.Element> = {
    // The void beneath the SetupGate plate - the gate owns the boot ritual
    // and flips the view before its curtain reveal. It paints the pre-shell
    // PLATE itself (not `bg-surface-base`) so the two can never drift: one
    // theme-aware alias means no white flash in chronos and no black flash
    // in celeris.
    splash: () => (
      <main
        data-vex-screen="boot-void"
        className="vex-gate-plate h-screen w-screen"
      />
    ),
    systemCheck: () => <SystemCheck />,
    dockerBootstrap: () => <BootstrapPanel />,
    composeBootstrap: () => <ComposeBootstrap />,
    migrations: () => <Migrations />,
    wizard: () => <WizardShell />,
    unlock: () => <UnlockScreen />,
    appShell: () => <AppShell />,
  };

  return (
    // reducedMotion="user": every Motion transform/layout animation in the
    // tree obeys the OS setting by construction (opacity still animates),
    // backstopping the per-surface useReducedMotion branches and matching
    // the CSS side's global kill-switch in base.css.
    <MotionConfig reducedMotion="user">
      {currentView === "appShell" || currentView === "splash"
        ? views[currentView]()
        : null}
      {/* Pre-shell stage — one continuous cobalt plate, screens as slides.
          `mode="wait"` sequences exit before enter so two full-bleed slides
          never stack; the wrapper is `fixed inset-0` so an exiting slide
          overlays (not reflows) whatever replaced it. Transform/opacity
          only (CSP-safe); reduced motion collapses both durations. Motion
          settles the wrapper's transform to `none` at rest, so fixed
          overlays inside the screens (dialogs) keep their viewport anchor. */}
      <AnimatePresence mode="wait" initial={false}>
        {PRE_SHELL_VIEWS.has(currentView) ? (
          <motion.div
            key={currentView}
            className="fixed inset-0"
            initial={reducedMotion ? false : { opacity: 0, y: 18 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: {
                duration: reducedMotion ? 0 : 0.3,
                ease: EASE_STANDARD,
              },
            }}
            exit={
              reducedMotion
                ? { opacity: 0, transition: { duration: 0 } }
                : {
                    opacity: 0,
                    y: -14,
                    transition: { duration: 0.18, ease: EASE_STANDARD },
                  }
            }
          >
            {views[currentView]()}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {/* Boot overlay (z-50) — covers every view until the launch pipeline
          resolves and the curtain reveal completes, then unmounts for the
          rest of the process. Mounted BELOW UpdateLayer (z-[60]) so a
          critical update toast stays visible over the boot ritual. */}
      {/* The nonce is a REMOUNT key: the dev tour's replay re-runs the
          gate choreography only if the whole gate is a fresh mount. It
          stays 0 for the entire life of a real launch. */}
      <ChronosGate key={prologueReplayNonce} />
      {/* Unlock-success exit curtain — armed by UnlockScreen after the
          unlock IPC succeeds; flips the view to unlockReturnView while the
          cobalt plate is opaque, then splits open over the revealed view.
          Same z-band as the gate (below UpdateLayer). */}
      {unlockCurtainActive ? (
        <CurtainExit
          onCovered={() =>
            setCurrentView(useUiStore.getState().unlockReturnView)
          }
          onDone={dismissUnlockCurtain}
        />
      ) : null}
      {/* Global, view-independent: a user-triggered update prompt can appear
          over any screen. No-ops when the updater bridge is absent. */}
      <UpdateLayer />
      {/* Single mount of both toast slots (transient + sticky). The update
          layer and feature showToast callers all render through it. */}
      <ToastHost />
      {import.meta.env.DEV ? <DevDiagnostics /> : null}
      {/* Diagnostic screen tour — renders only when VITE_VEX_SETUP_TOUR=1
          is baked into the build (owner request: view every pre-shell
          screen regardless of configured state). */}
      <SetupTour />
    </MotionConfig>
  );
}

/**
 * Dev-only floating panel that surfaces the M0 IPC health probes. Hidden
 * in production builds via `import.meta.env.DEV`, which Vite tree-shakes
 * out of the bundle.
 */
function DevDiagnostics(): JSX.Element | null {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const [capsResult, healthResult] = await Promise.all([
          window.vex.capabilities.get(),
          window.vex.system.health(),
        ]);
        if (cancelled) return;
        if (capsResult.ok) setCapabilities(capsResult.data);
        else setError(`capabilities: ${capsResult.error.message}`);
        if (healthResult.ok) setHealth(healthResult.data);
        else setError(`health: ${healthResult.error.message}`);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Unknown error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-border bg-card px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-ink-secondary hover:text-foreground"
      >
        dev · {open ? "hide" : "diagnostics"}
      </button>
      {open ? (
        <section className="mt-2 w-72 rounded-md border border-border bg-card p-3 text-xs">
          <h2 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-secondary">
            M0 diagnostics
          </h2>
          {capabilities ? (
            <ul className="mb-2 space-y-0.5 font-mono">
              <li>phase: {capabilities.phase}</li>
              <li>app: {capabilities.appVersion}</li>
              <li>onboarded: {String(capabilities.onboardingComplete)}</li>
            </ul>
          ) : null}
          {health ? (
            <ul className="mb-2 space-y-0.5 font-mono">
              <li>os: {health.os.platform}/{health.os.arch}</li>
              <li>electron: {health.os.electronVersion}</li>
              <li>net: {health.network.online ? "online" : "offline"}</li>
              <li>overall: {health.overall}</li>
            </ul>
          ) : null}
          <ul className="space-y-0.5 font-mono">
            <li>require: {typeof (window as unknown as { require?: unknown }).require}</li>
            <li>process: {typeof (window as unknown as { process?: unknown }).process}</li>
            <li>vex: {typeof window.vex}</li>
          </ul>
          {error ? <p className="mt-2 text-destructive">{error}</p> : null}
        </section>
      ) : null}
    </div>
  );
}
