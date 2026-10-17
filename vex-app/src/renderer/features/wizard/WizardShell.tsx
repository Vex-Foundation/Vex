/**
 * The setup wizard's frame (docs/design/R3-MINIMAL.md section 10.3).
 *
 * Layout: a plate at the left (480 at 1440, a third of the window under it,
 * gone under 1180): the plateau print, its grain, Vex rising from the token
 * and her state word on the print. At the right: the named stepper in the
 * top band (the hidden title bar's drag region), then the current step's page
 * (`WizardStepPanel`): "Step N of 7 · {name}", the serif title, the lead, the
 * form, and a footer at the window's foot with the privacy link and the
 * step's actions. Under 1180 a small vx mark and Vex's word stand above the
 * step instead of the plate. Loading is the quiet loading line.
 *
 * Vex's word follows real focus: "Listening" while a text field of the form
 * has focus, else "Ready".
 *
 * Per-step chrome lives in `WizardStepPanel`; the shell provides the wizard
 * host (`wizard-host.ts`) with what stands above each step's title. Each step
 * returns a `WizardStepPanel` (ReviewStep's edit path renders the edited
 * step's panel with the editing row added above its title).
 * `AnimatePresence` stays on this shell; the panel is a plain element so
 * transitions are not doubled.
 *
 * There is no back navigation outside Review's edit path; the active step
 * lives in local React state, not Zustand. Recovery after a crash mid-wizard
 * flows through `wizard-state.json` and the TanStack Query cache.
 *
 * If `completed === true` (Review finalised on a previous launch) we flip the
 * view to `appShell` immediately. Two effects own this routing: the one-time
 * init effect handles first mount (relaunch into a completed setup), and a
 * dedicated COMPLETION WATCHER handles the in-session flip after Finalize
 * succeeds on Review (where `currentStepId` is already non-null, so the init
 * effect's guard skips it).
 *
 * Contracts:
 *   - `data-vex-screen="wizard"` is the stable e2e/test selector.
 *   - `data-vex-onboarding="true"` keeps the shared onboarding accent scope.
 *   - `data-vex-gate="true"` applies the pre-shell token re-projection
 *     (`global-css/chronos-gate.css`); the frame also stamps it on
 *     documentElement for its lifetime so body-portaled surfaces (menus,
 *     tooltips, toasts) opened from a step keep it. The pre-shell screens
 *     never stack (`App` sequences them), so the frame owns the stamp while
 *     it stands.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { WizardStepId, WizardState } from "@shared/schemas/wizard.js";
import { Button } from "../../components/ui/button.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { StateWord } from "../../components/ui/state-word.js";
import type { SwatchState } from "../../components/ui/swatch.js";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { VxToken } from "../../components/ui/vx-token.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import type { K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import { useUiStore } from "../../stores/uiStore.js";
import { useWizardState } from "../../lib/api/wizard.js";
import { resolveWizardEntry } from "./wizard-entry.js";
import { HorizontalStepper, WizardStepEyebrow } from "./HorizontalStepper.js";
import { WizardHostContext, type WizardHostValue } from "./wizard-host.js";
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
  // Every wizard step receives `flowMode="first-pass"` from the shell.
  // ReviewStep itself dispatches edited steps with `flowMode="back-edit"`
  // (local nav, no persisted state advance).
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

/** The day and the night print (the plateau, `public/art/`). */
const PRINT_ART = {
  day: "/art/plateau.jpg",
  night: "/art/plateau-night.jpg",
} as const;

/** What Vex shows: her face, the fill and the word. */
interface WizardFace {
  readonly emotion: K2Emotion;
  readonly swatch: SwatchState;
  readonly word: string;
}

const READY: WizardFace = { emotion: "idle", swatch: "idle", word: "Ready" };
const LISTENING: WizardFace = {
  emotion: "listening",
  swatch: "listening",
  word: "Listening",
};

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "password",
  "search",
  "url",
  "email",
  "number",
  "tel",
]);

/** A field the user types into: Vex listens while one has focus. */
function isTextEntry(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type);
}

/**
 * Carry the `[data-vex-gate]` token scope on documentElement while the frame
 * stands, so a portaled surface opened from a step keeps the projection.
 */
function useGateDocumentScope(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset["vexGate"] = "true";
    return () => {
      // Another pre-shell screen that already stands keeps the stamp.
      if (document.querySelector('main[data-vex-gate="true"]') === null) {
        delete root.dataset["vexGate"];
      }
    };
  }, []);
}

