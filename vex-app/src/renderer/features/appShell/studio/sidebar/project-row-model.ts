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
 * Filter the project list by name.
 *
 * Case-insensitive substring on the name only: the rail shows names, and
 * matching a hidden field would produce rows whose match the user cannot see.
 * An empty or whitespace-only query returns the list UNCHANGED and in its
 * original order - nothing here ever re-sorts.
 */
export function filterProjectsByName(
  projects: readonly ProjectDto[],
  query: string,
): readonly ProjectDto[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return projects;
  return projects.filter((project) =>
    project.name.toLowerCase().includes(needle),
  );
}
