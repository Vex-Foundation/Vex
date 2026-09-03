/**
 * THE AGENT COMPOSER'S FOCUS SEAM - where `Ctrl+Shift+A` lands.
 *
 * Studio's back-to-Agent chord switched the shell and left
 * `document.activeElement` on `document.body` (measured on the built app), so
 * the keyboard user who left Studio arrived in the Agent shell with focus
 * nowhere and had to tab in from the top of the window. The draft field is
 * where that gesture means to arrive.
 *
 * A REGISTERED HANDLE, which is the shape the Studio rail's search seam uses
 * (`StudioSidebar.focusStudioRailSearch`) and for the same reason: the target
 * does not exist until its owner has decided to render it, so a DOM query at
 * the moment of asking would find nothing. This one goes ONE STEP FURTHER,
 * with a latch, because the caller is the handler that has just flipped
 * `runtimeMode`: `AppShell` renders the Studio centre and the session panel as
 * ALTERNATIVES, so at the instant the chord runs there is no composer mounted
 * at all, and the one that will answer arrives with React's next commit.
 *
 * The latch is therefore consumed by THE NEXT COMPOSER TO MOUNT, and that is
 * exactly the composer the mode switch is bringing on screen. It is not a
 * timer and it is not a poll: nothing here retries, and a request that is never
 * consumed simply never fires.
 *
 * ITS OWN MODULE rather than an export of `SessionComposer`, so the Studio
 * keyboard table can reach the seam without importing the Agent shell's
 * largest component - the same reason `workspace/workspace-handles.ts` exists
 * between the Studio centre and its controllers.
 *
 * Module-scope and single-slot because the shell mounts exactly one composer.
 * Process-local and never persisted, like every other registry of its kind.
 */

let composerFocus: (() => void) | null = null;
let requestPending = false;

/**
 * Register the mounted composer's focus action. Returns the unregister.
 *
 * A PENDING REQUEST IS CONSUMED HERE, which is what makes the chord work: the
 * request was made before this composer existed. Identity-checked on the way
 * out, like every other single-slot registration in this shell, so a composer
 * that unmounted after its successor mounted cannot delete the successor's
 * handle.
 */
export function publishComposerFocus(focus: () => void): () => void {
  composerFocus = focus;
  if (requestPending) {
    requestPending = false;
    focus();
  }
  return () => {
    if (composerFocus === focus) composerFocus = null;
  };
}

/**
 * Put the caret in the Agent draft field, now or as soon as one mounts.
 *
 * Always answers `true`, unlike the Studio surfaces' focus seams whose caller
 * must be able to decline a keystroke nothing answered. This one is called BY
 * the handler that has already switched the shell to Agent mode: the composer
 * is on its way by construction, and reporting "nothing answered" would make
 * that handler give up a chord it did act on.
 */
export function focusAgentComposer(): boolean {
  if (composerFocus !== null) {
    composerFocus();
    return true;
  }
  requestPending = true;
  return true;
}

/**
 * Drop the handle and any pending request.
 *
 * The RESET for a module singleton, and its consumers are the suites that
 * exercise this seam: a handle or an unconsumed request left behind by one case
 * would be taken by the next. Production needs no such call - the composer's
 * own unregister runs on unmount, and a request is always consumed by the
 * composer the mode switch brings on screen - so this is deliberately not wired
 * into a teardown it would have nothing to do in.
 */
export function clearComposerFocus(): void {
  composerFocus = null;
  requestPending = false;
}
