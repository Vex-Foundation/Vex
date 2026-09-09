import { realpath } from "node:fs/promises";
import path from "node:path";
import { PROJECT_TRASH_REMEDIATION, type ProjectTrashFailure } from "@shared/schemas/project-cleanup.js";
import type { ProjectTrashOutcome } from "@shared/schemas/projects.js";
import type { TrashItem } from "./os-trash.js";
import { classifyTrashFailure } from "./trash-failure.js";
import { log } from "../logger/index.js";

/**
 * Move the project folder to the OS trash.
 *
 * FIRST use of an OS trash in this app, on a destructive path, so the guard is
 * explicit: the directory's REALPATH must still resolve to a direct child of
 * the projects root's realpath. That is what stops a symlinked slug directory -
 * or a root that moved between the tombstone and this call - from turning
 * "trash the project" into "trash something else". THE GUARD LIVES HERE, with
 * the caller that knows the root, and never travels with the injected
 * capability.
 *
 * It is the TRASH, never an unlink: the user can get their files back.
 * A failure here NEVER rolls back the authority commit; the project is deleted
 * either way, and the folder is simply still on disk.
 */
export async function trashProjectFolder(
  configuredRoot: string,
  directory: string,
  correlationId: string,
  trashItem: TrashItem,
): Promise<{ trash: ProjectTrashOutcome; trashFailure?: ProjectTrashFailure }> {
  let resolvedDirectory: string;
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(configuredRoot);
    resolvedDirectory = await realpath(directory);
  } catch (cause) {
    // A folder that is already gone is not a failure: the obligation was to
    // ensure it is not there, and it is not there.
    if (isMissing(cause)) return { trash: "trashed" };
    log.warn(
      `[studio:delete] the project folder could not be resolved for trashing `
        + `correlationId=${correlationId}`,
    );
    return { trash: "failed", trashFailure: "path_unresolved" };
  }

  const prefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`;
  if (
    !resolvedDirectory.startsWith(prefix)
    || path.dirname(resolvedDirectory) !== resolvedRoot
  ) {
    log.error(
      `[studio:delete] REFUSED to trash a path outside the projects root `
        + `correlationId=${correlationId}`,
    );
    return { trash: "failed", trashFailure: "outside_root" };
  }

  try {
    await trashItem(resolvedDirectory);
    return { trash: "trashed" };
  } catch (cause) {
    const trashFailure = classifyTrashFailure(cause, resolvedDirectory);
    log.warn(
      `[studio:delete] trash refused correlationId=${correlationId}`,
      { reason: trashFailure, remediation: PROJECT_TRASH_REMEDIATION[trashFailure] },
    );
    return { trash: "failed", trashFailure };
  }
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object"
    && cause !== null
    && (cause as { code?: unknown }).code === "ENOENT"
  );
}

