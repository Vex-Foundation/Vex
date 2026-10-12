/**
 * UnlockScreen: the way in. Master-password re-prompt shown when the vault
 * is configured but locked (typical cause: app restart after onboarding,
 * or Lock Vex).
 *
 * Visual system (docs/design/V10-SPREAD.md sections 1 and 2, the d1
 * reference): the screen stands on the stage print (`SetupFrame`,
 * `layout="open"`). The release is the giant italic counter on the sky,
 * "Welcome back." and the field sit in the right column, and the forgot
 * link runs along the dark ground. The field is a label box with a 1.5px
 * blue rule; the in-flight signing stroke travels that rule ONLY while the
 * unlock IPC is in flight (the sanctioned in-flight loop). Throttle and
 * error notices are risk callouts (ink frame, hatched edge) in a box that
 * reads on the print.
 *
 * Functional logic:
 *   - password ref is uncontrolled (skill §14 — secret never lands in
 *     observable React state). The CTA's armed state rides a BOOLEAN
 *     `hasInput` set from the field's `onInput`: emptiness is the only
 *     thing that crosses into React,
 *   - PASSWORD_MIN_LENGTH client-side gate before IPC,
 *   - `secrets.unlock_throttled` surfaces an alert + 1s setInterval
 *     countdown; cleaned up on every state change (throttle windows are
 *     main-owned — the UI never implies attempts for non-password errors),
 *   - on success the password input is cleared and the page turn is armed
 *     (`beginUnlockCurtain`): App's `CurtainExit` brings the right page in
 *     over the print, flips the view to `unlockReturnView` ("wizard" |
 *     "appShell") beneath it, and lifts away.
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
import { Label } from "../../components/ui/label.js";
import { PasswordField } from "../../components/common/PasswordField.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
import { ReleaseCounter } from "../../components/onboarding/PreShellStage.js";
import { useUiStore } from "../../stores/uiStore.js";
import { PASSWORD_MIN_LENGTH } from "@shared/schemas/secrets.js";
import { getErrorCopy } from "../../lib/errors/error-copy.js";
import { cn } from "../../lib/utils.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../components/ui/dialog.js";
import { OpenLogsLink } from "../../components/common/OpenLogsLink.js";

interface ThrottleState {
  readonly message: string;
  readonly retryAtMs: number;
}

export function UnlockScreen(): JSX.Element {
  const passwordRef = useRef<HTMLInputElement | null>(null);
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

  // Tick once a second while a throttle window is active so the countdown
  // re-renders. Cleared on every state change — no leaked intervals.
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
          // Workflow-specific UX (countdown banner) — message comes
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
    <SetupFrame
      screen="unlock"
      layout="open"
      groundStart={
        <button
          type="button"
          disabled={inputsDisabled}
          onClick={() => setResetDialogOpen(true)}
        >
          I forgot my password - set up a new vault
          <span aria-hidden>→</span>
        </button>
      }
    >
      <div className="vex-unl">
        {/* THE COUNTER: the release this vault is opened with. */}
        <div>
          <ReleaseCounter />
        </div>

        <section aria-labelledby="vex-unlock-title" className="vex-unl__form">
          <h1 id="vex-unlock-title" className="vex-unl__h1 vex-rise">
            Welcome back.
          </h1>
          <p className="vex-unl__sub vex-rise vex-rise-d1">
            Your master password decrypts the local vault on this machine.
          </p>

          <form
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="vex-rise vex-rise-d2 flex flex-col"
          >
            <Label htmlFor="vex-unlock-password" className="vex-unl__lab">
              Master password
            </Label>
            <div className="vex-unl__row">
              <div className="vex-unl__field">
                <PasswordField
                  id="vex-unlock-password"
                  ref={passwordRef}
                  autoComplete="current-password"
                  autoFocus
                  disabled={inputsDisabled}
                  onInput={(event) => {
                    setHasInput(event.currentTarget.value.length > 0);
                  }}
                />
                {/* SIGNATURE STROKE - rests at scale 0 on the field's blue
                  rule; while the unlock IPC is in flight the ink travels it
                  (.vex-sign-stroke--signing, the sanctioned in-flight loop). */}
                <span
                  aria-hidden
                  className={cn(
                    "vex-unl__stroke vex-sign-stroke",
                    pending && "vex-sign-stroke--signing",
                  )}
                />
              </div>
              {/* ARMED CTA - the label box with the blue word while the
                field is empty, the one blue fill the moment anything is
                typed and while the unlock is in flight. `data-armed`
                carries only the boolean. */}
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
            </div>

            {throttleActive ? (
              <div className="vex-unl__alert vex-callout vex-callout--on-print flex flex-col gap-2">
                <p role="alert" data-vex-unlock-throttle="active">
                  {throttle.message}{" "}
                  <span className="font-mono text-xs tabular-nums">
                    ({throttleRemainingSeconds}s)
                  </span>
                </p>
                <OpenLogsLink />
              </div>
            ) : error ? (
              <div className="vex-unl__alert vex-callout vex-callout--on-print flex flex-col gap-2">
                <p role="alert">{error}</p>
                {errorFromBridge ? <OpenLogsLink /> : null}
              </div>
            ) : null}
          </form>
        </section>
      </div>
      <Dialog open={resetOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent closeOnBackdropClick={false}>
          <DialogHeader>
            <DialogTitle>Set up a new vault?</DialogTitle>
            <DialogDescription>
              This does not recover or decrypt the current vault.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
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
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={resetAcknowledged}
                    onChange={(event) => setResetAcknowledged(event.currentTarget.checked)}
                  />
                  <span>I understand that the forgotten password cannot be recovered.</span>
                </label>
                {resetError ? (
                  <div className="flex flex-col gap-2">
                    <p role="alert">{resetError}</p>
                    <OpenLogsLink />
                  </div>
                ) : null}
              </>
            )}
          </DialogBody>
          {!resetRestarting ? (
            <DialogFooter>
              <Button
                type="button"
                variant="quiet"
                // The safer choice takes focus (rule 08): the sibling
                // action destroys the vault. `DialogContent` moves focus
                // here after `showModal()`.
                {...DIALOG_INITIAL_FOCUS}
                disabled={resetPending}
                onClick={() => setResetDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ink"
                disabled={!resetAcknowledged || resetPending}
                onClick={() => void requestFreshVault()}
              >
                {resetPending ? "Requesting…" : "Set up new vault"}
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>
    </SetupFrame>
  );
}
