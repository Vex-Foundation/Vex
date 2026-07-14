/**
 * Pure decision logic for an incoming agent workspace-mode request. Kept free
 * of React/store/bridge so the ack-gating rule is unit-testable in isolation.
 *
 * Rule (product-locked):
 *  - `mode: "normal"`               → leave the mode (exit).
 *  - `mode: "hypervexing"`, acked   → enter the mode (play the transition).
 *  - `mode: "hypervexing"`, NOT acked → show the first-entry risk acknowledgment
 *    FIRST; the mode activates only after the user accepts. Real leverage on
 *    real funds is not entered by surprise.
 */

import type { HyperliquidWorkspaceModeEvent } from "@shared/schemas/hyperliquid.js";
import type { SkyTheme } from "../signalSkyShaders.js";
import type { VexTheme, WorkspaceMode } from "../../../stores/uiStore.js";

/**
 * The `data-vex-theme` value the shell root wears. DERIVED, never stored: while
 * the workspace is active it is always "hypervexing"; otherwise it is the
 * user's own persisted theme — so EXIT restores navy vs lime exactly, and the
 * mode never overwrites `theme`.
 */
export function deriveShellTheme(
  workspaceMode: WorkspaceMode,
  theme: VexTheme,
): SkyTheme {
  return workspaceMode === "hypervexing" ? "hypervexing" : theme;
}

export type WorkspaceModeAction =
  /** Activate the mode and play the enter transition. */
  | { readonly type: "enter" }
  /** Gate on the first-entry risk acknowledgment before activating. */
  | { readonly type: "acknowledge" }
  /** Leave the mode (agent asked for normal). */
  | { readonly type: "exit" };

export function resolveWorkspaceModeEvent(
  // Structural subset: the live push event AND the reconciliation read DTO
  // both satisfy it, so push handling and session-switch reconciliation share
  // one product-locked decision.
  event: Pick<HyperliquidWorkspaceModeEvent, "mode" | "acknowledged">,
): WorkspaceModeAction {
  if (event.mode === "normal") return { type: "exit" };
  return event.acknowledged ? { type: "enter" } : { type: "acknowledge" };
}
