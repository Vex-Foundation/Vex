/**
 * EVERY user-visible string of the Studio shell (stage B4a), in one module.
 *
 * The shell's own surfaces - the status word, the welcome screen, the sidebar
 * sections, the keep-alive dialog - speak from here so a wording change is one
 * review of one file rather than a grep across five components. The terminal,
 * the explorer and the viewer keep their own copy modules; those surfaces have
 * their own owners and their own vocabulary.
 *
 * Rules that bind this file: English, no em dashes, and NO ROADMAP COPY. A
 * surface that cannot do something yet does not say "coming soon" - it either
 * is not rendered at all or it is rendered and honestly disabled.
 */

import type {
  StudioHostState,
  StudioHostUnavailableCause,
} from "@shared/schemas/studio.js";
import type { StudioArtifactStatus } from "@shared/schemas/studio-installer.js";

/* ------------------------------- status word ------------------------------ */

/**
 * The one live word in the status strip while Studio is the active shell.
 *
 * `running` carries its connection figure because the number is the fact a user
 * acts on (a capacity refusal is the next thing they would hit), and at
 * capacity the figure is replaced by the words rather than shown beside them:
 * "RUNNING 16 connected" and "at capacity" are the same fact twice.
 */
export function studioHostStatusWord(
  state: StudioHostState,
  connectionCount: number,
  atCapacity: boolean,
): string {
  if (state === "running") {
    return atCapacity
      ? "Running at capacity"
      : `Running ${String(connectionCount)} connected`;
  }
  if (state === "locked") return "Locked";
  if (state === "starting") return "Starting";
  return "Unavailable";
}

/**
 * The accessible description under the word: WHY the host is unavailable.
 *
 * One sentence per wire cause, so a screen reader hears the reason rather than
 * a bare "unavailable", and none of them leaks a path, an endpoint or a
 * provider payload (rule 07). The specific failure stays in main's log.
 */
export const STUDIO_HOST_CAUSE_SENTENCES: Readonly<
  Record<StudioHostUnavailableCause, string>
> = {
  starting: "Vex Studio is still starting up.",
  fence_uninitialized:
    "Vex Studio cannot accept approvals yet, so it is not serving calls.",
  shutting_down: "Vex is shutting down, so Studio has stopped serving calls.",
  not_configured:
    "No agent executor is installed, so Vex Studio has nothing to serve.",
  endpoint_unavailable:
    "Vex Studio could not open its local endpoint on this machine.",
  // Says the true thing: it is off, it is off on purpose, and there is nothing
  // on this machine for the user to repair. Naming the working platforms is
  // the only remedy that exists.
  windows_transport_disabled:
    "Vex Studio is not available on Windows yet: its Windows connection has "
    + "been kept switched off until its security has been verified. Use Vex "
    + "Studio on Linux or macOS.",
  // Four sentences for four different failures. Each says WHAT could not be
  // completed and why, and stops there: the remedy is the card's next step
  // (`STUDIO_HOST_CAUSE_NEXT_STEPS`), which is also what the live region
  // announces, so the same instruction is never printed twice under itself.
  // None of them names a file, a pipe or a descriptor (rule 07), and none
  // blames the user.
  front_unavailable:
    "Vex Studio could not start the helper it needs for its Windows connection.",
  pipe_security_unconfirmed:
    "Windows did not confirm that Vex Studio's connection is protected, so Vex "
    + "did not open it.",
  front_restart_budget_exhausted:
    "Vex Studio's Windows connection helper stopped too many times, so Vex "
    + "stopped restarting it.",
  admission_permanently_closed:
    "Vex Studio can no longer confirm that locking is safe, so it has stopped "
    + "serving calls for this session.",
};

/**
 * What the pill's accessible name says the state is ABOUT. Not exported: the
 * name a consumer wants is the whole one, and that is `studioHostPillLabel`,
 * which is the only thing that may compose this fragment.
 */
const STUDIO_HOST_STATUS_LABEL = "Vex Studio host status";

/** Shown while the first host-status read is still in flight. */
export const STUDIO_HOST_STATUS_LOADING = "Checking";

/** Shown when the host-status read itself failed. */
export const STUDIO_HOST_STATUS_UNKNOWN = "Unknown";
export const STUDIO_HOST_STATUS_UNKNOWN_DETAIL =
  "Vex could not read the Studio host status.";

/* ----------------------------- host status card --------------------------- */

/**
 * THE CARD BEHIND THE STATUS PILL: what is not available, why, and what to do.
 *
 * The word alone answered none of rule 08's three questions, and the cause
 * sentence above reached the screen only as an accessible description - a
 * sighted user hovering `Locked` learned nothing and had nowhere to go. The
 * card says the headline (what is or is not available), the reason (the cause
 * sentence, ONE source, never a second wording of the same fact), and the next
 * step.
 */

