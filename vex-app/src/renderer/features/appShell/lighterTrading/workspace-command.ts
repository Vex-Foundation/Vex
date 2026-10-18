import { useLighterAnalysisStore } from "../../../stores/lighterAnalysisStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { recordFunnelStep } from "./funnel.js";

/**
 * Exact conversational activation phrase. Case, surrounding whitespace, and
 * terminal punctuation are presentation differences; extra words are not.
 */
export function isLighterWorkspaceCommand(message: string): boolean {
  return message
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .trim() === "light it up";
}

/**
 * Enter the Lighter shell mode. A renderer-local UI intent: it decides which
 * surfaces mount and touches no privileged seam beyond one funnel count. The
 * store transition parks the mode the user came from so `LighterSidebar`'s
 * back button can return there.
 *
 * The desk chat (Vex's column on the desk) is hidden by default: entering
 * from the nav or the Portfolio card leaves its slot (`vexOpenLighter`,
 * false until the user shows it) alone, so the desk opens with the room for
 * the chart, the book and the ticket. `openChat` is for an entry made from a
 * conversation ("Light it up" typed in the composer), which keeps the user
 * in that conversation by showing the desk chat.
 */
export function enterLighterMode(options: { readonly openChat?: boolean } = {}): void {
  recordFunnelStep("desk_enter", useLighterAnalysisStore.getState().desk.environment);
  useUiStore.getState().setRuntimeMode("lighter");
  if (options.openChat === true) useUiStore.getState().setBookOpen(true);
  useUiStore.getState().setSidebarNarrowExpanded(false);
}
