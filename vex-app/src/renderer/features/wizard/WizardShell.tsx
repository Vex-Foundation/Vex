/**
 * Wizard shell (M7, Phase 2 refactor — Mode + Wake steps removed; PR6
 * redesign — onboarding glass; V2 redesign — sidebar removed; Chronos
 * rebrand — the wizard joins the cobalt continuum).
 *
 * Layout (AMENDMENT A2): the wizard keeps its own full-bleed `<main>`
 * but paints the same SetupGate plate as every other pre-shell slide
 * (`.vex-gate-plate` + vignette + grain) and carries the
 * `data-vex-gate` token scope, so stock Buttons inside step forms are
 * cobalt pills and the step forms pick up the pre-shell type scale
 * (INK REDESIGN). Top-left brand + bottom corners match `SetupFrame`.
 * The centered column hosts the minimal `HorizontalStepper` rail above
 * `WizardStepPanel`. Loading state is the VexLoader ring.
 *
 * Per-step chrome lives in `WizardStepPanel`; each step returns a
 * `WizardStepPanel` (or, for ReviewStep back-edit, a sub-step's panel
 * with a small editing notice banner above). `AnimatePresence` stays
 * on this shell — the panel itself is a plain `<div>` so transitions
 * are not double-wrapped.
 *
 * Phase 1 has no back-navigation (Explore agent 1 finding §1) and no
 * cross-step needs; the active step lives in local React state, not
 * Zustand (codex turn 5 answer #5). Persistent recovery — surviving a
 * crash mid-wizard — flows through `wizard-state.json` and the
 * TanStack Query cache.
 *
 * If `completed === true` (Review finalised on a previous launch) we
 * flip the view to `appShell` immediately. Two effects own this routing:
 * the one-time init effect handles first-mount (relaunch into a completed
 * setup), and a dedicated COMPLETION WATCHER handles the in-session flip
 * after Finalize succeeds on Review (where `currentStepId` is already
 * non-null, so the init effect's guard skips it).
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type WizardStepId,
  type WizardState,
} from "@shared/schemas/wizard.js";
import { Button } from "../../components/ui/button.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { cn } from "../../lib/utils.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useWizardState } from "../../lib/api/wizard.js";
import { resolveWizardEntry } from "./wizard-entry.js";
import { HorizontalStepper } from "./HorizontalStepper.js";
import { AgentCoreStep } from "./steps/AgentCoreStep.js";
import { ApiKeysStep } from "./steps/ApiKeysStep.js";
import { EmbeddingStep } from "./steps/EmbeddingStep.js";
import { KeystoreStep } from "./steps/KeystoreStep.js";
import { ProviderStep } from "./steps/ProviderStep.js";
import { ReviewStep } from "./steps/review/ReviewStep.js";
import { WalletsStep } from "./steps/WalletsStep.js";

function renderStep(
  stepId: WizardStepId,
  completedSteps: ReadonlyArray<WizardStepId>,
  onAdvance: (next: WizardStepId) => void,
): JSX.Element {
  // M11: every wizard step receives `flowMode="first-pass"` from the
  // shell. ReviewStep itself dispatches edited steps with
  // `flowMode="back-edit"` (local nav, no persisted state advance).
  const props = { completedSteps, onAdvance, flowMode: "first-pass" as const };
  switch (stepId) {
    case "keystore":
      return <KeystoreStep {...props} />;
    case "wallets":
      return <WalletsStep {...props} />;
    case "apiKeys":
      return <ApiKeysStep {...props} />;
    case "embedding":
      return <EmbeddingStep {...props} />;
    case "agentCore":
      return <AgentCoreStep {...props} />;
    case "provider":
      return <ProviderStep {...props} />;
    case "review":
      return (
        <ReviewStep completedSteps={completedSteps} onAdvance={onAdvance} />
      );
  }
}

const SHELL_CHROME = cn(
  "relative flex h-screen w-screen overflow-hidden",
  "text-ink-primary",
);

/* Error state is an open composition on the plate (AMENDMENT A3 —
 * boxless): serif title, danger rail for the message, actions in flow. */
const ERROR_STACK_CHROME = cn("relative z-10 flex w-full max-w-md flex-col gap-4");

