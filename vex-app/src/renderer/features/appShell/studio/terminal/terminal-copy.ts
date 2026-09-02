/**
 * EVERY user-visible string of the Studio TERMINAL surface, in one module.
 *
 * The sibling surfaces each have one - `explorer/explorer-copy.ts`,
 * `viewer/viewer-copy.ts`, `projects/projects-copy.ts` - and the shell's own
 * `studio-copy.ts` says in its first paragraph why the terminal keeps its own
 * rather than joining it: this surface has its own owner and its own
 * vocabulary. It simply never got the file, and the strings lived at the top of
 * a 1000-line component where a wording review meant reading the component.
 *
 * Two of the three tables are EXHAUSTIVE over a closed union, which is the
 * property worth preserving: a refusal reason or a close failure added without
 * a sentence beside it is a type error rather than a reason code printed at the
 * user.
 *
 * Rules that bind this file, as they bind `studio-copy.ts`: English, no em
 * dashes, no roadmap copy.
 */

import type { TerminalErrorCode } from "@shared/schemas/terminal.js";
import { STUDIO_FILE_TABS_MAX } from "../workspace/types.js";
import type { WorkspaceCloseFailure } from "../workspace/close-lifecycle.js";
import type { WorkspaceRefusalReason } from "../workspace/types.js";

/* ------------------------------------------------------------------ *
 * The panel header
 * ------------------------------------------------------------------ */

/** The shell picker's accessible name, on the button and on the listbox. */
export const SHELL_PICKER_LABEL = "Shell for new terminals";

/**
 * What a shell Vex knows but this machine does not have says, in a row.
 *
 * A leading space, because it is APPENDED to the shell's own label to build the
 * accessible name. The row is still listed and still reachable by keyboard: a
 * user who cannot find zsh in the picker learns nothing, and a user who finds
 * it marked as not installed learns exactly what to do.
 */
export const SHELL_UNAVAILABLE_SUFFIX = " (not installed)";

/**
 * The accessible name of the directory line in the panel header.
 *
 * The visible text is the bare label (`src/lib`, `vex-core`, `outside
 * project`), which is what a person reading the header wants; on its own it is
 * an unexplained fragment to anyone hearing it, so the accessible name says
 * what the fragment IS. `null` is the state before the shell's first directory
 * property arrives, which is a real state and not an error.
 *
 * The value passed here is always a label. There is no branch that could
 * receive a filesystem path: the wire does not carry one.
 */
export function terminalLocationLabel(displayCwd: string | null): string {
  return displayCwd === null
    ? "Working directory not known yet"
    : `Working directory: ${displayCwd}`;
}

/** Why nothing happened, in words the person reading it can act on. */
export const REFUSAL_COPY: Partial<Record<TerminalErrorCode, string>> = {
  limit_project_terminals:
    "This project already has the maximum number of terminals. Close one to open another.",
  limit_global_terminals:
    "Vex has the maximum number of terminals open. Close one to open another.",
  host_unavailable:
    "The terminal service is not running and could not be restarted. Restart Vex to try again.",
  project_deleting: "This project is being deleted, so no new terminal can open.",
  create_timeout: "The terminal service did not answer in time. Try again.",
  launch_shell_unavailable:
    "That shell is not installed on this machine. Pick another one from the shell menu.",
  snapshot_unavailable: "Vex could not read this project's saved terminal layout.",
};

/**
 * What a FAILED close says, per failure.
 *
 * Exhaustive over `WorkspaceCloseFailure` for the reason the mutation table
 * beside it is exhaustive: a failure added without a sentence must be a type
 * error rather than a reason code printed at the user. Each one names what did
 * or did not survive, because that is the fact the user needs before deciding
 * whether to retry - the first two mean nothing was saved AND nothing was lost,
 * the last two mean the layout is safe and a shell is not.
 *
 * Only three of the four invite a retry. `kill_not_owned` says the host
 * reported a shell as belonging to ANOTHER Vex window, which no retry from this
 * one can change, so its sentence names the owner instead of asking the user to
 * try the same thing again.
 *
 * These live here rather than in `studio-copy.ts` deliberately: that module
 * owns the SHELL's vocabulary and says so in its own doc ("the terminal, the
 * explorer and the viewer keep their own copy modules"), and this is the
 * terminal surface's copy owner, beside the two refusal tables it already
 * holds.
 */
