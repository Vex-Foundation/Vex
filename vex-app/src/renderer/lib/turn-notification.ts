/**
 * Turn-complete notification (A34), title-badge form. The signal is the
 * EXISTING transcript spine (`engine.onTranscriptAppend`): an assistant chat
 * row for the active session landing while the window is unfocused marks an
 * unseen turn; regaining focus clears it. The HTML5 Notification API is
 * intentionally NOT used — main's permission policy is deny-all
 * (`src/main/permissions.ts`), and an OS-native path would need a new IPC
 * contract (named gap, coordinator's call); the title badge ships now on
 * existing contracts only.
 */

import { useEffect, useState } from "react";

/**
 * True while a turn completed for `sessionId` without window focus and the
 * user has not refocused since. Pure subscription — no render output beyond
 * the flag; feed it to `useWindowTitleSync`.
 */
export function useTurnCompleteNotification(sessionId: string | null): boolean {
  const [unseen, setUnseen] = useState(false);

  // Session switch: an unseen marker never carries across sessions.
  useEffect(() => {
    setUnseen(false);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === null) return;
    // Optional-chained like the portfolio invalidation hooks: partial test
    // bridges (and a torn-down preload) must not crash the panel.
    const subscribe = window.vex?.engine?.onTranscriptAppend;
    if (subscribe === undefined) return;
    const off = subscribe((event) => {
      if (event.sessionId !== sessionId) return;
      // A plain assistant chat row is the turn's answer; engine markers
      // (compaction, memory, …) are not user-facing turn completions.
      if (event.role !== "assistant" || event.messageType !== null) return;
      if (!document.hasFocus()) setUnseen(true);
    });
    const onFocus = (): void => setUnseen(false);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [sessionId]);

  return unseen;
}
