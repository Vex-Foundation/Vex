/**
 * Local state + export mechanics for `ExportPrivateKeyModal`.
 *
 * This hook is PRIVATE to the modal: it is invoked only by
 * `../ExportPrivateKeyModal.tsx` and must not be lifted outside the wallets
 * feature. It owns the high-risk export flow verbatim from the original
 * component:
 *
 *   - Password stays in the DOM (uncontrolled input via `passwordRef`). React
 *     state only tracks the boolean "is current value long enough to enable
 *     submit" — the secret value itself never lives in a React fiber, Zustand,
 *     TanStack cache, or event payload.
 *   - The renderer NEVER sees the raw private key: main copies it to the OS
 *     clipboard and replies only with `clearAfterMs`. No secret is logged or
 *     persisted here.
 *   - The password field is wiped immediately after submit on every outcome
 *     (failure, success, and unexpected error).
 *   - Timers (countdown, post-clear auto-close, session-lock auto-close) are
 *     cancelled on unmount; a ref-based reentry guard prevents a double
 *     `onClose` without blocking React StrictMode's effect replay.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { PASSWORD_MIN_LENGTH } from "@shared/schemas/secrets.js";
import { getErrorCopy } from "../../../lib/errors/error-copy.js";
import type { ExportWalletSelection } from "../ExportWalletPicker.js";
import type { Chain, Phase } from "./types.js";

/**
 * Auto-close delay (ms) once the clipboard-scrub countdown has elapsed and
 * before invoking `onClose()`. Gives the user time to read the
 * confirmation banner.
 */
const POST_CLEAR_AUTOCLOSE_MS = 3000;
/**
 * Auto-close delay (ms) for session-lock recovery. Same idea as the
 * post-clear close — the user reads the explanation, then we close so the
 * global unlock observer can take over.
 */
const SESSION_LOCK_AUTOCLOSE_MS = 3000;

export interface UseExportPrivateKeyParams {
  readonly chain: Chain;
  readonly onClose: () => void;
}

export interface UseExportPrivateKeyResult {
  readonly passwordRef: RefObject<HTMLInputElement | null>;
  readonly riskAcknowledged: boolean;
  readonly setRiskAcknowledged: (value: boolean) => void;
  readonly setPasswordLongEnough: (value: boolean) => void;
  readonly setSelected: (selection: ExportWalletSelection | null) => void;
  readonly pending: boolean;
  readonly error: string | null;
  readonly phase: Phase;
  readonly clearCountdown: number;
  readonly canSubmit: boolean;
  readonly dialogOpen: boolean;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  readonly onCancel: () => void;
  readonly safeClose: () => void;
}

