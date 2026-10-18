/**
 * Tool-inspect store: the inspect view for one tool call, ADDITIVE over the
 * Vex sidebar's body (docs/design/R3-MINIMAL.md section 5.1). A tool row in
 * the transcript calls `openToolInspect` with the call it renders; the Vex
 * sidebar hides its body behind the inspect view while a payload of the open
 * session is set, and its Back key closes it. UI-only Zustand state, never
 * persisted (tool args and results are session data, not preferences), and
 * not a uiStore slot: the seam is local by design (board contract with the
 * transcript owner, 2026-08-20).
 */

import { create } from "zustand";

export type ToolInspectStatus = "pending" | "running" | "done" | "error";

export interface ToolInspectPayload {
  /** Session the call belongs to; a session switch closes the view. */
  readonly sessionId: string;
  /** Stable identity of the call row (message/tool-call key). */
  readonly callKey: string;
  readonly toolName: string;
  readonly status: ToolInspectStatus;
  /** Raw call arguments as the transcript holds them; rendered, never executed. */
  readonly args: unknown;
  /** Tool result when the call has one; absent while pending/running. */
  readonly result?: unknown;
}

interface ToolInspectState {
  readonly inspect: ToolInspectPayload | null;
  readonly openToolInspect: (payload: ToolInspectPayload) => void;
  readonly closeToolInspect: () => void;
}

export const useToolInspectStore = create<ToolInspectState>((set) => ({
  inspect: null,
  openToolInspect: (payload) => set({ inspect: payload }),
  closeToolInspect: () => set({ inspect: null }),
}));