/**
 * The next step's BUTTON, and it exists only where the renderer really holds
 * that authority:
 *
 *  - `unlock`  opens the unlock screen (`uiStore.openUnlock`), which is the
 *              actual route out of `locked`;
 *  - `recheck` re-reads the host status through the same query the pill shows.
 *
 * "Restart Vex" and "Reinstall Vex" are deliberately NOT buttons: the renderer
 * has no restart or repair authority (there is no such IPC, and main owns that
 * decision), and a control that cannot do what its label says is worse than a
 * sentence. Those causes carry their step as an instruction instead.
 */
export type StudioHostCardButton = "unlock" | "recheck";

export interface StudioHostNextStep {
  /** The imperative next step, or null when there is nothing a user can do. */
  readonly instruction: string | null;
  /** A control the renderer can honestly perform, or null. */
  readonly button: StudioHostCardButton | null;
}

/**
 * One next step per wire cause. Total over the enum, so a cause added on the
 * wire cannot compile without someone deciding what a user should do about it,
 * and reconciled against the schema's own options by a table test.
 *
 * `starting`, `fence_uninitialized` and `shutting_down` carry NOTHING on
 * purpose: all three resolve themselves within seconds and every one of them
 * is push-updated, so an action here would ask the user to work around a state
 * that is already ending.
 */
export const STUDIO_HOST_CAUSE_NEXT_STEPS: Readonly<
  Record<StudioHostUnavailableCause, StudioHostNextStep>
> = {
  starting: { instruction: null, button: null },
  fence_uninitialized: { instruction: null, button: null },
  shutting_down: { instruction: null, button: null },
  not_configured: {
    instruction: "Install an agent executor, then check again.",
    button: "recheck",
  },
  endpoint_unavailable: { instruction: null, button: "recheck" },
  // Nothing to do and nothing to check: the transport is off by decision, and
  // the cause sentence already names the only remedy there is.
  windows_transport_disabled: { instruction: null, button: null },
  front_unavailable: {
    instruction: "Reinstall Vex, or rebuild it if you are running from source.",
    button: null,
  },
  pipe_security_unconfirmed: {
    instruction:
      "Close Vex and open it again. Reinstall Vex if this keeps happening.",
    button: null,
  },
  front_restart_budget_exhausted: {
    instruction: "Close Vex and open it again.",
    button: null,
  },
  admission_permanently_closed: {
    instruction: "Close Vex and open it again. Unlocking will not reopen it.",
    button: null,
  },
};

/**
 * The card's first line: what is or is not available, in the present tense.
 *
 * Derived from the STATE rather than the cause, because that is the fact the
 * word itself reports; the cause explains it on the line below.
 */
export function studioHostHeadline(
  state: StudioHostState,
  atCapacity: boolean,
): string {
  if (state === "running") {
    return atCapacity
      ? "Vex Studio has no free connection slots."
      : "Vex Studio is serving your projects.";
  }
  if (state === "starting") return "Vex Studio is starting.";
  if (state === "locked") {
    return "Vex Studio is not admitting connections while Vex is locked.";
  }
  return "Vex Studio is not serving calls.";
}

/** The running host's second line: the figure a capacity refusal comes from. */
export function studioHostConnectionsLine(
  connectionCount: number,
  maxConnections: number,
): string {
  return `${String(connectionCount)} of ${String(maxConnections)} connections in use.`;
}

/** The locked host's reason line. Unlocking is a real route, so it is a button. */
export const STUDIO_HOST_LOCKED_REASON =
  "Vex is locked, so Vex Studio refuses every connection without reading a project.";

/** The starting host's reason line. */
export const STUDIO_HOST_STARTING_REASON =
  "Vex Studio is binding its local endpoint. It reports the result itself.";

/** Shown in the card while the first read has not answered yet. */
export const STUDIO_HOST_LOADING_HEADLINE =
  "Vex is reading the Studio host status.";

/** Shown in the card when the read itself failed. */
export const STUDIO_HOST_UNKNOWN_HEADLINE =
  "Vex could not read the Studio host status.";

export const STUDIO_HOST_UNLOCK_LABEL = "Unlock Vex";
export const STUDIO_HOST_RECHECK_LABEL = "Check again";

/** Accessible name of the card the pill opens. */
export const STUDIO_HOST_CARD_LABEL = "Vex Studio host status details";

/**
 * The PILL's accessible name: the state first, then what the state is about.
 *
 * The word is the pill's visible text, so the name has to START with it. An
 * `aria-label` REPLACES an element's text, and a name of "Vex Studio host
 * status" alone left the visible word unspeakable to voice control (WCAG 2.5.3,
 * label in name) and left a screen-reader user who focused the pill hearing
 * what the control is for and never what it currently says.
 */
