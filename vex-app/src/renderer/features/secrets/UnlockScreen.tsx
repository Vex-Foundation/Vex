/**
 * UnlockScreen: the way in. Master-password re-prompt shown when the vault
 * is configured but locked (typical cause: app restart after onboarding,
 * or Lock Vex).
 *
 * Visual system (`docs/design/R3-MINIMAL.md section 10.2`): the screen stands
 * on the stage's plate (`SetupFrame`, `layout="open"`; the plate with Vex at
 * the left belongs to `App`). The right side is paper: "Welcome back.", the
 * master password field, "Unlock →" and the forgot link. Vex is asleep after
 * Lock Vex ("Sleeping · Locked"), still waking when the launch brought you
 * here, concerned on an error, and awake and looking at you once the vault
 * opens (`components/onboarding/stage-vex.ts`). A failure is the ink callout;
 * "Set up a new vault?" is an inline panel in place of the form, with dialog
 * semantics and the acknowledgement kept. The in-flight signing stroke travels
 * the field's rule ONLY while the unlock IPC is in flight (the sanctioned
 * in-flight loop).
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
 *     `unlockReturnView` ("wizard" | "appShell") beneath the plate and the
 *     plate lifts away in a 240ms crossfade.
 *
 * Test selectors preserved verbatim:
 *   - `data-vex-screen="unlock"` + `data-vex-onboarding="true"` (root,
 *     via SetupFrame),
 *   - `data-vex-unlock-throttle="active"` (throttle alert),
 *   - `<label htmlFor="vex-unlock-password">Master password</label>`,
 *   - button text "Unlock" / "Unlocking…",
 *   - `data-vex-button="armed"` + `data-armed` on the CTA.
 */

import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { Button } from "../../components/ui/button.js";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { Label } from "../../components/ui/label.js";
import { PasswordField } from "../../components/common/PasswordField.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { VersionStamp } from "../../components/onboarding/PreShellStage.js";
import {
  stageVexConcerned,
  stageVexUnlocked,
  useStageVex,
} from "../../components/onboarding/stage-vex.js";
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
  // After Lock Vex the desk is locked and she sleeps; the launch's own unlock is not that.
  const lockedDesk = !useStageVex().launching;

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
    <SetupFrame screen="unlock" layout="open">
      <div className="vex-stage-side vex-unl">
        {/* The form keeps its place in the tree while the reset panel stands
          in for it, so a half-typed password survives a Cancel. */}
        <section
          aria-labelledby="vex-unlock-title"
          hidden={resetOpen}
          className="vex-unl__form"
        >
          <h1 id="vex-unlock-title" className="vex-stage-title">
            Welcome back.
          </h1>
          <p className="vex-stage-lead">
            Your master password decrypts the local vault on this machine.
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
              {/* SIGNATURE STROKE - rests at scale 0 on the field's rule;
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

            {throttleActive ? (
              <ErrorCallout
                compact
                state="concerned"
                className="vex-unl__alert"
                title={
                  <span role="alert" data-vex-unlock-throttle="active">
                    {throttle.message}{" "}
                    <span className="vex-num">({throttleRemainingSeconds}s)</span>
                  </span>
                }
                hint={<OpenLogsLink className="text-[13px]" />}
              />
            ) : error ? (
              <ErrorCallout
                compact
                state="error"
                className="vex-unl__alert"
                title={<span role="alert">{error}</span>}
                hint={
                  errorFromBridge ? <OpenLogsLink className="text-[13px]" /> : undefined
                }
              />
            ) : null}

            {/* ARMED CTA - the dotted blue outline while the field is empty,
              the one blue fill the moment anything is typed and while the
              unlock is in flight. `data-armed` carries only the boolean. */}
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

          {lockedDesk ? (
            <p className="vex-unl__note">
              That password lives only in the app's memory while Vex is unlocked - never
              written to disk, never sent anywhere.
            </p>
          ) : null}
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
                {resetError ? (
                  <ErrorCallout
                    compact
                    state="error"
                    title={<span role="alert">{resetError}</span>}
                    hint={<OpenLogsLink className="text-[13px]" />}
                  />
                ) : null}
              </>
            )}
            {!resetRestarting ? (
              <div className="vex-unl__panel-foot">
                <Button
                  ref={cancelRef}
                  type="button"
                  variant="ink"
                  disabled={resetPending}
                  onClick={() => setResetDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="stop"
                  disabled={!resetAcknowledged || resetPending}
                  onClick={() => void requestFreshVault()}
                >
                  {resetPending ? "Requesting…" : "Set up new vault"}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}
      </div>
      <VersionStamp />
    </SetupFrame>
  );
}