/** The plate: the print, its grain, Vex and her word. */
function WizardPlate({ face }: { readonly face: WizardFace }): JSX.Element {
  return (
    <div className="vex-wz__plate">
      <img
        src={PRINT_ART.day}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="vex-wz__print vex-wz__print--day"
      />
      <img
        src={PRINT_ART.night}
        alt=""
        aria-hidden="true"
        decoding="async"
        draggable={false}
        className="vex-wz__print vex-wz__print--night"
      />
      <div aria-hidden="true" data-vex-print-grain="" className="vex-wz__grain" />
      <VexK2
        placement="stage"
        ground="print"
        emotion={face.emotion}
        className="vex-wz__vex"
      />
      <div className="vex-wz__word" data-vex-wizard-vex-word>
        <StateWord state={face.swatch} word={face.word} size={10} />
      </div>
      <div aria-hidden="true" className="vex-wz__drag vex-drag" />
    </div>
  );
}

/** The frame: the plate and the main column. */
function WizardFrame({
  face,
  top,
  onFocusWithin,
  onBlurWithin,
  children,
}: {
  readonly face: WizardFace;
  readonly top?: ReactNode;
  readonly onFocusWithin?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onBlurWithin?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}): JSX.Element {
  useGateDocumentScope();
  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen="wizard"
      className="vex-wz"
    >
      <WizardPlate face={face} />
      <div className="vex-wz__main" onFocus={onFocusWithin} onBlur={onBlurWithin}>
        <div className="vex-wz__top vex-drag">{top}</div>
        <div className="vex-wz__body">{children}</div>
      </div>
    </main>
  );
}

/** Under 1180, above the step: the vx mark and Vex's word. */
function WizardMini({ face }: { readonly face: WizardFace }): JSX.Element {
  return (
    <div className="vex-wzp__mini" data-vex-wizard-mini>
      <VxToken size={26} />
      <StateWord state={face.swatch} word={face.word} size={10} />
    </div>
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
  const [listening, setListening] = useState(false);
  const face = listening ? LISTENING : READY;

  // Diagnostic screen tour (VITE_VEX_SETUP_TOUR=1, dev builds only): pin
  // the wizard to its persisted step instead of auto-routing away, so a
  // completed setup can still be VIEWED. Routing logic is untouched for
  // real builds; unlock/appShell handoffs never fire while touring.
  const setupTour = import.meta.env.VITE_VEX_SETUP_TOUR === "1";

  // Initialise local step from persisted state on first resolution.
  // We deliberately don't bind to persisted on every change - once the
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

      // Shared decision table (features/wizard/wizard-entry.ts) - the boot
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

  const onFocusWithin = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setListening(isTextEntry(event.target));
  }, []);
  const onBlurWithin = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setListening(isTextEntry(event.relatedTarget));
  }, []);

  const host = useMemo<WizardHostValue | null>(
    () =>
      currentStepId === null
        ? null
        : {
            host: "wizard",
            before: (
              <>
                <WizardMini face={face} />
                <WizardStepEyebrow currentStepId={currentStepId} />
              </>
            ),
          },
    [currentStepId, face],
  );

  if (queryError) {
    const message =
      wizardStateQuery.data?.ok === false
        ? wizardStateQuery.data.error.message
        : "Could not load wizard state.";
    return (
      <WizardFrame face={face}>
        <div className="vex-wzp">
          <header className="vex-wzp__head">
            <WizardMini face={face} />
            <h1 className="vex-wzp__title">Setup unavailable</h1>
          </header>
          <div className="vex-wzp__content">
            <div className="vex-wz-stack">
              <p className="vex-callout">{message}</p>
              <p className="vex-wz-note">
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
          </div>
        </div>
      </WizardFrame>
    );
  }

  if (currentStepId === null || host === null) {
    return (
      <WizardFrame face={face}>
        {/* The quiet loading line; the loader root carries role="status". */}
        <div className="vex-wz__loading">
          <VexLoader label="Loading wizard progress…" />
        </div>
      </WizardFrame>
    );
  }

  return (
    <WizardFrame
      face={face}
      top={
        <HorizontalStepper
          currentStepId={currentStepId}
          completedSteps={persisted?.completedSteps ?? []}
        />
      }
      onFocusWithin={onFocusWithin}
      onBlurWithin={onBlurWithin}
    >
      <WizardHostContext.Provider value={host}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={currentStepId}
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
            className="vex-wz__step"
          >
            {renderStep(
              currentStepId,
              persisted?.completedSteps ?? [],
              onAdvance,
            )}
          </motion.div>
        </AnimatePresence>
      </WizardHostContext.Provider>
    </WizardFrame>
  );
}