export function studioHostPillLabel(word: string): string {
  return `${word}. ${STUDIO_HOST_STATUS_LABEL}`;
}

/* --------------------------------- welcome -------------------------------- */

export const STUDIO_WELCOME_TITLE = "Vex Studio";

/**
 * THE HERO'S THREE LINES.
 *
 * A start screen, not a text column (VS Code's Getting Started: a statement,
 * the actions, the recents; deepseek's `EmptyHero`: one sentence of purpose
 * and one obvious control). One line for what a project IS, one for what
 * creating one actually does, one for the way back to the agent shell.
 * Descriptive, not promotional, claiming nothing about safety, autonomy or
 * outcome (rule 90, product truth).
 */
export const STUDIO_WELCOME_LEAD =
  "A project is a folder on your disk that Vex and your coding agents share, with its own permission and its own wallet selection.";
export const STUDIO_WELCOME_NEXT =
  "Creating one writes each selected agent's config into that folder, then opens it with its terminal, its files and your portfolio side by side.";
export const STUDIO_WELCOME_AGENT_POINTER =
  "Vex's agent shell is one switch away, and Studio is where you left it when you come back.";

export const STUDIO_WELCOME_CREATE_LABEL = "New project";

/** The second action: open the project the list returned first. */
export function studioWelcomeOpenLabel(projectName: string): string {
  return `Open ${projectName}`;
}

/**
 * The welcome row's state dot IN WORDS.
 *
 * The dot is colour-only and `aria-hidden`, and this row carries no visible
 * verdict word beside it, so this label is the only thing assistive technology
 * can hear. A drifted row hears the drift sentence itself - one answer to "is
 * this project drifted", never a second wording of it.
 */
export const STUDIO_WELCOME_ROW_CLEAN_LABEL =
  "Vex's files in this project are as Vex wrote them";

export const STUDIO_WELCOME_RECENT_TITLE = "Projects";
export const STUDIO_WELCOME_RECENT_EMPTY = "No projects yet.";
export const STUDIO_WELCOME_RECENT_LOADING = "Loading projects";
export const STUDIO_WELCOME_RECENT_ERROR = "Vex could not read your projects.";

/* --------------------------------- sidebar -------------------------------- */

export const STUDIO_SIDEBAR_LABEL = "Studio projects sidebar";
export const STUDIO_NEW_PROJECT_LABEL = "New project";
export const STUDIO_PROJECTS_SECTION = "Projects";
export const STUDIO_WELCOME_ROW_LABEL = "Welcome";
export const STUDIO_EXPLORER_SECTION = "Explorer";

/**
 * THE SEARCH CONTROLS, and why there are three distinct names.
 *
 * The rail used to name the header toggle and the field's own control the same
 * thing ("Close project search"), so a screen reader offered two controls with
 * one name and no way to tell them apart. They do different things and now say
 * so: the header toggle OPENS or CLOSES the search, the field's control CLEARS
 * the query, and the field itself is named by what it searches.
 */
export const STUDIO_SEARCH_OPEN_LABEL = "Search projects and files";
export const STUDIO_SEARCH_CLOSE_LABEL = "Close search";
export const STUDIO_SEARCH_CLEAR_LABEL = "Clear search";
export const STUDIO_SEARCH_PLACEHOLDER = "Search projects and files";
export const STUDIO_SIDEBAR_COLLAPSE_LABEL = "Collapse Studio sidebar";
export const STUDIO_SIDEBAR_EXPAND_LABEL = "Expand Studio sidebar";

/* --------------------------------- search --------------------------------- */

export const STUDIO_SEARCH_RESULTS_LABEL = "Search results";
export const STUDIO_SEARCH_GROUP_PROJECTS = "Projects";
export const STUDIO_SEARCH_GROUP_FILES = "Files";
export const STUDIO_SEARCH_EMPTY = "No project or file matches that name.";

/**
 * THE SEARCH'S BOUND, said out loud on every result list.
 *
 * The file half of this search runs over the nodes the explorer has ALREADY
 * loaded for the open project. There is no main-side name index behind it, so a
 * file in a folder the user has never expanded is not searched. That is a real
 * limit on the answer and the user is told it rather than being left to infer
 * it from a result list that looks complete.
 */
export const STUDIO_SEARCH_FILE_SCOPE_NOTE =
  "Files cover the folders you have opened in this project.";

/** How many of the matches a bounded group is showing, and how many exist. */
export function studioSearchShowingLine(shown: number, total: number): string {
  return `Showing ${String(shown)} of ${String(total)} matches. Narrow the search to see the rest.`;
}

