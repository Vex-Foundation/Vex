/**
 * Attaching the DISK half of a project's file status to a DTO.
 *
 * The database layer fills the DURABLE half (which scope version was last
 * rendered completely, under which generator fingerprint) and deliberately
 * leaves `files.artifacts` empty: reading a project's files from inside a
 * database transaction would hold a row lock across filesystem IO, and the
 * scope-edit transaction in particular already holds the session control lock.
 *
 * So the disk half is attached HERE, at the IPC boundary, after every
 * transaction has committed. Every projects handler that returns a DTO goes
 * through this function, which is what makes "the DTO always carries a real
 * file status" a property of the surface rather than of each handler
 * remembering.
 */

import type { ProjectDto } from "@shared/schemas/projects.js";
import { enrichProjectFiles } from "../../studio/installer.js";

/** One project, with its artifacts inspected on disk. */
export async function withProjectFiles(
  project: ProjectDto,
  correlationId: string,
): Promise<ProjectDto> {
  return { ...project, files: await enrichProjectFiles(project, correlationId) };
}

/**
 * Every project, inspected SEQUENTIALLY.
 *
 * Not `Promise.all`: this walks the user's filesystem, and a list of projects
 * is small while a burst of concurrent directory walks is the kind of thing
 * that makes a spinning disk or a network mount feel broken. Order is preserved
 * so the list the renderer receives is the list the database returned.
 */
export async function withProjectFilesAll(
  projects: readonly ProjectDto[],
  correlationId: string,
): Promise<ProjectDto[]> {
  const out: ProjectDto[] = [];
  for (const project of projects) {
    out.push(await withProjectFiles(project, correlationId));
  }
  return out;
}
