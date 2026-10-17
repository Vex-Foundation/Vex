/**
 * THE REFUSAL LINE a form prints when its submit came back with a Result error.
 *
 * A shared primitive because five dialogs render it and it used to live inside
 * `features/appShell/SessionCreator/FormSections.tsx`, which meant the Studio
 * project dialogs reached across two features for one paragraph (rule 03: a
 * feature does not deep-import another feature's presentational internals).
 *
 * ## It is NOT a live region
 *
 * Deliberate, and it is the whole point of the pair it forms with
 * `components/ui/live-region.tsx`. This element used to carry `role="alert"`
 * while being mounted as the last child of a scrollable dialog body: below the
 * fold, often never painted, and the announcement was therefore a property of
 * where the node landed. Announcement is now the model's job - the submit
 * handler calls `announce("error", message)` the moment it sets the error -
 * and this node's only job is to be VISIBLE. Giving it `role="alert"` again
 * would announce the same sentence twice.
 *
 * The visibility half is `DialogPinnedSlot`'s: the slot renders outside the
 * body's scroll container, next to the button the user just pressed.
 *
 * R3 draws it as the compact ink alert (docs/design/R3-MINIMAL.md section
 * 12): the ink frame and hatch band, the error swatch, the sentence. Never
 * red. `ErrorCallout` sets no live role, which keeps the rule above.
 */

import type { JSX } from "react";
import { ErrorCallout } from "./error-callout.js";

export interface SubmitErrorProps {
  /** Main's already sanitized message, or `null` when there is no refusal. */
  readonly submitError: string | null;
}

export function SubmitError({ submitError }: SubmitErrorProps): JSX.Element | null {
  if (submitError === null) return null;
  return <ErrorCallout compact title={submitError} data-vex-submit-error="" />;
}
