/**
 * Turn-complete notification (A34): title badge + OS-native notification.
 * The signal is the EXISTING transcript spine (`engine.onTranscriptAppend`):
 * an assistant chat row for the active session landing while the window is
 * unfocused marks an unseen turn; regaining focus clears it. The same moment
 * also asks main for an OS notification over the narrow
 * `vex.system.notifyTurnComplete` contract - main re-checks focus itself, so
 * this call is a request, never an authorization. Gated by the persisted
 * `notificationsEnabled` preference. The HTML5 Notification API stays unused
 * (deny-all web permissions in `src/main/permissions.ts`).
 */

import { useEffect, useState } from "react";
import { useUiStore } from "../stores/uiStore.js";

/**
 * True while a turn completed for `sessionId` without window focus and the
 * user has not refocused since. Pure subscription — no render output beyond
 * the flag; feed it to `useWindowTitleSync`.
 */
export function useTurnCompleteNotification(
  sessionId: string | null,
  /** Display title for the OS notification body; null = badge only. */
  sessionTitle: string | null = null,
): boolean {
  const [unseen, setUnseen] = useState(false);
  const notificationsEnabled = useUiStore((s) => s.notificationsEnabled);

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
      if (!document.hasFocus()) {
        setUnseen(true);
        // Fire-and-forget: main measures focus again and owns the decision;
        // a failed call degrades to the title badge alone.
        if (notificationsEnabled && sessionTitle !== null) {
          void window.vex?.system?.notifyTurnComplete?.({ sessionTitle });
        }
      }
    });
    const onFocus = (): void => setUnseen(false);
    window.addEventListener("focus", onFocus);
    return () => {
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, [sessionId, sessionTitle, notificationsEnabled]);

  return unseen;
}
