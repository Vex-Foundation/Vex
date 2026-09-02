/**
 * WHAT MAKES A DIALOG'S SAFER CHOICE ACTUALLY FOCUSED, in a browser rather than
 * in jsdom.
 *
 * Rule 08: a dangerous action defaults focus to the safer choice. Studio's
 * consent dialogs all say so - `autoFocus` on Cancel, with a comment citing the
 * rule - and in a real browser two of them did not do it.
 *
 * ## The mechanism, measured
 *
 * React's `autoFocus` prop is NOT rendered as the `autofocus` content
 * attribute: React strips it and calls `.focus()` imperatively during the
 * commit. `Dialog` then calls `showModal()` from its own effect, and a parent's
 * effect runs AFTER its children's, so the native dialog focusing steps run
 * LAST and overwrite that focus with the first focusable descendant.
 *
 * What each dialog therefore opened on:
 *
 *   - `ProjectDeleteDialog` - the typed confirmation field, the control that
 *     ARMS the delete, instead of Cancel;
 *   - `StudioKeepAliveDialog` - the first project's `Close` button, which ends
 *     every shell running in that project, instead of Cancel.
 *
 * ## Why no unit test caught it
 *
 * The jsdom `showModal` polyfill in `studio-fixtures.ts` only sets the `open`
 * attribute and runs no focusing steps, so an assertion on
 * `document.activeElement` passes in jsdom for a dialog the browser focuses
 * elsewhere. The browser pass (`e2e/studio-states.spec.ts`) is what caught it,
 * and React's rendered output was probed directly to confirm the attribute is
 * absent from the DOM. So the regression guard for this is an assertion on the
 * ATTRIBUTE, which is the thing `showModal()` actually reads.
 *
 * ## Why a spread constant and not a `DialogContent` prop
 *
 * The general fix belongs to `DialogContent`, which already owns `showModal()`
 * and focus restoration and could move focus itself after opening. That file is
 * outside this task's scope, so this names the mechanism for the two dialogs
 * that were measurably wrong instead of reaching into it. Every other
 * `<dialog>` in the app that wants a specific initial focus has the same
 * latent bug.
 *
 * Spread onto the element that must receive focus, ALONGSIDE React's
 * `autoFocus` - the prop still covers the non-modal render path, and the
 * attribute is what survives `showModal()`.
 */
export const DIALOG_INITIAL_FOCUS = { autofocus: "" } as unknown as {
  readonly autofocus?: string;
};
