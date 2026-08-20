/**
 * Window-title sync (E15): the native window title mirrors the active
 * session through `document.title` — Electron forwards page-title updates to
 * the BrowserWindow and main never re-stamps its static "Vex" after create,
 * so no IPC channel is needed. The unseen-turn badge (A34 fallback) prefixes
 * a dot while a turn finished without focus.
 */

import { useEffect } from "react";

const PRODUCT_TITLE = "Vex";

/** Unseen-turn marker — a plain glyph, readable in any taskbar. */
const UNSEEN_BADGE = "● ";

/** Pure title composition: `[●] {session} - Vex` / `[●] Vex`. */
export function composeWindowTitle(
  sessionTitle: string | null,
  unseenTurn: boolean,
): string {
  const base =
    sessionTitle !== null && sessionTitle.trim().length > 0
      ? `${sessionTitle} - ${PRODUCT_TITLE}`
      : PRODUCT_TITLE;
  return unseenTurn ? `${UNSEEN_BADGE}${base}` : base;
}

/**
 * Keep `document.title` in step with the active session and the unseen-turn
 * badge. Mounted once by the session panel; restores the bare product title
 * on unmount so a torn-down panel never leaves a stale session name behind.
 */
export function useWindowTitleSync(
  sessionTitle: string | null,
  unseenTurn: boolean,
): void {
  useEffect(() => {
    document.title = composeWindowTitle(sessionTitle, unseenTurn);
  }, [sessionTitle, unseenTurn]);
  useEffect(
    () => () => {
      document.title = PRODUCT_TITLE;
    },
    [],
  );
}
