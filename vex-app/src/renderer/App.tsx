/**
 * Top-level renderer state machine.
 *
 * Boot: the `ChronosGate` overlay covers the window from first paint
 * while its orchestrator runs the launch pipeline, then hands off to a
 * view beneath itself and lifts away. The view machine itself is
 * unchanged:
 *   splash (void beneath the gate) → systemCheck → dockerBootstrap →
 *   composeBootstrap → migrations → wizard → unlock → appShell —
 * (on the native runtime, systemCheck → runtimeBootstrap → migrations, with
 * runtimeMigration first while an install's data must still be moved);
 * a healthy returning user skips straight from the gate to
 * unlock/appShell; first-run still walks the classic guided chain.
 *
 * THE STAGE (docs/design/V10-SPREAD.md sections 2 and 10): every pre-shell
 * screen stands on one picture, the plateau print with the eagle. It is
 * mounted ONCE here, behind the screens, so it never moves or restarts
 * while they change: their swaps ride ONE `AnimatePresence mode="wait"`
 * that crossfades only the type and the paper leaf over it. The app shell
 * is NEVER inside the stage. Unlock→shell plays the page turn
 * (`CurtainExit`, armed by a successful unlock): the print stays, the right
 * page arrives from the window edge, the view flips beneath it, and the
 * turn lifts away.
 *
 * The legacy M0 capability/health/security cards are gated behind
 * `import.meta.env.DEV` and are reachable via a dev-only side panel —
 * they are not part of the user-facing flow.
 */

import { useWindowChrome } from "./lib/use-window-chrome.js";
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
import { StagePrint } from "./components/onboarding/PreShellStage.js";
import {
  DURATION_BASE_MS,
  DURATION_SLOW_MS,
  EASE_STANDARD,
} from "./lib/motion/index.js";
import { SystemCheck } from "./features/systemCheck/SystemCheck.js";
import { BootstrapPanel } from "./features/docker/BootstrapPanel.js";
import { ComposeBootstrap } from "./features/compose/ComposeBootstrap.js";
import { RuntimeBootstrap } from "./features/runtime/RuntimeBootstrap.js";
import { RuntimeMigration } from "./features/runtime/RuntimeMigration.js";
import { Migrations } from "./features/database/Migrations.js";
import { WizardShell } from "./features/wizard/WizardShell.js";
import { AppShell } from "./features/appShell/AppShell.js";
import { UnlockScreen } from "./features/secrets/UnlockScreen.js";
import { UpdateLayer } from "./features/updates/UpdateLayer.js";
import { ToastHost } from "./components/ui/toast-host.js";
import {
  ErrorBoundary,
  type ErrorBoundaryAction,
} from "./components/ui/error-boundary.js";
import { useUiStore, type View } from "./stores/uiStore.js";
import type { Capabilities } from "../shared/schemas/capabilities.js";
import type { HealthReport } from "../shared/schemas/system.js";

/** The stage members: every screen on the print. Never splash/appShell. */
const PRE_SHELL_VIEWS: ReadonlySet<View> = new Set<View>([
  "systemCheck",
  "dockerBootstrap",
  "composeBootstrap",
  "runtimeMigration",
  "runtimeBootstrap",
  "migrations",
  "wizard",
  "unlock",
]);

