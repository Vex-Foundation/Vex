/**
 * The setup wizard on H3's stage (docs/design/H3-DESKTOP.md section 4.9; the
 * plates `stage-wizard-password` and `stage-wizard-wallets`, approved as
 * drawn).
 *
 * Layout: the stage frame (`StageFrame`), with Kimm on her stage in the
 * middle column (`App` mounts her column once, `StagePlate`). The left column
 * says where you are: the seven steps, drawn like the nav (`wizard-where.ts`);
 * the title cell says the step and "Setup · Step N of 7"; the work column is
 * the current step's page (`WizardStepPanel`): the title, the lead, the form,
 * and its keys in the bottom row. The bottom-left cell is the privacy link.
 * Loading is the quiet loading line.
 *
 * Vex follows real focus: she listens while a text field of the form has
 * focus (the Vex key reads Listening, and she says hi), else she rests beside
 * the step (Ready, at rest), as the plates draw her. The frame carries it as
 * `data-vex-wizard-mood`, and the stage store carries it to her column
 * (`useStageFace`).
 *
 * Per-step chrome lives in `WizardStepPanel`; the shell provides each step
 * its wizard host (`wizard-host.ts`): on steps 2 to 7, Back. Each step
 * returns a `WizardStepPanel` (ReviewStep's edit path renders the edited
 * step's panel with the editing row added above its title, and no Back: it
 * has "Return to review").
 *
 * BACK (the mockups' footer key on steps 2 to 7, the owner 2026-10-18) moves
 * the view one step back and saves nothing. Every form step the user has
 * seen stays mounted, hidden while another is shown, so the values typed into
 * it are still there both ways (a hidden step leaves the accessibility tree
 * and the tab order with `hidden`). Review is the exception: it is a summary
 * of what is saved, so it mounts afresh each time it is shown and never
 * shows a stale line after an earlier step changed. Moving on is always the step's own action, so
 * its checks run again: the vault step shows the configured vault (the
 * password rules never reopen and are never skipped), a form re-validates
 * before it saves, and the persisted state never moves behind the ground
 * already covered (`nextWizardStateFor`). A step that comes into view fades
 * in on the shared surface entrance (`wizard.css`).
 *
 * The active step lives in local React state, not Zustand. Recovery after a
 * crash mid-wizard flows through `wizard-state.json` and the TanStack Query
 * cache.
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
  useState,
  type FocusEvent,
  type JSX,
  type ReactNode,
} from "react";
import {
  WIZARD_STEP_IDS,
  type WizardStepId,
  type WizardState,
} from "@shared/schemas/wizard.js";
import { Button } from "../../components/ui/button.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";
import { StageActs, StageFrame, StageGap } from "../../components/onboarding/StageFrame.js";
import { useStageFace, type StageVexView } from "../../components/onboarding/stage-vex.js";
import { VexLoader } from "../../components/ui/vex-loader.js";
import { useUiStore } from "../../stores/uiStore.js";
import { previousStepId, useWizardState } from "../../lib/api/wizard.js";
import { kimmMoodOf } from "../vex/kimm-mood.js";
import { resolveWizardEntry } from "./wizard-entry.js";
import { WizardHostContext } from "./wizard-host.js";
import { WIZARD_STEP_META } from "./wizard-icons.js";
import { WIZARD_LABEL, wizardSub, wizardWhere } from "./wizard-where.js";
import { WizardPrivacyLink } from "./WizardStepPanel.js";
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

/**
 * What Vex shows beside the wizard, as the approved plates draw her: while a
 * text field has focus she listens and says hi (`stage-wizard-password`,
 * through the shell's own map); else she rests beside the step, the Vex key
 * reading Ready (`stage-wizard-wallets`: the plate's rest, not the map's hi).
 */
