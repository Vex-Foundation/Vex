/**
 * Copy-to-clipboard with transient "copied" feedback.
 *
 * Two paths, in order. `navigator.clipboard.writeText` is tried first so the
 * hook keeps working the day the shell stops denying it, but the renderer's
 * permission handlers are deny-all (`main/permissions.ts`), so today it
 * rejects and the off-screen-textarea + `execCommand("copy")` fallback is
 * what actually runs. `execCommand` is deprecated and reliable; the
 * alternative would be a privileged IPC surface for putting a string the user
 * can already see onto their own clipboard.
 *
 * `copied` flips true ONLY on a real success — a silent failure must not show
 * a checkmark, or the operator walks away believing they have the text.
 *
 * Extracted from `components/common/AddressDisplay.tsx`, which still carries
 * its own copy of this logic; it is a tested component and switching it over
 * was out of scope for the change that needed the hook. Worth unifying.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export const COPY_FEEDBACK_MS = 1500;

/**
 * Permissionless copy: an off-screen readonly textarea + the selection copy
 * command. Needs no permissions API.
 */
function copyViaSelection(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export interface UseCopyToClipboard {
  readonly copied: boolean;
  readonly copy: (text: string) => Promise<void>;
}

export function useCopyToClipboard(
  feedbackMs: number = COPY_FEEDBACK_MS,
): UseCopyToClipboard {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const copy = useCallback(
    async (text: string): Promise<void> => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = copyViaSelection(text);
      }
      if (!ok) return;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), feedbackMs);
    },
    [feedbackMs],
  );

  return { copied, copy };
}