export function useExportPrivateKey({
  chain,
  onClose,
}: UseExportPrivateKeyParams): UseExportPrivateKeyResult {
  // Password stays in the DOM (uncontrolled input). React state only tracks
  // the boolean "is current value long enough to enable submit" — the secret
  // value itself never lives in a React fiber.
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const [passwordLongEnough, setPasswordLongEnough] = useState<boolean>(false);
  const [riskAcknowledged, setRiskAcknowledged] = useState<boolean>(false);
  const [pending, setPending] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [clearCountdown, setClearCountdown] = useState<number>(0);
  // Which wallet to export — set by the picker; null disables submit.
  const [selected, setSelected] = useState<ExportWalletSelection | null>(null);

  // Ref-based reentry guard so the auto-close `setTimeout` callbacks never
  // call `onClose` twice (StrictMode double-mount, fast user double-click).
  const closedRef = useRef<boolean>(false);
  // Track whether a session-lock auto-close is already scheduled so a
  // re-render or a re-submission can't queue a second close.
  const lockAutoCloseScheduledRef = useRef<boolean>(false);
  // Timer id for the session-lock auto-close, so we can cancel it on unmount.
  const lockAutoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wipePasswordField = useCallback((): void => {
    if (passwordRef.current !== null) passwordRef.current.value = "";
    setPasswordLongEnough(false);
  }, []);

  const safeClose = useCallback((): void => {
    // Main may already be writing the key to the clipboard. Keep the dialog
    // visible until that request settles so its result cannot arrive unseen.
    if (closedRef.current || pending) return;
    closedRef.current = true;
    if (passwordRef.current !== null) passwordRef.current.value = "";
    onClose();
  }, [onClose, pending]);

  // Countdown timer: ticks once per second while phase === "copied".
  // Stops when the countdown reaches 0 and transitions to "cleared".
  useEffect(() => {
    if (phase !== "copied") return;
    if (clearCountdown <= 0) {
      setPhase("cleared");
      return;
    }
    const id = window.setInterval(() => {
      setClearCountdown((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          window.clearInterval(id);
          setPhase("cleared");
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => {
      window.clearInterval(id);
    };
  }, [phase, clearCountdown]);

  // Post-clear auto-close: schedule the dialog dismiss once the scrub
  // banner has been on screen long enough to read.
  useEffect(() => {
    if (phase !== "cleared") return;
    const id = window.setTimeout(() => {
      setPhase("closing");
      safeClose();
    }, POST_CLEAR_AUTOCLOSE_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [phase, safeClose]);

  // Cancel the session-lock timer on unmount. Do not mark the dialog closed
  // here: StrictMode replays effect cleanup while the dialog remains mounted.
  // Every other timer is cleaned up by its own effect.
  useEffect(() => {
    return () => {
      if (lockAutoCloseTimerRef.current !== null) {
        clearTimeout(lockAutoCloseTimerRef.current);
        lockAutoCloseTimerRef.current = null;
      }
    };
  }, []);

  const scheduleSessionLockAutoClose = useCallback((): void => {
    if (lockAutoCloseScheduledRef.current) return;
    lockAutoCloseScheduledRef.current = true;
    lockAutoCloseTimerRef.current = setTimeout(() => {
      lockAutoCloseTimerRef.current = null;
      safeClose();
    }, SESSION_LOCK_AUTOCLOSE_MS);
  }, [safeClose]);

  const canSubmit =
    phase === "idle" &&
    selected !== null &&
    riskAcknowledged &&
    passwordLongEnough &&
    !pending;

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (!canSubmit || selected === null) return;

      setPending(true);
      setError(null);

      try {
        const result = await window.vex.wallet.exportPrivateKey({
          chain,
          walletId: selected.walletId,
          password: passwordRef.current?.value ?? "",
          riskAcknowledged: true,
        });

        if (!result.ok) {
          // Always scrub the password input on a failed attempt: the user
          // will re-type, and we don't want even the briefest stale value
          // sitting in the DOM between attempts.
          wipePasswordField();

          const copy = getErrorCopy(result.error, { chain });
          setError(copy.message);
          // Helper signals that this error should auto-route the user back
          // to the global unlock screen — schedule the modal dismiss.
          if (copy.autoCloseMs !== undefined) {
            scheduleSessionLockAutoClose();
          }
          return;
        }

        // Success path — main has already copied the key to the OS
        // clipboard. We never see the secret. Render the scrub countdown.
        const clearMs = result.data.clearAfterMs;
        const clearSec = Math.max(1, Math.ceil(clearMs / 1000));
        wipePasswordField();
        setClearCountdown(clearSec);
        setPhase("copied");
      } catch (cause) {
        // contextBridge throws synchronously on unhandled invoke (e.g.
        // missing channel). Treat as an unknown internal failure — no
        // secret has been produced because main never replied successfully.
        const message =
          cause instanceof Error
            ? cause.message
            : "Unexpected error during private key export.";
        wipePasswordField();
        setError(message);
      } finally {
        setPending(false);
      }
    },
    [canSubmit, chain, selected, scheduleSessionLockAutoClose, wipePasswordField],
  );

  const onCancel = useCallback((): void => {
    safeClose();
  }, [safeClose]);

  const dialogOpen = phase !== "closing";

  return {
    passwordRef,
    riskAcknowledged,
    setRiskAcknowledged,
    setPasswordLongEnough,
    setSelected,
    pending,
    error,
    phase,
    clearCountdown,
    canSubmit,
    dialogOpen,
    onSubmit,
    onCancel,
    safeClose,
  };
}

export { PASSWORD_MIN_LENGTH };
