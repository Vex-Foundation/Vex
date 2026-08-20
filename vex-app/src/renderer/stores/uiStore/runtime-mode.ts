/**
 * Runtime-mode seam for the future vex-studio surface. A plain union slot in
 * the uiStore - no UI logic reads it yet; the studio workspace will be
 * mounted by a top-level dispatch on this value.
 */

export type RuntimeMode = "agent" | "studio";

export const DEFAULT_RUNTIME_MODE: RuntimeMode = "agent";