export const CLOSE_FAILURE_COPY: Readonly<Record<WorkspaceCloseFailure, string>> = {
  persist_unreachable:
    "Vex could not reach the terminal service to save this workspace, so nothing was closed. Your terminals are still running. Try closing again.",
  persist_refused:
    "The terminal service refused to save this workspace, so nothing was closed. Your terminals are still running. Try closing again.",
  kill_incomplete:
    "This workspace was saved, but at least one shell could not be ended. Your work is safe. Try closing again.",
  kill_not_owned:
    "This workspace was saved, but the terminal service reports at least one of its shells as belonging to another Vex window, so this window cannot end it. Your work is safe. Close that window to end the shell.",
};

/**
 * The RESTORE could not be read, so Vex does not know what this project holds.
 *
 * Said out loud rather than swallowed, because the silence was the defect: a
 * read that failed left an empty strip over a snapshot that may be perfectly
 * good, and nothing on screen distinguished that from a project that genuinely
 * has no terminals. It also names why no terminal was opened for them - the
 * auto-open deliberately does not fire over a layout Vex could not read, since
 * a terminal spawned there would be persisted on top of the layout it failed to
 * restore.
 */
export const RESTORE_FAILED_COPY =
  "Vex could not read this project's saved terminal workspace, so nothing was "
  + "restored and no terminal was opened. Open one below, or reopen the project "
  + "to try the restore again.";

/**
 * The EMPTY WORKSPACE, and why it is still reachable.
 *
 * Opening a project auto-creates its first terminal, so this is not the state a
 * fresh project starts in. It is what remains when the auto-open deliberately
 * did not fire (a restore Vex could not read) or when the user closed every tab
 * themselves. Both used to render a black rectangle with no affordance in it,
 * which reads as a broken surface rather than as an empty one.
 */
export const EMPTY_WORKSPACE_COPY = "No terminals or files are open in this project.";

/**
 * The empty state's own action.
 *
 * Deliberately NOT "New terminal", which is the tab strip's `+` button: two
 * controls sharing one accessible name is ambiguous to anyone navigating by
 * name, and the strip's `+` is still present above this panel.
 */
export const EMPTY_WORKSPACE_ACTION_COPY = "Open a terminal";

/** Refused because this workspace is closing. Not a bound; a phase. */
export const CLOSING_CREATE_COPY =
  "This workspace is closing, so no new terminal can open in it.";

export const KEEP_ALIVE_COPY =
  "This project already has the maximum number of live terminal tabs. Close one to open another - Vex never closes a running shell for you.";

/**
 * What a refused mutation SAYS, per reason.
 *
 * A lookup rather than a chain of ternaries because `WorkspaceMutation` gained
 * a second bound in B4b and the two read identically in code while meaning
 * different things to a user. Every member of the union has an entry, so a
 * refusal can never fall through to a reason code printed at the user.
 */
export const MUTATION_REFUSAL_COPY: Readonly<Record<WorkspaceRefusalReason, string>> = {
  keep_alive_limit: KEEP_ALIVE_COPY,
  file_tab_limit:
    `This project already has ${String(STUDIO_FILE_TABS_MAX)} files open. Close one to open another; Vex never closes a tab for you.`,
  unknown_tab: "That tab is no longer open.",
  unknown_pane: "That pane is no longer open.",
  last_pane:
    "That is the last pane in this tab. Close the tab itself to close it.",
};
