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
 */
export function enterLighterMode(): void {
  recordFunnelStep("desk_enter", useLighterAnalysisStore.getState().desk.environment);
  useUiStore.getState().setRuntimeMode("lighter");
}
