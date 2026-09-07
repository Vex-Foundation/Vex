/**
 * The props every launch LANE takes — the shared half of the launch surface's
 * public contract.
 *
 * Extracted so the facade (`../TokenLaunchDialog.tsx`) and the lane name the
 * same shape without importing each other. `TokenLaunchDialogProps` is
 * re-exported from the facade under its original name, so no caller's import
 * changes.
 */

import type { PoolsLaunchFormValues } from "./pools/form-values.js";

/**
 * Which of the three C1 origins opened the dialog. A RENDERER-side concept, not
 * a wire field: it decides whether dismissing the dialog owes an agent an
 * answer. The IPC contract deliberately has no origin - main stamps it.
 */
export type LaunchOrigin = "user" | "agent_requested_form" | "agent";

export interface LaunchLaneProps {
  readonly open: boolean;
  readonly onOpenChange: (next: boolean) => void;
  readonly sessionId: string | null;
  /**
   * Which of the three C1 origins opened this. `user` completes silently;
   * `agent_requested_form` answers a pending tool call, so cancelling it still
   * owes the agent an honest result.
   */
  readonly origin: LaunchOrigin;
  /** Present when an agent drafted the intent (Path 1). Cancel targets it. */
  readonly intentId?: string | null;
  /**
   * The draft to open with, for an agent-requested form: the token the agent
   * PROPOSED, read back from its intent row.
   *
   * It prefills the form and nothing else. Every field here is editable, Deploy
   * is still armed only by a resolved preview, and main still re-derives the
   * money from whatever the user finally confirms — so a prefill can shorten the
   * typing but can never shorten the authorization.
   *
   * Must be referentially STABLE (memoize it): it re-seeds the form when its
   * identity changes, and a fresh object every render would overwrite the user's
   * edits on each keystroke.
   */
  readonly initialValues?: PoolsLaunchFormValues | null;
  /**
   * Fired when this dialog becomes BUSY (a submit is in flight, or its result
   * has not been read yet) and when it stops. One boolean: the dialog keeps
   * owning its phase, and the host only needs to know whether it may unmount
   * it. Unmounting a busy dialog would drop the terminal phase and the
   * dismissal for a transaction that is already signed.
   */
  readonly onBusyChange?: (busy: boolean) => void;
}
