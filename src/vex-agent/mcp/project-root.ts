/**
 * The Studio project ROOT, read from the row the privileged app wrote.
 *
 * WHY THIS IS NOT A FIELD ON `ProjectScope`. A scope is a snapshot the caller
 * hands in, and `approval-service.ts` already states the doctrine for this
 * surface: "a scope carried on a connection is a stale authorization cache the
 * moment the user edits the project". A filesystem root is exactly the kind of
 * value that must be authoritative at the moment it is USED, because it decides
 * which files a model-supplied path may reach. So it is read here, per use,
 * from `projects.root_path`, the row the privileged main process owns and
 * writes; nothing on the wire and nothing the model sent can influence it.
 *
 * WHAT THIS IS FOR. On the Studio MCP surface a launch tool takes an
 * `imagePath` inside the agent's own project. That path is untrusted model
 * input reaching a filesystem sink (rule 07), and the root returned here is the
 * boundary `studio/files/no-follow-open.ts` contains it to. Nothing else.
 *
 * IT IS NOT A PERMISSION. Resolving a root says where a project lives, never
 * that a caller may read it; the scope's `permission` and the ordinary approval
 * gate remain the authority for what may be done.
 */

import { query } from "../db/client.js";

export type ProjectRootResolution =
  | { readonly kind: "ok"; readonly rootPath: string }
  /** No project row with that id, or the user deleted the project. */
  | { readonly kind: "unknown_project" }
  /** The row exists but records no usable root: a half-created project. */
  | { readonly kind: "no_root_recorded" };

/**
 * Resolve a Studio project's root directory.
 *
 * A soft-deleted project answers `unknown_project` rather than returning its
 * old root: the user's deletion is a decision, and handing a path back for a
 * project they removed would let an agent keep reading it.
 *
 * @throws whatever the database layer throws. A DB outage is neither "unknown"
 * nor "no root", and answering either would send the caller down a wrong
 * remedy; the caller reports the real failure instead.
 */
export async function resolveProjectRootPath(projectId: string): Promise<ProjectRootResolution> {
  const rows = await query<{ root_path: string | null; deleted_at: Date | string | null }>(
    "SELECT root_path, deleted_at FROM projects WHERE id = $1",
    [projectId],
  );
  const row = rows[0];
  if (row === undefined || row.deleted_at !== null) return { kind: "unknown_project" };
  const rootPath = typeof row.root_path === "string" ? row.root_path.trim() : "";
  if (rootPath === "") return { kind: "no_root_recorded" };
  return { kind: "ok", rootPath };
}
