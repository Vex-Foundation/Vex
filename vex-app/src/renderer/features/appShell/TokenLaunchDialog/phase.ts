/**
 * The launch dialog's PHASE union — what the user is currently being asked to
 * look at, shared by every platform lane.
 *
 * Shared deliberately: the phases are the CONSENT vocabulary, not a platform
 * detail. Both lanes must be able to say "the numbers moved, look again"
 * (`re_review`) and "this is what happened" (`done`) in the same words, because
 * a second dialect of the same states is how one surface ends up quietly
 * claiming more than the other.
 */

import type { TerminalTone } from "../token-launch/launch-display.js";

/** What the user is currently being asked to look at. */
export type DialogPhase =
  | { readonly kind: "editing" }
  | { readonly kind: "submitting" }
  | { readonly kind: "re_review"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string }
  | {
      readonly kind: "done";
      readonly message: string;
      readonly tone: TerminalTone;
      readonly autoDismiss: boolean;
    };

/**
 * How long the receipt stays up before the dialog dismisses itself (owner
 * decision D1). A beat, not a modal to close: the hash is also in the Activity
 * row, in My launches, and — for an agent-requested form — in the resumed turn.
 * Set to 0 for an immediate close.
 */
export const DEPLOYED_AUTO_DISMISS_MS = 2_500;
