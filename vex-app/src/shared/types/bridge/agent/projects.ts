import type { Result } from "../../../ipc/result.js";
import type {
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectDeleteResult,
  ProjectCreateResult,
  ProjectGetInput,
  ProjectGetResult,
  ProjectList,
  ProjectRepairFilesInput,
  ProjectRepairFilesResult,
  ProjectUpdateScopeInput,
  ProjectUpdateScopeResult,
} from "../../../schemas/projects.js";

/**
 * Vex Studio projects (stage P). A project is a folder under the projects root
 * plus one backing `sessions` row.
 *
 * The renderer holds NO filesystem authority through this surface: it sends a
 * project name and main derives the folder name and resolves the root itself.
 * The DTO's `rootPath` is root-relative and `displayPath` is label text; neither
 * is accepted back as input by any method here.
 */
export interface ProjectsBridge {
  /**
   * Create a project. Not idempotent and never auto-retried: each successful
   * call claims a new directory and writes a new backing session. A name whose
   * folder is already taken is refused by name (`projects.slug_taken`) with
   * nothing created.
   */
  readonly create: (
    input: ProjectCreateInput
  ) => Promise<Result<ProjectCreateResult>>;
  /** Read one project. `null` when the id is unknown (stale renderer cache). */
  readonly get: (input: ProjectGetInput) => Promise<Result<ProjectGetResult>>;
  /** Every project, newest first. */
  readonly list: () => Promise<Result<ProjectList>>;
  /**
   * Edit permission, wallet selection and agent roster under optimistic
   * concurrency. `expectedScopeVersion` must match the project's current
   * `scopeVersion`; a mismatch returns `projects.scope_conflict` and writes
   * nothing, so the caller re-reads and re-applies rather than retrying blind.
   */
  readonly updateScope: (
    input: ProjectUpdateScopeInput
  ) => Promise<Result<ProjectUpdateScopeResult>>;
  /**
   * Reconcile every file Vex maintains in the project folder, drift included.
   *
   * The ONLY path that overwrites an artifact a human edited after Vex wrote
   * it, which is why it is an explicit user action rather than a retry of
   * `updateScope`. It changes no authority and takes no expected version.
   * A5 never deletes files: the strongest thing this does is replace Vex's own
   * region inside a file that stays.
   */
  readonly repairFiles: (
    input: ProjectRepairFilesInput
  ) => Promise<Result<ProjectRepairFilesResult>>;
  /**
   * Delete a project (B0). A SOFT delete: the project row is tombstoned, its
   * backing session is tombstoned, every still-decidable approval it authorized
   * is refused inside the same transaction, and the artifacts Vex recorded
   * writing are then taken back out of the folder.
   *
   * NOT IDEMPOTENT IN THE ORDINARY SENSE, and never auto-retried. `expectedName`
   * is revalidated against the stored row, so a stale renderer cannot delete a
   * project the user was not looking at, and `alsoTrashFolder` is the user's
   * decision about their own files - honoured through the OS trash, never an
   * unlink. Repeating the call on an unfinished tombstone RESUMES the cleanup
   * rather than deleting again, and it honours the tombstone's recorded trash
   * intent instead of this call's checkbox.
   *
   * Every non-`removed` member of the result is an ANSWER, not an error:
   * `blocked_active_calls` and `blocked_pending_dispatch` wrote nothing,
   * `cleanup_pending` means the authority commit stands and the file work is
   * still owed, and `already_removed` means there was nothing left to do.
   */
  readonly delete: (
    input: ProjectDeleteInput
  ) => Promise<Result<ProjectDeleteResult>>;
}