/**
 * THE SECOND BOUND: the walk itself stopped before the end of what is loaded.
 *
 * `studioSearchShowingLine` reports rows that MATCHED and were not shown; this
 * reports files that were never looked at, which is a different and worse fact -
 * a file that matches may be missing from the list entirely. The scan cap keeps
 * one keystroke from walking an unbounded tree, and a bound the user is not told
 * about is a silent cut.
 */
export function studioSearchScanTruncatedLine(scanned: number): string {
  return `Searched the first ${String(scanned)} loaded files only. Open fewer folders, or narrow the search.`;
}

export const STUDIO_PROJECTS_LOADING = "Loading projects";
export const STUDIO_PROJECTS_EMPTY = "No projects yet.";
export const STUDIO_PROJECTS_ERROR = "Vex could not read your projects.";
export const STUDIO_PROJECTS_RETRY = "Retry";

/** The bounded PROJECTS list's tail control. The count is the whole list. */
export function studioShowAllProjectsLabel(total: number): string {
  return `Show all ${String(total)} projects`;
}

export const STUDIO_SHOW_FEWER_PROJECTS = "Show fewer projects";

/* ------------------------------- rail chrome ------------------------------ */

/** The vertical seam between the PROJECTS list and the EXPLORER pane. */
export const STUDIO_RAIL_SPLIT_LABEL = "Resize the projects and explorer panes";

export const STUDIO_RAIL_SETTINGS_LABEL = "Open settings";

/** The foot's theme control names the theme it switches TO, never the current one. */
export function studioThemeToggleLabel(nextTheme: "dark" | "light"): string {
  return nextTheme === "dark" ? "Switch to the dark theme" : "Switch to the light theme";
}

/** The row's permission tag. Always visible, never hover-revealed. */
export function projectPermissionTag(permission: "restricted" | "full"): string {
  return permission === "full" ? "full" : "restricted";
}

export function projectRowMenuLabel(projectName: string): string {
  return `Actions for ${projectName}`;
}

export const STUDIO_PROJECT_MENU_SETTINGS = "Settings";
export const STUDIO_PROJECT_MENU_REPAIR = "Repair";
export const STUDIO_PROJECT_MENU_DELETE = "Delete";

/* ---------------------------------- drift --------------------------------- */

/**
 * The drift badge's accessible name, per artifact state.
 *
 * `current` and `unsupported` are NOT drift and have no entry: `unsupported`
 * means the agent has no artifact by design, and rendering a warning for it
 * would teach the user to ignore the badge.
 */
export const STUDIO_DRIFT_SENTENCES: Readonly<
  Partial<Record<StudioArtifactStatus["state"], string>>
> = {
  drifted: "Edited since Vex wrote it",
  missing: "Missing from the project folder",
  stale: "Older than the current project scope",
  unreadable: "Could not be read from disk",
};

export function projectDriftLabel(
  projectName: string,
  sentence: string,
): string {
  return `${projectName}: ${sentence}`;
}

/**
 * The SAME sentence on the file the drift is actually about.
 *
 * The project row says a Vex-managed file drifted; the tree is where the user
 * can see WHICH one. Both readings come from `STUDIO_DRIFT_SENTENCES`, so the
 * row and the file cannot say different things about one artifact.
 */
export function projectFileDriftLabel(
  fileName: string,
  sentence: string,
): string {
  return `${fileName}: ${sentence}`;
}

/* ----------------------------- keep-alive dialog --------------------------- */

export const STUDIO_KEEP_ALIVE_TITLE = "Close a project workspace first";

export function studioKeepAliveDescription(
  projectName: string,
  bound: number,
): string {
  return `Vex keeps ${String(bound)} project workspaces open so their terminals and files stay where you left them. Close one to open "${projectName}"; Vex never closes a workspace for you.`;
}

export const STUDIO_KEEP_ALIVE_CANCEL = "Cancel";
export const STUDIO_KEEP_ALIVE_LIST_LABEL = "Open project workspaces";

export function studioKeepAliveCloseLabel(projectName: string): string {
  return `Close the ${projectName} workspace`;
}

/**
 * What closing THIS row costs, in shells.
 *
 * Closing a workspace ends its terminals, so the count is the consequence the
 * user is choosing between rows on, and a dialog that offered four
 * indistinguishable "Close" buttons would be asking them to choose blind.
 * Present tense, because the button beside it performs it.
 *
 * Shown only when the renderer KNOWS the count; see `peekProjectTerminals` for
 * why `null` and `0` are different facts and why neither is guessed.
 */
export function studioKeepAliveTerminalsLine(count: number): string {
  if (count === 0) return "No running terminals";
  return count === 1 ? "Closes 1 running terminal" : `Closes ${String(count)} running terminals`;
}

export const STUDIO_KEEP_ALIVE_CLOSE = "Close";
