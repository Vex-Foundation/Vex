/**
 * UnlockScreen — THE GATE. Master-password re-prompt shown when the
 * vault is configured but locked (typical cause: app restart after
 * onboarding).
 *
 * Visual system (Chronos rebrand, A2 plate + AMENDMENT A3 boxless): the
 * ink continuum plate (`SetupFrame`), the white vx mark above a serif
 * "Welcome back." statement, and the form DISSOLVED directly onto the
 * plate — no card, no box; the plate and the mark are the whole
 * ceremony. No grid, no scanlines, no
 * gate readout, no wordmark. Throttle/error alerts speak the A3 rail
 * grammar (left color rail, no fill). The signature rail under the
 * password field runs the `.vex-sign-stroke--signing` ink loop ONLY
 * while the unlock IPC is in flight (the sanctioned in-flight loop).
 *
 * Functional logic (unchanged from the previous version):
 *   - password ref is uncontrolled (skill §14 — secret never lands in
 *     observable React state),
 *   - PASSWORD_MIN_LENGTH client-side gate before IPC,
 *   - `secrets.unlock_throttled` surfaces an alert + 1s setInterval
 *     countdown; cleaned up on every state change (throttle windows are
 *     main-owned — the UI never implies attempts for non-password errors),
 *   - on success the password input is cleared and the exit curtain is
 *     armed (`beginUnlockCurtain`): App's `CurtainExit` covers the screen
 *     with the cobalt plate, flips the view to `unlockReturnView`
 *     ("wizard" | "appShell") beneath it, and splits open — the
 *     choreographed hand-off into the shell (Phase 2b, decree C.3).
 *
 * Test selectors preserved verbatim:
 *   - `data-vex-screen="unlock"` + `data-vex-onboarding="true"` (root,
 *     via SetupFrame),
 *   - `data-vex-unlock-throttle="active"` (throttle alert),
 *   - `<label htmlFor="vex-unlock-password">Master password</label>`,
 *   - button text "Unlock" / "Unlocking…",
 *   - `img[src="/brand/vex-mark-white.svg"]` (SetupFrame brand mark).
 */

import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { Button } from "../../components/ui/button.js";
import { Label } from "../../components/ui/label.js";
import { PasswordField } from "../../components/common/PasswordField.js";
import { SetupFrame } from "../../components/onboarding/SetupFrame.js";
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
    <SetupFrame screen="unlock">
      <section
        aria-labelledby="vex-unlock-title"
        className="mx-auto flex w-full max-w-[440px] flex-col"
      >
        {/* THE MARK — the vx script above the greeting (rebrand: the
          particle sigil is retired from the pre-shell). */}
        <img
          src="/brand/vex-mark-white.svg"
          alt=""
          aria-hidden
          draggable={false}
          className="vex-rise mx-auto h-16 w-auto select-none"
        />

        <h1
          id="vex-unlock-title"
          className="vex-rise vex-rise-d1 mt-6 text-center font-serif text-2xl font-normal leading-none text-ink-primary"
        >
          Welcome back.
        </h1>
        {/* Bespoke header (this screen passes no SetupFrame title), so the
         * subline steps up to 18px here rather than through the scaffold. */}
        <p className="vex-rise vex-rise-d1 mt-3 text-center text-lg leading-relaxed text-ink-secondary">
          Your master password decrypts the local vault on this machine.
        </p>

        {/* The form sits DIRECTLY on the plate (AMENDMENT A3 — the deep-ink
         * unlock card of decree B is retired with every other page box).
         * Controls keep their own chrome; spacing does the separating. */}
        <div className="vex-rise vex-rise-d2 mt-9">
          <form
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2.5">
              <Label
                htmlFor="vex-unlock-password"
                className="vex-micro font-medium text-ink-tertiary"
              >
                Master password
              </Label>
              <PasswordField
                id="vex-unlock-password"
                ref={passwordRef}
                autoComplete="current-password"
                autoFocus
                disabled={inputsDisabled}
                className="[&_input]:h-11 [&_input]:bg-white/[0.10]"
              />
              {/* SIGNATURE RAIL — resting hairline under the field; while
                the unlock IPC is in flight the cobalt ink travels it
                (.vex-sign-stroke--signing, the sanctioned in-flight loop). */}
              <div
                aria-hidden
                className="relative h-px w-full overflow-hidden bg-white/[0.08]"
              >
                <span
                  className={cn(
                    "vex-sign-stroke absolute inset-0 bg-[var(--vex-onboarding-accent,var(--color-accent-primary))]",
                    pending && "vex-sign-stroke--signing",
                  )}
                />
              </div>
            </div>

            {throttleActive ? (
              <div className="flex flex-col gap-2">
                {/* Warning RAIL (A3 alert grammar — no fill, no box). */}
                <p
                  role="alert"
                  data-vex-unlock-throttle="active"
                  className="border-l-2 border-[color-mix(in_oklab,var(--color-warning)_45%,transparent)] pl-3 text-sm text-[color-mix(in_oklab,var(--color-warning)_70%,white)]"
                >
                  {throttle.message}{" "}
                  <span className="font-mono text-xs tabular-nums">
                    ({throttleRemainingSeconds}s)
                  </span>
                </p>
                <OpenLogsLink />
              </div>
            ) : error ? (
              <div className="flex flex-col gap-2">
                {/* Danger RAIL (A3 alert grammar — no fill, no box). */}
                <p
                  role="alert"
                  className="border-l-2 border-[color-mix(in_oklab,var(--color-danger)_45%,transparent)] pl-3 text-sm text-[color-mix(in_oklab,var(--color-danger)_70%,white)]"
                >
                  {error}
                </p>
                {errorFromBridge ? <OpenLogsLink /> : null}
              </div>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={inputsDisabled}
              className="w-full"
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

          <Button
            type="button"
            variant="ghost"
            disabled={inputsDisabled}
            onClick={() => setResetDialogOpen(true)}
            className="mt-3 w-full text-ink-tertiary"
          >
            I forgot my password - set up a new vault
          </Button>
        </div>
      </section>
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
                variant="outline"
                autoFocus
                disabled={resetPending}
                onClick={() => setResetDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
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
