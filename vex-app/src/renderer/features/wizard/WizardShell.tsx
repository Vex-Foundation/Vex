/**
 * Wizard shell (M7, Phase 2 refactor: Mode + Wake steps removed; V10:
 * the wizard is a page on the stage, docs/design/V10-SPREAD.md section 2,
 * the d8 reference).
 *
 * Layout: the wizard stands on the pre-shell stage like every setup screen
 * (`SetupFrame`, the paper leaf at the right). The sky to the leaf's left
 * carries the current step number as the giant counter and the seven-step
 * index (`HorizontalStepper`); the leaf carries the stepper's eyebrow
 * ("Step 2 of 7 · Wallets") above `WizardStepPanel`; the ground carries the
 * privacy link and the version. Loading state is the VexLoader.
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
  WIZARD_STEP_IDS,
  type WizardStepId,
  type WizardState,
} from "@shared/schemas/wizard.js";
import { Button } from "../../components/ui/button.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { StageCounter } from "../../components/onboarding/PreShellStage.js";
import { IconArrowUpRight } from "../../components/icons/index.js";
import {
  VEX_PRIVACY_DOC_LABEL,
  VEX_PRIVACY_DOC_URL,
} from "@shared/docs-links.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useWizardState } from "../../lib/api/wizard.js";
import { resolveWizardEntry } from "./wizard-entry.js";
import {
  HorizontalStepper,
  WizardStepEyebrow,
  stepNumeral,
} from "./HorizontalStepper.js";
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

/** The stage ground: the privacy link and the version stamp (d8). */
const GROUND_START = (
  <a href={VEX_PRIVACY_DOC_URL} target="_blank" rel="noopener noreferrer">
    {VEX_PRIVACY_DOC_LABEL}
    <IconArrowUpRight size={12} />
  </a>
);
const GROUND_END = <span>v{__VEX_APP_VERSION__}</span>;

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
      <SetupFrame
        screen="wizard"
        title="Setup unavailable"
        groundStart={GROUND_START}
        groundEnd={GROUND_END}
      >
        <div className="flex flex-col gap-4">
          <p className="vex-callout">{message}</p>
          <p className="text-xs text-ink-tertiary">
            Most setup-state failures are transient - retry once, then
            restart Vex if the problem persists.
          </p>
          <OpenLogsLink />
          <div className="flex">
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
      </SetupFrame>
    );
  }

  if (currentStepId === null) {
    return (
      <SetupFrame
        screen="wizard"
        groundStart={GROUND_START}
        groundEnd={GROUND_END}
      >
        {/* Brand loading language - the VexLoader on the leaf. The loader
            root carries role="status" itself. */}
        <VexLoader size={24} stroke={2} label="Loading wizard progress…" />
      </SetupFrame>
    );
  }

  const stepIndex = WIZARD_STEP_IDS.indexOf(currentStepId);
  return (
    <SetupFrame
      screen="wizard"
      eyebrow={<WizardStepEyebrow currentStepId={currentStepId} />}
      sky={
        <div className="vex-stage-sky vex-stage-sky--steps">
          <StageCounter>{stepNumeral(stepIndex)}</StageCounter>
          <HorizontalStepper
            currentStepId={currentStepId}
            completedSteps={persisted?.completedSteps ?? []}
          />
        </div>
      }
      groundStart={GROUND_START}
      groundEnd={GROUND_END}
    >
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
    </SetupFrame>
  );
}
