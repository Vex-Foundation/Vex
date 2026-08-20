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
 *  - Renderer view-routing ONLY. No IPC, no main-process behavior, no
 *    gating bypassed anywhere that matters: screens still fetch real
 *    state and render their real branches; unlock still requires the
 *    real password to actually unlock. This is a viewer, not a skip.
 *  - The flag is baked at build time by Vite; release builds are made
 *    without it, so the navigator is unreachable in production.
 *  - WizardShell honors the same flag by pinning its entry to the
 *    persisted step instead of auto-routing away (see its tour guard) —
 *    otherwise a completed setup would bounce the tour straight to the
 *    shell.
 */

import type { JSX } from "react";
import { useUiStore, type View } from "../../stores/uiStore.js";

export const SETUP_TOUR_ENABLED =
  import.meta.env.VITE_VEX_SETUP_TOUR === "1";

const TOUR_VIEWS: ReadonlyArray<View> = [
  "systemCheck",
  "dockerBootstrap",
  "composeBootstrap",
  "migrations",
  "wizard",
  "unlock",
  "appShell",
];

export function SetupTour(): JSX.Element | null {
  const currentView = useUiStore((s) => s.currentView);
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const dismissSetupGate = useUiStore((s) => s.dismissSetupGate);
  const replayPrologue = useUiStore((s) => s.replayPrologue);

  if (!SETUP_TOUR_ENABLED) return null;

  return (
    <div
      data-vex-setup-tour
      className="fixed bottom-4 left-4 z-[70] flex flex-col gap-1 rounded-lg border border-[var(--color-border)] bg-[rgba(8,11,24,0.85)] p-2 vex-micro text-ink-secondary"
    >
      <span className="px-1 text-[9px] text-ink-tertiary">
        Setup tour
      </span>
      {TOUR_VIEWS.map((view) => (
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
              ? "rounded bg-white/[0.14] px-2 py-1 text-left text-ink-primary"
              : "rounded px-2 py-1 text-left hover:bg-white/[0.08]"
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
        className="mt-1 rounded border border-[var(--color-border)] px-2 py-1 text-left hover:bg-white/[0.08]"
      >
        Replay gate
      </button>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded border border-[var(--color-border)] px-2 py-1 text-left hover:bg-white/[0.08]"
      >
        Reload boot
      </button>
    </div>
  );
}
