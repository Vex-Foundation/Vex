/**
 * COMPOSITION for the name-search surface: the production collaborators, and
 * the process-wide instance the IPC handlers reach.
 *
 * `name-index.ts` owns the policy and takes every collaborator as a dependency,
 * which is what lets its session lifetime, single-flight build, eviction and
 * disposal be tested without Electron or Postgres. This file is the wiring.
 *
 * The same shape `files-composition.ts` and `terminal-domain.ts` use, including
 * the project-directory resolution below, which is deliberately the same three
 * public calls in the same order rather than a shared helper: each composition
 * states its own dependency on the projects root explicitly, and the halves
 * that matter (`resolveProjectsRoot` returns a REALPATH used as the anchor; the
 * directory is joined lexically and left unproven for the domain to prove) are
 * the invariant, not the lines.
 */

import { getProject } from "../../database/projects/read.js";
import type { ProjectFilesLocation } from "../files/files-domain.js";
import { resolveProjectDirectory, resolveProjectsRoot } from "../projects-root.js";
import { ProjectNameIndexes } from "./name-index.js";

/**
 * Where a project's files are, derived in MAIN from its slug.
 *
 * The renderer sends a project id and never a path, and `getProject` reads
 * ACTIVE projects only, so a tombstoned project resolves to `null` here and
 * every search of it is refused without this module needing to know what a
 * tombstone is.
 */
async function resolveSearchProjectDirectory(
  projectId: string,
): Promise<ProjectFilesLocation | null> {
  const correlationId = `search-dir-${projectId}`;
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return null;
  const project = await getProject(projectId, correlationId);
  if (!project.ok || project.data === null) return null;
  const directory = resolveProjectDirectory(rootOutcome.data, project.data.slug);
  if (directory === null) return null;
  return { anchoredRoot: rootOutcome.data, projectDirectory: directory };
}

let instance: ProjectNameIndexes | null = null;

/** The process-wide name indexes, created on first use. */
export function projectNameIndexes(): ProjectNameIndexes {
  instance ??= new ProjectNameIndexes({
    resolveProjectDirectory: resolveSearchProjectDirectory,
  });
  return instance;
}

/** Tear every index down at app quit. Idempotent. */
export function disposeProjectNameIndexes(): void {
  const current = instance;
  instance = null;
  current?.disposeAll();
}