/** The ink plate + corner chrome shared by all three shell states.
 * Paint layers first (behind), then the pointer-events-none corners. */
function WizardChrome(): JSX.Element {
  return (
    <>
      <div aria-hidden className="vex-gate-plate absolute inset-0" />
      <div aria-hidden className="vex-gate-vignette absolute inset-0" />
      <div aria-hidden className="vex-noise pointer-events-none absolute inset-0" />

      {/* The mark alone — owner decree 2026-07-22: no "VEX" text beside it.
       * Theme-swapped pair: white on the chronos ink plate, brand blue on
       * the celeris light plate. */}
      <div className="pointer-events-none absolute left-6 top-6 z-10">
        <img
          src="/brand/vex-mark-white.svg"
          alt=""
          aria-hidden
          draggable={false}
          className="h-6 w-auto select-none [[data-vex-theme=celeris]_&]:hidden"
        />
        <img
          src="/brand/vex-mark-color.svg"
          alt=""
          aria-hidden
          draggable={false}
          className="hidden h-6 w-auto select-none [[data-vex-theme=celeris]_&]:block"
        />
      </div>
      <span className="pointer-events-none absolute bottom-7 right-10 z-10 vex-micro text-ink-tertiary">
        v{__VEX_APP_VERSION__}
      </span>
    </>
  );
}

