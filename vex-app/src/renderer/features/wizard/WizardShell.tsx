/**
 * The setup wizard's frame (docs/design/R3-MINIMAL.md section 10.3).
 *
 * Layout: a plate at the left (480 at 1440, a third of the window under it,
 * gone under 1180): the plateau print, its grain and Vex rising from the
 * token, with no word under her (owner). At the right: the named stepper in the
 * top band (the hidden title bar's drag region), then the current step's page
 * (`WizardStepPanel`): "Step N of 7 · {name}", the serif title, the lead, the
 * form, and a footer at the window's foot with the privacy link and the
 * step's actions. Under 1180 a small vx mark stands above the step instead of
 * the plate. No state word stands under or beside her anywhere in the wizard
 * (the owner, 2026-10-17 on the plate and 2026-10-18 on every stage). Loading
 * is the quiet loading line.
 *
 * Vex's mood follows real focus: she listens while a text field of the form
 * has focus, else she is at rest (her face on the plate; the frame carries it
 * as `data-vex-wizard-mood`).
 *
 * Per-step chrome lives in `WizardStepPanel`; the shell provides each step
 * its wizard host (`wizard-host.ts`): what stands above its title and, on
 * steps 2 to 7, Back. Each step returns a `WizardStepPanel` (ReviewStep's edit
 * path renders the edited step's panel with the editing row added above its
 * title, and no Back: it has "Return to review").
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
import { VexLoader } from "../../components/ui/vex-loader.js";
import { VxToken } from "../../components/ui/vx-token.js";
import { VexK2 } from "../../components/vex/k2/VexK2.js";
import type { K2Emotion } from "../../components/vex/k2/k2-emotion.js";
import { useUiStore } from "../../stores/uiStore.js";
import { previousStepId, useWizardState } from "../../lib/api/wizard.js";
import { resolveWizardEntry } from "./wizard-entry.js";
import { HorizontalStepper, WizardStepEyebrow } from "./HorizontalStepper.js";
import { WizardHostContext } from "./wizard-host.js";
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

/** What Vex shows: her face (no word goes with it, the owner). */
interface WizardFace {
  readonly emotion: K2Emotion;
}

const READY: WizardFace = { emotion: "idle" };
const LISTENING: WizardFace = { emotion: "listening" };

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

/** The plate: the print, its grain and Vex (her mood, no word under her). */
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
      data-vex-wizard-mood={face.emotion}
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

/** The small mark's size under 1180 (spec 10.1: "a 40 mark" where the plate goes). */
export const WIZARD_MINI_MARK = 40;

/** Under 1180, above the step: the vx mark, with no state word (the owner). */
function WizardMini(): JSX.Element {
  return (
    <div className="vex-wzp__mini" data-vex-wizard-mini>
      <VxToken size={WIZARD_MINI_MARK} />
    </div>
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
      <WizardFrame face={face}>
        <div className="vex-wzp">
          <header className="vex-wzp__head">
            <WizardMini />
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

  if (currentStepId === null) {
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
              before: (
                <>
                  <WizardMini />
                  <WizardStepEyebrow currentStepId={id} />
                </>
              ),
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
