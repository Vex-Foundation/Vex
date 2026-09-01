/**
 * `showToast` - the app's one-line convenience over the notification model.
 *
 * ## What this module is, after B2.2
 *
 * It is NOT a store any more. The module-level transient slot, the sticky slot
 * and their subscribe/snapshot pairs are gone: `lib/notifications` owns what
 * exists, what is on screen, when it leaves, what is announced and what is
 * retained, and two more owners of the same questions is exactly the split
 * that made a missed toast unrecoverable.
 *
 * What survives is the CALL SHAPE, because a dozen call sites say
 * `showToast("Session exported.")` and that sentence is the right amount of
 * ceremony for a fire-and-forget confirmation. This adapter is the mapping and
 * nothing else: a tone becomes a severity, the scope is the app, the source is
 * `app`. Anything that needs a title, an action, progress, a scope, a handle
 * or a lifetime calls `notify` directly - that is the contract, not this.
 */

import { notify } from "./notifications/index.js";
import type { NotificationSeverity } from "./notifications/types.js";

/**
 * The three tones the call sites use. `neutral` is the SUCCESS/confirmation
 * tone and maps to `info`, which is what makes it announce politely (as a
 * status) rather than interrupting with an assertive alert.
 */
export type ToastTone = "neutral" | "warning" | "error";

const TONE_SEVERITY: Readonly<Record<ToastTone, NotificationSeverity>> = {
  neutral: "info",
  warning: "warning",
  error: "error",
};

/**
 * Show a transient app-wide toast. Copy arrives resolved from the caller.
 *
 * No dedup identity is passed, deliberately: two identical confirmations a
 * second apart are two things that happened, and collapsing them would hide
 * the second (see the dedup note in `types.ts`). The model stacks them,
 * retains both in the center, and reports anything it could not fit.
 */
export function showToast(
  text: string,
  options?: { readonly tone?: ToastTone },
): void {
  notify({
    severity: TONE_SEVERITY[options?.tone ?? "neutral"],
    scope: { kind: "global" },
    source: "app",
    message: text,
  });
}