export function WizardShell(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const openUnlock = useUiStore((s) => s.openUnlock);
  const wizardEntryMode = useUiStore((s) => s.wizardEntryMode);
  const wizardStateQuery = useWizardState();
  const reducedMotion = useReducedMotion();

  const persisted: WizardState | null =
    wizardStateQuery.data?.ok === true ? wizardStateQuery.data.data : null;
  const queryError =
    wizardStateQuery.isError ||
    (wizardStateQuery.data && wizardStateQuery.data.ok === false);

  const [currentStepId, setCurrentStepId] = useState<WizardStepId | null>(null);

  // Diagnostic screen tour (VITE_VEX_SETUP_TOUR=1, dev builds only): pin
  // the wizard to its persisted step instead of auto-routing away, so a
  // completed setup can still be VIEWED. Routing logic is untouched for
  // real builds; unlock/appShell handoffs never fire while touring.
  const setupTour = import.meta.env.VITE_VEX_SETUP_TOUR === "1";

  // Initialise local step from persisted state on first resolution.
  // We deliberately don't bind to persisted on every change — once the
  // wizard is mounted, the local step is the source of truth (the
  // user's `Save and Continue` advances both local and persisted).
  useEffect(() => {
    if (persisted === null || currentStepId !== null) return;
    if (setupTour) {
      setCurrentStepId(persisted.currentStepId);
      return;
    }
    let cancelled = false;
    const route = async (): Promise<void> => {
      const status = await window.vex.secrets.status();
      if (cancelled) return;
      const vaultConfigured = status.ok ? status.data.vaultConfigured : false;
      const unlocked = status.ok ? status.data.unlocked : false;

      // Shared decision table (features/wizard/wizard-entry.ts) — the boot
      // orchestrator resolves the SAME table, so a launch and a wizard
      // mount can never disagree about where the user lands.
      const decision = resolveWizardEntry({
        persisted,
        vaultConfigured,
        unlocked,
        entryMode: wizardEntryMode,
      });
      if (decision.kind === "unlock") {
        openUnlock(decision.returnView);
        return;
      }
      if (decision.kind === "appShell") {
        setCurrentView("appShell");
        return;
      }
      setCurrentStepId(decision.stepId);
    };
    void route();
    return () => {
      cancelled = true;
    };
  }, [persisted, currentStepId, setCurrentView, wizardEntryMode, openUnlock]);

  // Completion watcher. The init effect above owns first-mount routing
  // and early-returns once `currentStepId !== null`, so it never re-runs
  // the completed-routing after the wizard is mounted. When Finalize
  // succeeds the wizardState query refetches with `completed: true` while
  // the user is still parked on Review (`currentStepId === "review"`);
  // this effect performs the SAME completed-routing as the init effect so
  // the shell actually flips to the app shell. It guards on
  // `currentStepId !== null` (the init effect owns first-mount; this
  // avoids a relaunch double-fire) and on `persisted.completed` (only
  // fires after a real completion).
  useEffect(() => {
    if (persisted === null || currentStepId === null || !persisted.completed) {
      return;
    }
    if (setupTour) return;
    let cancelled = false;
    const route = async (): Promise<void> => {
      const status = await window.vex.secrets.status();
      if (cancelled) return;
      const vaultConfigured = status.ok ? status.data.vaultConfigured : false;
      const unlocked = status.ok ? status.data.unlocked : false;

      // Resolve the completed-routing rows of the shared table.
      const decision = resolveWizardEntry({
        persisted,
        vaultConfigured,
        unlocked,
        entryMode: "setup",
      });
      if (decision.kind === "unlock") {
        openUnlock(decision.returnView);
        return;
      }
      if (decision.kind === "step") {
        setCurrentStepId(decision.stepId);
        return;
      }
      setCurrentView("appShell");
    };
    void route();
    return () => {
      cancelled = true;
    };
  }, [persisted, currentStepId, setCurrentView, openUnlock]);

  const onAdvance = useCallback((next: WizardStepId) => {
    setCurrentStepId(next);
  }, []);

  if (queryError) {
    const message =
      wizardStateQuery.data?.ok === false
        ? wizardStateQuery.data.error.message
        : "Could not load wizard state.";
    return (
      <main
        data-vex-onboarding="true"
        data-vex-gate="true"
        data-vex-screen="wizard"
        className={cn(SHELL_CHROME, "items-center justify-center p-8")}
      >
        <WizardChrome />
        <div className={ERROR_STACK_CHROME}>
          <div className="flex flex-col gap-2">
            <h1 className="font-serif text-2xl font-normal leading-tight text-ink-primary">
              Setup unavailable
            </h1>
            {/* Danger RAIL (A3 alert grammar — no fill, no box). */}
            <p className="border-l-2 border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] pl-3 text-sm text-ink-secondary">
              {message}
            </p>
          </div>
          <p className="text-xs text-ink-tertiary">
            Most setup-state failures are transient - retry once, then
            restart Vex if the problem persists.
          </p>
          <OpenLogsLink />
          <div className="flex justify-end">
            <Button
              type="button"
              onClick={() => {
                void wizardStateQuery.refetch();
              }}
              disabled={wizardStateQuery.isFetching}
              data-vex-wizard-retry
            >
              {wizardStateQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </div>
      </main>
    );
  }

  if (currentStepId === null) {
    return (
      <main
        data-vex-onboarding="true"
        data-vex-gate="true"
        data-vex-screen="wizard"
        className={cn(SHELL_CHROME, "items-center justify-center p-8")}
      >
        <WizardChrome />
        {/* Brand loading language — the VexLoader ring, paper on the
            plate. The loader root carries role="status" itself. */}
        <div className="relative z-10 flex flex-col items-center">
          <VexLoader
            size={24}
            stroke={2}
            tone="paper"
            label="Loading wizard progress…"
          />
        </div>
      </main>
    );
  }

  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen="wizard"
      className={cn(SHELL_CHROME, "flex-col items-center px-6 pt-24 pb-8")}
    >
      <WizardChrome />

      {/*
        `m-auto` keeps the column vertically centered when the active
        step content is short. `min-h-0` + the panel's own
        `max-h-[calc(100vh-13rem)]` (13rem = pt-24 + stepper + gap-6 +
        pb-8) let the panel shrink and scroll on the 1024×720 minimum
        BrowserWindow size (codex final review V2 P1).
      */}
      <div className="relative z-10 m-auto flex min-h-0 w-full max-w-[760px] flex-col items-center gap-6">
        <HorizontalStepper
          currentStepId={currentStepId}
          completedSteps={persisted?.completedSteps ?? []}
        />
        {/* A3 boxless: the page scrolls here (quiet onboarding scrollbar),
            not inside a bordered panel well. max-w = 640px of readable
            measure + 4rem for .vex-gate-page's symmetric scrollbar gutter
            (chronos-gate.css), which keeps the thumb off the text column. */}
        <div className="vex-gate-page min-h-0 w-full max-w-[704px]">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentStepId}
              initial={reducedMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
              transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
              className="w-full"
            >
              {renderStep(
                currentStepId,
                persisted?.completedSteps ?? [],
                onAdvance,
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}
