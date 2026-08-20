/**
 * Toast: transient top-center banner on a dark plate in both themes.
 * Slides in, holds, fades out via CSS only, then reports done so the host
 * unmounts it. Rendered through a body portal so a transformed/filtered
 * ancestor cannot trap the fixed banner.
 */

import { useEffect, type ReactPortal } from "react";
import { createPortal } from "react-dom";
import { IconWarning } from "../icons/index.js";
import type { ToastTone } from "../../lib/toast.js";

/**
 * INVARIANT: HOLD_MS + FADE_MS drive the unmount timer and MUST equal the
 * vex-toast-fade delay (3000ms) and duration (1000ms) in
 * styles/global-css/ui-primitives.css - a mismatched sheet either cuts the
 * fade or leaves an invisible banner.
 */
export const HOLD_MS = 3000;
export const FADE_MS = 1000;

export function Toast({ text, tone = "neutral", onDone }: {
  readonly text: string;
  readonly tone?: ToastTone;
  /** Called once the fade completes; unmount the toast here. */
  readonly onDone: () => void;
}): ReactPortal {
  useEffect(() => {
    const timer = setTimeout(onDone, HOLD_MS + FADE_MS);
    return () => clearTimeout(timer);
  }, [onDone]);
  return createPortal(
    <div className="vex-toast" data-tone={tone} role="alert">
      {tone !== "neutral" && (
        <span className="vex-toast-icon" aria-hidden>
          <IconWarning size={16} />
        </span>
      )}
      <span className="vex-toast-text">{text}</span>
    </div>,
    document.body,
  );
}
