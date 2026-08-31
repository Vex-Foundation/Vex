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
};

/** Accessible name for the word itself, so the state is never colour-only. */
export const STUDIO_HOST_STATUS_LABEL = "Vex Studio host status";

/** Shown while the first host-status read is still in flight. */
export const STUDIO_HOST_STATUS_LOADING = "Checking";

/** Shown when the host-status read itself failed. */
export const STUDIO_HOST_STATUS_UNKNOWN = "Unknown";
export const STUDIO_HOST_STATUS_UNKNOWN_DETAIL =
  "Vex could not read the Studio host status.";

/* --------------------------------- welcome -------------------------------- */

export const STUDIO_WELCOME_TITLE = "Vex Studio";

/**
 * What Studio IS, in two sentences. Descriptive, not promotional: it says what
 * the surface does and what the user keeps control of, and claims nothing about
 * safety, autonomy or outcome (rule 90, product truth).
 */
export const STUDIO_WELCOME_SENTENCES: readonly string[] = [
  "A Studio project is a folder on your disk that Vex and your coding agents share, with its own permission and its own wallet selection.",
  "Open a project to get its terminal, its files and its portfolio side by side; nothing runs until you start it.",
];

export const STUDIO_WELCOME_CREATE_LABEL = "New project";
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

export const STUDIO_SEARCH_OPEN_LABEL = "Search projects";
export const STUDIO_SEARCH_CLOSE_LABEL = "Close project search";
export const STUDIO_SEARCH_PLACEHOLDER = "Search projects";
export const STUDIO_SIDEBAR_COLLAPSE_LABEL = "Collapse Studio sidebar";
export const STUDIO_SIDEBAR_EXPAND_LABEL = "Expand Studio sidebar";

export const STUDIO_PROJECTS_LOADING = "Loading projects";
export const STUDIO_PROJECTS_EMPTY = "No projects yet.";
export const STUDIO_PROJECTS_ERROR = "Vex could not read your projects.";
export const STUDIO_PROJECTS_RETRY = "Retry";
export const STUDIO_PROJECTS_SEARCH_EMPTY = "No project matches that name.";

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

export const STUDIO_KEEP_ALIVE_CLOSE = "Close";
