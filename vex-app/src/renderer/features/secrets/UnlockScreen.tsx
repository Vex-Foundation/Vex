/**
 * UnlockScreen: the way in. Master-password re-prompt shown when the vault
 * is configured but locked (typical cause: app restart after onboarding,
 * or Lock Vex).
 *
 * Visual system (docs/design/H3-DESKTOP.md section 4.13; owner decision
 * 2026-11-09, "full split, keep the local screen simple"): the lock screen
 * stands on no stage. It is one split: Kimm's panel at the left
 * (`KimmPanel`, her glyph field edge to edge and her still for her mood,
 * about half the window, 40% at the 1000 floor), and at the right one
 * centred column: the mark and LOCAL VAULT · LOCKED, the headline ("Welcome
 * back." after a launch, "Vex is locked." after Lock Vex), one muted line,
 * the master password as a 56-high cell with its Show cell, Unlock as the
 * full-width key under it (the one blue), and the forgot row. A failure and
 * the throttle's countdown are one ink line under the field, a square beside
 * the sentence. "Set up a new vault?" takes the form's place in the column
 * with dialog semantics and the acknowledgement kept, Cancel and Set up new
 * vault as its keys. She rests while the screen waits, is concerned (as the
 * stage maps it) on a failure, a throttle or the reset panel, and says hi
 * once the vault opens (`stageVexLockMood`); with her stored choice hidden
 * (`vexOpenChat`), the panel keeps her field without her figure. The
 * in-flight signing stroke travels the field's foot ONLY while the unlock
 * IPC is in flight (the sanctioned in-flight loop).
 *
 * Functional logic:
 *   - password ref is uncontrolled (skill §14: the secret never lands in
 *     observable React state). The CTA's armed state rides a BOOLEAN
 *     `hasInput` set from the field's `onInput`: emptiness is the only
 *     thing that crosses into React,
 *   - PASSWORD_MIN_LENGTH client-side gate before IPC,
 *   - `secrets.unlock_throttled` surfaces an alert + 1s setInterval
 *     countdown; cleaned up on every state change (throttle windows are
 *     main-owned, the UI never implies attempts for non-password errors),
 *   - on success the password input is cleared and the handoff is armed
 *     (`beginUnlockCurtain`): App's `CurtainExit` flips the view to
 *     `unlockReturnView` ("wizard" | "appShell") beneath the stage and her
 *     stage lifts away in a 240ms crossfade.
 *
 * Test selectors preserved verbatim:
 *   - `data-vex-screen="unlock"` + `data-vex-onboarding="true"` (root),
 *   - `data-vex-lock="launch" | "locked"` (root: which unlock it is),
 *   - `data-vex-unlock-throttle="active"` (throttle alert),
 *   - `<label htmlFor="vex-unlock-password">Master password</label>`,
 *   - button text "Unlock" / "Unlocking…",
 *   - `data-vex-button="armed"` + `data-armed` on the CTA.
 */

import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { Button } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import { PasswordField } from "../../components/common/PasswordField.js";
import { VexMark } from "../../components/common/VexMark.js";
import { StageSquare, StageVersion } from "../../components/onboarding/StageFrame.js";
import { useGateDocumentScope } from "../../components/onboarding/SetupFrame.js";
import {
  stageVexConcerned,
  stageVexLockMood,
  stageVexUnlocked,
  useStageVex,
} from "../../components/onboarding/stage-vex.js";
import { KimmPanel } from "../../components/vex/kimm/KimmPanel.js";
import { useUiStore } from "../../stores/uiStore.js";
import { PASSWORD_MIN_LENGTH } from "@shared/schemas/secrets.js";
import { getErrorCopy } from "../../lib/errors/error-copy.js";
import { cn } from "../../lib/utils.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";

interface ThrottleState {
  readonly message: string;
  readonly retryAtMs: number;
}

