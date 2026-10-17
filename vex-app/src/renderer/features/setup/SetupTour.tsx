/**
 * SETUP TOUR — diagnostic screen navigator (owner request 2026-07-22):
 * "one env that skips the configured-setup checks and lets me view every
 * screen." Set `VITE_VEX_SETUP_TOUR=1` (e.g. `VITE_VEX_SETUP_TOUR=1 pnpm
 * vex:dev`, or a line in `vex-app/.env.local` — gitignored) and a small
 * mono navigator docks bottom-left with one key per pre-shell view, plus
 * "Replay gate" (re-arms the boot gate so the Chronos Gate acts replay
 * from the first frame) and "Reload boot" (replays the whole cold open
 * naturally).
 *
 * Scope guarantees:
 *  - Renderer view-routing ONLY. No main-process behavior, no gating
 *    bypassed anywhere that matters: screens still fetch real state and
 *    render their real branches; unlock still requires the real password
 *    to actually unlock. This is a viewer, not a skip.
 *  - It lists only the views of the runtime main runs (one read of
 *    `system.runtime`): the bootstrap screens of the other runtime would
 *    probe a runtime this process does not use. Until the answer arrives,
 *    only the views both runtimes share.
 *  - The flag is baked at build time by Vite; release builds are made
 *    without it, so the navigator is unreachable in production.
 *  - WizardShell honors the same flag by pinning its entry to the
 *    persisted step instead of auto-routing away (see its tour guard) —
 *    otherwise a completed setup would bounce the tour straight to the
 *    shell.
 */

import type { JSX } from "react";
import { useRuntimeInfo } from "../../lib/api/system.js";
import { useUiStore, type View } from "../../stores/uiStore.js";

export const SETUP_TOUR_ENABLED =
  import.meta.env.VITE_VEX_SETUP_TOUR === "1";

/** The tour's order: the first view, the runtime's own, then the rest. */
const FIRST_VIEWS: ReadonlyArray<View> = ["systemCheck"];
const CONTAINER_RUNTIME_VIEWS: ReadonlyArray<View> = ["dockerBootstrap", "composeBootstrap"];
const NATIVE_RUNTIME_VIEWS: ReadonlyArray<View> = ["runtimeMigration", "runtimeBootstrap"];
const LAST_VIEWS: ReadonlyArray<View> = ["migrations", "wizard", "unlock", "appShell"];

export function tourViews(native: boolean | null): ReadonlyArray<View> {
  const runtimeViews = native === null ? [] : native ? NATIVE_RUNTIME_VIEWS : CONTAINER_RUNTIME_VIEWS;
  return [...FIRST_VIEWS, ...runtimeViews, ...LAST_VIEWS];
}

export function SetupTour(): JSX.Element | null {
  // The panel reads the runtime mode; a production build never mounts it.
  return SETUP_TOUR_ENABLED ? <SetupTourPanel /> : null;
}

function SetupTourPanel(): JSX.Element {
  const currentView = useUiStore((s) => s.currentView);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const dismissSetupGate = useUiStore((s) => s.dismissSetupGate);
  const replayPrologue = useUiStore((s) => s.replayPrologue);
  const runtime = useRuntimeInfo();
  const views = tourViews(runtime.data?.ok === true ? runtime.data.data.native : null);

  return (
    <div
      data-vex-setup-tour
      className="fixed bottom-4 left-4 z-[70] flex flex-col gap-1 border border-[var(--color-border)] bg-surface-2 p-2 vex-micro text-ink-secondary"
    >
      <span className="px-1 text-[9px] text-ink-tertiary">
        Setup tour
      </span>
      {views.map((view) => (
        <button
          key={view}
          type="button"
          onClick={() => {
            // The gate overlay would otherwise sit above a jumped-to view
            // on a fresh boot; dismissing is idempotent and dev-only.
            dismissSetupGate();
            setCurrentView(view);
          }}
          className={
            view === currentView
              ? "bg-interactive-active px-2 py-1 text-left text-ink-primary"
              : "px-2 py-1 text-left hover:bg-interactive-hover"
          }
        >
          {view}
        </button>
      ))}
      {/* Gate choreography, on demand: `replayPrologue` re-arms the boot
          gate and bumps its remount nonce, so the four acts replay from
          the first frame click after click. */}
      <button
        type="button"
        data-vex-tour-prologue
        onClick={replayPrologue}
        className="mt-1 border border-[var(--color-border)] px-2 py-1 text-left hover:bg-interactive-hover"
      >
        Replay gate
      </button>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="border border-[var(--color-border)] px-2 py-1 text-left hover:bg-interactive-hover"
      >
        Reload boot
      </button>
    </div>
  );
}