const READY: StageVexView = { state: "ready", word: "Ready", note: null, mood: "rest" };
const LISTENING: StageVexView = {
  state: "listening",
  word: "Listening",
  note: null,
  mood: kimmMoodOf("listening"),
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

/**
 * The frame: the stage frame with the wizard's left column, its title cell
 * (the step's name over "Setup · Step N of 7") and the privacy link in the
 * bottom-left cell; the step's page in the work column.
 */
function WizardFrame({
  face,
  current,
  completedSteps,
  onFocusWithin,
  onBlurWithin,
  children,
}: {
  readonly face: StageVexView;
  readonly current: WizardStepId | null;
  readonly completedSteps: ReadonlyArray<WizardStepId>;
  readonly onFocusWithin?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly onBlurWithin?: (event: FocusEvent<HTMLDivElement>) => void;
  readonly children: ReactNode;
}): JSX.Element {
  useGateDocumentScope();
  useStageFace(face);
  return (
    <StageFrame
      screen="wizard"
      title={current === null ? WIZARD_LABEL : WIZARD_STEP_META[current].label}
      sub={current === null ? WIZARD_LABEL : wizardSub(current)}
      // The step's page carries the heading (its title); the cell names it.
      heading={false}
      where={wizardWhere(current, completedSteps)}
      foot={<WizardPrivacyLink />}
      footVersion={false}
      rootProps={{ "data-vex-wizard-mood": face.state }}
    >
      <div className="vex-wz__main" onFocus={onFocusWithin} onBlur={onBlurWithin}>
        {children}
      </div>
    </StageFrame>
  );
}

export function WizardShell(): JSX.Element {
  const setCurrentView = useUiStore((s) => s.setCurrentView);
  const openUnlock = useUiStore((s) => s.openUnlock);
  const wizardEntryMode = useUiStore((s) => s.wizardEntryMode);
  const wizardStateQuery = useWizardState();

  const persisted: WizardState | null =
    wizardStateQuery.data?.ok === true ? wizardStateQuery.data.data : null;
  const queryError =
    wizardStateQuery.isError ||
    (wizardStateQuery.data && wizardStateQuery.data.ok === false);

  const [currentStepId, setCurrentStepId] = useState<WizardStepId | null>(null);
  // Every step shown in this session, kept mounted so what was typed stays.
  const [seen, setSeen] = useState<ReadonlySet<WizardStepId>>(() => new Set());
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
  const onBack = useCallback(() => {
    setCurrentStepId((step) => (step === null ? step : (previousStepId(step) ?? step)));
  }, []);
  useEffect(() => {
    if (currentStepId === null) return;
    setSeen((was) => (was.has(currentStepId) ? was : new Set([...was, currentStepId])));
    // The key that moved the view (Back, or a step's own action onto a step
    // already seen) now sits in a hidden step: focus goes to the shown
    // step's title, never to the page body. A step mounting for the first
    // time keeps its own autofocus.
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active.closest("[data-vex-wizard-pane]")?.hasAttribute("hidden") !== true) return;
    const pane = document.querySelector<HTMLElement>(`[data-vex-wizard-pane="${currentStepId}"]`);
    const title = pane?.querySelector<HTMLElement>("h1") ?? pane;
    if (title === null || title === undefined) return;
    if (!title.hasAttribute("tabindex")) title.setAttribute("tabindex", "-1");
    title.focus({ preventScroll: true });
  }, [currentStepId]);

  const onFocusWithin = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setListening(isTextEntry(event.target));
  }, []);
  const onBlurWithin = useCallback((event: FocusEvent<HTMLDivElement>) => {
    setListening(isTextEntry(event.relatedTarget));
  }, []);

  if (queryError) {
    const message =
      wizardStateQuery.data?.ok === false
        ? wizardStateQuery.data.error.message
        : "Could not load wizard state.";
    return (
      <WizardFrame face={face} current={null} completedSteps={[]}>
        <div className="vex-wzp">
          <div className="vex-pre__body vex-wzp__body">
            <div className="vex-wzp__page">
              <header className="vex-wzp__head">
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
                </div>
              </div>
            </div>
          </div>
          <StageActs className="vex-wzp__foot">
            <StageGap />
            <Button
              type="button"
              onClick={() => {
                void wizardStateQuery.refetch();
              }}
              disabled={wizardStateQuery.isFetching}
              data-vex-wizard-retry
              className="vex-pre-primary"
            >
              {wizardStateQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </StageActs>
        </div>
      </WizardFrame>
    );
  }

  if (currentStepId === null) {
    return (
      <WizardFrame face={face} current={null} completedSteps={[]}>
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
      current={currentStepId}
      completedSteps={persisted?.completedSteps ?? []}
      onFocusWithin={onFocusWithin}
      onBlurWithin={onBlurWithin}
    >
      {WIZARD_STEP_IDS.filter((id) => id === currentStepId || (seen.has(id) && id !== "review")).map((id) => (
        <div
          key={id}
          className="vex-wz__step"
          data-vex-wizard-pane={id}
          hidden={id !== currentStepId}
        >
          <WizardHostContext.Provider
            value={{
              host: "wizard",
              ...(previousStepId(id) === null ? {} : { onBack }),
            }}
          >
            {renderStep(id, persisted?.completedSteps ?? [], onAdvance)}
          </WizardHostContext.Provider>
        </div>
      ))}
    </WizardFrame>
  );
}