export function UnlockScreen(): JSX.Element {
  useGateDocumentScope();
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const forgotRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const resetWasOpenRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [errorFromBridge, setErrorFromBridge] = useState(false);
  const [pending, setPending] = useState(false);
  const [throttle, setThrottle] = useState<ThrottleState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [resetOpen, setResetOpen] = useState(false);
  const [resetAcknowledged, setResetAcknowledged] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [resetRestarting, setResetRestarting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  // ARMED SIGNAL - a BOOLEAN, never the password. The field stays
  // uncontrolled (skill §14): the only thing that crosses into React state
  // is whether it is empty, which is what lights the CTA up. Guarded by
  // `UnlockScreen-no-leak.test.tsx`.
  const [hasInput, setHasInput] = useState(false);
  const beginUnlockCurtain = useUiStore((s) => s.beginUnlockCurtain);
  // Her stored choice is the chat's, as on the stage (section 4.10): hidden, her
  // panel keeps the field without her figure. Read only: the lock screen has no key for it.
  const figure = useUiStore((s) => s.vexOpenChat) === true;
  const stage = useStageVex();
  // After Lock Vex the desk is locked; the launch's own unlock is not that.
  const lockedDesk = !stage.launching;
  const mood = stageVexLockMood(stage);

  // Tick once a second while a throttle window is active so the countdown
  // re-renders. Cleared on every state change, no leaked intervals.
  useEffect(() => {
    if (throttle === null) return;
    if (throttle.retryAtMs <= Date.now()) {
      setThrottle(null);
      return;
    }
    const id = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= throttle.retryAtMs) {
        window.clearInterval(id);
        setThrottle(null);
      }
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [throttle]);

  const throttleRemainingMs =
    throttle !== null ? Math.max(0, throttle.retryAtMs - now) : 0;
  const throttleRemainingSeconds = Math.ceil(throttleRemainingMs / 1000);
  const throttleActive = throttle !== null && throttleRemainingMs > 0;
  const inputsDisabled = pending || throttleActive;

  // Vex is concerned while there is something to be concerned about: a failed
  // attempt, a throttle window (with its seconds), the vault reset panel.
  const concerned = resetOpen || error !== null || throttleActive;
  useEffect(() => {
    stageVexConcerned(concerned, throttleActive ? throttleRemainingSeconds : null);
  }, [concerned, throttleActive, throttleRemainingSeconds]);
  useEffect(() => () => stageVexConcerned(false), []);

  // The reset panel takes the form's place: the safer choice takes focus (rule
  // 08, the sibling action destroys the vault), and closing it returns focus
  // to the link that opened it.
  useEffect(() => {
    if (resetOpen) {
      resetWasOpenRef.current = true;
      cancelRef.current?.focus();
      return;
    }
    if (resetWasOpenRef.current) {
      resetWasOpenRef.current = false;
      forgotRef.current?.focus();
    }
  }, [resetOpen]);

  // Escape closes the panel, unless the reset is in flight.
  useEffect(() => {
    if (!resetOpen || resetPending || resetRestarting) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setResetOpen(false);
      setResetAcknowledged(false);
      setResetError(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [resetOpen, resetPending, resetRestarting]);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (throttleActive) return;
    const password = passwordRef.current?.value ?? "";
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      setErrorFromBridge(false);
      return;
    }

    setPending(true);
    setError(null);
    setErrorFromBridge(false);
    try {
      const result = await window.vex.secrets.unlock({ password });
      if (!result.ok) {
        if (
          result.error.code === "secrets.unlock_throttled"
          && typeof result.error.retryAfterMs === "number"
          && result.error.retryAfterMs >= 0
        ) {
          // Workflow-specific UX (countdown banner), the message comes
          // from the shared copy helper so the wording stays
          // consistent with other throttle surfaces (e.g. wallet
          // private-key export).
          const copy = getErrorCopy(result.error);
          setThrottle({
            message: copy.message,
            retryAtMs: Date.now() + result.error.retryAfterMs,
          });
          setNow(Date.now());
          setError(null);
          return;
        }
        setError(getErrorCopy(result.error).message);
        setErrorFromBridge(true);
        return;
      }
      if (passwordRef.current) passwordRef.current.value = "";
      setHasInput(false);
      stageVexUnlocked();
      beginUnlockCurtain();
    } finally {
      setPending(false);
    }
  }

  function setResetDialogOpen(open: boolean): void {
    if (resetPending || resetRestarting) return;
    setResetOpen(open);
    if (!open) {
      setResetAcknowledged(false);
      setResetError(null);
    }
  }

  async function requestFreshVault(): Promise<void> {
    if (!resetAcknowledged || resetPending) return;
    setResetPending(true);
    setResetError(null);
    try {
      const result = await window.vex.secrets.resetToFreshVault({ confirm: true });
      if (!result.ok) {
        if (result.error.code !== "internal.cancelled") {
          setResetError(getErrorCopy(result.error).message);
        }
        return;
      }
      setResetRestarting(true);
    } finally {
      setResetPending(false);
    }
  }

  return (
    <main
      data-vex-onboarding="true"
      data-vex-gate="true"
      data-vex-screen="unlock"
      data-vex-lock={lockedDesk ? "locked" : "launch"}
      className="vex-lock"
    >
      {/* The window's top strip: a drag region over both halves, nothing in it
        (the mac lights stand over Kimm's top left, the caption overlay at the
        top right). The column below starts under it. */}
      <div aria-hidden="true" className="vex-lock__head vex-drag" />
      <KimmPanel mood={mood} figure={figure} className="vex-lock__kimm" />
      <div className="vex-lock__side">
        <div className="vex-lock__col vex-no-drag">
          <p className="vex-lock__brand">
            <VexMark size={24} />
            <span className="vex-lock__label">Local vault · Locked</span>
          </p>
          {/* The form keeps its place in the tree while the reset panel stands
            in for it, so a half-typed password survives a Cancel. */}
          <section
            aria-labelledby="vex-unlock-title"
            hidden={resetOpen}
            className="vex-unl__form"
          >
            <h1 id="vex-unlock-title" className="vex-lock__title">
              {lockedDesk ? "Vex is locked." : "Welcome back."}
            </h1>
            <p className="vex-lock__lead">
              Your master password decrypts the local vault on this machine. Your keys stay on
              this computer.
            </p>
            <form
              onSubmit={(event) => {
                void onSubmit(event);
              }}
              className="vex-unl__fields"
            >
              <Label htmlFor="vex-unlock-password" className="vex-unl__lab">
                Master password
              </Label>
              <div className="vex-unl__field" data-throttled={throttleActive ? "" : undefined}>
                <PasswordField
                  id="vex-unlock-password"
                  ref={passwordRef}
                  autoComplete="current-password"
                  autoFocus
                  aria-invalid={error !== null ? true : undefined}
                  disabled={inputsDisabled}
                  onInput={(event) => {
                    setHasInput(event.currentTarget.value.length > 0);
                  }}
                />
                {/* SIGNATURE STROKE - rests at scale 0 on the field's foot;
                  while the unlock IPC is in flight the ink travels it
                  (.vex-sign-stroke--signing, the sanctioned in-flight loop). */}
                <span
                  aria-hidden
                  className={cn(
                    "vex-unl__stroke vex-sign-stroke",
                    pending && "vex-sign-stroke--signing",
                  )}
                />
              </div>
              {/* A failure and the throttle's countdown: one ink line under the
                field, a square beside the sentence, the logs at the right. */}
              {throttleActive ? (
                <div className="vex-unl__alert" data-vex-unlock-alert="throttle">
                  <StageSquare kind="ink" />
                  <span role="alert" data-vex-unlock-throttle="active">
                    {throttle.message}{" "}
                    <span className="vex-num">({throttleRemainingSeconds}s)</span>
                  </span>
                  <OpenLogsLink className="vex-fr-link" />
                </div>
              ) : error ? (
                <div className="vex-unl__alert" data-vex-unlock-alert="error">
                  <StageSquare kind="failed" />
                  <span role="alert">{error}</span>
                  {errorFromBridge ? <OpenLogsLink className="vex-fr-link" /> : null}
                </div>
              ) : null}
              {/* THE ARMED CTA, the full-width key under the field: the key
                cell while the field is empty, the one blue fill the moment
                anything is typed and while the unlock is in flight.
                `data-armed` carries only the boolean. While the throttle
                window runs the key is disabled and held (the cell fill, muted
                words), though `data-armed` stays true. */}
              <Button
                type="submit"
                variant="armed"
                data-armed={hasInput}
                data-busy={pending ? "" : undefined}
                disabled={inputsDisabled}
                className="vex-unl__go"
              >
                {pending ? (
                  "Unlocking…"
                ) : (
                  <>
                    Unlock
                    <span aria-hidden>→</span>
                  </>
                )}
              </Button>
            </form>
            <button
              ref={forgotRef}
              type="button"
              disabled={inputsDisabled}
              onClick={() => setResetDialogOpen(true)}
              className="vex-unl__forgot"
            >
              I forgot my password - set up a new vault
              <span aria-hidden>→</span>
            </button>
          </section>

          {resetOpen ? (
            <section
              role="dialog"
              aria-modal="false"
              aria-labelledby="vex-unlock-reset-title"
              aria-describedby="vex-unlock-reset-desc"
              data-vex-unlock-reset=""
              className="vex-unl__panel"
            >
              <div className="vex-unl__panel-body">
                <h2 id="vex-unlock-reset-title" className="vex-unl__panel-title">
                  Set up a new vault?
                </h2>
                <p id="vex-unlock-reset-desc" className="vex-unl__panel-sub">
                  This does not recover or decrypt the current vault.
                </p>
                {resetRestarting ? (
                  <p role="status">Restarting Vex…</p>
                ) : (
                  <>
                    <p>
                      Your wallets stay encrypted with the forgotten password in the
                      backup folder and are kept until you deliberately delete them.
                      They remain unusable without that password.
                    </p>
                    <p>
                      On-chain funds can be recovered only from an existing backup or
                      seed phrase. Local history remains on this machine. Any
                      in-progress or persisted mission work will be abandoned, and
                      pending approvals will remain unanswered.
                    </p>
                    <label className="vex-unl__ack">
                      <input
                        type="checkbox"
                        checked={resetAcknowledged}
                        onChange={(event) => setResetAcknowledged(event.currentTarget.checked)}
                      />
                      <span>I understand that the forgotten password cannot be recovered.</span>
                    </label>
                  </>
                )}
              </div>
              {!resetRestarting && resetError ? (
                <div className="vex-unl__alert" data-vex-unlock-alert="reset">
                  <StageSquare kind="failed" />
                  <span role="alert">{resetError}</span>
                  <OpenLogsLink className="vex-fr-link" />
                </div>
              ) : null}
              {/* The reset's own keys: Cancel, the safer choice, first; the
                vault's reset beside it, never the blue (it is not the way in). */}
              {!resetRestarting ? (
                <div className="vex-unl__panel-acts">
                  <Button
                    ref={cancelRef}
                    type="button"
                    variant="ink"
                    disabled={resetPending}
                    onClick={() => setResetDialogOpen(false)}
                    className="vex-pre-key"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="stop"
                    disabled={!resetAcknowledged || resetPending}
                    onClick={() => void requestFreshVault()}
                    className="vex-pre-danger"
                  >
                    {resetPending ? "Requesting…" : "Set up new vault"}
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
        <div className="vex-lock__foot">
          <StageVersion />
        </div>
      </div>
    </main>
  );
}
