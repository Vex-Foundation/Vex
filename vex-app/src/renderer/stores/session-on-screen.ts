/**
 * Whether a session's conversation is on screen right now: the surface where
 * its inline cards (the turn failure card above the composer, among them)
 * are in front of the user.
 *
 * On screen means: the window is visible, the session is the active one, and
 * its panel is the one showing: the agent centre with no page over it, or
 * the Lighter desk with its chat column open. Studio shows no session panel.
 *
 * Pure over the ui state and the document's visibility, so the engine error
 * ingestion can decide, at the moment a failure arrives, whether the inline
 * card already tells the user (no toast, no Notices row for the same
 * failure) or the app-wide notice has to (the failure happened off screen).
 */

import { selectVexOpen, useUiStore, type UiState } from "./uiStore.js";

type OnScreenState = Pick<
  UiState,
  | "activeSessionId"
  | "runtimeMode"
  | "shellRoute"
  | "vexOpenChat"
  | "vexOpenPages"
  | "vexOpenLighter"
>;

function windowVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function isSessionOnScreen(
  sessionId: string,
  state: OnScreenState = useUiStore.getState(),
  visible: boolean = windowVisible(),
): boolean {
  if (!visible) return false;
  if (state.activeSessionId !== sessionId) return false;
  if (state.runtimeMode === "agent") return state.shellRoute.kind === "none";
  if (state.runtimeMode === "lighter") return selectVexOpen(state);
  return false;
}
