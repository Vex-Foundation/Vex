/**
 * WHERE FOCUS GOES IN STUDIO, and when it is allowed to move at all.
 *
 * Three gestures need this and one of them used to have a private answer:
 * the keyboard close, which puts focus back after removing the element
 * that held it, the OPEN, and the mode entry that lands on the welcome. The
 * open had no answer at all - a project opened
 * with `Enter` on the welcome's "Open <project>" left `document.activeElement`
 * on `document.body`, measured on the built app, so a keyboard user tabbed
 * from the top of the window every single time. Both are "the workspace has to
 * put focus somewhere useful", so both are decided here, in a pure module with
 * no React, beside the model the workspace's other rules live in.
 *
 * ## The permission is VS Code's, verbatim in shape
 *
 * `EditorPart.shouldRestoreFocus` (`browser/parts/editor/editorPart.ts`) is
 * two clauses and nothing else: restore focus if NOTHING is focused right now
 * (the active element is the body), or if the target already contains the
 * active element. Everything else is somebody else's focus and is left alone.
 * `EditorGroupView.restoreEditors` applies the same idea on the startup path -
 * it captures the active element before the async open and focuses only if
 * focus has not moved meanwhile, "to prevent focus from being stolen
 * accidentally on startup when the user already clicked somewhere".
 *
 * That clause is what makes an open-time focus safe to RETRY. A workspace that
 * is opened before its terminals have been revived has nothing worth focusing
 * yet, so its caller stays armed and asks again after the next commit; because
 * the permission is "only when nobody holds focus", an armed workspace can
 * never take focus away from the user who started typing in the meantime.
 *
 * ## The order of targets
 *
 * The ACTIVE TERMINAL is its own target, which is
 * `terminalService.focusActiveInstance`
 * (`contrib/terminal/browser/terminalService.ts:406`) - a shell you just opened
 * is a shell you are about to type in - and it is deliberately NOT chained to
 * the strip behind it. A workspace whose model names an active terminal that
 * has not attached yet is a workspace whose caller must WAIT, not one that
 * should park focus on a tab and call the landing done.
 *
 * The strip - the selected tab, then the one control an empty strip always has
 * - is the CLOSE path's chain, unchanged: after closing a tab the user is
 * working in the strip, and moving them into a shell instead would be a
 * different gesture's answer. It is also the open path's answer for a
 * workspace with no terminal to land in (a file tab, an empty strip).
 *
 * The terminal is found by `aria-label="Terminal input"` - xterm's own textarea
 * and its own public accessible name, the element a Tab key reaches and the one
 * the live keyboard pass measured - inside the wrapper the registry stamps with
 * `data-terminal-id`. That is the explorer focus seam's rule (`explorer/index.ts`:
 * find the surface by its public semantics rather than by a registration) applied
 * to a library's contract instead of our own.
 */

/** The selected tab trigger. Radix `Tabs` renders the role and the state. */
const SELECTED_TAB = '[role="tab"][aria-selected="true"]';

/** The strip's one always-present control, the fallback of last resort. */
const NEW_TERMINAL = 'button[aria-label="New terminal"]';

/** The Studio welcome's Start row, marked by the welcome itself. */
const WELCOME_PRIMARY_ACTION = '[data-vex-studio-welcome-action="primary"]';

/** xterm's own textarea, by the accessible name xterm gives it. */
const TERMINAL_INPUT = 'textarea[aria-label="Terminal input"]';

/**
 * May this surface take focus right now?
 *
 * - `"take"`: nothing is focused, so moving focus steals nothing.
 * - `"inside"`: the card already holds focus and there is nothing to do.
 * - `"elsewhere"`: someone else owns focus. Leave it alone, and stop asking.
 */
export type StudioFocusPermission = "take" | "inside" | "elsewhere";

export function studioFocusPermission(
  surface: HTMLElement | null,
  activeElement: Element | null,
): StudioFocusPermission {
  if (surface === null) return "elsewhere";
  if (activeElement !== null && surface.contains(activeElement)) return "inside";
  // `null` is jsdom's answer for a document nobody has focused yet, and the
  // body is every browser's answer for focus that has fallen off a removed
  // node - the state this whole module exists to repair.
  if (activeElement === null || activeElement === surface.ownerDocument.body) {
    return "take";
  }
  return "elsewhere";
}

/**
 * Focus the strip after a tab was closed: the newly selected tab, or - when
 * the close emptied the workspace - the control that is always there.
 *
 * Returns whether an element was found to focus. Both targets are inside the
 * card, so `studioSurfaceOf` keeps answering `workspace` and the next shortcut
 * resolves; that is the property the close path needs and the reason it does
 * not fall through to the document.
 */
export function focusWorkspaceStrip(card: HTMLElement): boolean {
  const next =
    card.querySelector<HTMLElement>(SELECTED_TAB)
    ?? card.querySelector<HTMLElement>(NEW_TERMINAL);
  if (next === null) return false;
  next.focus();
  return true;
}

/**
 * Focus ONE terminal by id: xterm's own textarea inside the wrapper the
 * registry stamps with `data-terminal-id`.
 *
 * Returns `false` when that terminal is not attached YET, which is an ordinary
 * state and not a failure: the model gains a pane on the commit that renders
 * its tab, and `XtermHost`'s mount effect - the thing that acquires the
 * instance and parents its wrapper - runs on a later scheduler turn. A caller
 * landing focus after an open therefore keeps asking rather than settling for
 * the strip, or the user would watch the caret land on a tab and would then
 * have to reach for the shell themselves.
 *
 * The id is compared through `dataset` rather than interpolated into a
 * selector: it is minted elsewhere (a revive hands back ids main generated) and
 * a selector built from a value this module does not own is a selector one
 * unexpected character can break.
 */
export function focusActiveTerminal(
  card: HTMLElement,
  terminalId: string,
): boolean {
  for (const wrapper of card.querySelectorAll<HTMLElement>("[data-terminal-id]")) {
    if (wrapper.dataset["terminalId"] !== terminalId) continue;
    const input = wrapper.querySelector<HTMLElement>(TERMINAL_INPUT);
    if (input === null) return false;
    // `preventScroll`, as the explorer's focus seam uses: the pane manages its
    // own scroll position and a focus that also scrolled would fight it.
    input.focus({ preventScroll: true });
    return true;
  }
  return false;
}

/**
 * Focus the Studio welcome's PRIMARY ACTION: the first control in its Start
 * row (create a project, or open the one the list returned first).
 *
 * Returns whether there was one. `false` while the project read is still in
 * flight is an ordinary answer, not a failure - the row renders nothing until
 * it can render something honest - and the caller stays armed and asks again
 * after the next commit, under the same "only when nobody holds focus"
 * permission as the workspace.
 */
export function focusStudioWelcome(welcome: HTMLElement): boolean {
  const action = welcome.querySelector<HTMLElement>(WELCOME_PRIMARY_ACTION);
  if (action === null) return false;
  action.focus({ preventScroll: true });
  return true;
}