export function App(): JSX.Element {
  const currentView = useUiStore((s) => s.currentView);
  const prologueReplayNonce = useUiStore((s) => s.prologueReplayNonce);
  const unlockCurtainActive = useUiStore((s) => s.unlockCurtainActive);
  const unlockReturnView = useUiStore((s) => s.unlockReturnView);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const dismissUnlockCurtain = useUiStore((s) => s.dismissUnlockCurtain);
  const reducedMotion = useReducedMotion() === true;
  useWindowChrome();

  // Dispatch map keeps view routing flat: adding a view = one entry,
  // not a new ternary branch. Keep the map inline (no separate registry
  // module) until M7+ wizard step views need real per-step prop wiring
  // or lazy loading (codex turn 4).
  const views: Record<View, () => JSX.Element> = {
    // The void beneath the gate - the gate owns the boot ritual and flips
    // the view before it lifts away. It stands on the stage print below
    // (mounted for splash too), so the gate leaves onto the same picture.
    splash: () => (
      <main data-vex-screen="boot-void" className="h-screen w-screen" />
    ),
    systemCheck: () => <SystemCheck />,
    dockerBootstrap: () => <BootstrapPanel />,
    composeBootstrap: () => <ComposeBootstrap />,
    runtimeMigration: () => <RuntimeMigration />,
    runtimeBootstrap: () => <RuntimeBootstrap />,
    migrations: () => <Migrations />,
    wizard: () => <WizardShell />,
    unlock: () => <UnlockScreen />,
    appShell: () => <AppShell />,
  };

  return (
    // THE ROOT CONTAINMENT BOUNDARY, and its position is the whole point.
    //
    // React 19 unmounts the ENTIRE root when a render throws with no boundary
    // above it, so one bad render anywhere below - the shell, a pre-shell
    // screen, the gate - left the owner looking at an empty window painted in
    // the app background colour, with nothing on screen and nothing in a log.
    // The boundary sits OUTSIDE every view because a boundary mounted inside
    // `AppShell` cannot catch `AppShell`'s own render throw. Each Studio
    // workspace carries its own finer boundary beneath this one, so this
    // fallback is the last resort rather than the usual answer.
    //
    // "Reload window" is offered HERE and deliberately not inside a workspace:
    // at this level there is no smaller known-good thing left to return to,
    // while a workspace reload would replay whatever persisted state produced
    // the throw.
    <ErrorBoundary
      surface="app"
      extent="screen"
      title="Vex could not finish rendering this screen"
      actions={RELOAD_ACTIONS}
    >
      {/* reducedMotion="user": every Motion transform/layout animation in the
          tree obeys the OS setting by construction (opacity still animates),
          backstopping the per-surface useReducedMotion branches and matching
          the CSS side's global kill-switch in base.css. */}
      <MotionConfig reducedMotion="user">
      {currentView === "appShell" || currentView === "splash"
        ? views[currentView]()
        : null}
      {/* THE STAGE PRINT - one picture under every pre-shell screen and
          under the void the gate covers, mounted once so it never moves or
          restarts while the screens change over it. */}
      {PRE_SHELL_VIEWS.has(currentView) || currentView === "splash" ? (
        <StagePrint className="fixed inset-0" />
      ) : null}
      {/* Pre-shell screens over the print. `mode="wait"` sequences exit
          before enter so two screens never stack; the wrapper is
          `fixed inset-0` so an exiting screen overlays (not reflows) its
          successor. Opacity only: the print is the ground and holds still,
          only the type and the leaf change. Reduced motion collapses both
          durations. */}
      <AnimatePresence mode="wait" initial={false}>
        {PRE_SHELL_VIEWS.has(currentView) ? (
          <motion.div
            key={currentView}
            className="fixed inset-0"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{
              opacity: 1,
              transition: {
                duration: reducedMotion ? 0 : DURATION_SLOW_MS / 1000,
                ease: EASE_STANDARD,
              },
            }}
            exit={{
              opacity: 0,
              transition: {
                duration: reducedMotion ? 0 : DURATION_BASE_MS / 1000,
                ease: EASE_STANDARD,
              },
            }}
          >
            {views[currentView]()}
          </motion.div>
        ) : null}
      </AnimatePresence>
      {/* Boot overlay (z-50): covers every view until the launch pipeline
          resolves and the gate has lifted away, then unmounts for the
          rest of the process. Mounted BELOW UpdateLayer (z-[60]) so a
          critical update toast stays visible over the boot ritual. */}
      {/* The nonce is a REMOUNT key: the dev tour's replay re-runs the
          gate choreography only if the whole gate is a fresh mount. It
          stays 0 for the entire life of a real launch. */}
      <ChronosGate key={prologueReplayNonce} />
      {/* Unlock-success page turn, armed by UnlockScreen after the
          unlock IPC succeeds; the right page arrives over the print, the
          view flips to unlockReturnView beneath it, and the turn lifts
          away. Same z-band as the gate (below UpdateLayer). */}
      {unlockCurtainActive ? (
        <CurtainExit
          target={unlockReturnView}
          onCovered={() =>
            setCurrentView(useUiStore.getState().unlockReturnView)
          }
          onDone={dismissUnlockCurtain}
        />
      ) : null}
      {/* Global, view-independent: a user-triggered update prompt can appear
          over any screen. No-ops when the updater bridge is absent. */}
      <UpdateLayer />
      {/* Single mount of the notification toast stack. Every floating signal -
          feature showToast calls, engine failures, the update prompt - renders
          through this one region. */}
      <ToastHost />
      {import.meta.env.DEV ? <DevDiagnostics /> : null}
      {/* Diagnostic screen tour — renders only when VITE_VEX_SETUP_TOUR=1
          is baked into the build (owner request: view every pre-shell
          screen regardless of configured state). */}
      <SetupTour />
      </MotionConfig>
    </ErrorBoundary>
  );
}

/**
 * The root boundary's second route out. Module-level so the array identity is
 * stable across renders (a fresh array every render would give the boundary a
 * changing prop for no reason).
 *
 * A reload is the honest last resort at THIS level and nowhere else: it
 * re-runs the launch pipeline from a clean renderer, which is exactly what a
 * user would otherwise do by quitting and reopening the app.
 */
const RELOAD_ACTIONS: readonly ErrorBoundaryAction[] = [
  {
    label: "Reload window",
    onSelect: () => {
      window.location.reload();
    },
  },
];

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
