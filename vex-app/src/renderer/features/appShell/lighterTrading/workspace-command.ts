const LIGHTER_WORKSPACE_OPEN_EVENT = "vex:lighter-workspace-open";

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

/** Renderer-local UI intent only. It crosses no preload or privileged seam. */
export function requestLighterWorkspaceOpen(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(LIGHTER_WORKSPACE_OPEN_EVENT));
}

export function subscribeLighterWorkspaceOpen(
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  window.addEventListener(LIGHTER_WORKSPACE_OPEN_EVENT, listener);
  return () => window.removeEventListener(LIGHTER_WORKSPACE_OPEN_EVENT, listener);
}
