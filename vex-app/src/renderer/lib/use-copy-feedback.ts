/**
 * Copy-to-clipboard hook with transient success feedback: write the text,
 * and on success flip a `copied` flag the caller renders as its success
 * state. A refused write leaves the flag untouched, so the control never
 * claims a copy the host declined.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { writeClipboard } from "./clipboard.js";

/** Default duration the `copied` flag stays true after a successful write. */
export const COPY_FEEDBACK_MS = 1500;

export interface CopyFeedback {
  /** True for the feedback window after a successful write. */
  readonly copied: boolean;
  /** Copy the hook's text; silent on a refused write. */
  readonly onCopy: () => void;
}

export function useCopyFeedback(
  text: string,
  feedbackMs: number = COPY_FEEDBACK_MS,
): CopyFeedback {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  const onCopy = useCallback(() => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), feedbackMs);
    });
  }, [text, feedbackMs]);

  return { copied, onCopy };
}
