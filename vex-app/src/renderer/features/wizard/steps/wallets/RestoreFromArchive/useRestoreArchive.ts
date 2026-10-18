import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import type { WalletRestoreArchiveResult } from "@shared/schemas/wallets.js";
import {
  restoreArchive,
  useInvalidateAfterArchiveRestore,
} from "../../../../../lib/api/wallets.js";
import { restoreErrorMessage } from "./errors.js";

/**
 * Local state + secret discipline for the C3 full-archive restore panel.
 *
 * The master password lives ONLY in the uncontrolled DOM input
 * (`passwordRef`); it is read once on submit and wiped immediately after.
 * React state tracks only a boolean "is the field non-empty" to gate the
 * Restore button - never the value itself. The restore IPC is a bare async
 * call (`restoreArchive`), NOT a `useMutation`, so the password never lands in
 * mutation observer state.
 */
export interface UseRestoreArchive {
  readonly expanded: boolean;
  readonly setExpanded: (value: boolean) => void;
  readonly selectedId: string | null;
  readonly setSelectedId: (value: string | null) => void;
  readonly passwordPresent: boolean;
  readonly setPasswordPresent: (value: boolean) => void;
  readonly pending: boolean;
  readonly error: string | null;
  readonly setError: (value: string | null) => void;
  readonly restored: WalletRestoreArchiveResult | null;
  readonly setRestored: (value: WalletRestoreArchiveResult | null) => void;
  readonly passwordRef: RefObject<HTMLInputElement | null>;
  readonly wipePassword: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

export function useRestoreArchive(): UseRestoreArchive {
  const invalidate = useInvalidateAfterArchiveRestore();

  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [passwordPresent, setPasswordPresent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<WalletRestoreArchiveResult | null>(
    null,
  );

  const passwordRef = useRef<HTMLInputElement | null>(null);

  const wipePassword = useCallback((): void => {
    if (passwordRef.current !== null) passwordRef.current.value = "";
    setPasswordPresent(false);
  }, []);

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      if (selectedId === null || pending) return;

      // Read the secret from the DOM once, then wipe the field synchronously
      // before the IPC promise resolves - the password never enters React
      // state or any cache.
      const password = passwordRef.current?.value ?? "";
      if (password.length === 0) return;
      wipePassword();

      setPending(true);
      setError(null);
      setRestored(null);

      try {
        const result = await restoreArchive(selectedId, password);
        if (result.ok) {
          setRestored(result.data);
          invalidate();
        } else {
          setError(
            restoreErrorMessage(result.error.code, result.error.message),
          );
        }
      } catch (cause) {
        // contextBridge throws synchronously on an unhandled invoke (e.g.
        // a missing channel). No secret has been produced - main never
        // replied successfully.
        setError(
          cause instanceof Error
            ? cause.message
            : "Unexpected error during restore.",
        );
      } finally {
        setPending(false);
      }
    },
    [selectedId, pending, wipePassword, invalidate],
  );

  return {
    expanded,
    setExpanded,
    selectedId,
    setSelectedId,
    passwordPresent,
    setPasswordPresent,
    pending,
    error,
    setError,
    restored,
    setRestored,
    passwordRef,
    wipePassword,
    onSubmit,
  };
}
