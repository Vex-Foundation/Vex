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
 * the third means the layout is safe and some shells are not.
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
};

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
