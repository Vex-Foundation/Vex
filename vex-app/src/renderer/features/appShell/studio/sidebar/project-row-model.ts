/**
 * Pure decisions a project row renders from. No React, no bridge - so the
 * "which drift wins" and "does this row match the search" rules are table-
 * testable without mounting a rail.
 */

import type { ProjectDto } from "@shared/schemas/projects.js";
import type { StudioArtifactStatus } from "@shared/schemas/studio-installer.js";

/**
 * The artifact states that count as DRIFT, worst first.
 *
 * `current` is clean. `unsupported` is NOT drift: it means the agent has no
 * artifact at all by design, and badging it would train the user to ignore the
 * badge that matters. The order is the badge's precedence - one row gets one
 * badge, and it names the worst thing true of that project.
 *
 *  - `drifted`   the file was edited since Vex wrote it, so a Repair OVERWRITES
 *                the user's edit. That is the only outcome here that can lose
 *                work, so it outranks everything.
 *  - `missing`   the project selects the file and it is not on disk: the agent
 *                is running without the scope the user granted.
 *  - `stale`     present and unedited, but older than the current scope.
 *  - `unreadable` could not be inspected. Last because it is the least specific,
 *                and it is still reported rather than hidden.
 */
const PROJECT_DRIFT_PRECEDENCE = [
  "drifted",
  "missing",
  "stale",
  "unreadable",
] as const satisfies readonly StudioArtifactStatus["state"][];

export type ProjectDriftState = (typeof PROJECT_DRIFT_PRECEDENCE)[number];

/** The worst drift state among a project's artifacts, or null when clean. */
export function worstDriftState(project: ProjectDto): ProjectDriftState | null {
  const states = new Set(project.files.artifacts.map((a) => a.state));
  for (const candidate of PROJECT_DRIFT_PRECEDENCE) {
    if (states.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Which of a project's Vex-managed FILES are drifted, by project-relative path.
 *
 * The project row already says "something Vex wrote has drifted"; this is what
 * lets the tree say WHICH file, on the row the user would click to look at it
 * (VS Code's explorer decorations put the same class of fact on the resource it
 * is about). Same precedence as {@link worstDriftState}, applied per artifact
 * rather than per project: one file's state is that file's own.
 *
 * An artifact with a null path is skipped - it names no file to decorate. A
 * `current` or `unsupported` artifact is not drift and is absent, so a caller
 * cannot decorate a clean file by looking it up.
 */
export function driftedArtifactPaths(
  project: ProjectDto,
): ReadonlyMap<string, ProjectDriftState> {
  const drifted = new Map<string, ProjectDriftState>();
  for (const artifact of project.files.artifacts) {
    const path = artifact.path;
    if (path === null) continue;
    const state = PROJECT_DRIFT_PRECEDENCE.find(
      (candidate) => candidate === artifact.state,
    );
    if (state === undefined) continue;
    const held = drifted.get(path);
    // Two artifacts can name one path (an agent file the project selects twice
    // in different roles). The WORST state wins, the same rule the row uses.
    if (
      held !== undefined &&
      PROJECT_DRIFT_PRECEDENCE.indexOf(held) <= PROJECT_DRIFT_PRECEDENCE.indexOf(state)
    ) {
      continue;
    }
    drifted.set(path, state);
  }
  return drifted;
}
